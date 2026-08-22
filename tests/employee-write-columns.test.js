// What the browser SENDS, checked against what the server ACCEPTS.
//
// Phase D put a column gate on PATCH/POST /api/data?table=employees: a body
// naming a column the caller may not write is refused with a 403 that names it,
// rather than being silently dropped. That is the right behaviour for an
// attacker and a trap for us — the roster's own Save sent `wage` on every write,
// so the gate as shipped would have 403'd every save from the Edit modal.
//
// `wage` had to go from the client because BBSI owns the column: the daily
// import writes it through payroll-db.updateEmployeeWage with the service key,
// which this gate does not touch. Anything typed in the app would have been
// replaced by the next morning's file, unannounced.
//
// So these tests are not "does the client omit wage" — that alone would pass
// again the day somebody adds a field. They compare the ACTUAL request bodies
// the two writers produce against permissions-lib's writable registry, which is
// the same list data.js gates on. A new field on either side that the other does
// not know about fails here, in the suite, instead of as a 403 on somebody's
// screen.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'src', 'js');
const { __SCRIPT_MODULES } = require('../netlify/functions/session.js');
const perms = require('../netlify/functions/permissions-lib');

const EMP_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

// A person with a value in every field a writer might carry, so an omission is
// an omission and not an empty source.
const PERSON = {
  id: EMP_ID, name: 'Ana Reyes', wage: '22.00', payType: 'Hourly',
  empNum: '0101', status: 'Active', language: 'English', days: 'MON-THU',
  department: 'Production', costClass: 'Manufacturing', positionGroup: 'Green Chain',
  position: 'Puller', break1: '7:00 AM', break2: '12:45 PM',
  birthday: '1990-03-15', phone: '555-0100', email: 'ana@sequoiafp.com',
  smsOptedOut: false, driveFolderId: 'folder-1',
  addressStreet: '1 Mill Rd', addressCity: 'Dinuba', addressState: 'CA',
  addressPostalCode: '93618'
};

function fakeEl() {
  return {
    textContent: '', innerHTML: '', value: '', checked: false, style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {}, addEventListener() {},
    appendChild() {}, querySelector: () => fakeEl(), querySelectorAll: () => []
  };
}

function sandbox() {
  const calls = [];
  const ctx = {
    console,
    window: {},
    document: {
      getElementById: () => fakeEl(),
      querySelector: () => fakeEl(),
      querySelectorAll: () => []
    },
    setTimeout: (fn) => { void fn; return 0; },
    URLSearchParams,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async (url, opts) => {
      const u = String(url);
      const method = (opts && opts.method) || 'GET';
      calls.push({ url: u, method, body: opts && opts.body ? JSON.parse(opts.body) : null });
      if (u.startsWith('/api/preapproved-ot')) return { ok: true, status: 200, json: async () => ({ ok: true, rows: [], otTypes: [] }) };
      if (u.startsWith('/api/allocations')) return { ok: true, status: 200, json: async () => ({ ok: true, allocations: [] }) };
      // The reload at the end of syncToSheet: hand back the row unchanged.
      if (method === 'GET') return { ok: true, status: 200, json: async () => ({ ok: true, data: [{ id: EMP_ID, name: 'Ana Reyes', wage: '22.00' }] }) };
      return { ok: true, status: 200, json: async () => ({ ok: true, data: [{ id: EMP_ID }] }) };
    }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const m of __SCRIPT_MODULES) {
    vm.runInContext(fs.readFileSync(path.join(SRC, m), 'utf8'), ctx, { filename: m });
  }
  vm.runInContext('globalThis.state = state;', ctx, { filename: 'expose.js' });
  vm.runInContext('toast = () => {};', ctx, { filename: 'stub-toast.js' });
  ctx.__calls = calls;
  return ctx;
}

const writesTo = (ctx, table) => ctx.__calls.filter(
  c => c.method !== 'GET' && c.url.includes('table=' + table));

// The base tier — no grant row at all, which is what every employee holds and
// therefore the only set these two writers may rely on.
const BASE_WRITABLE = perms.employeeWriteColumns(new Set([perms.TIER_HOURLY_WAGES]));

// ---------------------------------------------------------------------------
// the roster modal / profile card save
// ---------------------------------------------------------------------------

test('saveEdit sends no wage, and every column it does send is writable at the base tier', async () => {
  const ctx = sandbox();
  ctx.state.employees = [{ ...PERSON }];
  ctx.state.profile = null;
  ctx.state.editing = { ...PERSON, _idx: 0, _isNew: false };

  await ctx.saveEdit();

  const [write] = writesTo(ctx, 'employees');
  assert.ok(write, 'the employee row was written');
  assert.strictEqual(write.method, 'PATCH');
  assert.ok(!('wage' in write.body), 'wage must not be in the request body at all');

  const refused = Object.keys(write.body).filter(k => !BASE_WRITABLE.includes(k));
  assert.deepStrictEqual(refused, [],
    'these columns would be 403d by the gate in data.js: ' + refused.join(', '));

  // Not a vacuous pass: the body still carries the fields the form is for.
  assert.strictEqual(write.body.pay_type, 'Hourly');
  assert.strictEqual(write.body.name, 'Ana Reyes');
  assert.strictEqual(write.body.position, 'Puller');
});

test('saveEdit does not blank the local rate it no longer writes', async () => {
  const ctx = sandbox();
  ctx.state.employees = [{ ...PERSON }];
  ctx.state.profile = null;
  ctx.state.editing = { ...PERSON, _idx: 0, _isNew: false };

  await ctx.saveEdit();

  // The old saveEdit reassigned e.wage on its way through. With the column gone
  // from the write, doing that would leave the roster row showing a rate the
  // database does not agree with — or, for a salaried person, showing nothing
  // while wage still holds a value.
  assert.strictEqual(ctx.state.employees[0].wage, '22.00');
});

