// /api/economics — the staffing plan, and the one thing about it the app can change.
//
// The table has ONE owner. It is off the /api/data allowlist entirely, so this
// file is the complete surface: a GET and a PATCH that sets one column on one
// row. What is worth testing is everything it REFUSES, because the reason this
// endpoint is shaped the way it is, is a write path that deleted the whole table.
//
// A SEAT POINTS AT AN EMPLOYEE ID. That is the second reason: the column used to
// be free text holding a name, and renaming somebody orphaned their seat with
// nothing anywhere reporting it. So the tests below care about two things a
// name-based version could not have: that a rename FOLLOWS the person, and that
// the endpoint works either side of the migration that added the key.

const test = require('node:test');
const assert = require('node:assert');
const { createHmac } = require('node:crypto');

process.env.SESSION_SECRET = 'test-session-secret';
process.env.SUPABASE_URL = 'https://example.invalid';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const payrollDb = require('../netlify/functions/payroll-db');
const api = require('../netlify/functions/economics');

const CALLER  = 'peter.stroble@sequoiafp.com';
const SEAT_1  = '11111111-2222-3333-4444-555555555555';
const SEAT_2  = '22222222-3333-4444-5555-666666666666';
const ANA     = 'aaaaaaaa-0000-0000-0000-000000000001';
const BO      = 'aaaaaaaa-0000-0000-0000-000000000002';
const INACTIVE= 'aaaaaaaa-0000-0000-0000-000000000003';
const SALARIED= 'aaaaaaaa-0000-0000-0000-000000000004';

const SEATS = [
  { id: SEAT_1, num: 1, section: 'Mill', seat: 'Millwright 1', name: null,        employee_id: null, max_wage: 38.5 },
  { id: SEAT_2, num: 2, section: 'Mill', seat: 'Millwright 2', name: 'Ana Reyes', employee_id: ANA,  max_wage: 30 }
];

const EMPLOYEES = [
  { id: ANA,      name: 'Ana Reyes',       status: 'Active',   pay_type: 'Hourly',   wage: '36.00' },
  { id: BO,       name: 'Bo Tran',         status: 'Active',   pay_type: 'Hourly',   wage: '33.25' },
  { id: INACTIVE, name: 'Inactive Person', status: 'Inactive', pay_type: 'Hourly',   wage: '20.00' },
  { id: SALARIED, name: 'Sal Aried',       status: 'Active',   pay_type: 'Salaried', wage: '29.75' }
];

function cookie(email = CALLER) {
  const b64 = Buffer.from(JSON.stringify({ email, exp: Date.now() + 3600000 })).toString('base64url');
  return `sfp_session=${b64}.${createHmac('sha256', process.env.SESSION_SECRET).update(b64).digest('base64url')}`;
}

// `noKeyColumn` simulates a database where SCHEMA_ECONOMICS_EMPLOYEE_ID.sql has
// not been run: any select naming employee_id answers 400 / 42703, exactly as
// PostgREST does.
function stub(t, { tier = 'salaries', seats = SEATS, employees = EMPLOYEES,
                   missingTable = false, noKeyColumn = false } = {}) {
  const real = payrollDb.fetchEmployees;
  t.after(() => { payrollDb.fetchEmployees = real; });
  payrollDb.fetchEmployees = async () => employees;

  const rows = seats.map(x => ({ ...x }));     // per-test, never shared
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
    if (noKeyColumn && /employee_id/.test(u)) {
      return { ok: false, status: 400,
               text: async () => 'column economics.employee_id does not exist (42703)',
               json: async () => ({}) };
    }
    if (method === 'PATCH') {
      const id = (/\bid=eq\.([^&]+)/.exec(u) || [])[1];
      const row = rows.find(r => r.id === id);
      Object.assign(row, body);
      return { ok: true, status: 200, json: async () => [row], text: async () => JSON.stringify([row]) };
    }
    const wantId  = (/\bid=eq\.([^&]+)/.exec(u) || [])[1];
    const wantEmp = (/employee_id=eq\.([^&]+)/.exec(u) || [])[1];
    const notId   = (/id=neq\.([^&]+)/.exec(u) || [])[1];
    const out = rows.filter(r =>
      (!wantId || r.id === wantId) &&
      (!wantEmp || String(r.employee_id) === wantEmp) &&
      (!notId || r.id !== notId));
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
const seatIn = (res, id) => json(res).seats.find(s => s.id === id);

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
  assert.ok(!res.body.includes('38.5'));
  assert.ok(!res.body.includes('Millwright'));
});

