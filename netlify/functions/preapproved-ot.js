// /api/preapproved-ot — the standing pre-approved OT allowance.
//
//   GET                          every row, with the employee name joined on
//   PUT    {employeeId, otType, hours, description}
//                                upsert ONE row
//   DELETE ?employeeId=..&otType=..
//                                remove ONE row
//
// THERE IS NO REPLACE-ALL, and that is the point of this endpoint existing
// instead of another table on /api/data.
//
// The Overtime tab saved by deleting every row and re-inserting the whole table.
// Two things came of that: a byte-identical duplicate row (Rey Aispuro's 6-hour
// Weekend allowance, counted as 12 for months), and the standing risk that a
// partial save wipes rows nobody was editing. /api/data's PUT maps to
// db.replaceAll, which is exactly that operation, so `preapproved_ot` is
// deliberately NOT on that endpoint's allowlist.
//
// Every write here names one employee and one category. unique(employee_id,
// ot_type) in the database makes a duplicate impossible even if this code is
// wrong, which is the right order for those two defences.

const db = require('./db');
const payrollDb = require('./payroll-db');
const { verifySession, getCookies } = require('./session-lib');

// The live category values, confirmed against the data. The spec draft said
// 'Before Shift / After Shift'; those strings are not in the table and would
// fail the CHECK constraint on the first insert.
const OT_TYPES = ['Pre-Shift', 'Post-Shift', 'Weekend'];

// A standing weekly allowance. Anything above this is not an allowance, it is a
// typo — a 168 would silently make one person's approval bigger than the whole
// mill's overtime and Net OT would go deeply negative with nothing to point at.
const MAX_HOURS_PER_WEEK = 40;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isMissingTableError(err) {
  return /\b404\b|PGRST205|could not find the table|does not exist/i.test(
    String((err && err.message) || ''));
}

const MIGRATION_HINT =
  'The preapproved_ot table does not exist yet — run SCHEMA_PHASE_C_PREAPPROVED_OT.sql. ' +
  'Until then the OT report reads the old name-keyed `overtime` table and this page is read-only.';

// Validates a write and returns either {error} or the row to send. Kept separate
// from the handler so every rejection happens before anything is written and the
// rules are testable without a database.
function validateWrite(body) {
  const employeeId = String((body && body.employeeId) || '').trim();
  if (!UUID_RE.test(employeeId)) {
    return { error: 'employeeId must be an employee UUID. The allowance is keyed on employees.id, not on a name.' };
  }

  const otType = String((body && body.otType) || '').trim();
  if (!OT_TYPES.includes(otType)) {
    return { error: `otType must be one of ${OT_TYPES.join(', ')} — got "${otType}"` };
  }

  // Hours must be a number or a numeric string. Not null, not an object, not a
  // blank: Number('') is 0, which reads as "approved for nothing" rather than as
  // the empty field it actually is.
  const raw = body && body.hours;
  if (typeof raw !== 'number' && typeof raw !== 'string') {
    return { error: 'hours must be a number' };
  }
  const trimmed = typeof raw === 'string' ? raw.trim() : raw;
  if (trimmed === '') return { error: 'hours must be a number' };
  const hours = Number(trimmed);
  if (!Number.isFinite(hours) || hours < 0) {
    return { error: 'hours must be zero or more — an allowance cannot be negative' };
  }
  if (hours > MAX_HOURS_PER_WEEK) {
    return { error: `hours must be ${MAX_HOURS_PER_WEEK} or fewer — this is a weekly allowance, not a total` };
  }

  // The description is the point of keeping three categories: the category says
  // WHEN, the description says WHAT. Optional, but an empty one is stored as
  // null rather than '' so "no description" has one representation.
  const desc = body && body.description;
  const description = (typeof desc === 'string' && desc.trim() !== '') ? desc.trim() : null;

  return {
    row: {
      employee_id: employeeId,
      ot_type: otType,
      hours: Math.round(hours * 100) / 100,
      description,
      updated_at: new Date().toISOString()
    }
  };
}