test('flipping to Salaried writes pay_type and leaves wage untouched everywhere', async () => {
  const ctx = sandbox();
  ctx.state.employees = [{ ...PERSON }];
  ctx.state.profile = null;
  ctx.state.editing = { ...PERSON, _idx: 0, _isNew: false };

  ctx.setPayType('Salaried');
  assert.strictEqual(ctx.state.editing.payType, 'Salaried');
  assert.strictEqual(ctx.state.editing.wage, '22.00',
    'setPayType must not clear a rate it cannot write back');

  await ctx.saveEdit();

  const [write] = writesTo(ctx, 'employees');
  assert.strictEqual(write.body.pay_type, 'Salaried');
  assert.ok(!('wage' in write.body), 'still no wage, salaried or not');
  // And nothing reads the leftover rate as a fact about them.
  assert.strictEqual(ctx.fmtWage(ctx.state.employees[0]), 'Salary');
});

test('a new employee is created without a wage column', async () => {
  const ctx = sandbox();
  ctx.state.employees = [];
  ctx.state.profile = null;
  ctx.openAdd();
  Object.assign(ctx.state.editing, { name: 'New Hire', department: 'Production' });

  await ctx.saveEdit();

  const [write] = writesTo(ctx, 'employees');
  assert.strictEqual(write.method, 'POST');
  assert.ok(!('wage' in write.body), 'Add must not send wage either');
  const refused = Object.keys(write.body).filter(k => !BASE_WRITABLE.includes(k));
  assert.deepStrictEqual(refused, [], 'refused on create: ' + refused.join(', '));
});

// ---------------------------------------------------------------------------
// Sync — the whole roster, every row, one click
// ---------------------------------------------------------------------------

test('syncToSheet sends no wage on any row, and no column the gate refuses', async () => {
  const ctx = sandbox();
  ctx.state.employees = [
    { ...PERSON },
    { ...PERSON, id: 'row-2', name: 'Bo Tran', payType: 'Salaried', wage: 'Salary' },
    { ...PERSON, id: null, name: 'Unsaved Person' }
  ];

  await ctx.syncToSheet();

  const writes = writesTo(ctx, 'employees');
  assert.strictEqual(writes.length, 3, 'one write per roster row');
  for (const w of writes) {
    assert.ok(!('wage' in w.body), `${w.url} must not carry wage`);
    const refused = Object.keys(w.body).filter(k => !BASE_WRITABLE.includes(k));
    assert.deepStrictEqual(refused, [], 'refused: ' + refused.join(', '));
  }
  // Sync still asserts pay type, which is the fact it is allowed to carry.
  assert.deepStrictEqual(writes.map(w => w.body.pay_type), ['Hourly', 'Salaried', 'Hourly']);
});

// ---------------------------------------------------------------------------
// the field itself
// ---------------------------------------------------------------------------

test('the roster modal has no wage input, and shows the rate instead', () => {
  const ctx = sandbox();
  ctx.state.employees = [{ ...PERSON }];
  ctx.state.profile = null;
  ctx.state.editing = { ...PERSON, _idx: 0, _isNew: false };

  const html = ctx.renderModal();

  assert.ok(!/id="wageInput"/.test(html), 'no wage input');
  assert.ok(!/state\.editing\.wage\s*=/.test(html), 'nothing in the modal assigns a wage');
  assert.ok(!/formatWageInput/.test(html), 'the wage formatter is gone with its field');
  // The rate is still visible — removing the edit path is not the same as
  // hiding what somebody is paid.
  assert.match(html, /Hourly wage/);
  assert.match(html, /\$22\.00/);
  assert.match(html, /not editable here/i);
});

test('a salaried person sees no rate and is told where the salary lives', () => {
  const ctx = sandbox();
  const bo = { ...PERSON, name: 'Bo Tran', payType: 'Salaried', wage: 'Salary' };
  ctx.state.employees = [bo];
  ctx.state.profile = null;
  ctx.state.editing = { ...bo, _idx: 0, _isNew: false };

  const html = ctx.renderModal();
  assert.ok(!/id="wageInput"/.test(html));
  assert.match(html, /Salaries &amp; Wages page/);
});

test('the profile card still has no compensation field of any kind', () => {
  const ctx = sandbox();
  ctx.state.employees = [{ ...PERSON }];
  ctx.state.profile = { idx: 0 };
  ctx.startProfileEdit();

  const html = ctx.renderProfile();
  assert.ok(!/id="wageInput"/.test(html));
  assert.ok(!/annual_salary|annualSalary/.test(html));
  assert.ok(!/state\.editing\.wage\s*=/.test(html));
});

// ---------------------------------------------------------------------------
// the reason the whole thing exists
// ---------------------------------------------------------------------------

test('wage is readable by everyone and writable by nobody through /api/data', () => {
  const base = new Set([perms.TIER_HOURLY_WAGES]);
  assert.ok(perms.employeeReadColumns(base).includes('wage'),
    'hourly rates stay visible to every signed-in user — that was not what Phase D changed');
  for (const tier of perms.ALL_TIERS) {
    const held = new Set([perms.TIER_HOURLY_WAGES, tier]);
    assert.ok(!perms.employeeWriteColumns(held).includes('wage'),
      `${tier} must not be able to write wage; BBSI owns the column`);
  }
});
