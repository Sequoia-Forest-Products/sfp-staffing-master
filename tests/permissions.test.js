// Phase D — the permission gate.
//
// Written before the pages that consume it, because the hard part is not
// showing a salary, it is that the figure never reaches a browser that should
// not have it.
//
// EVERY TEST HERE ASSERTS AGAINST A REAL RESPONSE, not against a template's
// intent. The distinction is the whole point: Phase C's suppression work found
// a live leak precisely because a test checked rendered output instead of the
// payload, and Phase B's projection exists because a tab that declines to
// render a figure still ships it.
//
// The negative case is the one that matters. "A user with the tier sees the
// salary" failing is an inconvenience; "a user without it does not" failing is
// the thing this phase exists to prevent.

const test = require('node:test');
const assert = require('node:assert');
const { createHmac } = require('node:crypto');

process.env.SESSION_SECRET = 'test-session-secret';
process.env.SUPABASE_URL = 'https://example.invalid';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const perms = require('../netlify/functions/permissions-lib');
const data = require('../netlify/functions/data');

const {
  TIER_HOURLY_WAGES, TIER_SALARIES, TIER_ADMIN, GRANTABLE_TIERS
} = perms;

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
const HOURLY_ROW = {
  ...EMPLOYEE_ROW,
  id: 'h1', name: 'Bo Tran', employee_number: '0101',
  pay_type: 'Hourly', wage: '24.50', annual_salary: null,
  department: 'Production', position: 'Sawyer'
};

// ---------------------------------------------------------------------------
// THE negative case, on a real response
// ---------------------------------------------------------------------------

test('a user without the salaries tier gets a payload with annual_salary ABSENT', async () => {
  stub({ grants: [] });
  const res = await get('nobody@sequoiafp.com');
  assert.strictEqual(res.statusCode, 200);

  const row = JSON.parse(res.body).data[0];
  // Absent, not null, not empty string. `in` rather than a truthiness check:
  // a present key holding null is still a key that says the column exists.
  assert.ok(!('annual_salary' in row), 'the key is present in the payload');
  // And nothing that looks like the figure survived anywhere in the bytes.
  assert.ok(!res.body.includes('250000'), 'the salary value is in the response');
  assert.ok(!res.body.includes('annual_salary'), 'the column name is in the response');
});

test('the column is never even ASKED FOR without the tier', async () => {
  // Filtering the answer is not enough on its own. The select= must not name
  // the column, so it does not travel from the database to the function either
  // — which is what makes a later mistake in the response filter survivable.
  const calls = stub({ grants: [] });
  await get('nobody@sequoiafp.com');
  const q = calls.find(c => c.url.includes('employees') && c.url.includes('select='));
  assert.ok(q, 'no employees query was made');
  assert.ok(!q.url.includes('annual_salary'), `select named the column: ${q.url}`);
});

test('a user WITH the salaries tier gets it', async () => {
  stub({ grants: [grant('ryley@sequoiafp.com', TIER_SALARIES)] });
  const row = JSON.parse((await get('ryley@sequoiafp.com')).body).data[0];
  assert.strictEqual(row.annual_salary, 250000);
});

test('the grant matches regardless of how the email was capitalised', async () => {
  // A grant typed by hand on the admin page will not be canonical, and one that
  // fails to match on a capital letter is a grant that looks made and is not.
  stub({ grants: [grant('  Ryley@SequoiaFP.com ', TIER_SALARIES)] });
  const row = JSON.parse((await get('ryley@sequoiafp.com')).body).data[0];
  assert.strictEqual(row.annual_salary, 250000);
});

test('one person\'s grant does not leak to anybody else', async () => {
  stub({ grants: [grant('ryley@sequoiafp.com', TIER_SALARIES)] });
  const row = JSON.parse((await get('someone.else@sequoiafp.com')).body).data[0];
  assert.ok(!('annual_salary' in row));
});

test('the admin tier does not by itself unlock compensation', async () => {
  // Admin grants access; it does not read pay. Conflating the two would make
  // every future administrator a salary reader by side effect.
  stub({ grants: [grant('admin@sequoiafp.com', TIER_ADMIN)] });
  const row = JSON.parse((await get('admin@sequoiafp.com')).body).data[0];
  assert.ok(!('annual_salary' in row));
});

// ---------------------------------------------------------------------------
// fail closed
// ---------------------------------------------------------------------------

test('a permissions table that does not exist yet leaves everybody on the base tier', async () => {
  // Lets the code deploy before the migration. In that window annual_salary is
  // hidden from everyone, which is exactly the pre-Phase-D behaviour.
  stub({ grants: [], permsFail: { status: 404, message: 'PGRST205 could not find the table' } });
  const res = await get('ryley@sequoiafp.com');
  assert.strictEqual(res.statusCode, 200);
  assert.ok(!('annual_salary' in JSON.parse(res.body).data[0]));
});

