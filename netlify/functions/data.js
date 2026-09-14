const db = require('./db');
const { verifySession, getCookies } = require('./session-lib');
const perms = require('./permissions-lib');
const { planWageEdit } = require('./wage-edit-lib');
const { carriesPay, payRefusal, PAY_COLUMNS } = require('./pay-scope-lib');

// Tables this endpoint may touch. Until now `table` came off the query string
// and went straight through to PostgREST, so any signed-in user could read any
// table by URL — wage_history is a complete compensation history by design,
// daily_hours carries per-person earnings, processed_emails carries mailbox
// subjects. The app only ever asks for these four.
//
// The read was not the worst of it. PUT maps to db.replaceAll, which DELETEs
// every row in the table before inserting, so `PUT /api/data?table=daily_hours`
// with an empty rows array would have emptied the table.
//
// `economics` came OFF this list in Phase C, because leaving it allowlisted
// meant a signed-in caller could PUT it — delete-and-replace against the only
// record of a per-seat rate ceiling, with no screen that would show it had been
// emptied.
//
// PHASE D BROUGHT THE PAGE BACK AND THE TABLE DID NOT COME BACK HERE WITH IT.
// It briefly did: while Staffing Economics was read-only, `economics` sat on
// this list behind a READ_ONLY_TABLES exception. The moment seat assignment had
// to be editable that stopped being the right shape — a generic table endpoint
// with a per-table exception list is one edit away from re-exposing the
// delete-and-replace path that got the table removed in the first place.
//
// So the table has ONE owner: /api/economics, which serves the read and the one
// write that exists (assign a person to a seat: one column, one row, no
// replace-all). Nothing about `economics` is reachable through this endpoint,
// which is a stronger statement than "read-only here" and needs no machinery to
// hold. The exception Sets are gone with it rather than left empty.
const ALLOWED_TABLES = new Set(['employees', 'overtime', 'points']);

// An explicit projection, not a denylist. A column added to `employees` later
// is excluded until somebody deliberately lists it here, which is the right
// default for a table that holds compensation.
//
// annual_salary is the reason this exists. Without a select, PostgREST returns
// every column, so the salary would sit in the roster payload of every
// signed-in user's browser whether or not anything rendered it. It is no longer
// absent unconditionally — Phase D put the salaries tier behind it — but the
// mechanism is unchanged and still the point: what a caller may not read is
// never NAMED in the query, so it does not cross the wire even once.
//
// PHASE D: THE LIST NO LONGER LIVES HERE. permissions-lib.js is the one place
// that decides who may see and write which columns, and the projection is built
// from it per request out of the caller's tiers — see projectionsFor below. A
// reader without the salaries tier gets a select that does not name
// annual_salary at all: absent from the QUERY, not merely filtered out of the
// answer, so the column never crosses the wire even once.
//
// The three hardcoded lists that used to sit here are gone rather than kept
// alongside it. A second copy of a permission list is not redundancy, it is a
// pair of lists that will disagree, and the one that loses the argument is
// whichever the next edit happens to touch.

// Second layer, and it earns its keep. The projection above is what SHOULD keep
// annual_salary out of the payload, but it is a single string in a single place:
// one future edit — a select passed through from the query string, a helper that
// forgets it — and the salary is in every browser again. Picking the response
// apart against the same list makes the guarantee structural rather than
// dependent on the request staying correct. One list governs both, so they
// cannot drift.
function pickColumns(rows, columns) {
  if (!Array.isArray(rows)) return rows;
  return rows.map(row => {
    const out = {};
    for (const col of columns) if (col in row) out[col] = row[col];
    return out;
  });
}

// THE WRITE RESPONSE IS A READ, and it was not projected like one.
//
// db.js sends `Prefer: return=representation`, so PostgREST answers every POST
// and PATCH with the whole row — every column, annual_salary included. The GET
// path is projected twice over (a select= built from the caller's tiers, then
// picked apart again against the same list); the write path handed the row
// straight back. So a base-tier account could read any salary by PATCHing the
// employee's phone number to its current value and reading the response.
//
// Found 2026-09-14 while adding the cost-class scope below, which needed to
// read annual_salary server-side to clear it and would have widened the same
// hole. The projection is the one perms already computes for the GET, so the
// two directions cannot disagree about what this caller may see.
function projectEmployeeWrite(rows, tiers) {
  const columns = perms.employeeReadColumns(tiers);
  if (Array.isArray(rows)) return pickColumns(rows, columns);
  if (!rows || typeof rows !== 'object') return rows;
  return pickColumns([rows], columns)[0];
}

