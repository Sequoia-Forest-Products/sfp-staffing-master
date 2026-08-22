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
// A SEAT POINTS AT A PERSON, NOT AT A STRING
// ------------------------------------------------------------------------
//
// economics.employee_id is a foreign key to employees(id) and is the ONLY thing
// that decides who is in a seat. The occupant's name is resolved through it on
// every read, so renaming somebody on the Employees tab moves their seat with
// them instead of orphaning it.
//
// It used to be the text column `economics.name`, which is how 'Tim Green' and
// 'Timothy Green' became two people earlier in this project. An earlier version
// of this endpoint validated the incoming name against the roster, which stopped
// a bad name going IN but could do nothing about a good one going stale
// afterwards. SCHEMA_ECONOMICS_EMPLOYEE_ID.sql added the key and backfilled it.
//
// `name` is still in the table and is NOT read here. It holds the only record
// of the occupant for any row the backfill could not match, and it is dropped
// in a later, deliberate change.
//
// WORKS BEFORE AND AFTER THE MIGRATION, so there is no deploy ordering to get
// right. The read asks for employee_id and falls back to a projection without
// it on a 42703, the same ladder /api/data uses; with no column it resolves the
// occupant from the stored name, which is the old behaviour. The WRITE requires
// the column and says which file to run — an assignment that landed in `name`
// after the read had switched to employee_id would be a write nobody could see,
// which is worse than a refusal.

const db = require('./db');
const payrollDb = require('./payroll-db');
const perms = require('./permissions-lib');
const { verifySession, getCookies } = require('./session-lib');

const TABLE = 'economics';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The one column this endpoint may set. Kept as a list rather than a string so
// the refusal below reads the same way permissions-lib's does, and so adding a
// second editable column is one edit in one place.
const WRITABLE = ['employeeId'];

const BASE_COLUMNS = 'id,num,section,seat,name,max_wage';
const FULL_COLUMNS = BASE_COLUMNS + ',employee_id';

const MIGRATION_HINT =
  'The economics table does not exist in this database. The staffing plan lives there; ' +
  'nothing else depends on it, so the rest of the app is unaffected.';

const FK_MIGRATION_HINT =
  'economics.employee_id does not exist yet — run SCHEMA_ECONOMICS_EMPLOYEE_ID.sql. ' +
  'The plan still READS: seats fall back to the name recorded against them. Assignment is ' +
  'refused rather than written to that text column, because a write there would not be ' +
  'visible to a build that reads the key.';

function isMissingTableError(err) {
  return /\b404\b|PGRST205|could not find the table/i.test(
    String((err && err.message) || ''));
}

// PostgREST answers a select naming a column the table does not have with 400
// and 42703. Distinguished from a missing TABLE, because the two have different
// answers: a missing table is an empty page, a missing column is one rung down
// the ladder.
function isMissingColumnError(err) {
  return /\b42703\b|does not exist/i.test(String((err && err.message) || ''));
}

const textOf = (v) => String(v == null ? '' : v).trim();

// Every employee, by id. Used to resolve an occupant's CURRENT name on read and
// to decide who may fill a seat on write.
//
// Keyed by id and not by name, which is the whole change: a rename alters the
// value here and not the key, so a seat pointing at the key follows it.
async function employeesById() {
  const { isSalaried } = require('./wage-sync');
  const employees = await payrollDb.fetchEmployees();
  const out = new Map();
  for (const e of employees || []) {
    if (!e || !e.id) continue;
    out.set(String(e.id), {
      id: String(e.id),
      name: textOf(e.name),
      status: textOf(e.status),
      // Seats are hourly: a salaried person has no rate to bring to one. The
      // shared pay_type-first rule, imported rather than re-implemented — this
      // is the fourth runtime that asks the question.
      salaried: isSalaried(e)
    });
  }
  return out;
}

const isAssignable = (emp) =>
  !!emp && emp.status.toLowerCase() === 'active' && !emp.salaried;

