// Run with: npm test
//
// /api/data is the endpoint the whole frontend reads through, and it used to
// pass its `table` parameter straight to PostgREST. These tests pin the two
// things that fixed:
//
//   1. employees is fetched through an explicit projection, so a column added
//      to that table later — annual_salary being the one that prompted this —
//      is not in the payload until somebody deliberately lists it.
//   2. `table` is checked against an allowlist before the method dispatch, so
//      neither a read nor a write can reach a table the app does not use.
//
// Both mattered because every sequoiafp.com account had the same access:
// anything in the payload was readable by any employee with the app open.
//
// PHASE D CHANGED WHO, NOT HOW. There are tiers now, and the projection is
// built from the caller's own — but the mechanism these tests pin is unchanged
// and still the reason it works: a column the caller may not read is never
// NAMED in the query, so it does not cross the wire even once. The base tier is
// the default here, because it is what almost everybody holds and it is the
// case where a leak would matter.

const test = require('node:test');
const assert = require('node:assert');
const { createHmac } = require('node:crypto');

process.env.SESSION_SECRET = 'test-secret';
process.env.SUPABASE_URL = 'https://project.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

const data = require('../netlify/functions/data');

// A session cookie the handler will accept, built the way auth.js builds it.
function cookie(email = 'someone@sequoiafp.com') {
  const b64 = Buffer.from(JSON.stringify({ email, exp: Date.now() + 3600000 })).toString('base64url');
  const sig = createHmac('sha256', process.env.SESSION_SECRET).update(b64).digest('base64url');
  return `sfp_session=${b64}.${sig}`;
}

// Records every URL the handler asks Supabase for, and answers with `rows`.
//
// The user_permissions read that Phase D added is answered separately and is
// NOT recorded in `urls`. Every assertion in this file is about the data query
// the handler makes on the caller's behalf — how it is projected, whether the
// allowlist stopped it, how many times it retried — and folding an unrelated
// permissions lookup into those counts would make `urls[0]` mean something
// different depending on which gate ran first.
//
// `permissionGrants` defaults to none, so these tests exercise the BASE tier —
// which is the right default: it is what almost every user holds, and it is the
// case where annual_salary must be absent.
function stubFetch(rows = [], { fail = null, permissionGrants = [] } = {}) {
  const urls = [];
  global.fetch = async (url) => {
    const u = decodeURIComponent(String(url));
    if (u.includes('user_permissions')) {
      return { ok: true, status: 200,
               json: async () => permissionGrants,
               text: async () => JSON.stringify(permissionGrants) };
    }
    urls.push(u);
    if (fail) return { ok: false, status: 400, text: async () => fail, json: async () => ({ message: fail }) };
    return { ok: true, status: 200, json: async () => rows, text: async () => JSON.stringify(rows) };
  };
  return urls;
}

const get = (table, extra = {}) => data.handler({
  httpMethod: 'GET',
  headers: { cookie: cookie() },
  queryStringParameters: { table, ...extra }
});

// ============================================================
// The projection
// ============================================================

test('the employees read names its columns, and annual_salary is not one of them', async () => {
  const urls = stubFetch([]);
  const res = await get('employees');

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(urls.length, 1);

  const url = urls[0];
  assert.match(url, /employees\?select=/, 'no projection means PostgREST returns every column');
  assert.ok(!/annual_salary/.test(url), `annual_salary must not be requested: ${url}`);

  // The columns the frontend actually maps, so a projection that is too narrow
  // fails here rather than silently blanking a field in the app.
  for (const col of [
    'id', 'name', 'wage', 'dept', 'status', 'days',
    'clock_in', 'clock_out', 'break_1', 'break_2',
    'birthday', 'phone', 'language', 'email',
    'sms_opted_out', 'text_bolt', 'drive_folder_id',
    'employee_number', 'department', 'pay_type', 'cost_class', 'position_group'
  ]) {
    assert.ok(new RegExp(`\\b${col}\\b`).test(url), `projection is missing ${col}`);
  }
});

