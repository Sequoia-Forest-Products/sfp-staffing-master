// Cost allocations — /api/allocations, its 100% rule, and the profile-card UI.
//
// The failure this exists to prevent: a 90% allocation. Nothing on any screen
// would show it. Every department figure would look plausible and the total would
// just be quietly 10% short — the same class of silent shortfall this project has
// found after the fact several times.
//
// So the rule is enforced three times over, deliberately: in the UI (so the Save
// button is disabled), in the API (so a hand-made request is refused with a
// readable message), and in the database (a deferred constraint trigger, so it
// holds regardless of what any caller does). These tests cover the first two; the
// third is verified by SCHEMA_PHASE_C_ALLOCATIONS.sql §6c, which asks the
// database to reject a 90% allocation and fails loudly if it does not.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHmac } = require('crypto');

process.env.SESSION_SECRET = 'test-session-secret';
process.env.SUPABASE_URL = 'https://example.invalid';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const payrollDb = require('../netlify/functions/payroll-db');
const { handler, __test } = require('../netlify/functions/allocations');
const { buildCostReport, splitToCents } = require('../netlify/functions/cost-lib');

const JEFF = '11111111-1111-1111-1111-111111111111';
const AXERI = '22222222-2222-2222-2222-222222222222';

function cookie() {
  const b64 = Buffer.from(JSON.stringify({ email: 'peter.stroble@sequoiafp.com', exp: Date.now() + 3600000 }))
    .toString('base64url');
  return `sfp_session=${b64}.${createHmac('sha256', 'test-session-secret').update(b64).digest('base64url')}`;
}

const event = (method, { body, noCookie } = {}) => ({
  httpMethod: method,
  headers: noCookie ? {} : { cookie: cookie() },
  queryStringParameters: {},
  body: body === undefined ? null : JSON.stringify(body)
});

const EMPLOYEES = [
  { id: JEFF, name: 'Jeff Cook', employee_number: '0201', department: 'Sales & Marketing',
    cost_class: 'SG&A', status: 'Active', pay_type: 'Salaried', wage: 'Salary', annual_salary: 375000 },
  { id: AXERI, name: 'Axeri Ramirez', employee_number: '0300', department: 'Accounting',
    cost_class: 'SG&A', status: 'Active', pay_type: 'Hourly', wage: '30.00' }
];

function stub(t, { rows = [], employees = EMPLOYEES, fetchError, requestImpl } = {}) {
  const real = {
    fetchAllocations: payrollDb.fetchAllocations,
    fetchEmployees: payrollDb.fetchEmployees,
    request: payrollDb.request
  };
  t.after(() => Object.assign(payrollDb, real));

  const calls = [];
  payrollDb.fetchAllocations = async () => { if (fetchError) throw fetchError; return rows; };
  payrollDb.fetchEmployees = async () => employees;
  payrollDb.request = async (method, path, opts) => {
    calls.push({ method, path, opts });
    if (requestImpl) return requestImpl(method, path, opts);
    return { rows: (opts.body.p_rows || []).map((r, i) => ({ id: 'a' + i, employee_id: opts.body.p_employee_id, ...r })), total: null };
  };
  return calls;
}

const parse = (res) => JSON.parse(res.body);
const put = (body) => handler(event('PUT', { body }));

// ---------------------------------------------------------------------------
// THE rule
// ---------------------------------------------------------------------------