function isUndefinedColumnError(message) {
  return /\b42703\b|does not exist|could not find/i.test(String(message || ''));
}

// The projection ladder, built FROM the caller's permitted columns.
//
// Built from, not intersected with. The first version of this filtered the
// hardcoded projection list down to what the tiers allowed — which can
// only ever REMOVE columns, so annual_salary (never in that list) could not
// appear for anybody, tier or no tier. The permitted set has to be the source
// and the rungs have to subtract from it.
//
// Each rung drops exactly what the rung above it added, so a database missing
// one migration costs the screens that use those columns and nothing else. The
// order is newest-migration-first: Phase D's hire_date does not exist until
// SCHEMA_PHASE_D_PERMISSIONS.sql runs, and without its own rung the full
// projection would 400 and fall all the way through to pre-Phase-B, quietly
// taking `position` and the addresses with it.
const PHASE_D_COLUMNS = ['hire_date'];
const PHASE_B_COLUMNS = ['position', 'address_street', 'address_city', 'address_state', 'address_postal_code'];
const V2_COLUMNS      = ['pay_type', 'cost_class', 'position_group', 'annual_salary'];

function projectionsFor(tiers) {
  const without = (cols, drop) => cols.filter(c => !drop.includes(c));

  const full      = perms.employeeReadColumns(tiers);
  const preD      = without(full, PHASE_D_COLUMNS);
  const prePhaseB = without(preD, PHASE_B_COLUMNS);
  const preV2     = without(prePhaseB, V2_COLUMNS);

  return [
    { columns: full, missing: null },
    {
      columns: preD,
      missing: 'employees has no hire_date column — run SCHEMA_PHASE_D_PERMISSIONS.sql. ' +
               'Nothing reads it yet, so this costs nothing today.'
    },
    {
      columns: prePhaseB,
      missing: 'employees is missing the Phase B columns (position, address_*) — run ' +
               'SCHEMA_PHASE_B_POSITION.sql. The profile card will show no position and no address.'
    },
    {
      columns: preV2,
      missing: 'employees is missing the v2 columns — run SCHEMA_V2_MODEL.sql. Falling back ' +
               'to the pre-v2 projection.'
    }
  ];
}

// The write gate.
//
// REFUSES, it does not silently drop. A 200 for a write that discarded half the
// body reports success for something that did not happen, which is how somebody
// comes to believe a salary was recorded. The response names the columns.
//
// Only `employees` is gated by column: it is the table that holds compensation.
// overtime and points carry no pay and are left as they were.
function gateWrite(table, body, tiers) {
  if (table !== 'employees') return { body };

  const { permitted, refused } = perms.partitionWrite(body, tiers);
  if (!refused.length) return { body: permitted };

  return {
    error: {
      statusCode: 403,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        error: 'Not permitted to write: ' + refused.join(', '),
        refused,
        detail: 'This column requires a permission tier this account does not hold.'
      })
    }
  };
}

async function queryEmployees(tiers) {
  let lastErr = null;

  // Built ONCE, and indexed by position. projectionsFor returns fresh objects
  // every call, so asking a second copy of the ladder for indexOf(rung) finds
  // nothing, returns -1, and lands on rung 0 — whose `missing` is null. The
  // effect was not a crash but a silence: the console warning naming the
  // migration that had not been run would never have printed.
  const ladder = projectionsFor(tiers);

  for (let i = 0; i < ladder.length; i++) {
    const rung = ladder[i];
    try {
      const rows = await db.query('employees', `?select=${rung.columns.join(',')}&order=name.asc`);
      return pickColumns(rows, rung.columns);
    } catch (err) {
      if (!isUndefinedColumnError(err.message)) throw err;
      lastErr = err;
      const next = ladder[i + 1];
      if (next && next.missing) console.warn(next.missing);
    }
  }

  throw lastErr;
}

