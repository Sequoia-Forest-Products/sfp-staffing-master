// /api/economics — the staffing plan, and the one thing about it the app can change.
//
// The table has ONE owner. It is off the /api/data allowlist entirely, so this
// file is the complete surface: a GET and a PATCH that sets one column on one
// row. What is worth testing is everything it REFUSES, because the reason this
// endpoint is shaped the way it is, is a write path that deleted the whole table.

const test = require('node:test');
const assert = require('node:assert');
const { createHmac } = require('node:crypto');

process.env.SESSION_SECRET = 'test-session-secret';
process.env.SUPABASE_URL = 'https://example.invalid';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const payrollDb = require('../netlify/functions/payroll-db');
const api = require('../netlify/functions/economics');

const CALLER = 'peter.stroble@sequoiafp.com';
const SEAT_ID = '11111111-2222-3333-4444-555555555555';
const SEAT_2   = '22222222-3333-4444-5555-666666666666';

const SEATS = [
  { id: SEAT_ID, num: 1, section: 'Mill', seat: 'Millwright 1', name: null, max_wage: 38.5 },
  { id: SEAT_2,  num: 2, section: 'Mill', seat: 'Millwright 2', name: 'Ana Reyes', max_wage: 30 }
];

const EMPLOYEES = [
  { id: 'h1', name: 'Ana Reyes',        status: 'Active',   pay_type: 'Hourly',   wage: '36.00' },
  { id: 'h2', name: 'Bo Tran',          status: 'Active',   pay_type: 'Hourly',   wage: '33.25' },
  { id: 'x1', name: 'Inactive Person',  status: 'Inactive', pay_type: 'Hourly',   wage: '20.00' },
  { id: 's1', name: 'Sal Aried',        status: 'Active',   pay_type: 'Salaried', wage: '29.75' }
];

function cookie(email = CALLER) {
  const b64 = Buffer.from(JSON.stringify({ email, exp: Date.now() + 3600000 })).toString('base64url');
  return `sfp_session=${b64}.${createHmac('sha256', process.env.SESSION_SECRET).update(b64).digest('base64url')}`;
}

function stub(t, { tier = 'salaries', seats = SEATS, missingTable = false } = {}) {
  const real = payrollDb.fetchEmployees;
  t.after(() => { payrollDb.fetchEmployees = real; });
  payrollDb.fetchEmployees = async () => EMPLOYEES;

  const rows = seats.map(x => ({ ...x }));   // per-test, never shared
  const calls = [];
  const writes = [];
  global.fetch = async (url, opts = {}) => {
    const u = decodeURIComponent(String(url));
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: u, method, body });
    if (method !== 'GET') writes.push({ url: u, method, body });

    if (u.includes('user_permissions')) {
      const grants = tier ? [{ email: CALLER, tier }] : [];
      return { ok: true, status: 200, json: async () => grants, text: async () => JSON.stringify(grants) };
    }
    if (missingTable) {
      return { ok: false, status: 404,
               text: async () => 'PGRST205 could not find the table', json: async () => ({}) };
    }
    if (method === 'PATCH') {
      const id = (/id=eq\.([^&]+)/.exec(u) || [])[1];
      const row = rows.find(r => r.id === id);
      Object.assign(row, body);
      return { ok: true, status: 200, json: async () => [row], text: async () => JSON.stringify([row]) };
    }
    const wantId   = (/\bid=eq\.([^&]+)/.exec(u) || [])[1];
    const wantName = (/name=eq\.([^&]+)/.exec(u) || [])[1];
    const notId    = (/id=neq\.([^&]+)/.exec(u) || [])[1];
    const out = rows.filter(r =>
      (!wantId || r.id === wantId) && (!wantName || r.name === wantName) && (!notId || r.id !== notId));
    return { ok: true, status: 200, json: async () => out, text: async () => JSON.stringify(out) };
  };
  return { calls, writes, rows };
}

const call = (method, body, email = CALLER) => api.handler({
  httpMethod: method,
  headers: email ? { cookie: cookie(email) } : {},
  queryStringParameters: {},
  body: body === undefined ? undefined : JSON.stringify(body)
});

