// /api/preapproved-ot — the write surface for the standing OT allowance.
//
// The old Overtime tab saved by DELETING every row and re-inserting the whole
// table. Two things came of that: a byte-identical duplicate row that was
// counted for months, and the standing risk that a partial save wipes rows
// nobody was editing. So the thing being tested here is mostly what this
// endpoint refuses to do.

const test = require('node:test');
const assert = require('node:assert');
const { createHmac } = require('crypto');

process.env.SESSION_SECRET = 'test-session-secret';
process.env.SUPABASE_URL = 'https://example.invalid';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const payrollDb = require('../netlify/functions/payroll-db');
const { handler, __test } = require('../netlify/functions/preapproved-ot');
const data = require('../netlify/functions/data');

const ID_A = '11111111-2222-3333-4444-555555555555';
const ID_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function cookie() {
  const b64 = Buffer.from(JSON.stringify({ email: 'peter.stroble@sequoiafp.com', exp: Date.now() + 3600000 }))
    .toString('base64url');
  return `sfp_session=${b64}.${createHmac('sha256', 'test-session-secret').update(b64).digest('base64url')}`;
}

const event = (method, { body, params, noCookie } = {}) => ({
  httpMethod: method,
  headers: noCookie ? {} : { cookie: cookie() },
  queryStringParameters: params || {},
  body: body === undefined ? null : JSON.stringify(body)
});

const EMPLOYEES = [
  { id: ID_A, name: 'Ana Reyes', employee_number: '0101', department: 'Production', status: 'Active', wage: '25' },
  { id: ID_B, name: 'Gone Person', employee_number: '0108', department: null, status: 'Inactive', wage: '20' }
];

function stub(t, { rows, employees = EMPLOYEES, fetchError, requestImpl } = {}) {
  const real = {
    fetchPreApprovedOt: payrollDb.fetchPreApprovedOt,
    fetchEmployees: payrollDb.fetchEmployees,
    request: payrollDb.request
  };
  t.after(() => Object.assign(payrollDb, real));

  const calls = [];
  payrollDb.fetchPreApprovedOt = async () => {
    if (fetchError) throw fetchError;
    return rows || [];
  };
  payrollDb.fetchEmployees = async () => employees;
  payrollDb.request = async (method, path, opts) => {
    calls.push({ method, path, opts });
    if (requestImpl) return requestImpl(method, path, opts);
    return { rows: [{ id: 'new', ...(opts && opts.body ? opts.body[0] : {}) }], total: null };
  };
  return calls;
}

const parse = (res) => JSON.parse(res.body);

// ---------------------------------------------------------------------------
// the gate
// ---------------------------------------------------------------------------

test('no session is 401 on every method', async (t) => {
  stub(t, { rows: [] });
  for (const method of ['GET', 'PUT', 'POST', 'DELETE']) {
    assert.strictEqual((await handler(event(method, { noCookie: true }))).statusCode, 401, method);
  }
});

test('an unsupported method is 405', async (t) => {
  stub(t, { rows: [] });
  assert.strictEqual((await handler(event('PATCH'))).statusCode, 405);
});

// ---------------------------------------------------------------------------
// THE refusal
// ---------------------------------------------------------------------------

test('preapproved_ot is not reachable through /api/data, so it cannot be replace-all-ed', async () => {
  // /api/data's PUT maps to db.replaceAll, which DELETEs every row before
  // inserting. That operation is exactly what this table exists to stop, so the
  // table must not be on that endpoint's allowlist at all.
  const realFetch = global.fetch;
  const urls = [];
  global.fetch = async (url) => {
    urls.push(String(url));
    return { ok: true, status: 200, json: async () => [], text: async () => '[]' };
  };
  try {
    for (const method of ['GET', 'PUT', 'POST', 'DELETE']) {
      const res = await data.handler({
        httpMethod: method,
        headers: { cookie: cookie() },
        queryStringParameters: { table: 'preapproved_ot' },
        body: JSON.stringify({ rows: [] })
      });
      assert.strictEqual(res.statusCode, 400, `reachable via ${method}`);
    }
    assert.strictEqual(urls.length, 0, 'it reached the database anyway');
  } finally {
    global.fetch = realFetch;
  }
});

test('a write is an upsert on the unique key, never a delete-and-insert', async (t) => {
  const calls = stub(t, { rows: [] });
  const res = await handler(event('PUT', {
    body: { employeeId: ID_A, otType: 'Weekend', hours: 6, description: 'Weekend PM' }
  }));

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(calls.length, 1, 'one request, not a delete then an insert');
  assert.strictEqual(calls[0].method, 'POST');
  assert.match(calls[0].path, /on_conflict=employee_id,ot_type/);
  assert.match(calls[0].opts.headers.Prefer, /resolution=merge-duplicates/);
  assert.ok(!calls.some(c => c.method === 'DELETE'), 'nothing is deleted on a save');

  const row = calls[0].opts.body[0];
  assert.strictEqual(row.employee_id, ID_A);
  assert.strictEqual(row.ot_type, 'Weekend');
  assert.strictEqual(row.hours, 6);
  assert.strictEqual(row.description, 'Weekend PM');
});