test('annual_salary never reaches the response body, even if the database returns it', async () => {
  // Belt and braces: if the row somehow carries the column, assert on what the
  // caller actually receives rather than only on what was requested.
  stubFetch([{ id: '1', name: 'A B', wage: '24.50', annual_salary: 104000 }]);
  const res = await get('employees');
  const body = res.body;

  assert.ok(!/annual_salary/.test(body), 'annual_salary key is in the response');
  assert.ok(!/104000/.test(body), 'the salary VALUE is in the response');
});

// ---------------------------------------------------------------------------
// BOTH DIRECTIONS OF THE GATE
// ---------------------------------------------------------------------------
//
// Every assertion above is of the form "annual_salary must not appear". A gate
// that refuses EVERYBODY satisfies all of them — the projection could be
// hardcoded to drop the column for every tier, or resolveTiers could return the
// base set unconditionally, and this file would stay green while the salaries
// grant silently did nothing.
//
// That is not hypothetical here. There is a comment at data.js:81 recording
// that the first version of projectionsFor INTERSECTED a hardcoded list with the
// permitted set, which can only ever REMOVE columns — so annual_salary, never in
// that list, could not appear for anybody who held the tier. The bug shipped and
// was found by hand.
//
// So: the same two assertions, inverted, for a caller who holds the grant.

const SALARIES_GRANT = [{ email: 'someone@sequoiafp.com', tier: 'salaries' }];

test('WITH the salaries tier the projection DOES name annual_salary', async () => {
  const urls = stubFetch([], { permissionGrants: SALARIES_GRANT });
  const res = await get('employees');

  assert.strictEqual(res.statusCode, 200);
  const url = urls[0];
  assert.match(url, /annual_salary/,
    'the grant does nothing if the column is never requested: ' + url);
  // and the rest of the projection is still there, so this is not a
  // salary-only select that broke everything else.
  for (const col of ['id', 'name', 'wage', 'department', 'cost_class']) {
    assert.ok(new RegExp(`\\b${col}\\b`).test(url), `projection lost ${col}`);
  }
});

test('WITH the salaries tier the value reaches the response body', async () => {
  // The partner to "never reaches the response body" above. pickColumns filters
  // the response against the same permitted list the query was built from, so
  // this proves the second layer lets it through rather than only that the
  // first one asked for it.
  stubFetch([{ id: '1', name: 'A B', wage: '24.50', annual_salary: 104000 }],
            { permissionGrants: SALARIES_GRANT });
  const res = await get('employees');

  assert.match(res.body, /annual_salary/);
  assert.match(res.body, /104000/);
});

test('a write of annual_salary without the tier is refused, and writes nothing', async () => {
  // Hiding the input on the card is the cosmetic half. This is the half that
  // holds: the refusal is a 403 naming the column, and no request reaches the
  // employees table at all — not a silent strip that would let the rest of the
  // body through while the caller believes the salary landed.
  for (const method of ['POST', 'PATCH']) {
    const urls = stubFetch([]);
    const res = await data.handler({
      httpMethod: method,
      headers: { cookie: cookie() },
      queryStringParameters: { table: 'employees', id: '00000000-0000-0000-0000-000000000000' },
      body: JSON.stringify({ name: 'A B', annual_salary: 250000 })
    });

    assert.strictEqual(res.statusCode, 403, `${method} was not refused`);
    assert.match(res.body, /annual_salary/, 'the refusal names the column');
    assert.deepStrictEqual(urls, [],
      `${method} still reached the database — the name would have been written`);
  }
});

test('WITH the tier that same write goes through', async () => {
  // The inverted half again. Without this, gateWrite could refuse everybody and
  // the test above would still pass.
  const urls = stubFetch([{ id: '1' }], { permissionGrants: SALARIES_GRANT });
  const res = await data.handler({
    httpMethod: 'PATCH',
    headers: { cookie: cookie() },
    queryStringParameters: { table: 'employees', id: '00000000-0000-0000-0000-000000000000' },
    body: JSON.stringify({ annual_salary: 250000 })
  });

  assert.strictEqual(res.statusCode, 200);
  assert.ok(urls.length > 0, 'the write never reached the database');
});