const json = (res) => JSON.parse(res.body);

// ---------------------------------------------------------------------------
// the gate
// ---------------------------------------------------------------------------

test('no session is 401, and nothing is read', async (t) => {
  const { calls } = stub(t);
  const res = await api.handler({ httpMethod: 'GET', headers: {}, queryStringParameters: {} });
  assert.strictEqual(res.statusCode, 401);
  assert.deepStrictEqual(calls, []);
});

test('the base tier cannot read the plan, and no seat is queried', async (t) => {
  const { calls } = stub(t, { tier: null });
  const res = await call('GET');
  assert.strictEqual(res.statusCode, 403);
  assert.ok(!calls.some(c => c.url.includes('economics')), 'refused before the query');
  // No ceiling reaches the caller in any form.
  assert.ok(!res.body.includes('38.5'));
  assert.ok(!res.body.includes('Millwright'));
});

test('the admin tier alone does not open it', async (t) => {
  stub(t, { tier: 'admin' });
  assert.strictEqual((await call('GET')).statusCode, 403);
});

test('the base tier cannot ASSIGN, and nothing is written', async (t) => {
  const { writes } = stub(t, { tier: null });
  const res = await call('PATCH', { id: SEAT_ID, name: 'Ana Reyes' });
  assert.strictEqual(res.statusCode, 403);
  assert.deepStrictEqual(writes, []);
});

test('with the tier the plan reads, in plan order', async (t) => {
  const { calls } = stub(t);
  const res = await call('GET');
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(json(res).seats.length, 2);
  // num.asc, because 'Utility 10' sorts before 'Utility 2' alphabetically and
  // the plan has an order of its own.
  assert.ok(calls.some(c => /order=num\.asc/.test(c.url)));
});

// ---------------------------------------------------------------------------
// what it refuses to write — the reason it exists
// ---------------------------------------------------------------------------

test('there is no method that replaces the table', async (t) => {
  const { writes } = stub(t);
  for (const method of ['PUT', 'POST', 'DELETE']) {
    const res = await call(method, { rows: [] });
    assert.strictEqual(res.statusCode, 405, method);
  }
  assert.deepStrictEqual(writes, [], 'no DELETE, no bulk insert, nothing');
});

test('only the assigned person is writable — the plan itself is refused', async (t) => {
  const { writes } = stub(t);
  for (const body of [{ id: SEAT_ID, max_wage: 999 },
                      { id: SEAT_ID, seat: 'Millwright 9' },
                      { id: SEAT_ID, section: 'Yard' },
                      { id: SEAT_ID, num: 42 },
                      { id: SEAT_ID, name: 'Ana Reyes', max_wage: 999 }]) {
    const res = await call('PATCH', body);
    assert.strictEqual(res.statusCode, 403, JSON.stringify(body));
    // Refused, not filtered: a 200 that silently dropped max_wage would report
    // a ceiling change that did not happen.
    assert.match(json(res).error, /Not permitted to write/);
  }
  assert.deepStrictEqual(writes, []);
});

test('a seat is named by id, never by its title', async (t) => {
  const { writes } = stub(t);
  const res = await call('PATCH', { id: 'Millwright 1', name: 'Ana Reyes' });
  assert.strictEqual(res.statusCode, 400);
  assert.match(json(res).error, /UUID/);
  assert.deepStrictEqual(writes, []);
});

test('an unknown seat is 404 rather than a silent no-op', async (t) => {
  const { writes } = stub(t);
  const res = await call('PATCH', { id: '99999999-9999-9999-9999-999999999999', name: 'Ana Reyes' });
  assert.strictEqual(res.statusCode, 404);
  assert.deepStrictEqual(writes, []);
});

// ---------------------------------------------------------------------------
// who may fill a seat
// ---------------------------------------------------------------------------

test('a name that is not on the roster is refused', async (t) => {
  // economics.name is free text, and free text is how 'Tim Green' and
  // 'Timothy Green' became two people earlier in this project.
  const { writes } = stub(t);
  const res = await call('PATCH', { id: SEAT_ID, name: 'Timothy Green' });
  assert.strictEqual(res.statusCode, 400);
  assert.match(json(res).error, /not an active hourly employee/);
  assert.deepStrictEqual(writes, []);
});

