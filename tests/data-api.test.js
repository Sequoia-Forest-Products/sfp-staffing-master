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
// Both matter because every sequoiafp.com account currently has full access:
// anything in the payload is readable by any employee with the app open.

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
function stubFetch(rows = [], { fail = null } = {}) {
  const urls = [];
  global.fetch = async (url) => {
    urls.push(decodeURIComponent(String(url)));
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
  assert.strictEqual(urls.length, 2, 'expected exactly one retry');

  assert.ok(!/address_street/.test(urls[1]), 'the retry drops the address columns');
  assert.ok(/pay_type/.test(urls[1]), 'but KEEPS pay_type — this is the whole point of the middle rung');
  assert.ok(/cost_class/.test(urls[1]) && /position_group/.test(urls[1]), 'and the other two axes');
  assert.ok(!/annual_salary/.test(urls[1]), 'and still never asks for annual_salary');
});

test('a database without the v2 columns falls all the way back rather than taking the app down', async () => {
  const urls = stubFailingColumn('pay_type');

  const res = await get('employees');
  assert.strictEqual(res.statusCode, 200, 'a missing v2 column must not 500 the roster');
  assert.strictEqual(urls.length, 3, 'one retry per rung: full, pre-Phase-B, pre-v2');

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

test('the four tables the app uses are permitted', async () => {
  for (const table of ['employees', 'economics', 'overtime', 'points']) {
    stubFetch([]);
    const res = await get(table);
    assert.strictEqual(res.statusCode, 200, `${table} should be allowed`);
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
    assert.deepStrictEqual(body.allowed, ['employees', 'economics', 'overtime', 'points']);
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
