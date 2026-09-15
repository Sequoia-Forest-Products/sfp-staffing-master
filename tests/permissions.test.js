// The projection, and what /api/data will and will not write.
//
// THE TIERS ARE GONE, 2026-09-15. Phase D built three of them to hold
// annual_salary back from a company-wide sign-in; access is an explicit list
// now and everyone on it sees everything, so there is no tier left to test.
// What survives is the half of Phase D that was never about tiers:
//
//   THE PROJECTION. /api/data still names its columns, in the query and again
//   on the way out, so a column added to `employees` reaches nobody until
//   somebody edits permissions-lib.js. That was the right default when it
//   protected pay from the company and it is still right now that it protects
//   the app from a column added without thinking.
//
//   THE WRITE GATE. It still REFUSES rather than silently dropping, because a
//   200 for a write that discarded half the body reports success for something
//   that did not happen.
//
// EVERY TEST HERE ASSERTS AGAINST A REAL RESPONSE, not against a template's
// intent. Phase C's suppression work found a live leak precisely because a test
// checked rendered output instead of the payload.

const test = require('node:test');
const assert = require('node:assert');
const { createHmac } = require('node:crypto');

process.env.SESSION_SECRET = 'test-session-secret';
process.env.SUPABASE_URL = 'https://example.invalid';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const perms = require('../netlify/functions/permissions-lib');
const data = require('../netlify/functions/data');

const { EMPLOYEE_READ_COLUMNS, EMPLOYEE_WRITE_COLUMNS } = perms;

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

function cookie(email) {
  const b64 = Buffer.from(JSON.stringify({ email, exp: Date.now() + 3600000 })).toString('base64url');
  return `sfp_session=${b64}.${createHmac('sha256', process.env.SESSION_SECRET).update(b64).digest('base64url')}`;
}

// A fake PostgREST. `grants` are the rows user_permissions returns; `employee`
// is the row the employees table returns, and it carries a salary so a leak has
// something to leak.
const EMPLOYEE_ROW = {
  id: 'e1', name: 'Ryley Stanley', wage: null, status: 'Active',
  employee_number: '0250', department: 'Accounting', pay_type: 'Salaried',
  cost_class: 'SG&A', position_group: null, position: 'Controller',
  annual_salary: 250000, birthday: '1985-04-02', phone: '', email: '',
  dept: '', days: 'MON-THU', clock_in: null, clock_out: null,
  break_1: '07:00', break_2: '12:45', sms_opted_out: false, text_bolt: null,
  drive_folder_id: null, address_street: null, address_city: null,
  address_state: null, address_postal_code: null, hire_date: null
};

function stub({ grants = [], employee = EMPLOYEE_ROW, permsFail = null, employeesFail = null } = {}) {
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const u = decodeURIComponent(String(url));
    calls.push({ url: u, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });

    if (u.includes('user_permissions')) {
      if (permsFail) return { ok: false, status: permsFail.status || 500, text: async () => permsFail.message, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => grants, text: async () => JSON.stringify(grants) };
    }
    if (u.includes('employees') && (opts.method || 'GET') === 'GET') {
      if (employeesFail) return { ok: false, status: 400, text: async () => employeesFail, json: async () => ({}) };
      // Answer only the columns the select= actually asked for. A fake that
      // returns everything regardless would hide the entire point of narrowing
      // the projection before the query.
      const m = /select=([^&]+)/.exec(u);
      const asked = m ? m[1].split(',') : Object.keys(employee);
      const row = {};
      for (const c of asked) if (c in employee) row[c] = employee[c];
      return { ok: true, status: 200, json: async () => [row], text: async () => JSON.stringify([row]) };
    }
    return { ok: true, status: 200, json: async () => [{ id: 'e1' }], text: async () => '[]' };
  };
  return calls;
}

const get = (email, table = 'employees') => data.handler({
  httpMethod: 'GET', headers: { cookie: cookie(email) }, queryStringParameters: { table }
});

const patch = (email, body, id = 'e1') => data.handler({
  httpMethod: 'PATCH', headers: { cookie: cookie(email) },
  queryStringParameters: { table: 'employees', id }, body: JSON.stringify(body)
});

const grant = (email, tier) => ({ email, tier });