test('the admin tier alone does not open it', async (t) => {
  stub(t, { tier: 'admin' });
  assert.strictEqual((await call('GET')).statusCode, 403);
});

test('the base tier cannot ASSIGN, and nothing is written', async (t) => {
  const { writes } = stub(t, { tier: null });
  const res = await call('PATCH', { id: SEAT_1, employeeId: ANA });
  assert.strictEqual(res.statusCode, 403);
  assert.deepStrictEqual(writes, []);
});

// ---------------------------------------------------------------------------
// the point of the key
// ---------------------------------------------------------------------------

test("the occupant's name comes from the roster, so a rename follows the person", async (t) => {
  // The seat's stored text still says 'Ana Reyes'; the employee row says
  // otherwise. Under the old free-text scheme this seat was orphaned and read
  // as "not on the roster". Now it resolves.
  stub(t, { employees: EMPLOYEES.map(e => e.id === ANA ? { ...e, name: 'Ana Reyes-Marquez' } : e) });
  const res = await call('GET');
  const seat = seatIn(res, SEAT_2);

  assert.strictEqual(seat.name, 'Ana Reyes-Marquez', 'the name today, not the name stored');
  assert.strictEqual(seat.employeeId, ANA);
  assert.strictEqual(seat.unlinked, false, 'a rename must not orphan the seat');
});

test('a seat with no key but a stored name is reported as unlinked, not as vacant', async (t) => {
  // These are the rows SCHEMA_ECONOMICS_EMPLOYEE_ID.sql section 4b lists: the
  // backfill could not match them. Blanking them would hide a seat somebody is
  // sitting in.
  stub(t, { seats: [{ ...SEATS[0], name: 'Tim Green', employee_id: null }] });
  const seat = seatIn(await call('GET'), SEAT_1);
  assert.strictEqual(seat.unlinked, true);
  assert.strictEqual(seat.name, 'Tim Green', 'the only record of who was meant to be there');
  assert.strictEqual(seat.employeeId, null);
});

test('a genuinely vacant seat is vacant, not unlinked', async (t) => {
  stub(t);
  const seat = seatIn(await call('GET'), SEAT_1);
  assert.strictEqual(seat.unlinked, false);
  assert.strictEqual(seat.name, null);
  assert.strictEqual(seat.employeeId, null);
});

test('the occupant status rides along, so the page need not re-derive it', async (t) => {
  stub(t, { seats: [{ ...SEATS[1], employee_id: SALARIED }] });
  const seat = seatIn(await call('GET'), SEAT_2);
  assert.strictEqual(seat.name, 'Sal Aried');
  assert.strictEqual(seat.occupantSalaried, true);
  assert.strictEqual(seat.occupantStatus, 'Active');
});

test('with the tier the plan reads, in plan order', async (t) => {
  const { calls } = stub(t);
  const res = await call('GET');
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(json(res).seats.length, 2);
  assert.strictEqual(json(res).assignable, true);
  // num.asc, because 'Utility 10' sorts before 'Utility 2' alphabetically and
  // the plan has an order of its own.
  assert.ok(calls.some(c => /order=num\.asc/.test(c.url)));
});

// ---------------------------------------------------------------------------
// either side of the migration
// ---------------------------------------------------------------------------