test('the two directions disagree, which is what makes either meaningful', async () => {
  // One test, both callers, same stubbed row. If this ever passes with the two
  // bodies identical, the tier is not being read at all.
  const row = [{ id: '1', name: 'A B', wage: '24.50', annual_salary: 104000 }];

  stubFetch(row);
  const base = (await get('employees')).body;

  stubFetch(row, { permissionGrants: SALARIES_GRANT });
  const withTier = (await get('employees')).body;

  assert.notStrictEqual(base, withTier, 'the salaries grant changed nothing');
  assert.ok(!/104000/.test(base));
  assert.ok(/104000/.test(withTier));
});

// The roster still renders an hourly rate per person, on the Employees tab. That
// predates this phase and is unchanged; what Manufacturing Costs stopped doing is
// rendering rates on a COSTING page, where the whole point is the aggregate.
// Removing wage from this projection is Phase D's job, with permissions.
test('wage is still returned — the roster renders it', async () => {
  const urls = stubFetch([]);
  await get('employees');
  assert.match(urls[0], /\bwage\b/);
});

// The projection degrades one rung at a time: full -> without the Phase B
// additions -> pre-v2. It used to be a single binary fallback, which meant one
// absent column (`position`, added to the live database by hand) dropped
// pay_type, cost_class and position_group out of the payload too and took the
// classification off every screen that reads it.
//
// `failFor` fails any request naming that column, so the stub does not have to
// count calls to know which rung it is on.
function stubFailingColumn(failFor) {
  const urls = [];
  global.fetch = async (url) => {
    const decoded = decodeURIComponent(String(url));
    // Same exclusion as stubFetch: the permissions lookup is not one of the
    // projection attempts these tests are counting.
    if (decoded.includes('user_permissions')) {
      return { ok: true, status: 200, json: async () => [], text: async () => '[]' };
    }
    urls.push(decoded);
    if (decoded.includes(failFor)) {
      return { ok: false, status: 400, text: async () => `column employees.${failFor} does not exist` };
    }
    return { ok: true, status: 200, json: async () => [], text: async () => '[]' };
  };
  return urls;
}

test('a database without the Phase B columns keeps the v2 classification', async () => {
  const urls = stubFailingColumn('position,');   // the trailing comma avoids position_group

  const res = await get('employees');
  assert.strictEqual(res.statusCode, 200, 'a missing Phase B column must not 500 the roster');
  // THREE attempts, not two. Phase D added a rung above the Phase B one for
  // hire_date, which does not exist until SCHEMA_PHASE_D_PERMISSIONS.sql runs.
  // Without its own rung a missing hire_date would drop straight past Phase B
  // and cost `position` and the addresses for everybody.
  assert.strictEqual(urls.length, 3, 'full, then without hire_date, then without the Phase B columns');
  assert.ok(/hire_date/.test(urls[0]) && /position,/.test(urls[0]));
  assert.ok(!/hire_date/.test(urls[1]) && /position,/.test(urls[1]), 'the first retry drops only hire_date');

  const landed = urls[2];
  assert.ok(!/address_street/.test(landed), 'the rung that lands drops the address columns');
  assert.ok(/pay_type/.test(landed), 'but KEEPS pay_type — this is the whole point of the middle rung');
  assert.ok(/cost_class/.test(landed) && /position_group/.test(landed), 'and the other two axes');
  assert.ok(!/annual_salary/.test(landed), 'and still never asks for annual_salary');
});