test('a permissions read that ERRORS denies rather than grants', async () => {
  // A database that cannot be reached must not be an open door. It costs an
  // admin their admin until it recovers; that is the correct trade, and is why
  // the migration documents a plain-SQL recovery path.
  stub({ grants: [], permsFail: { status: 500, message: 'connection refused' } });
  const res = await get('ryley@sequoiafp.com');
  assert.strictEqual(res.statusCode, 200, 'the roster still loads');
  assert.ok(!('annual_salary' in JSON.parse(res.body).data[0]));
});

test('an unrecognised tier in the table grants nothing and does not throw', async () => {
  stub({ grants: [grant('x@sequoiafp.com', 'salarys'), grant('x@sequoiafp.com', 'SALARIES ')] });
  const row = JSON.parse((await get('x@sequoiafp.com')).body).data[0];
  // 'SALARIES ' normalises and IS honoured; 'salarys' is a typo and is not.
  assert.strictEqual(row.annual_salary, 250000);

  stub({ grants: [grant('y@sequoiafp.com', 'salarys'), grant('y@sequoiafp.com', 'superuser')] });
  assert.ok(!('annual_salary' in JSON.parse((await get('y@sequoiafp.com')).body).data[0]));
});

test('a session with no email gets the base tier, not a crash', async () => {
  stub({ grants: [grant('', TIER_SALARIES)] });
  const b64 = Buffer.from(JSON.stringify({ exp: Date.now() + 3600000 })).toString('base64url');
  const sig = createHmac('sha256', process.env.SESSION_SECRET).update(b64).digest('base64url');
  const res = await data.handler({
    httpMethod: 'GET', headers: { cookie: `sfp_session=${b64}.${sig}` },
    queryStringParameters: { table: 'employees' }
  });
  assert.strictEqual(res.statusCode, 200);
  assert.ok(!('annual_salary' in JSON.parse(res.body).data[0]));
});

// ---------------------------------------------------------------------------
// THE WRITE GATE — the direction that was completely open
// ---------------------------------------------------------------------------