// ------------------------------------------------------------------------
// employees.wage — the one column on this endpoint that leaves a record
// ------------------------------------------------------------------------
//
// Phase D refused `wage` for every tier because BBSI overwrote it nightly. That
// stopped being true on 2026-08-22: the daily file's rate was a hand
// transcription nobody maintains any more, the import no longer reads it, and
// employees.wage is the record of truth behind every dollar this system
// computes. So it is writable, at the base tier, by anybody signed in.
//
// Writable, NOT quietly writable. Every move is recorded in wage_history, which
// is append-only at the database, and the history row goes in FIRST — before
// the update that makes the old rate unrecoverable. That is the same ordering
// applyWageSync uses for the import, for the same reason.
//
// wage_history is deliberately absent from ALLOWED_TABLES, so this is the only
// way it is ever written from a browser and there is no request that can write
// the rate without it.

const hasWage = body => body && Object.prototype.hasOwnProperty.call(body, 'wage');

// ------------------------------------------------------------------------
// employees.annual_salary — the OTHER compensation column, and the cost-class
// rule that now governs both
// ------------------------------------------------------------------------
//
// The salaries tier decides WHO may write a salary. pay-scope-lib decides
// whether the column applies to this PERSON at all: only the Manufacturing cost
// class carries compensation since 2026-09-14, because SG&A and Mill Overhead
// are no longer analysed here and pay nothing reads is a liability with no
// benefit.
//
// The two questions are answered in that order and by different files on
// purpose — a tier that let somebody write a salary onto an SG&A row would be
// answering a question it was never asked.
//
// annual_salary has no history table, so a refusal here is the only protection
// the column gets. It is a 409 rather than a 403 for the same reason a wage
// refusal is: the request is well-formed and the caller is permitted, and what
// makes it impossible is the state of the row.
const hasSalary = body => body && Object.prototype.hasOwnProperty.call(body, 'annual_salary');
const hasCostClass = body => body && Object.prototype.hasOwnProperty.call(body, 'cost_class');

const scopeRefusal = (headers, employee, column) => ({
  statusCode: 409, headers, body: JSON.stringify(payRefusal(employee, column))
});

// Reads a value as "a pay figure is being set" rather than "the column is being
// mentioned". Clearing is always allowed — it is what a reclassification does,
// and refusing to let somebody remove pay from a person who may not hold it
// would be the rule pointing the wrong way.
const isSetting = value => value !== null && value !== undefined && String(value).trim() !== '';

// Refusals from planWageEdit are 409, not 400: the request is well-formed and
// permitted, and what makes it impossible is the state of the row (salaried, no
// employee number, nothing to record a cleared rate with). The message is meant
// to be shown to the person who typed it, so it says what to fix.
const wageRefusal = (headers, plan) => ({
  statusCode: 409, headers,
  body: JSON.stringify({ error: plan.error, detail: plan.detail })
});