// The salary row above is SALARIED, which is the right default for a file about
// leaking annual_salary. A wage edit against it is refused on those grounds
// before anything about permissions is reached, so the wage tests need somebody
// hourly to be about what they claim to be.
//
// cost_class is Manufacturing here and SG&A on EMPLOYEE_ROW above, which is a
// second thing this fixture has to be right about since 2026-09-14: pay is only
// held for Manufacturing, and a rate edit against any other class is refused
// before pay type or employee number is even looked at. See tests/wage-edit.js
// for that rule on its own.
const HOURLY_ROW = {
  ...EMPLOYEE_ROW,
  id: 'h1', name: 'Bo Tran', employee_number: '0101',
  pay_type: 'Hourly', wage: '24.50', annual_salary: null,
  cost_class: 'Manufacturing', department: 'Production', position: 'Sawyer'
};

// A salaried person the app still costs. EMPLOYEE_ROW above is SG&A, which
// since 2026-09-14 carries no pay at all — so it is the right fixture for a
// READ test about leaking a salary, and the wrong one for any WRITE test about
// what a tier permits: the cost class refuses those before a tier is consulted.
const SALARIED_ROW = {
  ...EMPLOYEE_ROW,
  id: 'm1', name: 'Eduardo Rivera', employee_number: '7522',
  pay_type: 'Salaried', wage: null, annual_salary: 105000,
  cost_class: 'Manufacturing', department: 'Production', position: 'Production Lead'
};

// ---------------------------------------------------------------------------
// the projection, on a real response
// ---------------------------------------------------------------------------

test('everybody signed in gets annual_salary — one list, no tiers', async () => {
  // The reversal. Until 2026-09-15 this column was absent unless the caller
  // held the salaries tier. Access is an explicit list now: being signed in
  // means somebody put you on it, and everyone on it sees the same columns.
  stub({ grants: [] });
  const res = await get('anybody@sequoiafp.com');
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(JSON.parse(res.body).data[0].annual_salary, 250000);
});

test('the select NAMES its columns, and nothing outside the list is asked for', async () => {
  // The projection is not about tiers and never only was. A select that names
  // its columns is how a column added to `employees` reaches nobody until
  // somebody edits permissions-lib.js — the deny-by-default that survived the
  // collapse.
  const calls = stub({ grants: [] });
  await get('anybody@sequoiafp.com');
  const q = calls.find(c => c.url.includes('employees') && c.url.includes('select='));
  assert.ok(q, 'no employees query was made');

  const asked = /select=([^&]+)/.exec(q.url)[1].split(',');
  assert.ok(asked.includes('annual_salary'));
  for (const col of asked) {
    assert.ok(EMPLOYEE_READ_COLUMNS.includes(col), `select asked for an ungoverned column: ${col}`);
  }
});

test('a column the list does not name never reaches the browser', async () => {
  // The second layer. The select above is a single string in a single place;
  // picking the response apart against the same list makes the guarantee
  // structural rather than dependent on the request staying correct.
  stub({ grants: [], employee: { ...EMPLOYEE_ROW, secret_note: 'do not ship this' } });
  const res = await get('anybody@sequoiafp.com');
  assert.ok(!res.body.includes('secret_note'));
  assert.ok(!res.body.includes('do not ship this'));
});

test('a session with no email still gets a projected payload, not a crash', async () => {
  stub({ grants: [] });
  const b64 = Buffer.from(JSON.stringify({ exp: Date.now() + 3600000 })).toString('base64url');
  const sig = createHmac('sha256', process.env.SESSION_SECRET).update(b64).digest('base64url');
  const res = await data.handler({
    httpMethod: 'GET', headers: { cookie: `sfp_session=${b64}.${sig}` },
    queryStringParameters: { table: 'employees' }
  });
  assert.strictEqual(res.statusCode, 200);
});

test('the roster no longer costs a permissions read at all', async () => {
  // The tiers were resolved per request, against user_permissions, before every
  // roster load. Access is checked once at SIGN-IN now — see auth.js — so this
  // endpoint has nothing left to look up, and a permissions table that is down
  // cannot take the roster with it.
  const calls = stub({ grants: [] });
  const res = await get('anybody@sequoiafp.com');
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(calls.filter(c => c.url.includes('user_permissions')).length, 0);
});

// ---------------------------------------------------------------------------
// THE WRITE GATE — the direction that was completely open
// ---------------------------------------------------------------------------

test('anybody signed in can write annual_salary — one list, no tiers', async () => {
  // The reversal, on the write side. It is the accepted cost of the collapse:
  // Eduardo's salary is held and everyone on the access list can now change it.
  const calls = stub({ grants: [], employee: SALARIED_ROW });
  const res = await patch('anybody@sequoiafp.com', { annual_salary: 110000 }, 'm1');

  assert.strictEqual(res.statusCode, 200, res.body);
  const writes = calls.filter(c => c.method === 'PATCH');
  assert.strictEqual(writes.length, 1);
  assert.deepStrictEqual(writes[0].body, { annual_salary: 110000 });
});

