// /api/economics — the budgeted staffing plan, and the ONE thing about it that
// is editable from the app.
//
//   GET                    every seat, in plan order.
//   PATCH {id, name}       assign or unassign ONE seat. name '' or null clears it.
//
// Both need the salaries tier.
//
// ------------------------------------------------------------------------
// WHY THIS ENDPOINT EXISTS AT ALL, when /api/data could serve the table
// ------------------------------------------------------------------------
//
// It briefly did. When the page came back it was read-only, so `economics` went
// on the /api/data allowlist behind a READ_ONLY_TABLES check. The moment
// assignment had to be editable, that stopped being the right shape: a generic
// table endpoint with a per-table exception list is one edit away from
// exposing the write path that got this table removed in the first place.
//
// So the table has one owner. It is off the /api/data allowlist entirely — not
// "read-only there", not reachable there — and the only write in existence is
// the one below, which sets one column on one row.
//
// ------------------------------------------------------------------------
// WHAT THIS DELIBERATELY CANNOT DO
// ------------------------------------------------------------------------
//
// NO REPLACE-ALL. The old page saved the whole table with PUT, which maps to
// db.replaceAll — DELETE every row, then insert. Over the only record of a
// per-seat rate ceiling, with no screen that would have shown it had been
// emptied. That is the failure this endpoint is shaped around: the unit of
// change is one seat, and nothing here can touch a row the caller did not name.
//
// ONLY `name` IS WRITABLE. num, section, seat and max_wage are the PLAN. Moving
// a ceiling or renaming a seat is a budgeting decision, not staffing, and it
// does not belong on a screen whose job is "who is sitting here". A body naming
// any other column is refused rather than filtered, so a caller is told.
//
// NO CREATE, NO DELETE. Adding or removing a seat changes the size of the plan.
//
// ------------------------------------------------------------------------
// A NOTE ON MATCHING BY NAME
// ------------------------------------------------------------------------
//
// economics.name is TEXT holding a person's name, not a foreign key to
// employees.id. That is the existing schema and this endpoint does not change
// it — but free-text names are exactly how 'Tim Green' and 'Timothy Green'
// became two people earlier in this project. So an assignment is validated
// against the roster and refused unless it matches an active hourly employee
// EXACTLY. The app can only ever send a name it read from the roster; this
// stops anything else, including a stale tab holding somebody who has left.
//
// The real fix is an employee_id column with a foreign key, which would make a
// rename impossible to get wrong and would let a seat survive one. That is a
// migration, and a deliberate one — noted here rather than done quietly.

const db = require('./db');
const payrollDb = require('./payroll-db');
const perms = require('./permissions-lib');
const { verifySession, getCookies } = require('./session-lib');

const TABLE = 'economics';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The one column this endpoint may set. Kept as a list rather than a string so
// the refusal below reads the same way permissions-lib's does, and so adding a
// second editable column is one edit in one place.
const WRITABLE = ['name'];

const MIGRATION_HINT =
  'The economics table does not exist in this database. The staffing plan lives there; ' +
  'nothing else depends on it, so the rest of the app is unaffected.';

function isMissingTableError(err) {
  return /\b404\b|PGRST205|could not find the table|does not exist/i.test(
    String((err && err.message) || ''));
}

const textOf = (v) => String(v == null ? '' : v).trim();