test('a partial allocation is refused, and the message says what would be lost', async (t) => {
  const calls = stub(t);
  const res = await put({ employeeId: JEFF, rows: [{ department: 'Corporate', percent: 90 }] });

  assert.strictEqual(res.statusCode, 400);
  const { error } = parse(res);
  assert.match(error, /add up to 90%, not 100%/);
  assert.match(error, /10% of this person's cost would land nowhere/);
  assert.match(error, /every department total would be quietly short/);
  assert.strictEqual(calls.length, 0, 'nothing reached the database');
});

test('an over-allocation is refused, and says the cost would be double-counted', async (t) => {
  const calls = stub(t);
  const res = await put({ employeeId: JEFF, rows: [
    { department: 'Corporate', percent: 60 }, { department: 'Sales & Marketing', percent: 60 }
  ]});
  assert.strictEqual(res.statusCode, 400);
  assert.match(parse(res).error, /120%.*counted twice/s);
  assert.strictEqual(calls.length, 0);
});

test('the two real allocations are accepted', async (t) => {
  const calls = stub(t);

  const jeff = await put({ employeeId: JEFF, rows: [
    { department: 'Corporate', percent: 50 }, { department: 'Sales & Marketing', percent: 50 }
  ]});
  assert.strictEqual(jeff.statusCode, 200);

  // Thirds. 100/3 is not representable to two decimals and the sum must be
  // EXACTLY 100 — a tolerance would let real shortfalls through, which is the
  // thing the rule exists to stop. So the odd hundredth goes on the primary
  // department, the same rule the cost report uses for rounding remainders.
  const axeri = await put({ employeeId: AXERI, rows: [
    { department: 'Accounting', percent: 33.34 },
    { department: 'Corporate', percent: 33.33 },
    { department: 'HR', percent: 33.33 }
  ]});
  assert.strictEqual(axeri.statusCode, 200, JSON.stringify(parse(axeri)));
  assert.strictEqual(calls.length, 2);
});

test('a valid split whose floats do not sum to 100 is still accepted', () => {
  // Thirds happen to add up exactly in IEEE 754 — 33.34 + 33.33 + 33.33 is
  // precisely 100 — so they are not the case that matters. Sixths are: six
  // shares of 16.66 with 16.70 on the primary is an exact 100 in hundredths and
  // 99.99999999999999 as a running float sum. A strict `!== 100` on the float
  // would reject a split the database stores happily, so the comparison is done
  // in integer hundredths.
  const sixths = [16.70, 16.66, 16.66, 16.66, 16.66, 16.66];
  let naive = 0;
  for (const v of sixths) naive += v;
  assert.notStrictEqual(naive, 100, 'this is the case integer hundredths exist for');
  assert.strictEqual(Math.round(naive * 100), 10000);

  const departments = ['Accounting', 'Corporate', 'HR', 'Procurement', 'Sales & Marketing', 'Mill Overhead'];
  const { error } = __test.validateSet({
    employeeId: AXERI,
    rows: sixths.map((percent, i) => ({ department: departments[i], percent }))
  });
  assert.strictEqual(error, undefined, `a split summing to exactly 100 was rejected: ${error}`);

  // And thirds, the split actually in use, obviously still validate.
  assert.strictEqual(__test.validateSet({ employeeId: AXERI, rows: [
    { department: 'Accounting', percent: 33.34 },
    { department: 'Corporate', percent: 33.33 },
    { department: 'HR', percent: 33.33 }
  ]}).error, undefined);
});

test('an empty set removes the allocation rather than erroring', async (t) => {
  // A real operation: it puts the person back to 100% of their primary
  // department. Treating it as an error would leave no way to undo a split.
  const calls = stub(t);
  const res = await put({ employeeId: JEFF, rows: [] });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(parse(res).removed, true);
  assert.deepStrictEqual(calls[0].opts.body.p_rows, []);
});

test('the write is one atomic call, not a delete followed by an insert', async (t) => {
  // PostgREST gives each HTTP request its own transaction. Assembling the delete
  // and the insert here would be two transactions with a window in between where
  // the split is wrong — and insert-then-delete would trip the deferred check on
  // a sum over 100.
  const calls = stub(t);
  await put({ employeeId: JEFF, rows: [
    { department: 'Corporate', percent: 50 }, { department: 'Sales & Marketing', percent: 50 }
  ]});
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].method, 'POST');
  assert.strictEqual(calls[0].path, 'rpc/set_employee_allocations');
  assert.ok(!calls.some(c => c.method === 'DELETE'));
});

test('the write is scoped to one employee and cannot touch anybody else', async (t) => {
  const calls = stub(t);
  await put({ employeeId: AXERI, rows: [
    { department: 'Accounting', percent: 33.34 },
    { department: 'Corporate', percent: 33.33 },
    { department: 'HR', percent: 33.33 }
  ]});
  assert.strictEqual(calls[0].opts.body.p_employee_id, AXERI);
  assert.ok(!JSON.stringify(calls[0].opts.body).includes(JEFF));
});

// ---------------------------------------------------------------------------
// validation detail
// ---------------------------------------------------------------------------

test('an allocation is keyed on a UUID, not a name', async (t) => {
  const calls = stub(t);
  for (const employeeId of ['Jeff Cook', '', '0201', undefined, 7, {}]) {
    const res = await put({ employeeId, rows: [{ department: 'Corporate', percent: 100 }] });
    assert.strictEqual(res.statusCode, 400, JSON.stringify(employeeId));
    assert.match(parse(res).error, /belongs to a person, not a name/);
  }
  assert.strictEqual(calls.length, 0);
});