test('anybody can write `wage`, with no grant at all', async () => {
  // Phase D refused this for every tier: BBSI overwrote the column every
  // morning through payroll-db with the service key, so a value typed in the
  // app would have been silently replaced overnight. The daily file no longer
  // carries a rate and employees.wage is the record of truth, so the refusal
  // would now mean nobody in the company can set a pay rate anywhere.
  const calls = stub({ grants: [], employee: HOURLY_ROW });
  const res = await patch('nobody@sequoiafp.com', { wage: '26.00' }, 'h1');

  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  const writes = calls.filter(c => c.method === 'PATCH');
  assert.strictEqual(writes.length, 1);
  assert.deepStrictEqual(writes[0].body, { wage: '26.00' });
});

test('a rate change writes its history row BEFORE the rate itself', async () => {
  // The ordering is the safety property, not a detail. Once employees.wage is
  // overwritten the old rate is unrecoverable, so a failure between the two
  // writes must leave a history row with no update — never an update with no
  // history.
  const calls = stub({ grants: [], employee: HOURLY_ROW });
  const res = await patch('peter.stroble@sequoiafp.com', { wage: '26.00' }, 'h1');
  assert.strictEqual(res.statusCode, 200);

  const writes = calls.filter(c => c.method === 'POST' || c.method === 'PATCH');
  assert.strictEqual(writes.length, 2);
  assert.ok(/wage_history/.test(writes[0].url), 'the rate was overwritten before its history was recorded');
  assert.strictEqual(writes[0].method, 'POST');
  assert.ok(/employees/.test(writes[1].url));
  assert.strictEqual(writes[1].method, 'PATCH');

  const h = writes[0].body;
  assert.strictEqual(h.rate, 26);
  assert.strictEqual(h.previous_rate, 24.5);
  assert.strictEqual(h.employee_number, '0101');
  assert.strictEqual(h.employee_id, 'h1');
  assert.strictEqual(h.source, 'manual');
  assert.match(h.note, /peter\.stroble@sequoiafp\.com/);
});

test('the history row records the rate the DATABASE held, not the browser\'s', async () => {
  // A page open since this morning holds a rate somebody else may have changed
  // since. previous_rate must come from the row read inside the request, so
  // this sends a body claiming a different starting point and asserts it is
  // ignored.
  const calls = stub({ grants: [], employee: { ...HOURLY_ROW, wage: '31.00' } });
  await patch('a@sequoiafp.com', { wage: '32.00', name: HOURLY_ROW.name }, 'h1');

  const history = calls.find(c => /wage_history/.test(c.url));
  assert.strictEqual(history.body.previous_rate, 31);
  assert.strictEqual(history.body.change_pct, 3.23);
});

test('retyping the same rate writes nothing at all', async () => {
  // '24.5' over a stored '24.50' is not a change. Writing it would append a
  // history row saying a rate moved when it did not.
  const calls = stub({ grants: [], employee: HOURLY_ROW });
  const res = await patch('a@sequoiafp.com', { wage: '24.5' }, 'h1');

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(calls.filter(c => c.method === 'POST' || c.method === 'PATCH').length, 0);
});

test('an unchanged rate does not block the rest of the same PATCH', async () => {
  const calls = stub({ grants: [], employee: HOURLY_ROW });
  const res = await patch('a@sequoiafp.com', { wage: '24.50', position: 'Lead Sawyer' }, 'h1');

  assert.strictEqual(res.statusCode, 200);
  const writes = calls.filter(c => c.method === 'PATCH');
  assert.strictEqual(writes.length, 1);
  assert.deepStrictEqual(writes[0].body, { position: 'Lead Sawyer' });
});

test('a wage that cannot be recorded is refused, and nothing is written', async () => {
  // Each of these is a different mistake with a different remedy, so each gets
  // its own sentence rather than one generic rejection.
  const cases = [
    { employee: SALARIED_ROW,                          wage: '30.00', match: /salaried/i },
    // The scope refusal, which is checked before all of them: there is no rate
    // to record rather than a rate that cannot be recorded. EMPLOYEE_ROW is
    // SALARIED SG&A — since 2026-09-15 an HOURLY SG&A employee carries a rate,
    // so it is the pay type doing the refusing here, not the class on its own.
    { employee: EMPLOYEE_ROW,                          wage: '30.00', match: /SG&A/ },
    { employee: { ...HOURLY_ROW, employee_number: '' }, wage: '30.00', match: /employee number/i },
    { employee: HOURLY_ROW,                            wage: '',      match: /cannot be cleared/i },
    { employee: HOURLY_ROW,                            wage: '0',     match: /not an hourly rate/i },
    { employee: HOURLY_ROW,                            wage: 'abc',   match: /not an hourly rate/i }
  ];
  for (const c of cases) {
    const calls = stub({ grants: [], employee: c.employee });
    const res = await patch('a@sequoiafp.com', { wage: c.wage }, c.employee.id);
    assert.strictEqual(res.statusCode, 409, JSON.stringify(c));
    const payload = JSON.parse(res.body);
    assert.match(payload.error + ' ' + payload.detail, c.match);
    assert.strictEqual(calls.filter(c2 => c2.method === 'POST' || c2.method === 'PATCH').length, 0,
      'a refused wage still reached the database');
  }
});