// One seat, as the page sees it. `name` is the occupant's name TODAY, resolved
// through the key — that is what makes a rename propagate. `unlinked` marks a
// row the backfill could not match: it still has a recorded occupant in the
// legacy text column and is shown, because a seat whose occupant nobody can
// identify is exactly the thing worth surfacing rather than blanking.
function shapeSeat(row, byId, hasKey) {
  const seat = {
    id: row.id, num: row.num, section: row.section, seat: row.seat,
    max_wage: row.max_wage, employeeId: null, name: null,
    occupantStatus: null, occupantSalaried: null, unlinked: false
  };
  if (!hasKey) {
    // Pre-migration: the stored text is all there is. Today's behaviour.
    seat.name = textOf(row.name) || null;
    seat.unlinked = !!seat.name;
    return seat;
  }
  const emp = row.employee_id ? byId.get(String(row.employee_id)) : null;
  if (emp) {
    seat.employeeId = emp.id;
    seat.name = emp.name;
    seat.occupantStatus = emp.status;
    seat.occupantSalaried = emp.salaried;
    return seat;
  }
  // A key that resolves to nobody should be impossible — the FK is ON DELETE
  // SET NULL — but a roster read that is narrower than the plan would produce
  // it, and inventing a vacancy would hide a seat somebody is sitting in.
  seat.name = textOf(row.name) || null;
  seat.unlinked = !!(row.employee_id || seat.name);
  return seat;
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

    // Two rungs, the same shape as /api/data's ladder: ask for the key, and if
    // the column is not there yet drop to the projection without it. That is
    // what makes this deployable before the migration.
    async function readSeats() {
      try {
        return { rows: await db.query(TABLE, `?select=${FULL_COLUMNS}&order=num.asc`), hasKey: true };
      } catch (err) {
        if (isMissingTableError(err) || !isMissingColumnError(err)) throw err;
        console.warn(FK_MIGRATION_HINT);
        return { rows: await db.query(TABLE, `?select=${BASE_COLUMNS}&order=num.asc`), hasKey: false };
      }
    }

    if (method === 'GET') {
      try {
        const { rows, hasKey } = await readSeats();
        const byId = hasKey ? await employeesById() : new Map();
        return {
          statusCode: 200, headers,
          body: JSON.stringify({
            ok: true,
            seats: (rows || []).map(r => shapeSeat(r, byId, hasKey)),
            // So the page can say why assignment is unavailable rather than
            // presenting a control that will refuse.
            assignable: hasKey,
            note: hasKey ? undefined : FK_MIGRATION_HINT
          })
        };
      } catch (err) {
        if (!isMissingTableError(err)) throw err;
        // The page renders, empty, and says why. A 500 would look like a broken
        // app rather than a table this database does not have.
        return { statusCode: 200, headers,
                 body: JSON.stringify({ ok: true, seats: [], assignable: false,
                                        tableMissing: true, note: MIGRATION_HINT }) };
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
        detail: refused.includes('name')
          ? 'A seat points at an employee id, not at a name — that is what stops a rename ' +
            'orphaning it. Send employeeId.'
          : 'Only the assigned person can be changed here. The seat number, section, title and ' +
            'rate ceiling are the plan itself — changing those is a budgeting decision and is ' +
            'made in the database.'
      });
    }

    const wantedId = textOf(body.employeeId);
    if (wantedId && !UUID_RE.test(wantedId)) {
      return fail(400, 'employeeId must be an employee UUID, or empty to vacate the seat.');
    }

    try {
      // The key has to exist before anything is written, and this read is what
      // establishes it: naming employee_id in the projection means a database
      // without the column answers 42703 here, before any write is attempted.
      // One query answers both "is there a seat" and "has the migration run".
      //
      // Deliberately NOT wrapped in its own catch. An earlier version handled
      // the missing table and missing column here as well as in the catch
      // below, which is the same two answers written twice — and a negative
      // control proved it: removing the inner handling failed no test, because
      // the outer one had it covered. Two paths to one behaviour is one path
      // that can rot unnoticed.
      const existing = await db.query(TABLE, `?select=${FULL_COLUMNS}&id=eq.${encodeURIComponent(id)}`);
      if (!existing || !existing.length) return fail(404, 'No seat with that id');
      const seat = existing[0];

      let emp = null;
      if (wantedId) {
        emp = (await employeesById()).get(wantedId) || null;
        if (!emp) return fail(400, 'No employee with that id');
        if (!isAssignable(emp)) {
          return fail(400, `${emp.name || 'That employee'} cannot be seated`, {
            detail: emp.salaried
              ? 'Seats are hourly, and a salaried person has no hourly rate to bring to one.'
              : 'Only an active employee can fill a seat.'
          });
        }
      }

      const nextId = emp ? emp.id : null;

      // Nothing to do. Said rather than written, so an idempotent click does not
      // stamp an updated_at and does not read as a change in any audit of the row.
      if (String(seat.employee_id || '') === String(nextId || '')) {
        const byId = await employeesById();
        return { statusCode: 200, headers,
                 body: JSON.stringify({ ok: true, seat: shapeSeat(seat, byId, true), unchanged: true }) };
      }

      // `name` goes with it, and this is the one place it is still written: not
      // as the source of truth but as the last-known spelling, so a row that
      // ever loses its key is not left anonymous. Everything READS the key.
      const updated = await db.update(TABLE, id, { employee_id: nextId, name: emp ? emp.name : null });
      const row = (Array.isArray(updated) ? updated[0] : updated)
        || { ...seat, employee_id: nextId, name: emp ? emp.name : null };

      // ALLOWED, BUT REPORTED. Somebody in two seats is always a plan error, and
      // the page flags it — but refusing here would make a straight swap
      // impossible without unassigning first, and a mid-swap state that resolves
      // on the next click is not worth blocking. So it goes through and the
      // caller is told immediately rather than finding out from a banner.
      //
      // Asked by id now, so it also catches the case a name comparison could
      // not: the same person in two seats under two spellings.
      let alsoIn = [];
      if (nextId) {
        const others = await db.query(TABLE,
          `?select=seat&employee_id=eq.${encodeURIComponent(nextId)}&id=neq.${encodeURIComponent(id)}`);
        alsoIn = (others || []).map(o => o.seat).filter(Boolean);
      }

      const byId = await employeesById();
      return { statusCode: 200, headers,
               body: JSON.stringify({ ok: true, seat: shapeSeat(row, byId, true), alsoIn }) };
    } catch (err) {
      if (isMissingTableError(err)) return fail(503, MIGRATION_HINT);
      if (isMissingColumnError(err)) return fail(503, FK_MIGRATION_HINT);
      throw err;
    }

  } catch (err) {
    console.error('economics error:', err.message);
    return fail(500, err.message);
  }
};