test('a department cannot appear twice', async (t) => {
  const res = await put({ employeeId: JEFF, rows: [
    { department: 'Corporate', percent: 50 }, { department: 'Corporate', percent: 50 }
  ]});
  assert.strictEqual(res.statusCode, 400);
  assert.match(parse(res).error, /appears twice/);
});

test('a zero share is refused — remove the row instead', async (t) => {
  // A department getting nothing is a department that should not be in the list.
  // Storing it would make the list lie about where the cost reaches.
  const res = await put({ employeeId: JEFF, rows: [
    { department: 'Corporate', percent: 100 }, { department: 'HR', percent: 0 }
  ]});
  assert.strictEqual(res.statusCode, 400);
  assert.match(parse(res).error, /more than 0% — remove the row/);
});

test('a missing or unparseable percentage is refused, and a blank is not zero', async (t) => {
  for (const percent of ['', '  ', null, undefined, {}, 'half', NaN, Infinity, -5]) {
    const res = await put({ employeeId: JEFF, rows: [{ department: 'Corporate', percent }] });
    assert.strictEqual(res.statusCode, 400, JSON.stringify(percent));
  }
});

test('a row with no department is refused', async (t) => {
  for (const department of ['', '   ', null, undefined]) {
    const res = await put({ employeeId: JEFF, rows: [{ department, percent: 100 }] });
    assert.strictEqual(res.statusCode, 400, JSON.stringify(department));
    assert.match(parse(res).error, /needs a department/);
  }
});

test('rows must be an array, and an absurd number of them is refused', async (t) => {
  assert.strictEqual((await put({ employeeId: JEFF, rows: 'Corporate' })).statusCode, 400);
  assert.strictEqual((await put({ employeeId: JEFF })).statusCode, 400);
  const many = Array.from({ length: __test.MAX_ROWS + 1 }, (_, i) => ({ department: 'D' + i, percent: 1 }));
  assert.strictEqual((await put({ employeeId: JEFF, rows: many })).statusCode, 400);
});

test('a single department at 100% is accepted — it is the default, written down', async (t) => {
  // Harmless, and it is what somebody halfway through an edit has. Rejecting it
  // would make the UI unable to hold an intermediate state.
  const calls = stub(t);
  const res = await put({ employeeId: JEFF, rows: [{ department: 'Corporate', percent: 100 }] });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(calls.length, 1);
});

// ---------------------------------------------------------------------------
// the gate, and absence
// ---------------------------------------------------------------------------

test('no session is 401 on every method', async (t) => {
  stub(t);
  for (const method of ['GET', 'PUT', 'POST']) {
    assert.strictEqual((await handler(event(method, { noCookie: true }))).statusCode, 401, method);
  }
});

test('an unsupported method is 405, and the response is never cached', async (t) => {
  stub(t);
  assert.strictEqual((await handler(event('DELETE'))).statusCode, 405);
  assert.strictEqual((await handler(event('GET'))).headers['Cache-Control'], 'no-store');
});

test('a missing table renders an empty page rather than a 500', async (t) => {
  stub(t, { fetchError: new Error('{"code":"PGRST205","message":"Could not find the table \'public.employee_allocations\'"}') });
  const res = await handler(event('GET'));
  assert.strictEqual(res.statusCode, 200);
  const body = parse(res);
  assert.strictEqual(body.tableMissing, true);
  assert.match(body.note, /SCHEMA_PHASE_C_ALLOCATIONS\.sql/);
  assert.match(body.note, /correct answer for all but two people/);
});

test('an unreachable database is a 500, not an empty allocation list', async (t) => {
  // "No allocations" and "cannot reach the database" produce the same numbers on
  // the Overhead tab, and only one of them is right.
  stub(t, { fetchError: new Error('JWT expired') });
  assert.strictEqual((await handler(event('GET'))).statusCode, 500);
});

test('a trigger rejection is reported as a disagreement, not a generic failure', async (t) => {
  // validateSet checks the same rule first, so reaching the trigger means the API
  // and the database disagree. That is worth saying rather than dressing up.
  stub(t, {
    requestImpl: () => { throw new Error('Allocation for employee x sums to 90%, not 100%'); }
  });
  const res = await put({ employeeId: JEFF, rows: [
    { department: 'Corporate', percent: 50 }, { department: 'HR', percent: 50 }
  ]});
  assert.strictEqual(res.statusCode, 409);
  assert.match(parse(res).error, /those two rules disagree — do not retry/);
});

test('an employee not on the roster is a client mistake', async (t) => {
  stub(t, { requestImpl: () => { throw new Error('No employee with id 99'); } });
  const res = await put({ employeeId: JEFF, rows: [{ department: 'Corporate', percent: 100 }] });
  assert.strictEqual(res.statusCode, 400);
  assert.match(parse(res).error, /not on the roster/);
});

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