test('a refusal is a REFUSAL, not a silent drop of the offending column', async () => {
  // Returning 200 having discarded half the body reports success for a write
  // that did not happen. The permitted half must not be written either. This
  // outlived the tiers because it was never about them: the question "is this
  // column writable through this endpoint at all" still has a real answer, and
  // it is not "any column PostgREST will accept".
  const calls = stub({ grants: [] });
  const res = await patch('anybody@sequoiafp.com', { name: 'Changed', created_at: 'now' });
  assert.strictEqual(res.statusCode, 403);
  assert.match(JSON.parse(res.body).error, /Not permitted to write: created_at/);
  assert.strictEqual(calls.filter(c => c.method === 'PATCH').length, 0,
    'the permitted columns were written while the request was refused');
});

test('annual_salary and name go together in one write', async () => {
  const calls = stub({ grants: [], employee: SALARIED_ROW });
  const res = await patch('anybody@sequoiafp.com', { annual_salary: 260000, name: 'Eduardo Rivera' }, 'm1');
  assert.strictEqual(res.statusCode, 200, res.body);

  const write = calls.find(c => c.method === 'PATCH');
  assert.deepStrictEqual(write.body, { annual_salary: 260000, name: 'Eduardo Rivera' });
});

// ---------------------------------------------------------------------------
// THE COST-CLASS SCOPE — a different question from the tier, asked after it
// ---------------------------------------------------------------------------
//
// The tier decides WHO may write a salary. pay-scope-lib decides whether the
// column applies to this PERSON at all. Holding the grant does not create a
// salary for somebody the app does not cost.

test('nobody can set a salary on somebody outside Manufacturing', async () => {
  // pay-scope-lib, not a permission. The tiers decided WHO could write the
  // column; this decides whether the column applies to this PERSON at all, and
  // it survived the collapse untouched because it was never the same question.
  const calls = stub({ grants: [] });   // EMPLOYEE_ROW is SG&A
  const res = await patch('anybody@sequoiafp.com', { annual_salary: 260000 });

  assert.strictEqual(res.statusCode, 409);
  assert.match(JSON.parse(res.body).error, /SG&A/);
  assert.strictEqual(calls.filter(c => c.method === 'PATCH').length, 0,
    'nothing may reach the database');
});

test('reclassifying somebody out of Manufacturing clears their pay, at the base tier', async () => {
  // The app's rule, not the caller's, so it is applied AFTER the tier gate: a
  // supervisor with no salaries grant must be able to move somebody to SG&A,
  // and requiring them to send annual_salary: null to do it would 403 them for
  // obeying the rule.
  const calls = stub({ grants: [], employee: SALARIED_ROW });
  const res = await patch('nobody@sequoiafp.com', { cost_class: 'SG&A' }, 'm1');

  assert.strictEqual(res.statusCode, 200, res.body);
  const write = calls.find(c => c.method === 'PATCH');
  assert.deepStrictEqual(write.body, { cost_class: 'SG&A', annual_salary: null });
});

test('a rate may be set on somebody being moved INTO Manufacturing by the same write', async () => {
  // Scoped against the class the write LANDS in. Judging it by the stored class
  // would refuse this and accept the reverse, which is the wrong way round in
  // both directions.
  const calls = stub({ grants: [], employee: { ...EMPLOYEE_ROW, id: 'x1', pay_type: 'Hourly',
                                               wage: null, annual_salary: null } });
  const res = await patch('nobody@sequoiafp.com',
    { cost_class: 'Manufacturing', wage: '26.00' }, 'x1');

  assert.strictEqual(res.statusCode, 200, res.body);
  const write = calls.find(c => c.method === 'PATCH');
  assert.deepStrictEqual(write.body, { cost_class: 'Manufacturing', wage: '26.00' });
});