async function recordWageHistory(row) {
  // POST directly rather than through db.insert so a failure here is
  // distinguishable in the log from a failure writing the employee.
  await db.insert('wage_history', row);
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  const session = verifySession(getCookies(event).sfp_session || '');
  if (!session) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };

  // Resolved LAZILY and at most once per request. Two reasons it is not
  // resolved up front: a request the table allowlist is about to refuse should
  // not cost a permissions round-trip first, and the tables that carry no pay
  // never need the answer at all.
  let tiersPromise = null;
  const callerTiers = () => (tiersPromise || (tiersPromise = perms.fetchTiers(session.email, db)));

  const method = event.httpMethod;
  const params = event.queryStringParameters || {};
  const table = params.table;

  // Checked before the method dispatch, so it covers the writes too.
  if (table && !ALLOWED_TABLES.has(table)) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        error: `Table not available through this endpoint: ${table}`,
        allowed: [...ALLOWED_TABLES]
      })
    };
  }

  try {
    // GET /api/data?table=employees|overtime|points
    if (method === 'GET' && table) {
      let orderBy = '';
      if (table === 'employees') orderBy = '?order=name.asc';
      if (table === 'overtime') orderBy = '?order=ot_type.asc,hours.asc';
      if (table === 'points') orderBy = '?order=points.desc';
      const rows = table === 'employees'
        ? await queryEmployees(await callerTiers())
        : await db.query(table, orderBy);
      return { statusCode: 200, headers, body: JSON.stringify({ data: rows }) };
    }

    // POST /api/data?table=employees — insert single row
    if (method === 'POST' && table) {
      const body = JSON.parse(event.body || '{}');
      const gated = gateWrite(table, body, table === 'employees' ? await callerTiers() : null);
      if (gated.error) return gated.error;

      // A new person created WITH a rate. The app's Add form has no rate field,
      // so this is the hand-crafted case — and it is exactly the case that must
      // not slip a rate in without a history row. Planned against an empty row
      // so the refusals (salaried, no employee number, blank, zero) all apply
      // and previous_rate is null, which is what a first observation is.
      // A salary on a new row is scoped against the cost class being created
      // with it. There is no stored row to consult — the body IS the row.
      if (table === 'employees' && hasSalary(gated.body) && isSetting(gated.body.annual_salary)
          && !carriesPay(gated.body)) {
        return scopeRefusal(headers, gated.body, 'annual_salary');
      }

      let wagePlan = null;
      if (table === 'employees' && hasWage(gated.body)) {
        wagePlan = planWageEdit({
          employee: { id: 'pending', name: gated.body.name, wage: null,
                      employee_number: gated.body.employee_number,
                      pay_type: gated.body.pay_type,
                      // Rule 7 needs the class the row is being created in.
                      // Absent here, every Add would read as unclassified and
                      // be refused — including a production hire typed with a
                      // rate in the same form.
                      cost_class: gated.body.cost_class },
          value: gated.body.wage,
          editorEmail: session.email
        });
        if (!wagePlan.ok) return wageRefusal(headers, wagePlan);
        gated.body.wage = wagePlan.wage;
      }

      const row = await db.insert(table, gated.body);

      // History AFTER the insert here, and only here: the row it references
      // does not have an id until the insert returns. Same order, and the same
      // reason, as applyWageSync's create op.
      //
      // db.insert returns what PostgREST returns, which is an ARRAY even for a
      // single row — reading .id off it directly is undefined, and the history
      // row would silently never be written.
      if (wagePlan && !wagePlan.unchanged) {
        const created = Array.isArray(row) ? row[0] : row;
        if (!created || !created.id) {
          throw new Error('The employee insert returned no row, so the rate could not be recorded.');
        }
        await recordWageHistory({ ...wagePlan.history, employee_id: created.id });
      }
      const payload = table === 'employees'
        ? projectEmployeeWrite(row, await callerTiers())
        : row;
      return { statusCode: 200, headers, body: JSON.stringify({ data: payload }) };
    }

    // PATCH /api/data?table=employees&id=uuid — update single row
    if (method === 'PATCH' && table && params.id) {
      const body = JSON.parse(event.body || '{}');
      const gated = gateWrite(table, body, table === 'employees' ? await callerTiers() : null);
      if (gated.error) return gated.error;

      // The row as the DATABASE has it, not as the browser remembers it. A page
      // open since this morning holds a rate somebody else may have changed
      // since, and a history row whose previous_rate was never the current rate
      // is worse than no history at all. Read ONCE and shared by the three
      // decisions below, all of which need the same row.
      let found = null;
      if (table === 'employees'
          && (hasWage(gated.body) || hasSalary(gated.body) || hasCostClass(gated.body))) {
        const rows = await db.query('employees',
          `?id=eq.${encodeURIComponent(params.id)}` +
          `&select=id,name,employee_number,wage,pay_type,cost_class,annual_salary`);
        found = (rows || [])[0] || null;
      }

      // THE CLASS THIS ROW WILL BE IN WHEN THE WRITE LANDS, not the one it is in
      // now. A single PATCH can carry both the reclassification and the pay, and
      // scoping against the stored class would judge the write by a fact it is
      // itself changing — in both directions: it would refuse a rate on somebody
      // being moved INTO Manufacturing, and accept one on somebody being moved
      // out.
      const nextCostClass = hasCostClass(gated.body)
        ? { cost_class: gated.body.cost_class, name: (found && found.name) || gated.body.name }
        : found;

      if (table === 'employees' && hasSalary(gated.body) && isSetting(gated.body.annual_salary)
          && !carriesPay(nextCostClass)) {
        return scopeRefusal(headers, nextCostClass || gated.body, 'annual_salary');
      }

      if (table === 'employees' && hasWage(gated.body)) {
        const plan = planWageEdit({
          // Scoped against the class this write lands in, for the reason above.
          employee: found
            ? { ...found, ...(hasCostClass(gated.body) ? { cost_class: gated.body.cost_class } : {}) }
            : null,
          value: gated.body.wage,
          editorEmail: session.email
        });
        if (!plan.ok) return wageRefusal(headers, plan);

        if (plan.unchanged) {
          // The same rate, retyped. Dropping it from the body rather than
          // writing it keeps wage_history free of rows saying a rate moved when
          // it did not — and the rest of the PATCH still goes through.
          delete gated.body.wage;
        } else {
          // History FIRST. If this throws, the catch below turns it into a 500
          // and the wage update never runs: an overwrite with no history is the
          // one outcome that cannot be repaired afterwards.
          await recordWageHistory(plan.history);
          gated.body.wage = plan.wage;
        }

        // A PATCH whose only column was an unchanged wage has nothing left to
        // write. db.update with an empty body is a request that changes nothing
        // and returns nothing useful, so answer from the row already read.
        if (!Object.keys(gated.body).length) {
          // Projected, because `found` was read with the service key and carries
          // every column — including the one this caller may not see.
          return {
            statusCode: 200, headers,
            body: JSON.stringify({ data: projectEmployeeWrite(found, await callerTiers()) })
          };
        }
      }

      // RECLASSIFYING SOMEBODY OUT OF MANUFACTURING TAKES THEIR PAY WITH IT,
      // and the app does it rather than asking the caller to.
      //
      // Appended AFTER the tier gate on purpose. The rule belongs to the
      // application, not to the caller: a supervisor with no salaries tier must
      // be able to move somebody to SG&A, and requiring them to send
      // annual_salary: null to do it would 403 them for obeying the rule. They
      // are not writing a salary — they are writing a cost class, and this is
      // what that means.
      //
      // Deliberately unrecorded in wage_history: that table's `rate` is NOT
      // NULL, so a removal cannot be expressed in it at all, and the last row it
      // holds stays the record of what the rate was. Compare rule 4 in
      // wage-edit-lib — a rate cannot be CLEARED by typing an empty box, which
      // is a different act from a reclassification that makes the column
      // inapplicable.
      if (table === 'employees' && hasCostClass(gated.body) && !carriesPay(nextCostClass) && found) {
        for (const col of PAY_COLUMNS) {
          if (found[col] !== null && found[col] !== undefined) gated.body[col] = null;
        }
      }

      const row = await db.update(table, params.id, gated.body);
      const updated = table === 'employees'
        ? projectEmployeeWrite(row, await callerTiers())
        : row;
      return { statusCode: 200, headers, body: JSON.stringify({ data: updated }) };
    }

    // DELETE /api/data?table=employees&id=uuid — delete single row
    if (method === 'DELETE' && table && params.id) {
      await db.remove(table, params.id);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    // PUT /api/data?table=overtime — replace entire table (for OT and Points batch saves)
    //
    // NOT employees, ever. replaceAll DELETES the table and re-inserts the body,
    // so a column gate is the wrong instrument here: refusing annual_salary in
    // the payload would still leave a request that drops every employee row and
    // rebuilds the roster from whatever the browser happened to be holding. The
    // gate on PATCH would be worth nothing next to a door like that.
    //
    // Nothing PUTs employees. Audited across the frontend: /api/data?table=
    // employees is used with GET, POST and PATCH only, and points is the sole
    // PUT caller. So this costs nothing and closes the one write path into the
    // compensation table that the column gate cannot cover.
    if (method === 'PUT' && table === 'employees') {
      return {
        statusCode: 405, headers,
        body: JSON.stringify({
          error: 'PUT is not allowed on employees',
          detail: 'This method replaces the whole table. Employee rows are written one ' +
                  'at a time with POST and PATCH.'
        })
      };
    }
    if (method === 'PUT' && table) {
      const body = JSON.parse(event.body || '{}');
      const rows = await db.replaceAll(table, body.rows || []);
      return { statusCode: 200, headers, body: JSON.stringify({ data: rows }) };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  } catch (err) {
    console.error('Data error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