test('before the migration the plan still READS, falling back one rung', async (t) => {
  const { calls } = stub(t, { noKeyColumn: true });
  const res = await call('GET');

  assert.strictEqual(res.statusCode, 200);
  const seat = json(res).seats.find(s => s.id === SEAT_2);
  assert.strictEqual(seat.name, 'Ana Reyes', 'resolved from the stored text, as it was before');
  assert.strictEqual(seat.employeeId, null);
  // Two attempts: with the key, then without it.
  const econGets = calls.filter(c => c.method === 'GET' && c.url.includes('economics'));
  assert.strictEqual(econGets.length, 2);
  assert.ok(/employee_id/.test(econGets[0].url));
  assert.ok(!/employee_id/.test(econGets[1].url));
});

test('before the migration assignment is REFUSED, and names the file to run', async (t) => {
  const { writes } = stub(t, { noKeyColumn: true });
  const res = await call('PATCH', { id: SEAT_1, employeeId: ANA });

  assert.strictEqual(res.statusCode, 503);
  assert.match(json(res).error, /SCHEMA_ECONOMICS_EMPLOYEE_ID\.sql/);
  // The alternative is writing to the text column, which a build that reads the
  // key would never show — an invisible write is worse than a refusal.
  assert.deepStrictEqual(writes, [], 'nothing is written to the legacy column');
});

test('before the migration the page is told not to offer assignment', async (t) => {
  stub(t, { noKeyColumn: true });
  const b = json(await call('GET'));
  assert.strictEqual(b.assignable, false);
  assert.match(b.note, /SCHEMA_ECONOMICS_EMPLOYEE_ID\.sql/);
});

// ---------------------------------------------------------------------------
// what it refuses to write — the reason it exists
// ---------------------------------------------------------------------------

test('there is no method that replaces the table', async (t) => {
  const { writes } = stub(t);
  for (const method of ['PUT', 'POST', 'DELETE']) {
    assert.strictEqual((await call(method, { rows: [] })).statusCode, 405, method);
  }
  assert.deepStrictEqual(writes, [], 'no DELETE, no bulk insert, nothing');
});

test('only the assigned person is writable — the plan itself is refused', async (t) => {
  const { writes } = stub(t);
  for (const body of [{ id: SEAT_1, max_wage: 999 },
                      { id: SEAT_1, seat: 'Millwright 9' },
                      { id: SEAT_1, section: 'Yard' },
                      { id: SEAT_1, num: 42 },
                      { id: SEAT_1, employeeId: ANA, max_wage: 999 }]) {
    const res = await call('PATCH', body);
    assert.strictEqual(res.statusCode, 403, JSON.stringify(body));
    assert.match(json(res).error, /Not permitted to write/);
  }
  assert.deepStrictEqual(writes, []);
});

test('sending a name instead of an id is refused, and says why', async (t) => {
  // The old contract. Worth a specific message rather than a generic refusal:
  // it is the mistake somebody porting a script will make.
  const { writes } = stub(t);
  const res = await call('PATCH', { id: SEAT_1, name: 'Ana Reyes' });
  assert.strictEqual(res.statusCode, 403);
  assert.match(json(res).detail, /points at an employee id/);
  assert.match(json(res).detail, /Send employeeId/);
  assert.deepStrictEqual(writes, []);
});

test('a seat is named by id, never by its title', async (t) => {
  const { writes } = stub(t);
  const res = await call('PATCH', { id: 'Millwright 1', employeeId: ANA });
  assert.strictEqual(res.statusCode, 400);
  assert.match(json(res).error, /UUID/);
  assert.deepStrictEqual(writes, []);
});

test('an employeeId that is not a UUID is refused before any lookup', async (t) => {
  const { writes } = stub(t);
  const res = await call('PATCH', { id: SEAT_1, employeeId: 'Ana Reyes' });
  assert.strictEqual(res.statusCode, 400);
  assert.match(json(res).error, /employeeId must be an employee UUID/);
  assert.deepStrictEqual(writes, []);
});

test('an unknown seat is 404 rather than a silent no-op', async (t) => {
  const { writes } = stub(t);
  const res = await call('PATCH', { id: '99999999-9999-9999-9999-999999999999', employeeId: ANA });
  assert.strictEqual(res.statusCode, 404);
  assert.deepStrictEqual(writes, []);
});