// ---------------------------------------------------------------------------
// the scope is PER COLUMN since 2026-09-15
// ---------------------------------------------------------------------------
//
// SG&A carries `wage` for hourly staff — SG&A overtime is still tracked here and
// an hourly person's overtime is paid at a rate — and carries `annual_salary`
// for nobody. Everything below is the second half of that: opening one column
// must not have opened the other, and the two now clear independently.

const SGA_HOURLY = {
  ...EMPLOYEE_ROW, id: 'a1', name: 'Axeri Ramirez', employee_number: '1643',
  pay_type: 'Hourly', wage: '24.50', annual_salary: null
};

test('an hourly SG&A employee may have their rate set', async () => {
  const calls = stub({ grants: [], employee: SGA_HOURLY });
  const res = await patch('a@sequoiafp.com', { wage: '26.00' }, 'a1');

  assert.strictEqual(res.statusCode, 200, res.body);
  const write = calls.find(c => c.method === 'PATCH' && /table=employees|employees\?/.test(c.url));
  assert.strictEqual(write.body.wage, '26.00');
  // And the change is recorded, which is what makes the column safe to write.
  assert.ok(calls.some(c => c.method === 'POST' && /wage_history/.test(c.url)),
    'a rate change on an SG&A employee must still write history');
});

test('opening the wage for SG&A did NOT open annual_salary alongside it', async () => {
  // The half of the 2026-09-14 decision that stands. Everyone may write the
  // column now and still cannot put one on this person.
  const calls = stub({ grants: [], employee: SGA_HOURLY });
  const res = await patch('anybody@sequoiafp.com', { annual_salary: 120000 }, 'a1');

  assert.strictEqual(res.statusCode, 409, res.body);
  assert.match(JSON.parse(res.body).error, /SG&A/);
  assert.strictEqual(calls.filter(c => c.method === 'PATCH').length, 0);
});

test('a salaried SG&A employee is refused a rate, and told the pay type is why', async () => {
  const calls = stub({ grants: [], employee: EMPLOYEE_ROW });   // SG&A, Salaried
  const res = await patch('a@sequoiafp.com', { wage: '30.00' }, 'e1');

  assert.strictEqual(res.statusCode, 409);
  const payload = JSON.parse(res.body);
  assert.match(payload.error, /salaried SG&A/i);
  assert.match(payload.detail, /pay type/i);
  assert.strictEqual(calls.filter(c => c.method === 'PATCH').length, 0);
});

test('moving an HOURLY person from Manufacturing to SG&A keeps the rate and clears the salary', async () => {
  // The per-column clear. The all-or-nothing version nulled both, which would
  // delete the rate this person's overtime is priced at — for a move that does
  // not take the column away from them at all.
  const calls = stub({ grants: [], employee: { ...HOURLY_ROW, wage: '24.50', annual_salary: 90000 } });
  const res = await patch('nobody@sequoiafp.com', { cost_class: 'SG&A' }, 'h1');

  assert.strictEqual(res.statusCode, 200, res.body);
  const write = calls.find(c => c.method === 'PATCH');
  assert.deepStrictEqual(write.body, { cost_class: 'SG&A', annual_salary: null });
  assert.ok(!('wage' in write.body), 'the rate must not be nulled — they still carry it');
});

test('flipping an SG&A employee to Salaried clears the rate they no longer carry', async () => {
  // Pay type can now make a column inapplicable, so it triggers the same clear
  // a reclassification does. A wage left on somebody who cannot hold one is a
  // figure no screen draws and no report reads.
  const calls = stub({ grants: [], employee: SGA_HOURLY });
  const res = await patch('nobody@sequoiafp.com', { pay_type: 'Salaried' }, 'a1');

  assert.strictEqual(res.statusCode, 200, res.body);
  const write = calls.find(c => c.method === 'PATCH');
  assert.deepStrictEqual(write.body, { pay_type: 'Salaried', wage: null });
});

test('a rate may be set on an SG&A employee being made hourly by the same write', async () => {
  // The mirror of the Manufacturing case above, for the other axis. Judging the
  // write by the STORED pay type would refuse the one save that fixes somebody
  // recorded as salaried who is not.
  const calls = stub({ grants: [], employee: { ...EMPLOYEE_ROW, id: 'a2', employee_number: '1643',
                                               wage: null, annual_salary: null } });
  const res = await patch('nobody@sequoiafp.com', { pay_type: 'Hourly', wage: '24.50' }, 'a2');

  assert.strictEqual(res.statusCode, 200, res.body);
  const write = calls.find(c => c.method === 'PATCH');
  assert.deepStrictEqual(write.body, { pay_type: 'Hourly', wage: '24.50' });
});

