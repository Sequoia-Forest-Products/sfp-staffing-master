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
// TWO COLUMNS ARE WRITABLE: the occupant and `max_wage`, the position rate. num,
// section and seat are the PLAN's shape — changing those resizes the plan — and
// a body naming one is refused rather than filtered, so a caller is told.
//
// `max_wage` was in that refused list until this change, on the argument that
// moving a ceiling is a budgeting decision and does not belong on a screen whose
// job is "who is sitting here". What that produced in practice was a figure
// nobody could move: the number the entire variance column is measured against
// was editable only by writing SQL against a live table. That is a worse audit
// trail than an app write and a standing reason for the plan to drift out of
// date, so the ceiling is now typed here. The gate is unchanged — the endpoint
// already requires the salaries tier to read a ceiling at all, so the people who
// can set one are exactly the people who could already see one.
//
// ONE COLUMN PER REQUEST, still. A body naming both employeeId and maxWage is
// refused: they are unrelated facts and one response cannot report both
// honestly.
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

// The columns this endpoint may set, and there are two now.
//
// `maxWage` IS A REVERSAL. The ceiling was deliberately unwritable: this screen's
// job was "who is sitting here", and moving a ceiling is a budgeting decision,
// so it was made in the database on purpose. That turned out to mean nobody
// moved one — the figure the whole variance column is measured against could
// only be changed by somebody willing to write SQL against a live table, which
// is both a worse audit trail than an app write and a reason for the plan to go
// stale. It is the same tier either way: the endpoint already needs `salaries`
// for the read, so anybody who can SEE a ceiling can now set one.
//
// STILL ONE COLUMN PER REQUEST. A body naming both is refused — see the check
// below. The two are unrelated facts (who is in the seat, what the seat is
// budgeted at) and reporting the outcome of a combined write honestly would
// mean describing two changes in one sentence.
const WRITABLE = ['employeeId', 'maxWage'];

// A ceiling above this is refused as a typo rather than stored. The realistic
// accident is an annual salary pasted into an hourly field — 95000 in a column
// whose values are all between 20 and 55 — and it would silently make the
// variance column meaningless for that seat rather than look wrong. Generous on
// purpose: it is a guard against a misplaced decimal point, not a policy about
// what anybody may be paid.
const MAX_CEILING = 1000;

const BASE_COLUMNS = 'id,num,section,seat,name,max_wage';
const FULL_COLUMNS = BASE_COLUMNS + ',employee_id';

// economics_history. Written BEFORE the row it describes, and a failure to
// record aborts the change — the same rule wage-edit-lib states first and for
// the same reason: an overwrite with no history is the thing a history table
// exists to prevent, and a history row for a change that then failed to apply
// is recoverable, while the reverse is not.
const HISTORY_TABLE = 'economics_history';

const HISTORY_MIGRATION_HINT =
  'economics_history does not exist yet — run SCHEMA_ECONOMICS_HISTORY.sql. The plan still ' +
  'READS, and an assignment or a position rate can still be looked at, but neither can be ' +
  'CHANGED until the trail exists: a change nobody can audit is the thing that file was added ' +
  'to stop, so it is refused rather than written unrecorded.';

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

// Records one change, and RETURNS NOTHING — it either writes or throws, and a
// throw is what stops the caller applying the change.
//
// The seat is copied onto the row (num, section, title) so the record still
// identifies its seat after a rename or a delete; the FK is ON DELETE SET NULL,
// so without the copies such a row could not say what it was about.
//
// Values go in twice on purpose: `previous_value`/`new_value` are the raw
// stored figures, and `previous_display`/`new_display` are what they MEANT at
// the time. An employee_id is an unreadable UUID whose employee may later be
// renamed or deleted, and a history row has to still make sense years later.
async function recordChange({ seat, field, previousValue, newValue, previousDisplay, newDisplay, changedBy }) {
  await db.insert(HISTORY_TABLE, {
    seat_id: seat.id,
    seat_num: seat.num,
    seat_section: seat.section,
    seat_title: seat.seat,
    field,
    previous_value: previousValue == null ? null : String(previousValue),
    new_value: newValue == null ? null : String(newValue),
    previous_display: previousDisplay == null ? null : String(previousDisplay),
    new_display: newDisplay == null ? null : String(newDisplay),
    changed_by: changedBy
  });
}