// Everyone a seat may legitimately name. Active and hourly, for the reason the
// page states: seats are hourly, and a salaried person has no rate to bring to
// one. isSalaried is the shared pay_type-first rule, imported rather than
// re-implemented — this is the fourth runtime that asks the question.
async function assignableNames() {
  const { isSalaried } = require('./wage-sync');
  const employees = await payrollDb.fetchEmployees();
  const out = new Map();
  for (const e of employees || []) {
    const name = textOf(e.name);
    if (!name) continue;
    if (textOf(e.status).toLowerCase() !== 'active') continue;
    if (isSalaried(e)) continue;
    out.set(name.toLowerCase(), name);
  }
  return out;
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const fail = (statusCode, error, extra = {}) =>
    ({ statusCode, headers, body: JSON.stringify({ ok: false, error, ...extra }) });

  const session = verifySession(getCookies(event).sfp_session || '');
  if (!session) return fail(401, 'Unauthorized');

  const method = event.httpMethod;
  if (method !== 'GET' && method !== 'PATCH') return fail(405, 'Method not allowed');

  try {
    // Resolved from the same registry as every other gate, and failing closed to
    // the base tier. All-or-nothing: every column here is part of one
    // compensation view — the seat, who is in it, and the ceiling for it — so
    // there is no useful subset to hand somebody without the tier.
    const tiers = await perms.fetchTiers(session.email, db);
    if (!perms.has(tiers, perms.TIER_SALARIES)) {
      return fail(403, 'Not permitted to read the staffing plan',
        { detail: 'This needs the salaries tier. An administrator can grant it under Settings → Access.' });
    }

    if (method === 'GET') {
      try {
        const seats = await db.query(TABLE, '?select=id,num,section,seat,name,max_wage&order=num.asc');
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, seats: seats || [] }) };
      } catch (err) {
        if (!isMissingTableError(err)) throw err;
        // The page renders, empty, and says why. A 500 would look like a broken
        // app rather than a table this database does not have.
        return { statusCode: 200, headers,
                 body: JSON.stringify({ ok: true, seats: [], tableMissing: true, note: MIGRATION_HINT }) };
      }
    }

    // ---- PATCH: one seat, one column ----
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return fail(400, 'Body is not valid JSON'); }

    const id = textOf(body.id);
    if (!UUID_RE.test(id)) {
      return fail(400, 'id must be the seat\'s UUID — an assignment belongs to a seat, not to a seat name.');
    }

    // REFUSED, not filtered. A 200 for a write that discarded half the body
    // reports success for something that did not happen.
    const refused = Object.keys(body).filter(k => k !== 'id' && !WRITABLE.includes(k));
    if (refused.length) {
      return fail(403, 'Not permitted to write: ' + refused.join(', '), {
        refused,
        detail: 'Only the assigned person can be changed here. The seat number, section, title and ' +
                'rate ceiling are the plan itself — changing those is a budgeting decision and is ' +
                'made in the database.'
      });
    }

    const wanted = textOf(body.name);

    try {
      const existing = await db.query(TABLE,
        `?select=id,num,section,seat,name,max_wage&id=eq.${encodeURIComponent(id)}`);
      if (!existing || !existing.length) return fail(404, 'No seat with that id');
      const seat = existing[0];

      let canonical = null;                      // null is the stored "vacant"
      if (wanted) {
        const roster = await assignableNames();
        canonical = roster.get(wanted.toLowerCase()) || null;
        if (!canonical) {
          return fail(400, `"${wanted}" is not an active hourly employee`, {
            detail: 'A seat can only be filled by somebody on the roster, active, and hourly. If ' +
                    'they have just been added, reload; if they are salaried, they have no hourly ' +
                    'rate to bring to a seat.'
          });
        }
      }

      // Nothing to do. Said rather than written, so an idempotent click does not
      // stamp an updated_at and does not read as a change in any audit of the row.
      if (textOf(seat.name) === textOf(canonical)) {
        return { statusCode: 200, headers,
                 body: JSON.stringify({ ok: true, seat, unchanged: true }) };
      }

      const updated = await db.update(TABLE, id, { name: canonical });
      const row = (Array.isArray(updated) ? updated[0] : updated) || { ...seat, name: canonical };

      // ALLOWED, BUT REPORTED. Somebody in two seats is always a plan error, and
      // the page flags it — but refusing here would make a straight swap
      // impossible without unassigning first, and a mid-swap state that resolves
      // on the next click is not worth blocking. So it goes through and the
      // caller is told immediately rather than finding out from a banner.
      let alsoIn = [];
      if (canonical) {
        const others = await db.query(TABLE,
          `?select=seat&name=eq.${encodeURIComponent(canonical)}&id=neq.${encodeURIComponent(id)}`);
        alsoIn = (others || []).map(o => o.seat).filter(Boolean);
      }

      return { statusCode: 200, headers,
               body: JSON.stringify({ ok: true, seat: row, alsoIn }) };
    } catch (err) {
      if (isMissingTableError(err)) return fail(503, MIGRATION_HINT);
      throw err;
    }

  } catch (err) {
    console.error('economics error:', err.message);
    return fail(500, err.message);
  }
};