test('flipping a MANUFACTURING person to Salaried does not clear their rate', async () => {
  // Manufacturing carries both columns whatever the pay type, so nothing became
  // inapplicable here and nothing is cleared. Pinned because the per-column
  // clear now runs on a pay_type change, and over-reaching would silently
  // delete a production rate.
  const calls = stub({ grants: [], employee: { ...HOURLY_ROW, wage: '24.50' } });
  const res = await patch('nobody@sequoiafp.com', { pay_type: 'Salaried' }, 'h1');

  assert.strictEqual(res.statusCode, 200, res.body);
  const write = calls.find(c => c.method === 'PATCH');
  assert.deepStrictEqual(write.body, { pay_type: 'Salaried' });
});

test('a write response never carries a column the caller may not read', async () => {
  // db.js sends Prefer: return=representation, so PostgREST answers a PATCH
  // with the whole row. The GET path is projected from the caller's tiers; this
  // one was not, so a base-tier account could read any salary by PATCHing a
  // phone number to its current value. Found 2026-09-14.
  stub({ grants: [], employee: SALARIED_ROW });
  const res = await patch('nobody@sequoiafp.com', { phone: '555-0100' }, 'm1');

  assert.strictEqual(res.statusCode, 200);
  const returned = JSON.parse(res.body).data;
  const rows = Array.isArray(returned) ? returned : [returned];
  for (const row of rows) assert.ok(!('annual_salary' in row), 'the salary came back on a write');
});

test('an ordinary profile save is unaffected', async () => {
  const calls = stub({ grants: [] });
  const res = await patch('nobody@sequoiafp.com', {
    name: 'Ana Reyes', phone: '555-0100', department: 'Production',
    break_1: '07:00', position: 'Puller'
  });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(calls.filter(c => c.method === 'PATCH').length, 1);
});

test('POST is gated the same way as PATCH', async () => {
  // A column nobody lists is not writable through a different verb either.
  const calls = stub({ grants: [] });
  const res = await data.handler({
    httpMethod: 'POST', headers: { cookie: cookie('anybody@sequoiafp.com') },
    queryStringParameters: { table: 'employees' },
    body: JSON.stringify({ name: 'New Hire', some_future_column: 'x' })
  });
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(calls.filter(c => c.method === 'POST').length, 0);
});

test('a new hire created with a salary is scoped by cost class, not by a tier', async () => {
  // The other half of the POST path. Unclassified carries no pay, so this is
  // refused for everybody — and it is a 409 about the row, not a 403 about the
  // caller.
  const calls = stub({ grants: [] });
  const res = await data.handler({
    httpMethod: 'POST', headers: { cookie: cookie('anybody@sequoiafp.com') },
    queryStringParameters: { table: 'employees' },
    body: JSON.stringify({ name: 'New Hire', annual_salary: 500000 })
  });
  assert.strictEqual(res.statusCode, 409);
  assert.match(JSON.parse(res.body).error, /cost class/i);
  assert.strictEqual(calls.filter(c => c.method === 'POST').length, 0);
});

test('a column nobody has heard of is refused rather than forwarded', async () => {
  // Deny by default, applied to writes. A column added to the table is not
  // writable through this endpoint until somebody lists it.
  const calls = stub({ grants: [] });
  const res = await patch('anybody@sequoiafp.com', { some_future_column: 'x' });
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(calls.filter(c => c.method === 'PATCH').length, 0);
});

test('tables that hold no pay are not column-gated', async () => {
  // overtime and points carry no compensation. Gating them by column would be
  // scope creep with a maintenance cost and no benefit.
  const calls = stub({ grants: [] });
  const res = await data.handler({
    httpMethod: 'PATCH', headers: { cookie: cookie('nobody@sequoiafp.com') },
    queryStringParameters: { table: 'points', id: 'p1' },
    body: JSON.stringify({ points: 3, anything: 'goes' })
  });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(calls.filter(c => c.method === 'PATCH').length, 1);
});

// ---------------------------------------------------------------------------
// the registry itself
// ---------------------------------------------------------------------------

test('every writable column is also readable', async () => {
  // The asymmetry Phase D was built to fix: annual_salary was carefully kept
  // out of the read projection while being freely writable. The tiers are gone
  // but the shape of that failure is not — a column somebody can set and then
  // cannot see is a value nobody can check.
  for (const col of EMPLOYEE_WRITE_COLUMNS) {
    assert.ok(EMPLOYEE_READ_COLUMNS.includes(col),
      `${col} can be written and never read back`);
  }
});

