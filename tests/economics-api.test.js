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
                   missingTable = false, noKeyColumn = false,
                   historyMissing = false } = {}) {
  const real = payrollDb.fetchEmployees;
  t.after(() => { payrollDb.fetchEmployees = real; });
  payrollDb.fetchEmployees = async () => employees;

  const rows = seats.map(x => ({ ...x }));     // per-test, never shared
  const historyRows = [];                     // what a history READ returns
  const calls = [];
  const writes = [];
  const history = [];
  global.fetch = async (url, opts = {}) => {
    const u = decodeURIComponent(String(url));
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: u, method, body });
    // History inserts are collected SEPARATELY from writes to the plan. Two
    // reasons: every existing assertion about `writes[0]` is about the seat
    // row and should stay readable, and the ORDER between the two is itself
    // under test — the history row goes in first, so a caller that never
    // reaches the seat write left no half-recorded change.
    if (/economics_history/.test(u)) {
      if (historyMissing) {
        return { ok: false, status: 404,
                 text: async () => 'PGRST205 could not find the table public.economics_history',
                 json: async () => ({}) };
      }
      if (method === 'POST') {
        history.push({ url: u, body, afterSeatWrites: writes.length });
        return { ok: true, status: 201, json: async () => [body], text: async () => JSON.stringify([body]) };
      }
      const rowsOut = historyRows.filter(h => {
        const want = (/seat_id=eq\.([^&]+)/.exec(u) || [])[1];
        return !want || String(h.seat_id) === want;
      });
      return { ok: true, status: 200, json: async () => rowsOut, text: async () => JSON.stringify(rowsOut) };
    }
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
  return { calls, writes, rows, history, historyRows };
}