test('GET groups by employee, sums, and carries no pay figure', async (t) => {
  stub(t, { rows: [
    { id: 'a1', employee_id: AXERI, department: 'Accounting', percent: '33.3400' },
    { id: 'a2', employee_id: AXERI, department: 'Corporate', percent: '33.3300' },
    { id: 'a3', employee_id: AXERI, department: 'HR', percent: '33.3300' },
    { id: 'a4', employee_id: JEFF, department: 'Corporate', percent: '50.0000' },
    { id: 'a5', employee_id: JEFF, department: 'Sales & Marketing', percent: '50.0000' }
  ]});
  const res = await handler(event('GET'));
  const body = parse(res);

  assert.strictEqual(body.allocations.length, 2);
  const axeri = body.allocations.find(a => a.employeeId === AXERI);
  assert.strictEqual(axeri.name, 'Axeri Ramirez');
  assert.strictEqual(axeri.primaryDepartment, 'Accounting');
  assert.strictEqual(axeri.total, 100);
  assert.strictEqual(axeri.sumsTo100, true);
  assert.strictEqual(axeri.includesPrimary, true);
  // Largest share first, so the primary carrying the odd hundredth reads first.
  assert.strictEqual(axeri.rows[0].department, 'Accounting');

  // How a cost is DIVIDED, never how large it is. The roster read behind this
  // carries wage and annual_salary.
  assert.ok(!res.body.includes('375000'));
  assert.ok(!res.body.includes('annual_salary'));
  assert.ok(!res.body.includes('"wage"'));
  assert.ok(!res.body.includes('30.00'));
});

test('GET flags a split that does not include the primary department', async (t) => {
  // Legal — but the rounding remainder lands on the primary, so a split that
  // omits it is worth showing plainly rather than leaving to be discovered.
  stub(t, { rows: [
    { id: 'a1', employee_id: JEFF, department: 'Corporate', percent: '50' },
    { id: 'a2', employee_id: JEFF, department: 'HR', percent: '50' }
  ]});
  const jeff = parse(await handler(event('GET'))).allocations[0];
  assert.strictEqual(jeff.primaryDepartment, 'Sales & Marketing');
  assert.strictEqual(jeff.includesPrimary, false);
  assert.strictEqual(jeff.sumsTo100, true);
});

test('GET reports a set that does not sum to 100, rather than hiding it', async (t) => {
  // The trigger makes this impossible at rest, so a true here means the trigger
  // is not installed — which every Overhead figure depends on.
  stub(t, { rows: [{ id: 'a1', employee_id: JEFF, department: 'Corporate', percent: '90' }] });
  const jeff = parse(await handler(event('GET'))).allocations[0];
  assert.strictEqual(jeff.total, 90);
  assert.strictEqual(jeff.sumsTo100, false);
});

// ---------------------------------------------------------------------------
// what the split actually does to the cost report
// ---------------------------------------------------------------------------

test('a split moves COST across departments and leaves HOURS with the primary', async () => {
  // Axeri works whole hours in one place. Splitting her hours would make
  // cost-per-hour meaningless in all three departments.
  // EVERY department here needs at least three people, or its money is
  // suppressed and this test asserts on nulls. That is the small-bucket rule
  // doing its job, not a problem with the split — but it does mean a split into
  // a department nobody works in shows hours-free cost only once that department
  // has enough headcount of its own. Worth knowing: on the real roster,
  // Corporate has one person and HR none, so Axeri's real split lands in
  // departments whose figures are withheld today.
  const dept = (name, n, from) => Array.from({ length: n }, (_, i) => ({
    id: name + i, name: name + ' Person ' + i, employee_number: String(from + i),
    status: 'Active', department: name, cost_class: 'SG&A', pay_type: 'Hourly', wage: '20.00'
  }));
  const employees = [
    ...dept('Accounting', 5, 4000),
    ...dept('Corporate', 3, 5000),
    ...dept('HR', 3, 6000),
    { id: AXERI, name: 'Axeri Ramirez', employee_number: '0300', status: 'Active',
      department: 'Accounting', cost_class: 'SG&A', pay_type: 'Hourly', wage: '30.00' }
  ];
  const dailyRows = [
    ...employees.filter(e => e.id !== AXERI)
      .map(e => ({ work_date: '2026-08-17', employee_number: e.employee_number, total_hours: 10 })),
    { work_date: '2026-08-17', employee_number: '0300', total_hours: 10 }
  ];

  const r = buildCostReport({
    employees, dailyRows, costClass: 'SG&A',
    allocations: [
      { employee_id: AXERI, department: 'Accounting', percent: 33.34 },
      { employee_id: AXERI, department: 'Corporate', percent: 33.33 },
      { employee_id: AXERI, department: 'HR', percent: 33.33 }
    ]
  });

  const bucket = (k) => r.byDepartment.find(d => d.key === k);
  // Her 10 hours stay whole, with Accounting. The other two get a share of her
  // COST and none of her hours.
  assert.strictEqual(bucket('Accounting').hours, 60, '5 clerks x 10 + Axeri x 10');
  assert.strictEqual(bucket('Corporate').hours, 30, 'its own 3 people, and none of hers');
  assert.strictEqual(bucket('HR').hours, 30);

  // Her cost is 30 x 10 = 300, split three ways on top of each department's own.
  assert.strictEqual(bucket('Corporate').cost, 600 + 99.99);     // 33.33% of 300
  assert.strictEqual(bucket('HR').cost, 600 + 99.99);
  assert.strictEqual(bucket('Accounting').cost, 1000 + 100.02);  // her primary takes the remainder

  // And the whole thing reconciles exactly: 11 x 200 + 300.
  assert.strictEqual(r.totals.cost, 2500);
  const summed = r.byDepartment.reduce((t, d) => t + (d.cost || 0), 0);
  assert.strictEqual(Math.round(summed * 100) / 100, 2500,
    'the departments must sum to the total exactly — a lost cent every day is a visible variance in a year');
});