test('a user without the tier cannot WRITE annual_salary, and nothing reaches the database', async () => {
  // Before Phase D this returned 200 and forwarded the column straight to
  // PostgREST. The read gate was the only gate, so any signed-in account could
  // set anybody's salary — a column it could not itself read back.
  const calls = stub({ grants: [] });
  const res = await patch('nobody@sequoiafp.com', { name: 'Legit', annual_salary: 999999 });

  assert.strictEqual(res.statusCode, 403);
  assert.match(JSON.parse(res.body).error, /Not permitted to write: annual_salary/);
  assert.strictEqual(calls.filter(c => c.method === 'PATCH').length, 0,
    'a write reached the database despite the refusal');
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
    { employee: EMPLOYEE_ROW,                          wage: '30.00', match: /salaried/i },
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

test('`wage` being writable did not open `annual_salary` alongside it', async () => {
  // The two live in the same body on the same page. A base-tier account sending
  // both must have the salary refused and — because a refusal is a refusal —
  // the wage not written either.
  const calls = stub({ grants: [] });
  const res = await patch('nobody@sequoiafp.com', { wage: '99.00', annual_salary: 250000 });

  assert.strictEqual(res.statusCode, 403);
  assert.match(JSON.parse(res.body).error, /Not permitted to write: annual_salary/);
  assert.strictEqual(calls.filter(c => c.method === 'PATCH').length, 0);
});

test('a refusal is a REFUSAL, not a silent drop of the offending column', async () => {
  // Returning 200 having discarded half the body reports success for a write
  // that did not happen. The permitted half must not be written either.
  const calls = stub({ grants: [] });
  const res = await patch('nobody@sequoiafp.com', { name: 'Changed', annual_salary: 1 });
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(calls.filter(c => c.method === 'PATCH').length, 0,
    'the permitted columns were written while the request was refused');
});

test('a user WITH the tier can write annual_salary, and only that column goes', async () => {
  const calls = stub({ grants: [grant('ryley@sequoiafp.com', TIER_SALARIES)] });
  const res = await patch('ryley@sequoiafp.com', { annual_salary: 260000, name: 'Ryley Stanley' });
  assert.strictEqual(res.statusCode, 200);

  const write = calls.find(c => c.method === 'PATCH');
  assert.deepStrictEqual(write.body, { annual_salary: 260000, name: 'Ryley Stanley' });
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
  // A new employee created with a salary would be the same hole through a
  // different verb.
  const calls = stub({ grants: [] });
  const res = await data.handler({
    httpMethod: 'POST', headers: { cookie: cookie('nobody@sequoiafp.com') },
    queryStringParameters: { table: 'employees' },
    body: JSON.stringify({ name: 'New Hire', annual_salary: 500000 })
  });
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(calls.filter(c => c.method === 'POST').length, 0);
});

test('a column nobody has heard of is refused rather than forwarded', async () => {
  // Deny by default, applied to writes. A column added to the table is not
  // writable through this endpoint until somebody lists it.
  const calls = stub({ grants: [grant('r@sequoiafp.com', TIER_SALARIES)] });
  const res = await patch('r@sequoiafp.com', { some_future_column: 'x' });
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

test('read and write lists cannot drift apart on a gated column', async () => {
  // The asymmetry this phase was built to fix: annual_salary was carefully kept
  // out of the read projection while being freely writable. Any column gated in
  // one direction must be gated in the other.
  for (const col of perms.gatedColumns()) {
    const base = perms.resolveTiers('x@y.com', []);
    assert.ok(!perms.employeeReadColumns(base).includes(col),
      `${col} is gated for writing but readable by the base tier`);
    assert.ok(!perms.employeeWriteColumns(base).includes(col),
      `${col} is gated for reading but writable by the base tier`);
  }
});

test('the base tier is implicit and is never a stored grant', async () => {
  // Storing it would invite the reading that a missing row means no access at
  // all, when it means exactly the base.
  assert.ok(!GRANTABLE_TIERS.includes(TIER_HOURLY_WAGES));
  assert.deepStrictEqual(Array.from(GRANTABLE_TIERS), [TIER_SALARIES, TIER_ADMIN]);
  assert.ok(perms.resolveTiers('x@y.com', []).has(TIER_HOURLY_WAGES));
});

test('hourly wages are the base tier by decision, and that is pinned', async () => {
  // `wage` being readable by everyone is a state Peter accepted, not an
  // oversight. Pinned so that changing it is deliberate.
  const base = perms.resolveTiers('x@y.com', []);
  assert.ok(perms.employeeReadColumns(base).includes('wage'));
});

// ---------------------------------------------------------------------------
// the write paths the column gate cannot cover
// ---------------------------------------------------------------------------

test('PUT is refused on employees, and replaceAll never runs', async () => {
  // replaceAll DELETES the table and re-inserts the request body. A column gate
  // is the wrong instrument against that: refusing annual_salary in the payload
  // still leaves a request that drops every employee row and rebuilds the
  // roster from whatever the browser was holding. So the method is closed.
  const calls = stub({ grants: [grant('admin@sequoiafp.com', TIER_ADMIN),
                               grant('admin@sequoiafp.com', TIER_SALARIES)] });
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

test('the seeded grants resolve to the tiers they were written for', () => {
  // Parsed from SCHEMA_PHASE_D_PERMISSIONS.sql rather than restated here. A
  // seed and a test that agree because somebody typed them both the same way
  // agree about nothing; this fails if the migration is edited and the intent
  // is not.
  //
  // The near-miss this guards against is real and already happened once, in
  // the good direction: the pattern two of these three follow gives
  // jeff.cook@, and Jeff's actual address is jeffrey.cook@. §0c of the
  // migration caught it before the insert was written. A wrong address inserts
  // cleanly, grants nothing, and is never reported by anything — so the seed is
  // worth pinning.
  const fs = require('node:fs');
  const path = require('node:path');
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'SCHEMA_PHASE_D_PERMISSIONS.sql'), 'utf8');

  const block = /insert into user_permissions[^;]*?values([\s\S]*?)on conflict/i.exec(sql);
  assert.ok(block, 'the seed insert is still in the migration');

  const rows = [];
  for (const m of block[1].matchAll(/\(\s*'([^']+)'\s*,\s*'([^']+)'/g)) {
    rows.push({ email: m[1], tier: m[2] });
  }
  assert.strictEqual(rows.length, 5, 'five grants across three people');

  const tiersOf = (email) => Array.from(perms.resolveTiers(email, rows)).sort();

  assert.deepStrictEqual(tiersOf('peter.stroble@sequoiafp.com'),
    ['admin', 'hourly_wages', 'salaries']);
  assert.deepStrictEqual(tiersOf('ryley.stanley@sequoiafp.com'),
    ['admin', 'hourly_wages', 'salaries']);
  assert.deepStrictEqual(tiersOf('jeffrey.cook@sequoiafp.com'),
    ['hourly_wages', 'salaries'], 'Jeff gets salaries and NOT admin');

  // The guess, kept as a live assertion rather than a comment: it must resolve
  // to the base tier and nothing more.
  assert.deepStrictEqual(tiersOf('jeff.cook@sequoiafp.com'), ['hourly_wages']);
  assert.deepStrictEqual(tiersOf('someone.else@sequoiafp.com'), ['hourly_wages']);

  // Every seeded row satisfies the constraints the migration puts on the column,
  // so the file cannot be edited into an insert the database would reject.
  for (const r of rows) {
    assert.strictEqual(r.email, r.email.trim().toLowerCase(),
      `${r.email} violates user_permissions_email_canonical`);
    assert.match(r.email, /.@./, `${r.email} violates user_permissions_email_shape`);
    assert.ok(GRANTABLE_TIERS.includes(r.tier),
      `${r.tier} violates user_permissions_tier_check`);
  }
});