// ---------------------------------------------------------------------------
// who may fill a seat
// ---------------------------------------------------------------------------

test('an id nobody has is refused', async (t) => {
  const { writes } = stub(t);
  const res = await call('PATCH', { id: SEAT_1, employeeId: '99999999-9999-9999-9999-999999999999' });
  assert.strictEqual(res.statusCode, 400);
  assert.match(json(res).error, /No employee with that id/);
  assert.deepStrictEqual(writes, []);
});

test('an inactive person cannot be seated', async (t) => {
  const { writes } = stub(t);
  const res = await call('PATCH', { id: SEAT_1, employeeId: INACTIVE });
  assert.strictEqual(res.statusCode, 400);
  assert.match(json(res).detail, /active employee/);
  assert.deepStrictEqual(writes, []);
});

test('a salaried person cannot be seated — they have no rate to bring', async (t) => {
  // Note the fixture: Sal Aried still carries 29.75 in wage. pay_type is the
  // fact, so the leftover number must not make them look seatable.
  const { writes } = stub(t);
  const res = await call('PATCH', { id: SEAT_1, employeeId: SALARIED });
  assert.strictEqual(res.statusCode, 400);
  assert.match(json(res).detail, /no hourly rate/);
  assert.deepStrictEqual(writes, []);
});

test('assigning writes the key, and the name only as a last-known spelling', async (t) => {
  const { writes } = stub(t);
  const res = await call('PATCH', { id: SEAT_1, employeeId: BO });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(writes[0].body, { employee_id: BO, name: 'Bo Tran' });
  assert.strictEqual(json(res).seat.employeeId, BO);
  assert.strictEqual(json(res).seat.name, 'Bo Tran');
});

test('an empty employeeId vacates the seat, and that is a real instruction', async (t) => {
  const { writes } = stub(t);
  const res = await call('PATCH', { id: SEAT_2, employeeId: '' });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(writes[0].body, { employee_id: null, name: null });
  assert.strictEqual(json(res).seat.employeeId, null);
  assert.strictEqual(json(res).seat.name, null);
});

test('assigning the person already there writes nothing at all', async (t) => {
  const { writes } = stub(t);
  const res = await call('PATCH', { id: SEAT_2, employeeId: ANA });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(json(res).unchanged, true);
  assert.deepStrictEqual(writes, [],
    'an idempotent click must not stamp an updated_at or read as a change in an audit');
});

test('a second seat for the same person goes through, and the response says where', async (t) => {
  const { writes } = stub(t);
  const res = await call('PATCH', { id: SEAT_1, employeeId: ANA });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(json(res).alsoIn, ['Millwright 2']);
  assert.strictEqual(writes.length, 1, 'only the seat that was named is touched');
  assert.match(writes[0].url, new RegExp('id=eq\\.' + SEAT_1));
});

test('the duplicate check is by id, so it catches two spellings of one person', async (t) => {
  // A name comparison could not: seat 2 stores 'Ana Reyes' and seat 1 would
  // store whatever the roster says today. Both point at the same id.
  const { calls } = stub(t, {
    seats: [SEATS[0], { ...SEATS[1], name: 'Ana R.' }],
    employees: EMPLOYEES.map(e => e.id === ANA ? { ...e, name: 'Ana Reyes-Marquez' } : e)
  });
  const res = await call('PATCH', { id: SEAT_1, employeeId: ANA });
  assert.deepStrictEqual(json(res).alsoIn, ['Millwright 2']);
  assert.ok(calls.some(c => /employee_id=eq\./.test(c.url)), 'asked by id');
  assert.ok(!calls.some(c => /\bname=eq\./.test(c.url)), 'never by name');
});

test('a vacated seat reports no duplicates rather than looking them up', async (t) => {
  const { calls } = stub(t);
  const res = await call('PATCH', { id: SEAT_2, employeeId: '' });
  assert.deepStrictEqual(json(res).alsoIn, []);
  assert.ok(!calls.some(c => /employee_id=eq\./.test(c.url)), 'nobody to look for');
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
  assert.strictEqual(b.assignable, false);
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