// (method, body, queryStringParameters, email). Nothing passed a third argument
// before the history read existed, so adding params there disturbs no call site.
const call = (method, body, params = {}, email = CALLER) => api.handler({
  httpMethod: method,
  headers: email ? { cookie: cookie(email) } : {},
  queryStringParameters: params,
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

test("the plan's SHAPE is refused — and so is the raw column name", async (t) => {
  // `maxWage` is writable now; `max_wage` is not. That is not pedantry: the
  // camelCase key is this endpoint's own vocabulary, and accepting the column
  // name too would mean two spellings of one operation, one of which bypasses
  // the parsing and the ceiling guard.
  const { writes } = stub(t);
  for (const body of [{ id: SEAT_1, max_wage: 999 },
                      { id: SEAT_1, seat: 'Millwright 9' },
                      { id: SEAT_1, section: 'Yard' },
                      { id: SEAT_1, num: 42 }]) {
    const res = await call('PATCH', body);
    assert.strictEqual(res.statusCode, 403, JSON.stringify(body));
    assert.match(json(res).error, /Not permitted to write/);
  }
  assert.deepStrictEqual(writes, []);
});

test('a body naming BOTH the occupant and the position rate is refused', async (t) => {
  // One fact per request. They are unrelated — who is in the seat, and what the
  // seat is budgeted at — and one response cannot report both honestly.
  const { writes } = stub(t);
  const res = await call('PATCH', { id: SEAT_1, employeeId: ANA, maxWage: 42 });
  assert.strictEqual(res.statusCode, 400);
  assert.match(json(res).error, /One change at a time/);
  assert.match(json(res).detail, /separate requests/);
  assert.deepStrictEqual(writes, []);
});

test('a body naming neither is refused rather than treated as a no-op', async (t) => {
  const { writes } = stub(t);
  const res = await call('PATCH', { id: SEAT_1 });
  assert.strictEqual(res.statusCode, 400);
  assert.match(json(res).error, /Nothing to change/);
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

// ---------------------------------------------------------------------------
// the position rate
// ---------------------------------------------------------------------------
//
// `max_wage` was on the refused list, on the argument that moving a ceiling is
// a budgeting decision and does not belong on a screen about who is sitting
// where. What that produced was a figure nobody could move: the number the
// whole variance column is measured against was editable only by writing SQL
// against a live table, which is a worse audit trail than an app write.
//
// The GATE did not change. The endpoint already requires the salaries tier to
// read a ceiling, so the people who can set one are exactly the people who
// could already see one — which is what the first test here pins.

test('setting a position rate needs the salaries tier, like everything else here', async (t) => {
  const { writes } = stub(t, { tier: null });
  const res = await call('PATCH', { id: SEAT_1, maxWage: 42 });
  assert.strictEqual(res.statusCode, 403);
  assert.match(json(res).detail, /salaries tier/);
  assert.deepStrictEqual(writes, [], 'refused before any write');
});

test('a position rate writes one column on one row', async (t) => {
  const { writes } = stub(t);
  const res = await call('PATCH', { id: SEAT_1, maxWage: 42.5 });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(writes.length, 1);
  assert.deepStrictEqual(writes[0].body, { max_wage: 42.5 });
  assert.strictEqual(json(res).seat.max_wage, 42.5);
  // The previous value comes back, because a ceiling has no history table and
  // this response is the only place it is stated.
  assert.strictEqual(json(res).previousMaxWage, 38.5);
});

test('it does not touch the occupant', async (t) => {
  // The assignment path writes employee_id AND name. This one must write
  // neither, or a ceiling change would restamp the seat's occupant.
  const { writes } = stub(t);
  await call('PATCH', { id: SEAT_2, maxWage: 31 });
  assert.deepStrictEqual(Object.keys(writes[0].body), ['max_wage']);
  const res = await call('PATCH', { id: SEAT_2, maxWage: 32 });
  assert.strictEqual(json(res).seat.employeeId, ANA, 'still Ana');
  assert.strictEqual(json(res).seat.name, 'Ana Reyes');
});

test('what somebody types is what is parsed', async (t) => {
  for (const [typed, stored] of [['45', 45], ['45.00', 45], ['$45.00', 45],
                                 ['45.567', 45.57], [45.5, 45.5], [' 45 ', 45]]) {
    const { writes } = stub(t);
    const res = await call('PATCH', { id: SEAT_1, maxWage: typed });
    assert.strictEqual(res.statusCode, 200, String(typed));
    assert.deepStrictEqual(writes[0].body, { max_wage: stored }, String(typed));
  }
});

test('clearing a position rate writes null — a seat with no ceiling is real', async (t) => {
  // Unlike clearing an hourly rate, which wage_history has no way to record.
  // The read has always tolerated a null max_wage and drawn a dash for it.
  const { writes } = stub(t);
  const res = await call('PATCH', { id: SEAT_1, maxWage: '' });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(writes[0].body, { max_wage: null });
  assert.strictEqual(json(res).seat.max_wage, null);
});

test('re-sending the rate already stored writes nothing at all', async (t) => {
  // Blur fires on every tab-through, so this is the ordinary case. A write here
  // would stamp updated_at and read as a change in any audit of the row.
  const { writes } = stub(t);
  for (const same of [38.5, '38.50', '$38.50']) {
    const res = await call('PATCH', { id: SEAT_1, maxWage: same });
    assert.strictEqual(res.statusCode, 200, String(same));
    assert.strictEqual(json(res).unchanged, true, String(same));
  }
  assert.deepStrictEqual(writes, []);
});

test('clearing an already-empty ceiling is also a no-op', async (t) => {
  const { writes } = stub(t, {
    seats: SEATS.map(x => (x.id === SEAT_1 ? { ...x, max_wage: null } : x)) });
  const res = await call('PATCH', { id: SEAT_1, maxWage: '' });
  assert.strictEqual(json(res).unchanged, true);
  assert.deepStrictEqual(writes, []);
});

test('an unparseable rate is refused with its own sentence', async (t) => {
  const { writes } = stub(t);
  for (const bad of ['forty', 'abc', '45.5.5', '--3']) {
    const res = await call('PATCH', { id: SEAT_1, maxWage: bad });
    assert.strictEqual(res.statusCode, 400, bad);
    assert.match(json(res).error, /is not a position rate/, bad);
  }
  assert.deepStrictEqual(writes, []);
});

test('a negative rate is refused, and the remedy named', async (t) => {
  const { writes } = stub(t);
  const res = await call('PATCH', { id: SEAT_1, maxWage: -5 });
  assert.strictEqual(res.statusCode, 400);
  assert.match(json(res).error, /cannot be negative/);
  assert.match(json(res).detail, /Clear the field/);
  assert.deepStrictEqual(writes, []);
});

test('an annual figure in the hourly field is refused, not stored', async (t) => {
  // THE ACCIDENT WORTH GUARDING. A ceiling of 95000 does not look wrong on the
  // page — it makes the variance column meaningless for that seat, quietly.
  const { writes } = stub(t);
  for (const annual of [95000, '105,000', 1001]) {
    const res = await call('PATCH', { id: SEAT_1, maxWage: annual });
    assert.strictEqual(res.statusCode, 400, String(annual));
    assert.match(json(res).error, /too high/, String(annual));
    assert.match(json(res).detail, /annual figure or a misplaced decimal/, String(annual));
  }
  assert.deepStrictEqual(writes, []);
  // The boundary itself is allowed: it is a typo guard, not a pay policy.
  const ok = await call('PATCH', { id: SEAT_1, maxWage: 1000 });
  assert.strictEqual(ok.statusCode, 200);
});

test('zero IS a real ceiling and is stored', async (t) => {
  // Unlike an hourly wage, where zero prices a day's work at nothing. A seat
  // budgeted at zero is a seat nobody may be paid for, which is a coherent — if
  // unusual — plan, and refusing it would be inventing a policy.
  const { writes } = stub(t);
  const res = await call('PATCH', { id: SEAT_1, maxWage: 0 });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(writes[0].body, { max_wage: 0 });
});

test('a rate for a seat that does not exist is a 404, and writes nothing', async (t) => {
  const { writes } = stub(t);
  const res = await call('PATCH', { id: '99999999-9999-9999-9999-999999999999', maxWage: 42 });
  assert.strictEqual(res.statusCode, 404);
  assert.deepStrictEqual(writes, []);
});

// ---------------------------------------------------------------------------
// economics_history
// ---------------------------------------------------------------------------
//
// Both writes this endpoint has are recorded: the ceiling, and the occupant.
// Until 2026-09-10 neither was, and that was tolerable while the ceiling was
// read-only in the app — moving one meant writing SQL by hand, which at least
// left a trace in somebody's query history. It is a field on a page now.
//
// HISTORY FIRST, ALWAYS, and a failure to record aborts the change. Same rule
// wage-edit-lib states first and for the same reason: an overwrite with no
// history is what a history table exists to prevent, while a history row for a
// change that then failed to apply is recoverable.

test('a ceiling change records history BEFORE it writes the seat', async (t) => {
  const { writes, history } = stub(t);
  const res = await call('PATCH', { id: SEAT_1, maxWage: 42 });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(history.length, 1);
  assert.strictEqual(writes.length, 1);
  // The ordering assertion, and the reason the stub records it: zero seat
  // writes had happened when the history row went in.
  assert.strictEqual(history[0].afterSeatWrites, 0, 'history is written first');
});

test('the recorded ceiling row says what moved, from what, and who moved it', async (t) => {
  const { history } = stub(t);
  await call('PATCH', { id: SEAT_1, maxWage: 42 });
  const h = history[0].body;
  assert.strictEqual(h.field, 'max_wage');
  assert.strictEqual(h.previous_value, '38.5');
  assert.strictEqual(h.new_value, '42');
  // The displays are what the figures MEANT, formatted for a reader years on.
  assert.strictEqual(h.previous_display, '38.50');
  assert.strictEqual(h.new_display, '42.00');
  assert.strictEqual(h.changed_by, CALLER);
  // The seat is copied in, so the row still identifies its seat after a rename
  // or a delete — the FK is ON DELETE SET NULL.
  assert.strictEqual(h.seat_id, SEAT_1);
  assert.strictEqual(h.seat_num, 1);
  assert.strictEqual(h.seat_title, 'Millwright 1');
  assert.strictEqual(h.seat_section, 'Mill');
});

test('an assignment is recorded too, by name as well as by id', async (t) => {
  // The occupant is included because it is the other write here, and because a
  // table called economics_history that silently covered half the writes would
  // be worse than none — a reader would conclude nothing else had changed.
  const { history } = stub(t);
  await call('PATCH', { id: SEAT_2, employeeId: BO });
  const h = history[0].body;
  assert.strictEqual(h.field, 'employee_id');
  assert.strictEqual(h.previous_value, ANA);
  assert.strictEqual(h.new_value, BO);
  // A UUID is unreadable and its employee may later be renamed or deleted, so
  // the name at the time is recorded beside it.
  assert.strictEqual(h.previous_display, 'Ana Reyes');
  assert.strictEqual(h.new_display, 'Bo Tran');
});

test('a vacancy is recorded as null, not as the word "vacant"', async (t) => {
  // The column means "none" when empty. A sentinel string would sort, group
  // and deduplicate as a person called vacant.
  const { history } = stub(t);
  await call('PATCH', { id: SEAT_2, employeeId: '' });
  const h = history[0].body;
  assert.strictEqual(h.new_value, null);
  assert.strictEqual(h.new_display, null);
  assert.strictEqual(h.previous_display, 'Ana Reyes', 'and who left is still named');
});

test('clearing a ceiling records the figure that went away', async (t) => {
  const { history } = stub(t);
  await call('PATCH', { id: SEAT_1, maxWage: '' });
  const h = history[0].body;
  assert.strictEqual(h.previous_display, '38.50');
  assert.strictEqual(h.new_value, null);
  assert.strictEqual(h.new_display, null);
});

test('a no-op records nothing at all', async (t) => {
  // The endpoint answers `unchanged` without writing, so there must be no
  // history row either — a trail full of rows saying nothing moved is a trail
  // nobody will read.
  const { writes, history } = stub(t);
  const res = await call('PATCH', { id: SEAT_1, maxWage: '38.50' });
  assert.strictEqual(json(res).unchanged, true);
  assert.deepStrictEqual(writes, []);
  assert.deepStrictEqual(history, []);
});

test('a refused change records nothing', async (t) => {
  const { writes, history } = stub(t);
  for (const bad of [{ maxWage: 'forty' }, { maxWage: 95000 }, { maxWage: -5 }]) {
    await call('PATCH', { id: SEAT_1, ...bad });
  }
  assert.deepStrictEqual(writes, []);
  assert.deepStrictEqual(history, [], 'refused before anything is recorded');
});

test('if the history cannot be recorded, the change is REFUSED', async (t) => {
  // The rule that matters. A missing economics_history must not mean "write the
  // change unrecorded" — that is exactly the state the table was added to end.
  const { writes } = stub(t, { historyMissing: true });
  const res = await call('PATCH', { id: SEAT_1, maxWage: 42 });
  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(json(res).historyMissing, true);
  assert.match(json(res).error, /SCHEMA_ECONOMICS_HISTORY\.sql/);
  assert.deepStrictEqual(writes, [], 'the seat was NOT changed');
});

test('the missing-history message is not confused with a missing plan', async (t) => {
  // Both look like a missing table to PostgREST. Reporting "the plan does not
  // exist" when the plan is fine would send somebody looking in the wrong
  // place, so the history case is checked first and named.
  const { } = stub(t, { historyMissing: true });
  const res = await call('PATCH', { id: SEAT_1, employeeId: BO });
  assert.strictEqual(res.statusCode, 503);
  assert.ok(!/does not exist in this database/.test(json(res).error),
    'not the economics-table message');
  assert.match(json(res).error, /economics_history does not exist/);
});

// ---- reading it back ----

test('GET ?history=<seat> returns that seat\'s changes, shaped for a reader', async (t) => {
  const { historyRows } = stub(t);
  historyRows.push(
    { id: 'h1', seat_id: SEAT_1, field: 'max_wage', previous_display: '38.50',
      new_display: '42.00', changed_by: CALLER, changed_at: '2026-09-10T22:00:00Z' },
    { id: 'h0', seat_id: SEAT_1, field: 'max_wage', previous_display: null,
      new_display: '38.50', changed_by: 'migration', changed_at: '2026-09-01T00:00:00Z' });

  const res = await call('GET', null, { history: SEAT_1 });
  assert.strictEqual(res.statusCode, 200);
  const rows = json(res).history;
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].previous, '38.50');
  assert.strictEqual(rows[0].next, '42.00');
  assert.strictEqual(rows[0].changedBy, CALLER);
  assert.strictEqual(rows[0].opening, false);
  // The migration's opening rows are marked, so the page can say "predates the
  // trail" rather than presenting them as somebody's edit.
  assert.strictEqual(rows[1].opening, true);
  // The raw values are deliberately not sent: a UUID of somebody who may have
  // left adds nothing a reader can use.
  assert.ok(!('previous_value' in rows[0]));
});

test('reading the history needs the salaries tier, like the plan', async (t) => {
  stub(t, { tier: null });
  const res = await call('GET', null, { history: SEAT_1 });
  assert.strictEqual(res.statusCode, 403);
  assert.match(json(res).detail, /salaries tier/);
});

test('a history read for a non-UUID is refused', async (t) => {
  stub(t);
  const res = await call('GET', null, { history: 'Millwright 1' });
  assert.strictEqual(res.statusCode, 400);
  assert.match(json(res).error, /seat UUID/);
});

test('READING before the migration is an empty list, not an error', async (t) => {
  // The one place the read and the write differ. Somebody opening the log
  // before the table exists should see "nothing recorded" and why; a WRITER
  // must be refused.
  stub(t, { historyMissing: true });
  const res = await call('GET', null, { history: SEAT_1 });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(json(res).history, []);
  assert.strictEqual(json(res).historyMissing, true);
  assert.match(json(res).note, /SCHEMA_ECONOMICS_HISTORY\.sql/);
});