test('an inactive person cannot be seated', async (t) => {
  const { writes } = stub(t);
  assert.strictEqual((await call('PATCH', { id: SEAT_ID, name: 'Inactive Person' })).statusCode, 400);
  assert.deepStrictEqual(writes, []);
});

test('a salaried person cannot be seated — they have no rate to bring', async (t) => {
  // Note the fixture: Sal Aried still carries 29.75 in wage. pay_type is the
  // fact, so the leftover number must not make them look seatable.
  const { writes } = stub(t);
  const res = await call('PATCH', { id: SEAT_ID, name: 'Sal Aried' });
  assert.strictEqual(res.statusCode, 400);
  assert.match(json(res).detail, /no hourly rate/);
  assert.deepStrictEqual(writes, []);
});

test('the stored name is canonicalised from the roster, not taken as typed', async (t) => {
  const { writes } = stub(t);
  const res = await call('PATCH', { id: SEAT_ID, name: '  ana REYES ' });
  assert.strictEqual(res.statusCode, 200);
  const [w] = writes;
  assert.deepStrictEqual(w.body, { name: 'Ana Reyes' }, 'exactly one column, canonical value');
  assert.strictEqual(json(res).seat.name, 'Ana Reyes');
});

test('an empty name vacates the seat, and that is a real instruction', async (t) => {
  const { writes } = stub(t, { seats: [{ ...SEATS[0], name: 'Ana Reyes' }, SEATS[1]] });
  const res = await call('PATCH', { id: SEAT_ID, name: '' });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(writes[0].body, { name: null }, 'null, not the empty string');
  assert.strictEqual(json(res).seat.name, null);
});

test('assigning the person already there writes nothing at all', async (t) => {
  const { writes } = stub(t);
  const res = await call('PATCH', { id: SEAT_2, name: 'Ana Reyes' });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(json(res).unchanged, true);
  assert.deepStrictEqual(writes, [],
    'an idempotent click must not stamp an updated_at or read as a change in an audit');
});

test('a second seat for the same person goes through, and the response says where', async (t) => {
  const { writes } = stub(t);
  const res = await call('PATCH', { id: SEAT_ID, name: 'Ana Reyes' });
  assert.strictEqual(res.statusCode, 200);
  // Allowed, because refusing would make a straight swap impossible without
  // unassigning first. Reported, because it is always a plan error.
  assert.deepStrictEqual(json(res).alsoIn, ['Millwright 2']);
  assert.strictEqual(writes.length, 1, 'and only the seat that was named is touched');
  assert.match(writes[0].url, new RegExp('id=eq\\.' + SEAT_ID));
});

test('a vacated seat reports no duplicates rather than looking them up', async (t) => {
  const { calls } = stub(t, { seats: [{ ...SEATS[0], name: 'Ana Reyes' }, SEATS[1]] });
  const res = await call('PATCH', { id: SEAT_ID, name: '' });
  assert.deepStrictEqual(json(res).alsoIn, []);
  assert.ok(!calls.some(c => /name=eq\./.test(c.url)), 'nobody to look for');
});

// ---------------------------------------------------------------------------
// a database without the table
// ---------------------------------------------------------------------------

test('a missing table renders an empty page rather than a 500', async (t) => {
  stub(t, { missingTable: true });
  const res = await call('GET');
  assert.strictEqual(res.statusCode, 200);
  const b = json(res);
  assert.deepStrictEqual(b.seats, []);
  assert.strictEqual(b.tableMissing, true);
  assert.match(b.note, /does not exist/);
});

test('malformed JSON is a 400, not a crash', async (t) => {
  const { writes } = stub(t);
  const res = await api.handler({
    httpMethod: 'PATCH', headers: { cookie: cookie() },
    queryStringParameters: {}, body: '{not json'
  });
  assert.strictEqual(res.statusCode, 400);
  assert.deepStrictEqual(writes, []);
});