test('saving the same person and category twice does not add a second row', async (t) => {
  // Rey Aispuro's duplicate, made impossible. The unique constraint is the real
  // defence; this asserts the endpoint asks for the upsert that relies on it.
  const calls = stub(t, { rows: [] });
  for (let i = 0; i < 3; i++) {
    await handler(event('PUT', { body: { employeeId: ID_A, otType: 'Weekend', hours: 6 } }));
  }
  assert.strictEqual(calls.length, 3);
  for (const c of calls) {
    assert.match(c.path, /on_conflict=employee_id,ot_type/);
    assert.strictEqual(c.opts.body.length, 1, 'one row per write, never the whole table');
  }
});

test('a delete names both the employee and the category', async (t) => {
  const calls = stub(t, { rows: [] });
  const res = await handler(event('DELETE', { params: { employeeId: ID_A, otType: 'Pre-Shift' } }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(calls[0].method, 'DELETE');
  assert.match(calls[0].path, new RegExp(`employee_id=eq\\.${ID_A}`));
  assert.match(calls[0].path, /ot_type=eq\.Pre-Shift/);
});

test('a delete missing either filter is refused rather than widened', async (t) => {
  // A DELETE with only the employee would remove all three of their categories;
  // with only the category, everybody's.
  const calls = stub(t, { rows: [] });
  for (const params of [{ employeeId: ID_A }, { otType: 'Weekend' }, {},
                        { employeeId: 'not-a-uuid', otType: 'Weekend' },
                        { employeeId: ID_A, otType: 'Whenever' }]) {
    const res = await handler(event('DELETE', { params }));
    assert.strictEqual(res.statusCode, 400, JSON.stringify(params));
  }
  assert.strictEqual(calls.length, 0, 'nothing reached the database');
});

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

test('the allowance is keyed on a UUID, never on a name', async (t) => {
  const calls = stub(t, { rows: [] });
  for (const employeeId of ['Ana Reyes', '', '0101', 'null', undefined, 42, {}]) {
    const res = await handler(event('PUT', { body: { employeeId, otType: 'Weekend', hours: 1 } }));
    assert.strictEqual(res.statusCode, 400, JSON.stringify(employeeId));
    assert.match(parse(res).error, /employees\.id, not on a name/);
  }
  assert.strictEqual(calls.length, 0);
});

test('only the three live category values are accepted', async (t) => {
  stub(t, { rows: [] });
  for (const otType of ['Pre-Shift', 'Post-Shift', 'Weekend']) {
    assert.strictEqual(
      (await handler(event('PUT', { body: { employeeId: ID_A, otType, hours: 1 } }))).statusCode, 200, otType);
  }
  // The spec draft said these. They are not in the table and would fail the
  // database CHECK on the first insert.
  for (const otType of ['Before Shift', 'After Shift', 'Friday', 'weekend', '']) {
    const res = await handler(event('PUT', { body: { employeeId: ID_A, otType, hours: 1 } }));
    assert.strictEqual(res.statusCode, 400, otType);
  }
});

test('hours must be a real number, and a blank is not zero', async (t) => {
  const calls = stub(t, { rows: [] });
  for (const hours of ['', '   ', null, undefined, {}, [], 'lots', NaN, Infinity]) {
    const res = await handler(event('PUT', { body: { employeeId: ID_A, otType: 'Weekend', hours } }));
    assert.strictEqual(res.statusCode, 400, JSON.stringify(hours));
  }
  assert.strictEqual(calls.length, 0);
});

test('zero hours is a real setting and is accepted', async (t) => {
  // It switches this person's allowance off without deleting the row, which is
  // a different statement from having no row. So this can never be a
  // truthiness test.
  const calls = stub(t, { rows: [] });
  assert.strictEqual(
    (await handler(event('PUT', { body: { employeeId: ID_A, otType: 'Weekend', hours: 0 } }))).statusCode, 200);
  assert.strictEqual(calls[0].opts.body[0].hours, 0);
});

test('a negative allowance is refused', async (t) => {
  const res = await handler(event('PUT', { body: { employeeId: ID_A, otType: 'Weekend', hours: -1 } }));
  assert.strictEqual(res.statusCode, 400);
  assert.match(parse(res).error, /cannot be negative/);
});

test('an implausible weekly allowance is refused rather than wrecking Net OT', async (t) => {
  // 168 is a typo, not an allowance. Accepted, it would make one person's
  // approval larger than the whole mill's overtime and Net OT would go deeply
  // negative with nothing on screen to point at.
  const calls = stub(t, { rows: [] });
  const res = await handler(event('PUT', { body: { employeeId: ID_A, otType: 'Weekend', hours: 168 } }));
  assert.strictEqual(res.statusCode, 400);
  assert.match(parse(res).error, /weekly allowance, not a total/);
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(__test.MAX_HOURS_PER_WEEK, 40);
});

test('hours are rounded to the cent, and a numeric string is accepted', async (t) => {
  const calls = stub(t, { rows: [] });
  await handler(event('PUT', { body: { employeeId: ID_A, otType: 'Weekend', hours: '0.256' } }));
  assert.strictEqual(calls[0].opts.body[0].hours, 0.26);
});

test('an empty description is stored as null, so "none" has one representation', async (t) => {
  const calls = stub(t, { rows: [] });
  for (const description of ['', '   ', undefined, null, 42]) {
    await handler(event('PUT', { body: { employeeId: ID_A, otType: 'Weekend', hours: 1, description } }));
  }
  for (const c of calls) assert.strictEqual(c.opts.body[0].description, null);

  calls.length = 0;
  await handler(event('PUT', { body: { employeeId: ID_A, otType: 'Weekend', hours: 1, description: '  Quad Saw Change  ' } }));
  assert.strictEqual(calls[0].opts.body[0].description, 'Quad Saw Change');
});

test('a body that is not JSON is a 400, not a 500', async (t) => {
  stub(t, { rows: [] });
  const res = await handler({ httpMethod: 'PUT', headers: { cookie: cookie() }, body: '{not json' });
  assert.strictEqual(res.statusCode, 400);
});

test('an employee id not on the roster is reported as a client mistake', async (t) => {
  stub(t, {
    rows: [],
    requestImpl: () => { throw new Error('{"code":"23503","message":"violates foreign key constraint"}'); }
  });
  const res = await handler(event('PUT', { body: { employeeId: ID_B, otType: 'Weekend', hours: 1 } }));
  assert.strictEqual(res.statusCode, 400);
  assert.match(parse(res).error, /not on the roster/);
});

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

test('GET joins the employee on, and carries no pay figure of any kind', async (t) => {
  stub(t, {
    rows: [
      { id: 'p1', employee_id: ID_A, ot_type: 'Weekend', hours: '6.00', description: 'Weekend PM' },
      { id: 'p2', employee_id: ID_B, ot_type: 'Post-Shift', hours: '1.00', description: 'Ensure Start-up' }
    ]
  });
  const res = await handler(event('GET'));
  assert.strictEqual(res.statusCode, 200);

  const body = parse(res);
  const ana = body.rows.find(r => r.employeeId === ID_A);
  assert.strictEqual(ana.name, 'Ana Reyes');
  assert.strictEqual(ana.department, 'Production');
  assert.strictEqual(ana.hours, 6);
  assert.strictEqual(ana.onRoster, true);
  assert.strictEqual(ana.status, 'Active');

  // This endpoint says who is approved for how many hours. It never says what
  // anybody is paid, and the roster read it does carries a wage column.
  assert.ok(!res.body.includes('"wage"'));
  assert.ok(!res.body.includes('25'), 'Ana\'s hourly rate must not be in the response');
  assert.ok(!res.body.includes('annual_salary'));
});

test('GET marks an inactive holder rather than hiding the row', async (t) => {
  stub(t, { rows: [{ id: 'p2', employee_id: ID_B, ot_type: 'Weekend', hours: '5', description: null }] });
  const row = parse(await handler(event('GET'))).rows[0];
  assert.strictEqual(row.status, 'Inactive');
  assert.strictEqual(row.name, 'Gone Person');
  // The report excludes it from every total; the page has to be able to say why,
  // and offer to delete it. Hiding it is how it stays there forever.
});

test('GET marks a row whose employee was deleted', async (t) => {
  stub(t, { rows: [{ id: 'p3', employee_id: '99999999-9999-9999-9999-999999999999', ot_type: 'Weekend', hours: '5' }] });
  const row = parse(await handler(event('GET'))).rows[0];
  assert.strictEqual(row.onRoster, false);
  assert.strictEqual(row.name, null);
});

test('a missing table is a rendered empty page, not a 500', async (t) => {
  // The deploy and the migration can happen in either order. A 500 here would
  // look like a broken app rather than a migration that has not been run.
  stub(t, { fetchError: new Error('{"code":"PGRST205","message":"Could not find the table \'public.preapproved_ot\'"}') });
  const res = await handler(event('GET'));
  assert.strictEqual(res.statusCode, 200);
  const body = parse(res);
  assert.strictEqual(body.tableMissing, true);
  assert.deepStrictEqual(body.rows, []);
  assert.match(body.note, /SCHEMA_PHASE_C_PREAPPROVED_OT\.sql/);
});

test('a write against a missing table is a 409 that names the migration', async (t) => {
  stub(t, {
    rows: [],
    requestImpl: () => { throw new Error('{"code":"PGRST205","message":"Could not find the table"}'); }
  });
  const res = await handler(event('PUT', { body: { employeeId: ID_A, otType: 'Weekend', hours: 1 } }));
  assert.strictEqual(res.statusCode, 409);
  assert.match(parse(res).error, /SCHEMA_PHASE_C_PREAPPROVED_OT\.sql/);
});

test('an unreachable database is a 500', async (t) => {
  stub(t, { fetchError: new Error('JWT expired') });
  assert.strictEqual((await handler(event('GET'))).statusCode, 500);
});

test('the response is never cached', async (t) => {
  stub(t, { rows: [] });
  assert.strictEqual((await handler(event('GET'))).headers['Cache-Control'], 'no-store');
});