test('both pay columns are in both lists, which is the whole collapse', async () => {
  for (const col of ['wage', 'annual_salary']) {
    assert.ok(EMPLOYEE_READ_COLUMNS.includes(col), `${col} is not readable`);
    assert.ok(EMPLOYEE_WRITE_COLUMNS.includes(col), `${col} is not writable`);
  }
});

test('the columns nothing should set through this endpoint are absent from the write list', async () => {
  for (const col of ['id', 'created_at', 'updated_at']) {
    assert.ok(!EMPLOYEE_WRITE_COLUMNS.includes(col), `${col} is writable through /api/data`);
  }
});

test('the access list is resolved case-insensitively and deduplicated', async () => {
  // An entry that fails to match because of a capital letter is access that
  // looks granted and is not, and nothing would ever report it. Peter holds two
  // rows from the tier model; he is one person.
  const rows = [
    { email: '  Peter.Stroble@SequoiaFP.com ' },
    { email: 'peter.stroble@sequoiafp.com' },
    { email: 'ryley.stanley@sequoiafp.com' },
    { email: '' },
    { email: null }
  ];
  assert.deepStrictEqual(perms.resolveAccessList(rows),
    ['peter.stroble@sequoiafp.com', 'ryley.stanley@sequoiafp.com']);
  assert.strictEqual(perms.hasAccess('PETER.STROBLE@sequoiafp.com', rows), true);
  assert.strictEqual(perms.hasAccess('nobody@sequoiafp.com', rows), false);
  assert.strictEqual(perms.hasAccess('', rows), false);
});

// ---------------------------------------------------------------------------
// the write paths the column gate cannot cover
// ---------------------------------------------------------------------------

test('PUT is refused on employees, and replaceAll never runs', async () => {
  // replaceAll DELETES the table and re-inserts the request body. A column gate
  // is the wrong instrument against that: refusing annual_salary in the payload
  // still leaves a request that drops every employee row and rebuilds the
  // roster from whatever the browser was holding. So the method is closed.
  const calls = stub({ grants: [] });
  const res = await data.handler({
    httpMethod: 'PUT', headers: { cookie: cookie('admin@sequoiafp.com') },
    queryStringParameters: { table: 'employees' },
    body: JSON.stringify({ rows: [{ id: 'e1', name: 'Ryley Stanley', annual_salary: 1 }] })
  });

  assert.strictEqual(res.statusCode, 405);
  // The one that matters: no DELETE and no bulk POST reached the database.
  const writes = calls.filter(c => c.method !== 'GET' && c.url.includes('employees'));
  assert.deepStrictEqual(writes, [], 'nothing was written to employees');
  // Not even the highest tier gets through. This is not a permission question.
  assert.ok(!res.body.includes('annual_salary'));
});

test('PUT still works on the tables it was built for', async () => {
  stub();
  const res = await data.handler({
    httpMethod: 'PUT', headers: { cookie: cookie('anyone@sequoiafp.com') },
    queryStringParameters: { table: 'points' },
    body: JSON.stringify({ rows: [{ name: 'Ana Reyes', points: 3 }] })
  });
  assert.strictEqual(res.statusCode, 200);
});

test('a missing hire_date costs hire_date and nothing else, and says so out loud', async () => {
  // The rung exists so that a database without SCHEMA_PHASE_D_PERMISSIONS.sql
  // does not fall all the way through to the pre-Phase-B projection, taking
  // `position` and the addresses off everybody's profile card.
  const asked = [];
  global.fetch = async (url, opts = {}) => {
    const u = decodeURIComponent(String(url));
    if (u.includes('user_permissions')) return { ok: true, status: 200, json: async () => [], text: async () => '[]' };
    const cols = (/select=([^&]+)/.exec(u) || [, ''])[1].split(',');
    asked.push(cols);
    if (cols.includes('hire_date')) {
      return { ok: false, status: 400,
               text: async () => 'column employees.hire_date does not exist (42703)',
               json: async () => ({}) };
    }
    const row = {};
    for (const c of cols) if (c in EMPLOYEE_ROW) row[c] = EMPLOYEE_ROW[c];
    return { ok: true, status: 200, json: async () => [row], text: async () => JSON.stringify([row]) };
  };

  const warned = [];
  const realWarn = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  let res;
  try { res = await get('anyone@sequoiafp.com'); } finally { console.warn = realWarn; }

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(asked.length, 2, 'it fell exactly one rung, not through to pre-v2');
  assert.ok(!asked[1].includes('hire_date'));
  // The columns the lower rungs would have cost are all still there.
  for (const col of ['position', 'address_street', 'pay_type', 'cost_class', 'position_group']) {
    assert.ok(asked[1].includes(col), `${col} must survive a missing hire_date`);
  }
  // And the warning naming the migration actually printed. Building the ladder
  // twice made indexOf(rung) return -1, which landed on rung 0 — whose
  // `missing` is null — so this was silent.
  assert.ok(warned.some(w => /SCHEMA_PHASE_D_PERMISSIONS\.sql/.test(w)),
    'the console warning naming the unrun migration printed; got: ' + JSON.stringify(warned));
});