// One history row as the page reads it. The raw values are deliberately NOT
// sent: the page renders the displays, and shipping a UUID of somebody who may
// have left adds nothing a reader can use.
function shapeHistory(row) {
  return {
    id: row.id,
    field: row.field,
    previous: row.previous_display,
    next: row.new_display,
    changedBy: row.changed_by,
    changedAt: row.changed_at,
    // The opening rows §4 of the migration wrote. Marked so the page can say
    // "predates the trail" rather than presenting them as somebody's edit.
    opening: row.changed_by === 'migration'
  };
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

    // GET ?history=<seat uuid> — that seat's changes, newest first.
    //
    // Served HERE rather than through /api/data for the same reason the plan is:
    // this endpoint resolves the caller's tiers itself, and the history is the
    // same compensation view as the seat it describes. economics_history also
    // carries RLS with no policy, so it is unreachable by a browser holding the
    // publishable key even if somebody allowlisted it there.
    //
    // A MISSING TABLE IS AN EMPTY LIST, not an error, and that is the one place
    // this differs from the write path. A reader who opens the history before
    // the migration has run should see "no changes recorded" and a note saying
    // why, not a failure; a WRITER must be refused, because writing a change
    // nobody can audit is the thing the table exists to stop.
    if (method === 'GET' && textOf((event.queryStringParameters || {}).history)) {
      const seatId = textOf((event.queryStringParameters || {}).history);
      if (!UUID_RE.test(seatId)) {
        return fail(400, 'history must be a seat UUID');
      }
      try {
        const rows = await db.query(HISTORY_TABLE,
          `?select=id,field,previous_display,new_display,changed_by,changed_at` +
          `&seat_id=eq.${encodeURIComponent(seatId)}&order=changed_at.desc&limit=50`);
        return { statusCode: 200, headers,
                 body: JSON.stringify({ ok: true, history: (rows || []).map(shapeHistory) }) };
      } catch (err) {
        if (isMissingTableError(err)) {
          return { statusCode: 200, headers,
                   body: JSON.stringify({ ok: true, history: [], historyMissing: true,
                                          note: HISTORY_MIGRATION_HINT }) };
        }
        throw err;
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
          : 'Only the assigned person and the position rate can be changed here. The seat ' +
            'number, section and title are the plan itself — changing those resizes the plan ' +
            'and is done in the database.'
      });
    }

    // Exactly one column, named explicitly. Refusing both together keeps the
    // one-fact-per-request shape the whole endpoint is built on, and keeps the
    // response able to say what happened in one sentence.
    const naming = WRITABLE.filter(k => Object.prototype.hasOwnProperty.call(body, k));
    if (naming.length === 0) {
      return fail(400, 'Nothing to change', {
        detail: 'Send employeeId to assign the seat, or maxWage to set its position rate.'
      });
    }
    if (naming.length > 1) {
      return fail(400, 'One change at a time: ' + naming.join(' and '), {
        detail: 'Who is in a seat and what the seat is budgeted at are separate facts. ' +
                'Send them as separate requests.'
      });
    }
    const op = naming[0];

    const wantedId = textOf(body.employeeId);
    if (op === 'employeeId' && wantedId && !UUID_RE.test(wantedId)) {
      return fail(400, 'employeeId must be an employee UUID, or empty to vacate the seat.');
    }

    // The position rate, parsed the way somebody types one: 45, 45.00, $45.00,
    // '45.5'. Three outcomes and each gets its own sentence, because each has a
    // different remedy — the same shape as parseRate in the browser and
    // wage-edit-lib on the server.
    let nextMax;
    if (op === 'maxWage') {
      const raw = String(body.maxWage == null ? '' : body.maxWage).replace(/[$,\s]/g, '');
      if (raw === '') {
        // A seat with no ceiling is a real state — the read has always tolerated
        // a null max_wage and the page shows a dash for it and for the variance.
        // So clearing is allowed, unlike clearing an hourly rate, which
        // wage_history cannot record.
        nextMax = null;
      } else {
        const n = Number(raw);
        if (!isFinite(n)) {
          return fail(400, `"${String(body.maxWage).trim()}" is not a position rate`, {
            detail: 'Enter an hourly figure, e.g. 45.00, or clear it to leave the seat with no ceiling.'
          });
        }
        if (n < 0) {
          return fail(400, 'A position rate cannot be negative', {
            detail: 'Clear the field to leave the seat with no ceiling.'
          });
        }
        if (n > MAX_CEILING) {
          return fail(400, `${n} is too high to be an hourly position rate`, {
            detail: `Position rates are hourly, so anything above ${MAX_CEILING} is almost ` +
                    'certainly an annual figure or a misplaced decimal point. Nothing was changed.'
          });
        }
        nextMax = Math.round(n * 100) / 100;
      }
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

      // ---- the position rate ----
      //
      // Handled first and returns on its own, so the assignment path below is
      // untouched by it. `max_wage` needs none of what that path does: there is
      // no roster to validate against, nobody to be seated twice, and no `name`
      // to carry along.
      if (op === 'maxWage') {
        const currentMax = seat.max_wage == null ? null : Number(seat.max_wage);
        // Compared as numbers, so re-saving 45 over a stored 45.00 is not a
        // change and does not stamp updated_at.
        const same = (currentMax == null && nextMax == null) ||
                     (currentMax != null && nextMax != null && Math.abs(currentMax - nextMax) < 0.005);
        const byIdNow = await employeesById();
        if (same) {
          return { statusCode: 200, headers,
                   body: JSON.stringify({ ok: true, seat: shapeSeat(seat, byIdNow, true), unchanged: true }) };
        }
        // HISTORY FIRST. If this throws, the update below never runs and the
        // caller is told the change was not recorded — see the catch at the
        // foot of this try, which turns a missing table into a 503 naming the
        // file to run.
        await recordChange({
          seat, field: 'max_wage',
          previousValue: currentMax, newValue: nextMax,
          previousDisplay: currentMax == null ? null : currentMax.toFixed(2),
          newDisplay: nextMax == null ? null : nextMax.toFixed(2),
          changedBy: session.email
        });
        const updatedMax = await db.update(TABLE, id, { max_wage: nextMax });
        const maxRow = (Array.isArray(updatedMax) ? updatedMax[0] : updatedMax)
          || { ...seat, max_wage: nextMax };
        return { statusCode: 200, headers,
                 body: JSON.stringify({
                   ok: true,
                   seat: shapeSeat(maxRow, byIdNow, true),
                   // What it was, so the page can report the move rather than
                   // just the new figure. A ceiling has no history table; this
                   // response is the only place the previous value is stated.
                   previousMaxWage: currentMax
                 }) };
      }

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

      // HISTORY FIRST, as above. The occupant is recorded as well as the
      // ceiling: it is the other write this endpoint has, a seat's occupant
      // moving is as much a change to the plan, and a table called
      // economics_history that silently covered half the writes would be worse
      // than none — a reader would conclude nothing else had changed.
      //
      // The DISPLAY is the name, because that is what the change meant to a
      // person. A vacancy is null in both, not the string 'vacant': the column
      // means "none" when empty, and a sentinel would sort and group as a
      // person called vacant.
      const previousOccupant = seat.employee_id
        ? ((await employeesById()).get(String(seat.employee_id)) || null)
        : null;
      await recordChange({
        seat, field: 'employee_id',
        previousValue: seat.employee_id || null, newValue: nextId,
        previousDisplay: previousOccupant ? previousOccupant.name : (textOf(seat.name) || null),
        newDisplay: emp ? emp.name : null,
        changedBy: session.email
      });

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
      // The history table gets its own answer, and it has to be checked FIRST:
      // a missing economics_history and a missing economics both look like a
      // missing table to PostgREST, and reporting "the plan does not exist"
      // when the plan is fine would send somebody looking in the wrong place.
      if (/economics_history/i.test(String((err && err.message) || ''))) {
        return fail(503, HISTORY_MIGRATION_HINT, { historyMissing: true });
      }
      if (isMissingTableError(err)) return fail(503, MIGRATION_HINT);
      if (isMissingColumnError(err)) return fail(503, FK_MIGRATION_HINT);
      throw err;
    }

  } catch (err) {
    console.error('economics error:', err.message);
    return fail(500, err.message);
  }
};