test('the rounding remainder lands on the primary department', async () => {
  // A third of a penny disappearing daily becomes a real variance over a year,
  // so the split sums exactly and the odd cent goes somewhere stated.
  const parts = splitToCents(100, [33.33, 33.33, 33.34], 2);
  assert.strictEqual(parts.reduce((a, b) => a + b, 0), 100);
  const oddOne = splitToCents(10, [1, 1, 1], 0);
  assert.strictEqual(oddOne.reduce((a, b) => a + b, 0), 10);
  assert.ok(oddOne[0] >= oddOne[1], 'the primary absorbs the remainder');
});

// ---------------------------------------------------------------------------
// the profile-card UI
// ---------------------------------------------------------------------------

const SRC = path.join(__dirname, '..', 'src', 'js');
const MODULES = ['core.js', 'employees.js', 'preapproved.js', 'allocations.js'];

function fakeEl() {
  return {
    textContent: '', innerHTML: '', value: '', checked: false, style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {}, addEventListener() {},
    appendChild() {}, querySelector: () => fakeEl(), querySelectorAll: () => []
  };
}

function sandbox() {
  const ctx = {
    console, window: {},
    document: { getElementById: () => fakeEl(), querySelector: () => fakeEl(), querySelectorAll: () => [] },
    setTimeout: (fn) => { void fn; return 0; },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, allocations: [] }) })
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const m of MODULES) {
    vm.runInContext(fs.readFileSync(path.join(SRC, m), 'utf8'), ctx, { filename: m });
  }
  vm.runInContext('globalThis.state = state;', ctx, { filename: 'expose.js' });
  ctx.state.allocLoaded = true;
  return ctx;
}

const JEFF_ROW = {
  id: JEFF, name: 'Jeff Cook', department: 'Sales & Marketing', costClass: 'SG&A',
  status: 'Active', payType: 'Salaried'
};

// The card has ONE Edit button now, so the allocation editor only renders in
// edit mode. profileEditing() requires an open card AND an editing record whose
// id matches — that pairing is what stops the roster's own Edit modal, which
// renders neither section, from putting them into edit mode for another record.
function enterEdit(ctx, row = JEFF_ROW) {
  ctx.state.employees = [row];
  ctx.state.profile = { idx: 0 };
  ctx.state.editing = { ...row, _idx: 0, _isNew: false };
  return ctx;
}