// ---------------------------------------------------------------------------
// the bootstrap seed, read out of the migration itself
// ---------------------------------------------------------------------------
// the migration's seed, checked against the resolver that will read it
// ---------------------------------------------------------------------------

test('the access-list seed is the UNION of both old lists, and resolves', () => {
  // Taking either list alone would silently drop people: the grant list alone
  // unsubscribes four managers from the weekly report, and the recipient list
  // alone locks Ryley out of the app.
  const fs = require('node:fs');
  const path = require('node:path');
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'SCHEMA_ACCESS_LIST.sql'), 'utf8');

  const block = /insert into user_permissions[^;]*?values([\s\S]*?)on conflict/i.exec(sql);
  assert.ok(block, 'the seed insert is still in the migration');

  const rows = [];
  for (const m of block[1].matchAll(/\(\s*'([^']+)'\s*,\s*'([^']+)'/g)) {
    rows.push({ email: m[1], tier: m[2] });
  }

  const list = perms.resolveAccessList(rows);
  assert.deepStrictEqual(list, [
    'cyle.coburn@sequoiafp.com',
    'eduardo.rivera@sequoiafp.com',
    'jeffrey.cook@sequoiafp.com',
    'peter.stroble@sequoiafp.com',
    'ryley.stanley@sequoiafp.com',
    'tony.griffith@sequoiafp.com',
    'travis.vance@sequoiafp.com'
  ]);

  // Everyone who held a grant.
  for (const email of ['peter.stroble@sequoiafp.com', 'ryley.stanley@sequoiafp.com',
                       'jeffrey.cook@sequoiafp.com']) {
    assert.ok(perms.hasAccess(email, rows), `${email} held a grant and lost access`);
  }
  // Everyone who was receiving the weekly report.
  for (const email of ['tony.griffith@sequoiafp.com', 'travis.vance@sequoiafp.com',
                       'cyle.coburn@sequoiafp.com', 'eduardo.rivera@sequoiafp.com']) {
    assert.ok(perms.hasAccess(email, rows), `${email} was a recipient and lost the email`);
  }

  // THE TYPO IS NOT SEEDED, and that is a decision rather than an omission.
  // The recipient list carried jefrey.cook@ with one f while user_permissions
  // carried jeffrey.cook@ with two — one person under two spellings, and
  // nothing in the app could ever have noticed. Seeding both would put them on
  // the list twice, one of those under an address that may not receive mail.
  assert.ok(!perms.hasAccess('jefrey.cook@sequoiafp.com', rows),
    'the one-f spelling was seeded; it should be added by hand if it is the right one');

  assert.ok(!perms.hasAccess('someone.else@sequoiafp.com', rows));

  // Every seeded row satisfies the constraints the table puts on the column.
  for (const r of rows) {
    assert.strictEqual(r.email, r.email.trim().toLowerCase(),
      `${r.email} violates user_permissions_email_canonical`);
    assert.match(r.email, /.@./, `${r.email} violates user_permissions_email_shape`);
    assert.ok(['access', 'salaries', 'admin'].includes(r.tier),
      `${r.tier} violates user_permissions_tier_check`);
  }
});

test('the migration widens the tier CHECK before it seeds', () => {
  // The seed writes tier='access', which the Phase D constraint rejects. The
  // order in the file is load-bearing: §2 before §3.
  const fs = require('node:fs');
  const path = require('node:path');
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'SCHEMA_ACCESS_LIST.sql'), 'utf8');

  const widen = sql.indexOf("check (tier in ('access'");
  const seed  = sql.search(/insert into user_permissions/i);
  assert.ok(widen > -1, 'the CHECK is not widened');
  assert.ok(widen < seed, 'the seed runs before the constraint accepts it');

  // And the last-admin trigger goes with the tier it guarded.
  assert.match(sql, /drop trigger if exists user_permissions_keep_an_admin on/);
  assert.match(sql, /drop trigger if exists user_permissions_keep_an_admin_truncate on/);
});
