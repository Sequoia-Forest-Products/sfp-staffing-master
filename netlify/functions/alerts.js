// /api/alerts — the Alerts tab.
//
//   GET                          open + acknowledged alerts, and the open count
//   GET ?evaluate=1              re-evaluate first (the tab does this on open)
//   GET ?count=1                 just the open count, for the nav badge
//   GET ?resolved=1              also include the 50 most recently resolved
//   POST {action:'acknowledge', id}
//   POST {action:'markBbsiStaff', employeeNumber, note?}
//   POST {action:'variance', importId}   one reconciliation's variance summary
//   POST {action:'reconciliations'}      the recent weekly imports, with totals
//
// Everyone on the access list can do everything here; there are no tiers.

const db = require('./payroll-db');
const { verifySession, getCookies } = require('./session-lib');
const { runAlertEvaluation } = require('./alerts-engine');
const { TYPES } = require('./alerts-lib');
const { normalizeEmpNumber } = require('./payroll-lib');
const { DAILY_FILE, WEEKLY_FILE, ALERT_THRESHOLDS } = require('./timeclock-config');

const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const ok = body => ({ statusCode: 200, headers, body: JSON.stringify({ ok: true, ...body }) });
const fail = (statusCode, error) => ({ statusCode, headers, body: JSON.stringify({ ok: false, error }) });

class BadRequest extends Error {}

async function acknowledge({ id }, session) {
  if (!id) throw new BadRequest('id is required.');
  const alert = await db.fetchAlert(id);
  if (!alert) throw new BadRequest(`No alert ${id}.`);
  if (alert.status === 'resolved') return { alert };
  const stamp = new Date().toISOString();
  // Weekly variance has no standing condition to clear, so acknowledging it IS
  // its resolution. Every other type stays acknowledged until its condition
  // clears, and then the engine resolves it.
  const patch = alert.type === 'weekly_variance'
    ? { status: 'resolved', acknowledged_at: stamp, acknowledged_by: session.email,
        resolved_at: stamp, resolved_reason: `acknowledged by ${session.email}` }
    : { status: 'acknowledged', acknowledged_at: stamp, acknowledged_by: session.email };
  const rows = await db.updateAlert(id, patch);
  return { alert: rows[0] || { ...alert, ...patch } };
}

async function markBbsiStaff({ employeeNumber, note }, session) {
  const n = normalizeEmpNumber(employeeNumber);
  if (!n) throw new BadRequest('employeeNumber is required.');
  const roster = await db.fetchEmployees();
  if ((roster || []).some(e => normalizeEmpNumber(e.employee_number) === n)) {
    throw new BadRequest(`#${n} is on the roster, so it is an SFP employee, not BBSI staff.`);
  }
  const held = await db.fetchHeldRows({ employeeNumber: n });
  const name = held.length ? [held[0].first_name, held[0].last_name].filter(Boolean).join(' ') || null : null;
  await db.addExclusion({ employee_number: n, reason: 'bbsi_staff', name,
    note: note ? String(note).slice(0, 500) : null, created_by: session.email });
  await db.markHeldExternal(n);
  const evaluation = await runAlertEvaluation({ db });
  return { employeeNumber: n, evaluation };
}

async function variance({ importId }) {
  if (!importId) throw new BadRequest('importId is required.');
  const imp = await db.fetchImport(importId);
  if (!imp) throw new BadRequest(`No import ${importId}.`);
  return { import: imp };
}

async function reconciliations() {
  const imports = await db.fetchImports({ source: 'weekly', limit: 20 });
  return {
    reconciliations: imports.map(i => ({
      id: i.id, from: i.work_date_from, to: i.work_date_to, receivedAt: i.file_received_at,
      createdAt: i.created_at, rowsCounted: i.rows_counted, rowsHeld: i.rows_held,
      totals: i.variance && i.variance.totals ? i.variance.totals : null,
      fixedPunches: i.variance && i.variance.fixedPunches ? i.variance.fixedPunches.length : 0
    }))
  };
}

const ACTIONS = { acknowledge, markBbsiStaff, variance, reconciliations };

exports.handler = async (event) => {
  const session = verifySession(getCookies(event).sfp_session || '');
  if (!session) return fail(401, 'Unauthorized');

  try {
    if (event.httpMethod === 'GET') {
      const q = event.queryStringParameters || {};
      let evaluation = null;
      if (q.evaluate) evaluation = await runAlertEvaluation({ db });
      const statuses = q.resolved ? ['open', 'acknowledged', 'resolved'] : ['open', 'acknowledged'];
      const alerts = await db.fetchAlerts({ statuses, limit: q.resolved ? 300 : 500 });
      const openCount = alerts.filter(a => a.status === 'open').length;
      if (q.count) return ok({ openCount });
      return ok({
        alerts, openCount, evaluation, types: TYPES,
        config: { daily: DAILY_FILE, weekly: WEEKLY_FILE, thresholds: ALERT_THRESHOLDS }
      });
    }
    if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed.');
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return fail(400, 'Request body is not valid JSON.'); }
    const run = Object.prototype.hasOwnProperty.call(ACTIONS, body.action) ? ACTIONS[body.action] : null;
    if (!run) return fail(400, `Unknown action ${JSON.stringify(body.action)}. Expected one of: ${Object.keys(ACTIONS).join(', ')}.`);
    return ok(await run(body, session));
  } catch (err) {
    if (err instanceof BadRequest) return fail(400, err.message);
    console.error('alerts failed:', err);
    return fail(500, err.message || 'Unexpected error');
  }
};