test('a database without the v2 columns falls all the way back rather than taking the app down', async () => {
  const urls = stubFailingColumn('pay_type');

  const res = await get('employees');
  assert.strictEqual(res.statusCode, 200, 'a missing v2 column must not 500 the roster');
  assert.strictEqual(urls.length, 4, 'one attempt per rung: full, pre-Phase-D, pre-Phase-B, pre-v2');

  const last = urls[urls.length - 1];
  assert.ok(!/pay_type/.test(last), 'the last attempt drops the v2 columns');
  assert.ok(!/address_street/.test(last) && !/,position,/.test(last + ','), 'and the Phase B ones');
  assert.ok(!/annual_salary/.test(last), 'and must still not ask for annual_salary');
});

test('an unrelated failure is not hidden behind a narrower read', async () => {
  const urls = stubFetch([], { fail: 'JWT expired' });
  const res = await get('employees');
  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(urls.length, 1, 'no pointless retry on an auth failure');
});

// ============================================================
// The allowlist
// ============================================================

test('the three tables the app uses are permitted', async () => {
  for (const table of ['employees', 'overtime', 'points']) {
    stubFetch([]);
    const res = await get(table);
    assert.strictEqual(res.statusCode, 200, `${table} should be allowed`);
  }
});

test('economics is not reachable through this endpoint at all, by any method', async () => {
  // It came off the allowlist in Phase C because PUT maps to db.replaceAll,
  // which deletes every row before inserting — over the only record of a
  // per-seat rate ceiling, with no screen that would show it had been emptied.
  //
  // Phase D brought the PAGE back and briefly put the table back here too,
  // read-only behind an exception list. Once seat assignment had to be
  // editable that stopped being the right shape: a generic table endpoint with
  // per-table exceptions is one edit away from re-exposing the write path. The
  // table now has one owner, /api/economics, and this endpoint does not know
  // about it — which needs no machinery to hold.
  for (const grants of [[], [{ email: 'someone@sequoiafp.com', tier: 'salaries' }],
                        [{ email: 'someone@sequoiafp.com', tier: 'admin' }]]) {
    for (const method of ['GET', 'PUT', 'POST', 'PATCH', 'DELETE']) {
      const urls = stubFetch([], { permissionGrants: grants });
      const res = await data.handler({
        httpMethod: method,
        headers: { cookie: cookie() },
        queryStringParameters: { table: 'economics', id: '00000000-0000-0000-0000-000000000000' },
        body: JSON.stringify({ rows: [] })
      });
      assert.strictEqual(res.statusCode, 400, `economics reachable via ${method}`);
      assert.strictEqual(urls.length, 0, `economics reached the database via ${method}`);
    }
  }
});

test('a table the app does not use is refused, and never reaches Supabase', async () => {
  for (const table of ['wage_history', 'daily_hours', 'processed_emails',
                       'employee_setup_tasks', 'employees_cleanup_snapshot', 'settings']) {
    const urls = stubFetch([]);
    const res = await get(table);
    assert.strictEqual(res.statusCode, 400, `${table} should be refused`);
    assert.strictEqual(urls.length, 0, `${table} reached the database anyway`);
    const body = JSON.parse(res.body);
    assert.match(body.error, new RegExp(table));
    assert.deepStrictEqual(body.allowed, ['employees', 'overtime', 'points']);
  }
});

test('the allowlist covers writes, not just reads', async () => {
  // PUT is the dangerous one: it maps to db.replaceAll, which deletes every row
  // in the table before inserting. An empty rows array would have emptied it.
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
    const urls = stubFetch([]);
    const res = await data.handler({
      httpMethod: method,
      headers: { cookie: cookie() },
      queryStringParameters: { table: 'daily_hours', id: '00000000-0000-0000-0000-000000000000' },
      body: JSON.stringify({ rows: [] })
    });
    assert.strictEqual(res.statusCode, 400, `${method} to an off-list table should be refused`);
    assert.strictEqual(urls.length, 0, `${method} reached the database anyway`);
  }
});

test('an unauthenticated caller is still refused before any of this', async () => {
  const urls = stubFetch([]);
  const res = await data.handler({
    httpMethod: 'GET', headers: {}, queryStringParameters: { table: 'employees' }
  });
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(urls.length, 0);
});
