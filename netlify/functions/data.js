const db = require('./db');
const { verifySession, getCookies } = require('./session-lib');
const perms = require('./permissions-lib');

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
// PHASE D PUTS IT BACK, READ-ONLY AND GATED. Two separate restrictions, and
// both are enforced below rather than by anybody remembering:
//
//   READ_ONLY_TABLES     every write method is 405 here, so the delete-and-
//                        replace path that got it removed cannot come back by
//                        somebody adding a table to the allowlist and not
//                        noticing PUT exists.
//   SALARIES_ONLY_TABLES a GET requires the salaries tier. max_wage is a
//                        budgeted ceiling per seat, and the page that reads it
//                        puts that ceiling next to a named person's rate. That
//                        is a compensation view, whatever the individual
//                        columns are.
const ALLOWED_TABLES = new Set(['employees', 'overtime', 'points', 'economics']);

// Readable through this endpoint, never writable through it. Checked before the
// method dispatch, so it covers POST, PATCH, DELETE and PUT together — listing
// a table here is the whole statement, with nothing to keep in sync.
const READ_ONLY_TABLES = new Set(['economics']);

// A GET here needs the salaries tier. Unlike the employees projection, which
// narrows a row, this is all-or-nothing: every column of the table is part of
// the same compensation view, so there is no useful subset to hand somebody
// without the tier.
const SALARIES_ONLY_TABLES = new Set(['economics']);

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
        // Said plainly, because the two refusals have different remedies and a
        // generic "forbidden" would send somebody looking for the wrong one.
        detail: refused.includes('wage')
          ? 'Hourly rates come from the daily payroll file and are overwritten every ' +
            'morning; nothing in the app may set them. Other refused columns require ' +
            'a permission tier this account does not hold.'
          : 'This column requires a permission tier this account does not hold.'
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
    // Read-only tables. BEFORE the method dispatch on purpose: one check covers
    // POST, PATCH, DELETE and PUT together, so a method added to this handler
    // later is refused here by default rather than by somebody remembering.
    if (READ_ONLY_TABLES.has(table) && method !== 'GET') {
      return {
        statusCode: 405, headers,
        body: JSON.stringify({
          error: `${table} is read-only through this endpoint`,
          detail: 'It is reference data maintained in the database. The write path was removed ' +
                  'because PUT here replaces the whole table, and nothing in the app writes it.'
        })
      };
    }

    // Tables whose every column is part of a compensation view. Unlike the
    // employees projection, which narrows a row, this is all-or-nothing: there
    // is no useful subset of a staffing plan to hand somebody without the tier.
    if (SALARIES_ONLY_TABLES.has(table) && !perms.has(await callerTiers(), perms.TIER_SALARIES)) {
      return {
        statusCode: 403, headers,
        body: JSON.stringify({
          error: `Not permitted to read ${table}`,
          detail: 'This needs the salaries tier. An administrator can grant it under Settings → Access.'
        })
      };
    }

    // GET /api/data?table=employees|overtime|points|economics
    if (method === 'GET' && table) {
      let orderBy = '';
      if (table === 'employees') orderBy = '?order=name.asc';
      if (table === 'overtime') orderBy = '?order=ot_type.asc,hours.asc';
      if (table === 'points') orderBy = '?order=points.desc';
      if (table === 'economics') orderBy = '?order=num.asc';
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
      const row = await db.insert(table, gated.body);
      return { statusCode: 200, headers, body: JSON.stringify({ data: row }) };
    }

    // PATCH /api/data?table=employees&id=uuid — update single row
    if (method === 'PATCH' && table && params.id) {
      const body = JSON.parse(event.body || '{}');
      const gated = gateWrite(table, body, table === 'employees' ? await callerTiers() : null);
      if (gated.error) return gated.error;
      const row = await db.update(table, params.id, gated.body);
      return { statusCode: 200, headers, body: JSON.stringify({ data: row }) };
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