test('read mode states there is no allocation rather than showing an editor', () => {
  // Three save mechanics on one card was the complaint. In read mode this
  // section has no inputs and nothing to press.
  const ctx = sandbox();
  ctx.state.employees = [JEFF_ROW];
  ctx.state.profile = { idx: 0 };
  const html = ctx.profileAllocation(JEFF_ROW);
  assert.match(html, /No allocation — 100% of this person's cost goes to Sales &amp; Marketing/);
  assert.ok(!html.includes('<input'), 'read mode must not render inputs');
  assert.ok(!html.includes('Save'), 'read mode must not offer a save');
});

test('read mode shows a stored split without an editor', () => {
  const ctx = sandbox();
  ctx.state.employees = [JEFF_ROW];
  ctx.state.profile = { idx: 0 };
  ctx.state.allocations = [{
    employeeId: JEFF, name: 'Jeff Cook', primaryDepartment: 'Sales & Marketing',
    onRoster: true, status: 'Active', total: 100, sumsTo100: true, includesPrimary: true,
    rows: [{ department: 'Corporate', percent: 50 }, { department: 'Sales & Marketing', percent: 50 }]
  }];
  const html = ctx.profileAllocation(JEFF_ROW);
  assert.match(html, /Corporate/);
  assert.match(html, /50\.00%/);
  assert.match(html, /· primary/, 'the primary department is marked, since the remainder lands there');
  assert.match(html, /HOURS are not split/);
  assert.ok(!html.includes('<input'));
});

test('edit mode seeds an unallocated person with their primary at 100%', () => {
  const ctx = enterEdit(sandbox());
  const html = ctx.profileAllocation(JEFF_ROW);
  assert.match(html, /One department at 100% means no allocation/);
  assert.match(html, /100\.00%/);
  // It is the state they are actually in, and one edit from a real split.
  const draft = ctx.allocDraft(JEFF, 'Sales & Marketing');
  assert.deepStrictEqual(Array.from(draft, r => [r.department, r.percent]),
    [['Sales & Marketing', 100]]);
});

test('the card says hours are not split, because that is the surprising part', () => {
  const ctx = enterEdit(sandbox());
  const html = ctx.profileAllocation(JEFF_ROW);
  assert.match(html, /hours are not split/);
  assert.match(html, /remainder on Sales &amp; Marketing/);
});

test('a total that is not 100% says what would be lost, and blocks the card\'s Save', () => {
  const ctx = enterEdit(sandbox());
  ctx.state.allocDrafts = { [JEFF]: [
    { department: 'Corporate', percent: 50 }, { department: 'HR', percent: 40 }
  ]};
  const html = ctx.profileAllocation(JEFF_ROW);
  assert.match(html, /90\.00% — must be 100%/);
  assert.match(html, /10\.00% of this person's cost would land nowhere/);

  // The section no longer has its own Save button — the CARD's Save is gated,
  // via allocDraftValid, so one button owns the decision.
  assert.ok(!html.includes('btn-primary'), 'the section must not carry its own save');
  assert.strictEqual(ctx.allocDraftValid(JEFF), false);
  assert.match(ctx.renderProfile(), /must add up to 100% before this can be saved/);
  assert.match(ctx.renderProfile(), /<button class="btn btn-primary" disabled/);
});

test('a valid draft lets the card save, and an untouched one is always valid', () => {
  const ctx = enterEdit(sandbox());
  ctx.state.allocDrafts = { [JEFF]: [
    { department: 'Corporate', percent: 50 }, { department: 'Sales & Marketing', percent: 50 }
  ]};
  assert.strictEqual(ctx.allocDraftValid(JEFF), true);
  assert.ok(!ctx.renderProfile().includes('btn btn-primary" disabled'));

  // No draft at all means nothing was edited, which cannot be invalid.
  ctx.state.allocDrafts = {};
  assert.strictEqual(ctx.allocDraftValid(JEFF), true);

  // A row with no department chosen is not committable either.
  ctx.state.allocDrafts = { [JEFF]: [
    { department: '', percent: 50 }, { department: 'HR', percent: 50 }
  ]};
  assert.strictEqual(ctx.allocDraftValid(JEFF), false);
});

test('split evenly sums to exactly 100 and puts the odd hundredth first', () => {
  const ctx = sandbox();
  ctx.state.employees = [JEFF_ROW];
  ctx.state.allocDrafts = { [JEFF]: [
    { department: 'Accounting', percent: 0 },
    { department: 'Corporate', percent: 0 },
    { department: 'HR', percent: 0 }
  ]};
  ctx.allocSplitEvenly(JEFF);
  const rows = ctx.state.allocDrafts[JEFF];
  assert.strictEqual(ctx.allocDraftTotal(rows), 100);
  assert.strictEqual(rows[0].percent, 33.34);
  assert.strictEqual(rows[1].percent, 33.33);
  assert.strictEqual(rows[2].percent, 33.33);
});

test('split evenly is exact for any number of departments', () => {
  const ctx = sandbox();
  for (const n of [1, 2, 3, 4, 6, 7, 11, 12]) {
    ctx.state.allocDrafts = { [JEFF]: Array.from({ length: n }, (_, i) => ({ department: 'D' + i, percent: 0 })) };
    ctx.allocSplitEvenly(JEFF);
    assert.strictEqual(ctx.allocDraftTotal(ctx.state.allocDrafts[JEFF]), 100, `${n} departments`);
  }
});

test('a draft is per employee, so one half-finished edit does not leak into another card', () => {
  const ctx = sandbox();
  ctx.allocDraft(JEFF, 'Sales & Marketing');
  ctx.state.allocDrafts[JEFF][0].percent = 60;
  const axeriDraft = ctx.allocDraft(AXERI, 'Accounting');
  assert.strictEqual(axeriDraft[0].percent, 100);
  assert.strictEqual(ctx.state.allocDrafts[JEFF][0].percent, 60);
});

test('the department dropdown offers the twelve values grouped by cost class', () => {
  const ctx = enterEdit(sandbox());
  const html = ctx.profileAllocation(JEFF_ROW);
  for (const cc of ['Manufacturing', 'Mill Overhead', 'SG&A']) {
    assert.ok(html.includes(`<optgroup label="${cc.replace('&', '&amp;')}">`), `missing group ${cc}`);
  }
  // The ampersand has to survive being an option value AND a label.
  assert.match(html, /<option value="Sales &amp; Marketing"/);
});

test('a missing table says so instead of offering an editor that cannot save', () => {
  const ctx = sandbox();
  ctx.state.allocTableMissing = true;
  ctx.state.employees = [JEFF_ROW];
  const html = ctx.profileAllocation(JEFF_ROW);
  assert.match(html, /SCHEMA_PHASE_C_ALLOCATIONS\.sql/);
  assert.ok(!html.includes('Save allocation'));
});

test('an unsaved employee is told to save first rather than shown a broken editor', () => {
  const ctx = sandbox();
  const html = ctx.profileAllocation({ name: 'New Hire', department: 'Production' });
  assert.match(html, /Save this employee first/);
});

// ---------------------------------------------------------------------------
// headcount vs. allocated-in — two numbers, and both are load-bearing
// ---------------------------------------------------------------------------

// The real SG&A shape: Accounting 2, Corporate 1, Procurement 1,
// Sales & Marketing 3, HR 0. Axeri's actual split sends a third of her cost into
// Corporate (one person) and a third into HR (nobody at all).
function sgaRoster() {
  const emp = (id, name, department, wage) => ({
    id, name, employee_number: id, status: 'Active',
    department, cost_class: 'SG&A', pay_type: 'Hourly', wage
  });
  const employees = [
    emp('1', 'Axeri Ramirez', 'Accounting', '30.00'),
    emp('2', 'Ryley Stanley', 'Accounting', '40.00'),
    emp('3', 'Peter Stroble', 'Corporate', '50.00')
  ];
  return {
    employees,
    dailyRows: employees.map(e => ({ work_date: '2026-08-17', employee_number: e.employee_number, total_hours: 10 })),
    allocations: [
      { employee_id: '1', department: 'Accounting', percent: 33.34 },
      { employee_id: '1', department: 'Corporate', percent: 33.33 },
      { employee_id: '1', department: 'HR', percent: 33.33 }
    ]
  };
}

test('department headcounts sum to the report headcount, even with a split', () => {
  // They did not before. Axeri counted as one person in each of her three
  // departments, so three people produced a department headcount of five and the
  // People column could not be reconciled against its own total — the exact
  // "rows do not add up and nothing says why" problem the suppression banner
  // exists to avoid elsewhere.
  const { employees, dailyRows, allocations } = sgaRoster();
  const r = buildCostReport({ employees, dailyRows, costClass: 'SG&A', allocations });
  assert.strictEqual(r.headcount, 3);
  assert.strictEqual(r.byDepartment.reduce((t, d) => t + d.headcount, 0), 3);
});

test('a department a cost is allocated INTO reports it separately from its own people', () => {
  const { employees, dailyRows, allocations } = sgaRoster();
  const r = buildCostReport({ employees, dailyRows, costClass: 'SG&A', allocations });
  const b = (k) => r.byDepartment.find(d => d.key === k);

  assert.deepStrictEqual([b('Accounting').headcount, b('Accounting').allocatedFrom], [2, 0]);
  assert.deepStrictEqual([b('Corporate').headcount, b('Corporate').allocatedFrom], [1, 1]);
  // HR has no employees at all. It still appears, because a third of somebody's
  // cost lands there and a destination with no bucket would lose the money.
  assert.deepStrictEqual([b('HR').headcount, b('HR').allocatedFrom], [0, 1]);
});

test('a department with no employees and one allocated cost does NOT publish it', () => {
  // THE trap. Suppression judged on headcount alone would see HR with 0 people,
  // conclude there is nothing to protect, and publish exactly one third of a
  // named individual's pay as "HR cost". It has to judge on how many people's
  // money is in the bucket, not how many work there.
  const { employees, dailyRows, allocations } = sgaRoster();
  const r = buildCostReport({ employees, dailyRows, costClass: 'SG&A', allocations });
  const hr = r.byDepartment.find(d => d.key === 'HR');

  assert.strictEqual(hr.headcount, 0);
  assert.strictEqual(hr.suppressed, true);
  for (const key of ['cost', 'burdenedCost', 'costPerHour', 'burdenedCostPerHour']) {
    assert.strictEqual(hr[key], null, `HR leaked ${key}`);
  }
  assert.match(hr.suppressedReason, /only 1 person contributes cost/);

  // And Axeri's third is not findable anywhere in the payload. 30/hr x 10 hrs is
  // 300; a third is 99.99.
  const wire = JSON.stringify(r);
  for (const forbidden of ['99.99', '100.02', '300', '30.00']) {
    assert.ok(!wire.includes(forbidden), `the report leaked ${forbidden}`);
  }
});

test('an allocation cannot be used to get a figure out of a suppressed department', () => {
  // Splitting one person's cost across many departments must not turn one
  // withheld bucket into several publishable ones.
  const solo = [{
    id: 's1', name: 'Solo Executive', employee_number: '9001', status: 'Active',
    department: 'Corporate', cost_class: 'SG&A', pay_type: 'Hourly', wage: '100.00'
  }];
  const r = buildCostReport({
    employees: solo,
    dailyRows: [{ work_date: '2026-08-17', employee_number: '9001', total_hours: 10 }],
    costClass: 'SG&A',
    allocations: [
      { employee_id: 's1', department: 'Corporate', percent: 20 },
      { employee_id: 's1', department: 'HR', percent: 20 },
      { employee_id: 's1', department: 'Accounting', percent: 20 },
      { employee_id: 's1', department: 'Procurement', percent: 20 },
      { employee_id: 's1', department: 'Sales & Marketing', percent: 20 }
    ]
  });
  assert.strictEqual(r.byDepartment.length, 5);
  assert.ok(r.byDepartment.every(d => d.suppressed), 'every one-person destination stays withheld');
  assert.strictEqual(r.totalsSuppressed, true, 'and a one-person cost class withholds its total too');
  const wire = JSON.stringify(r);
  for (const forbidden of ['200', '1000', '100.00']) {
    assert.ok(!wire.includes(forbidden), `leaked ${forbidden}`);
  }
});

test('with enough people in each destination the split is visible and reconciles', () => {
  const dept = (name, n, from) => Array.from({ length: n }, (_, i) => ({
    id: name + i, name: name + ' ' + i, employee_number: String(from + i),
    status: 'Active', department: name, cost_class: 'SG&A', pay_type: 'Hourly', wage: '20.00'
  }));
  const employees = [
    ...dept('Accounting', 3, 4000), ...dept('Corporate', 3, 5000), ...dept('HR', 3, 6000),
    { id: 'ax', name: 'Axeri Ramirez', employee_number: '0300', status: 'Active',
      department: 'Accounting', cost_class: 'SG&A', pay_type: 'Hourly', wage: '30.00' }
  ];
  const r = buildCostReport({
    employees,
    dailyRows: employees.map(e => ({ work_date: '2026-08-17', employee_number: e.employee_number, total_hours: 10 })),
    costClass: 'SG&A',
    allocations: [
      { employee_id: 'ax', department: 'Accounting', percent: 33.34 },
      { employee_id: 'ax', department: 'Corporate', percent: 33.33 },
      { employee_id: 'ax', department: 'HR', percent: 33.33 }
    ]
  });
  const b = (k) => r.byDepartment.find(d => d.key === k);
  assert.strictEqual(b('Corporate').cost, 600 + 99.99);
  assert.strictEqual(b('HR').cost, 600 + 99.99);
  assert.strictEqual(b('Accounting').cost, 600 + 100.02);
  assert.strictEqual(r.totals.cost, 2100);
  assert.strictEqual(
    Math.round(r.byDepartment.reduce((t, d) => t + d.cost, 0) * 100) / 100, 2100);
  // Headcount still reconciles; allocated-in is reported beside it.
  assert.strictEqual(r.byDepartment.reduce((t, d) => t + d.headcount, 0), r.headcount);
  assert.strictEqual(b('HR').allocatedFrom, 1);
});
