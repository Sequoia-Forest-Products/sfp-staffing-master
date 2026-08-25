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

test('the Add form has no wage input, and says where the rate comes from', () => {
  // The modal is Add-only now. Editing an existing person opens the profile
  // card, so a modal rendered over an existing employee is a state that can no
  // longer be reached — testing it would pin behaviour nothing produces.
  const ctx = sandbox();
  ctx.state.employees = [];
  ctx.state.profile = null;
  ctx.openAdd();

  const html = ctx.renderModal();

  assert.match(html, /Add employee/);
  assert.ok(!/Edit —/.test(html), 'the unreachable Edit title is gone, not just unused');
  assert.ok(!/id="wageInput"/.test(html), 'no wage input');
  assert.ok(!/state\.editing\.wage\s*=/.test(html), 'nothing in the form assigns a wage');
  assert.ok(!/formatWageInput/.test(html), 'the wage formatter is gone with its field');
  // Whoever is adding somebody needs to know where the rate DOES come from,
  // or they will go looking for the field.
  assert.match(html, /Hourly wage/);
  assert.match(html, /not editable here/i);
  assert.match(html, /daily payroll file/i);
});

test('adding a salaried person is told where the salary lives', () => {
  const ctx = sandbox();
  ctx.state.employees = [];
  ctx.state.profile = null;
  ctx.openAdd();
  ctx.setPayType('Salaried');

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

test('wage is readable AND writable by everyone through /api/data', () => {
  // The reversal. Phase D refused `wage` for every tier because BBSI overwrote
  // it every morning and a value typed in the app would not have survived the
  // night. The import stopped reading the file's rate on 2026-08-22, so
  // employees.wage is the record of truth and somebody has to be able to set
  // it. Base tier, deliberately: the people who correct a rate are supervisors.
  const base = new Set([perms.TIER_HOURLY_WAGES]);
  assert.ok(perms.employeeReadColumns(base).includes('wage'),
    'hourly rates stay visible to every signed-in user');
  assert.ok(perms.employeeWriteColumns(base).includes('wage'),
    'and are now writable at the base tier, with no grant');

  // The reversal is `wage` and nothing else. annual_salary moved in neither
  // direction, which is the whole point of the two lists being separate.
  assert.ok(!perms.employeeReadColumns(base).includes('annual_salary'));
  assert.ok(!perms.employeeWriteColumns(base).includes('annual_salary'));
});

// ---------------------------------------------------------------------------
// one edit surface
// ---------------------------------------------------------------------------
//
// The roster's Edit modal and the profile card's Edit were two field lists over
// the same row. The modal existed because it was the only place an hourly wage
// could be set; Phase D removed that input, and with it the modal's reason to
// be a second list. Edit now opens the card. Add still opens the modal, because
// a person who does not exist yet has no card to open.

test('the roster Edit opens the profile card in edit mode, not a modal', () => {
  const ctx = sandbox();
  ctx.state.employees = [{ ...PERSON }];
  ctx.state.profile = null;
  ctx.state.editing = null;

  ctx.openEdit(0);

  assert.deepStrictEqual({ idx: ctx.state.profile.idx }, { idx: 0 }, 'the card is open');
  assert.ok(ctx.state.editing, 'and it is in edit mode');
  assert.strictEqual(ctx.state.editing._idx, 0);
  assert.strictEqual(ctx.state.editing._isNew, false);

  // renderEmployees picks the modal on (editing && !profile). With both set it
  // must pick the card, so this is the assertion that the collapse actually
  // routes rather than merely setting state.
  // Asserted on which surface is wired up, because neither of the obvious
  // checks works: the roster toolbar carries an 'Add employee' button whatever
  // is open, and the profile card is ALSO rendered inside .modal-bg. What
  // separates them is the close handler and the form's own title.
  const html = ctx.renderEmployees();
  assert.ok(!html.includes('closeModal()'), 'the Add form is not open');
  assert.ok(!/<span>Add employee<\/span>/.test(html), 'nor its title');
  assert.match(html, /closeProfile\(\)/, 'the profile card is');
  assert.match(html, /onclick="saveEdit\(\)"/, 'the card, in edit mode');
});

test('Add still opens the modal, because there is no card for a person who does not exist', () => {
  const ctx = sandbox();
  ctx.state.employees = [];
  ctx.openAdd();
  assert.strictEqual(ctx.state.profile, null);
  assert.strictEqual(ctx.state.editing._isNew, true);
  assert.match(ctx.renderEmployees(), /Add employee/);
});

test('the card carries every field the modal had — checked, not assumed', () => {
  // The collapse is only safe if nothing was on the modal alone. Comparing the
  // rendered surfaces rather than the source, so a field that exists but is not
  // drawn fails here.
  const ctx = sandbox();
  ctx.state.employees = [{ ...PERSON }];

  ctx.openAdd();
  Object.assign(ctx.state.editing, PERSON, { _isNew: true });
  const modal = ctx.renderModal();

  ctx.state.profile = { idx: 0 };
  ctx.state.editing = { ...PERSON, _idx: 0, _isNew: false };
  const card = ctx.renderProfile();

  const bound = (html) => new Set(
    [...html.matchAll(/state\.editing\.([A-Za-z0-9_]+)\s*=/g)].map(m => m[1]));

  const onlyOnModal = [...bound(modal)].filter(f => !bound(card).has(f));
  assert.deepStrictEqual(onlyOnModal, [],
    'these fields would become uneditable once Edit stops opening the modal: ' + onlyOnModal.join(', '));

  // And the card is a STRICT superset — it has fields the modal never did, which
  // is the other half of why the collapse is an improvement rather than a merge.
  const onlyOnCard = [...bound(card)].filter(f => !bound(modal).has(f));
  for (const f of ['break1', 'break2', 'addressStreet', 'addressCity', 'addressState', 'addressPostalCode']) {
    assert.ok(onlyOnCard.includes(f), `${f} should be a card-only field`);
  }
});

test('neither surface can write compensation', () => {
  const ctx = sandbox();
  ctx.state.employees = [{ ...PERSON }];

  ctx.openAdd();
  const modal = ctx.renderModal();
  ctx.openEdit(0);
  const card = ctx.renderProfile();

  for (const [name, html] of [['the Add form', modal], ['the profile card', card]]) {
    assert.ok(!/state\.editing\.wage\s*=/.test(html), `${name} assigns a wage`);
    assert.ok(!/annualSalary\s*=|annual_salary/.test(html), `${name} touches annual_salary`);
    assert.ok(!/id="wageInput"/.test(html), `${name} has the wage input`);
  }
});