// GET returns the rows with the employee's name and department attached, because
// a list of UUIDs is unreadable and the client should not have to re-join what
// the server already knows. No wage, no salary: this endpoint says who is
// approved for how many hours, never what they are paid.
async function listRows() {
  const [rows, employees] = await Promise.all([
    payrollDb.fetchPreApprovedOt(),
    payrollDb.fetchEmployees()
  ]);
  const byId = new Map((employees || []).map(e => [String(e.id), e]));

  return (rows || []).map((r) => {
    const emp = byId.get(String(r.employee_id)) || null;
    return {
      id: r.id,
      employeeId: r.employee_id,
      name: emp ? (emp.name || '') : null,
      employeeNumber: emp ? (emp.employee_number || null) : null,
      department: emp ? (emp.department || null) : null,
      // Surfaced so the page can show WHY a row contributes nothing, rather than
      // leaving somebody to wonder where their allowance went. The report applies
      // the same rule — an inactive employee's allowance counts nowhere.
      status: emp ? (emp.status || 'Active') : null,
      onRoster: !!emp,
      otType: r.ot_type,
      hours: Number(r.hours) || 0,
      description: r.description || '',
      updatedAt: r.updated_at || null
    };
  }).sort((a, b) =>
    String(a.name || '￿').localeCompare(String(b.name || '￿'))
    || OT_TYPES.indexOf(a.otType) - OT_TYPES.indexOf(b.otType));
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const fail = (statusCode, error, extra = {}) =>
    ({ statusCode, headers, body: JSON.stringify({ ok: false, error, ...extra }) });

  const session = verifySession(getCookies(event).sfp_session || '');
  if (!session) return fail(401, 'Unauthorized');

  const method = event.httpMethod;

  try {
    if (method === 'GET') {
      try {
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, rows: await listRows(), otTypes: OT_TYPES }) };
      } catch (err) {
        if (!isMissingTableError(err)) throw err;
        // Not an error for the caller to handle: the page renders, empty, and
        // says why. A 500 here would look like a broken app rather than a
        // migration that has not been run.
        return {
          statusCode: 200, headers,
          body: JSON.stringify({ ok: true, rows: [], otTypes: OT_TYPES, tableMissing: true, note: MIGRATION_HINT })
        };
      }
    }

    if (method === 'PUT' || method === 'POST') {
      let body;
      try { body = JSON.parse(event.body || '{}'); }
      catch { return fail(400, 'Body must be JSON'); }

      const { error, row } = validateWrite(body);
      if (error) return fail(400, error);

      // Upsert on the unique key, so saving the same person and category twice
      // updates rather than duplicating. This is the whole difference from the
      // old replace-the-table save.
      try {
        const saved = await payrollDb.request('POST', 'preapproved_ot?on_conflict=employee_id,ot_type', {
          body: [row],
          headers: { Prefer: 'resolution=merge-duplicates,return=representation' }
        });
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, row: (saved.rows || [])[0] || null }) };
      } catch (err) {
        if (isMissingTableError(err)) return fail(409, MIGRATION_HINT);
        // A foreign-key violation means the employee id is not on the roster,
        // which is a client mistake rather than a server fault.
        if (/foreign key|23503/i.test(String(err.message))) {
          return fail(400, 'That employee is not on the roster.');
        }
        throw err;
      }
    }

    if (method === 'DELETE') {
      const params = event.queryStringParameters || {};
      const employeeId = String(params.employeeId || '').trim();
      const otType = String(params.otType || '').trim();
      if (!UUID_RE.test(employeeId)) return fail(400, 'employeeId must be an employee UUID');
      if (!OT_TYPES.includes(otType)) return fail(400, `otType must be one of ${OT_TYPES.join(', ')}`);

      // Both filters, always. A DELETE carrying only one of them would remove
      // every category for that person, or that category for everyone.
      const path = 'preapproved_ot'
        + `?employee_id=eq.${encodeURIComponent(employeeId)}`
        + `&ot_type=eq.${encodeURIComponent(otType)}`;
      try {
        await payrollDb.request('DELETE', path);
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, deleted: { employeeId, otType } }) };
      } catch (err) {
        if (isMissingTableError(err)) return fail(409, MIGRATION_HINT);
        throw err;
      }
    }

    return fail(405, 'Method not allowed');

  } catch (err) {
    console.error('preapproved-ot error:', err.message);
    return fail(500, err.message);
  }
};

exports.__test = { validateWrite, OT_TYPES, MAX_HOURS_PER_WEEK };
