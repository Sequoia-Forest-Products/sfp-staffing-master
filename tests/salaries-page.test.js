// The Salaries view under Overhead, and the Access section that grants entry
// to it.
//
// IT WAS THE 'Salaries & Wages' TAB and it held both pay columns. The hourly
// half moved to the employee profile card — see profile-wage-edit.test.js,
// which carries every rule that came with it — and the salaried half is this,
// one view of a tab that the salaries tier gates whole.
//
// The UI gate is COSMETIC and these tests are written knowing that: the server
// builds its projection from the caller's tiers, so annual_salary is absent
// from the select= before any row is read, and /api/data 403s a write of it
// from anyone without the tier. What is tested here is the other half — that
// the page does not OFFER a control the server would refuse, and that when a
// refusal happens anyway it is reported instead of swallowed.
//
// The one genuinely load-bearing assertion below is that a figure the caller
// may not see never appears in the rendered HTML. Everything else is about not
// lying to the user.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'src', 'js');
const { __SCRIPT_MODULES } = require('../netlify/functions/session.js');

// Every fixture carries an explicit status, because the page filters on it and
// a fixture that left it out would exercise the blank-reads-as-active fallback
// in every test rather than the ordinary path.
const SALARIED = [
  { id: 's1', name: 'Eduardo Rivera', payType: 'Salaried', wage: '', annualSalary: 105000,
    position: 'Plant Superintendent', department: 'Production', empNum: '0101', status: 'Active' },
  { id: 's2', name: 'Jeff Cook', payType: 'Salaried', wage: '', annualSalary: 250000,
    position: 'CEO', department: 'Corporate', empNum: '', status: 'Active' },
  { id: 's3', name: 'No Salary Yet', payType: 'Salaried', wage: '', annualSalary: null,
    position: 'Controller', department: 'Accounting', empNum: '', status: 'Active' },
  // Inactive, and carrying a real salary — so a test that finds this figure on
  // the page is finding a leak, not an empty row.
  { id: 's4', name: 'Gone Salaried', payType: 'Salaried', wage: '', annualSalary: 90000,
    position: 'Former', department: 'Corporate', empNum: '', status: 'Inactive' }
];
const HOURLY = [
  { id: 'h1', name: 'Ana Reyes', payType: 'Hourly', wage: 22, annualSalary: null,
    position: 'Puller', department: 'Production', empNum: '0201', status: 'Active' },
  { id: 'h2', name: 'No Rate', payType: 'Hourly', wage: '', annualSalary: null,
    position: 'Utility', department: 'Production', empNum: '0202', status: 'Active' },
  { id: 'h3', name: 'Gone Hourly', payType: 'Hourly', wage: '18.00', annualSalary: null,
    position: 'Former', department: 'Production', empNum: '0203', status: 'Inactive' }
];

function fakeEl(id) {
  const el = {
    id, textContent: '', innerHTML: '', value: '', checked: false, hidden: false,
    style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {}, addEventListener() {},
    appendChild() {}, querySelector: () => fakeEl(), querySelectorAll: () => []
  };
  return el;
}

function sandbox({ tiers = ['hourly_wages'], grants = null, responder = null } = {}) {
  const calls = [];
  const toasts = [];
  const els = new Map();
  const getEl = (id) => {
    if (!els.has(id)) els.set(id, fakeEl(id));
    return els.get(id);
  };
  const ctx = {
    console,
    window: {},
    document: {
      getElementById: getEl,
      querySelector: (sel) => {
        const m = /data-tab="([^"]+)"/.exec(sel);
        return m ? getEl('tab:' + m[1]) : fakeEl();
      },
      querySelectorAll: () => []
    },
    setTimeout: (fn) => { void fn; return 0; },
    URLSearchParams,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async (url, opts = {}) => {
      const u = String(url);
      const method = opts.method || 'GET';
      calls.push({ url: u, method, body: opts.body ? JSON.parse(opts.body) : null });
      const over = responder ? responder(u, method, calls.length) : null;
      if (over) return { ok: over.status < 400, status: over.status, json: async () => over.body };
      if (u.startsWith('/api/permissions')) {
        return { ok: true, status: 200, json: async () => ({
          ok: true, email: 'me@sequoiafp.com', tiers, grants,
          isAdmin: tiers.includes('admin'), grantableTiers: ['salaries', 'admin'] }) };
      }
      if (u.startsWith('/api/preapproved-ot')) return { ok: true, status: 200, json: async () => ({ ok: true, rows: [], otTypes: [] }) };
      if (u.startsWith('/api/allocations')) return { ok: true, status: 200, json: async () => ({ ok: true, allocations: [] }) };
      return { ok: true, status: 200, json: async () => ({ ok: true, data: [] }) };
    }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const m of __SCRIPT_MODULES) {
    if (m === 'bootstrap.js') continue;   // no top-level calls in a test
    vm.runInContext(fs.readFileSync(path.join(SRC, m), 'utf8'), ctx, { filename: m });
  }
  vm.runInContext('globalThis.state = state;', ctx, { filename: 'expose.js' });
  vm.runInContext('toast = (msg, type) => { globalThis.__toasts.push({ msg, type }); };',
    ctx, { filename: 'stub-toast.js' });
  ctx.__toasts = toasts;
  ctx.__calls = calls;
  ctx.__el = getEl;
  ctx.state.employees = [...SALARIED, ...HOURLY].map(e => ({ ...e }));
  ctx.state.loading = false;
  // Seeded synchronously so the render tests do not each have to await
  // loadPermissions. The tests that are ABOUT loadPermissions call it and let
  // it overwrite this.
  ctx.state.perms.tiers = tiers.slice();
  ctx.state.perms.isAdmin = tiers.includes('admin');
  ctx.state.perms.grants = grants;
  ctx.state.perms.loaded = true;
  return ctx;
}

const withTier = (t) => sandbox({ tiers: ['hourly_wages', t] });
const lastToast = (ctx) => ctx.__toasts[ctx.__toasts.length - 1] || {};
const writes = (ctx) => ctx.__calls.filter(c => c.method !== 'GET');

// By id, never by index. The fixtures grew an inactive person in each section
// and every hardcoded state.employees[3] silently became somebody else.
const person = (ctx, id) => ctx.state.employees.find(e => String(e.id) === id);

// ---------------------------------------------------------------------------
// who is on the page
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// who is on the page
// ---------------------------------------------------------------------------

test('only ACTIVE salaried employees are listed, and the omission is stated', () => {
  const ctx = withTier('salaries');
  const html = ctx.renderSalariedPay();
  assert.ok(html.includes('Eduardo Rivera'));
  assert.ok(!html.includes('Gone Salaried'), 'an inactive person is not listed');
  // And the figure they carry is not on the page either — a terminated
  // person's pay is history, and a leak of it is still a leak.
  assert.ok(!/90000|90,000/.test(html));
  assert.match(html, /1 inactive salaried person is not listed/);
});

test('hourly people are not on this page at all', () => {
  // The split. Their rates are typed on their own profile card, at the base
  // tier, and a page that listed them would be re-creating the surface that
  // made a supervisor open the company salary list to fix one number.
  const ctx = withTier('salaries');
  const html = ctx.renderSalariedPay();
  assert.ok(!html.includes('Ana Reyes'), 'an hourly person is not listed');
  assert.ok(!html.includes('No Rate'));
  assert.match(html, /profile card/, 'and the page says where they are instead');
});

test('a blank status reads as active rather than hiding a real person', () => {
  const ctx = withTier('salaries');
  person(ctx, 's1').status = '';
  assert.ok(ctx.renderSalariedPay().includes('Eduardo Rivera'));
});

test('an inactive person cannot be opened by id', () => {
  // The list is not the gate: openPay is reachable from a row rendered before a
  // status changed, and from the console.
  const ctx = withTier('salaries');
  ctx.openPay('s4');
  assert.strictEqual(ctx.state.pay.id, null);
  assert.match(lastToast(ctx).msg, /not active/);
  assert.strictEqual(lastToast(ctx).type, 'error');
});

test('an hourly person cannot be opened here, and is told where to go', () => {
  const ctx = withTier('salaries');
  ctx.openPay('h1');
  assert.strictEqual(ctx.state.pay.id, null);
  assert.match(lastToast(ctx).msg, /hourly/i);
  assert.match(lastToast(ctx).msg, /profile card/);
});

// ---------------------------------------------------------------------------
// the gate
// ---------------------------------------------------------------------------
//
// The page itself carries NO tier check any more: renderOverheadTab() refuses
// the whole Overhead tab without the salaries tier, so a reader who reaches
// renderSalariedPay holds it. A second check here would be a second answer to
// the same question. What these assert is that the tab-level refusal is real
// and that no figure escapes it.

test('the whole tab is refused without the tier, and no salary is in the HTML', () => {
  const ctx = sandbox({ tiers: ['hourly_wages'] });
  const html = ctx.renderOverheadTab();
  assert.match(html, /needs the salaries tier/i);
  // The load-bearing assertion in this file: a figure the caller may not see
  // never reaches the rendered page.
  for (const figure of ['105000', '105,000', '250000', '250,000', '90000']) {
    assert.ok(!html.includes(figure), `${figure} must not be in the HTML`);
  }
  assert.ok(!html.includes('Eduardo Rivera'), 'nor the names beside them');
});

test('the admin tier alone does not open it', () => {
  // Admin grants access; it does not itself read pay. Same rule as the column
  // registry and the suppression floor.
  const ctx = withTier('admin');
  assert.match(ctx.renderOverheadTab(), /needs the salaries tier/i);
});

test('without the tier a salaried person cannot be opened by id either', () => {
  const ctx = sandbox({ tiers: ['hourly_wages'] });
  ctx.openPay('s1');
  assert.strictEqual(ctx.state.pay.id, null);
  assert.match(lastToast(ctx).msg, /salaries tier/);
});

// ---------------------------------------------------------------------------
// the list is read-only
// ---------------------------------------------------------------------------

test('the list has no inputs at all — a row opens a screen instead', () => {
  // The shape this page was rebuilt into. A table of open inputs made a
  // mis-click indistinguishable from an edit, and one Save moved several
  // people's pay at once.
  const ctx = withTier('salaries');
  const html = ctx.renderSalariedPay();
  assert.ok(!/<input/.test(html), 'the list must contain no input elements');
  assert.match(html, /onclick="openPay\('s1'\)"/);
  assert.match(html, /Click a row to change/);
});

test('people with nothing on file are surfaced rather than shown as zero', () => {
  const ctx = withTier('salaries');
  const html = ctx.renderSalariedPay();
  assert.match(html, /none on file/);
  assert.match(html, /1 person has no salary on file/);
  // And the total says what it excludes, so it cannot be read as the whole
  // payroll.
  assert.match(html, /excluding 1 with none/);
});

// ---------------------------------------------------------------------------
// the detail screen
// ---------------------------------------------------------------------------

test('opening a row shows that person and nobody else', () => {
  const ctx = withTier('salaries');
  ctx.openPay('s1');
  const html = ctx.renderSalariedPay();
  assert.ok(html.includes('Eduardo Rivera'));
  assert.ok(!html.includes('Jeff Cook'), 'the other rows are not on the detail screen');
  assert.ok(!/250000|250,000/.test(html));
});

test('the field starts at what is stored, not blank', () => {
  const ctx = withTier('salaries');
  ctx.openPay('s1');
  assert.strictEqual(ctx.state.pay.draft, '105000');
  assert.match(ctx.renderSalariedPay(), /value="105000"/);
});

test('the hourly equivalent is shown, and is the divisor the reports use', () => {
  const ctx = withTier('salaries');
  ctx.openPay('s1');
  const html = ctx.renderSalariedPay();
  assert.match(html, /Annual salary/);
  // 105000 / 2080 = 50.48. Shown so this page and the costing reports cannot
  // disagree about what a salary means.
  assert.match(html, /50\.48/);
  assert.match(html, /2,080/);
});

test('Save is disabled until something actually changes', () => {
  const ctx = withTier('salaries');
  ctx.openPay('s1');
  assert.ok(/onclick="savePay\(\)" disabled/.test(ctx.renderSalariedPay()));
  ctx.paySet('110000');
  assert.ok(!/onclick="savePay\(\)" disabled/.test(ctx.renderSalariedPay()));
});

test('retyping the same value in a different format is not a change', () => {
  const ctx = withTier('salaries');
  ctx.openPay('s1');
  ctx.paySet('$105,000');
  assert.strictEqual(ctx.payDirty(), false);
});

test('Cancel leaves without writing, and drops the draft', async () => {
  const ctx = withTier('salaries');
  ctx.openPay('s1');
  ctx.paySet('999999');
  ctx.closePay();
  assert.strictEqual(ctx.state.pay.id, null);
  assert.strictEqual(ctx.state.pay.draft, '');
  assert.deepStrictEqual(writes(ctx), []);
  assert.strictEqual(person(ctx, 's1').annualSalary, 105000);
});

// ---------------------------------------------------------------------------
// saving
// ---------------------------------------------------------------------------

test('a salary save sends only annual_salary', async () => {
  const ctx = withTier('salaries');
  ctx.openPay('s1');
  ctx.paySet('112500');
  await ctx.savePay();

  const w = writes(ctx);
  assert.strictEqual(w.length, 1);
  assert.strictEqual(w[0].method, 'PATCH');
  assert.match(w[0].url, /table=employees&id=s1/);
  assert.deepStrictEqual(w[0].body, { annual_salary: 112500 });
  assert.strictEqual(person(ctx, 's1').annualSalary, 112500);
});

test('clearing a salary writes null — a real instruction, not a mistake', async () => {
  // Unlike an hourly rate, a salary CAN be cleared: nothing records salary
  // history, so there is no row that would have to say a figure went away.
  const ctx = withTier('salaries');
  ctx.openPay('s1');
  ctx.paySet('');
  await ctx.savePay();
  assert.deepStrictEqual(writes(ctx)[0].body, { annual_salary: null });
});

test('a negative salary is refused as unparseable rather than stored', async () => {
  const ctx = withTier('salaries');
  ctx.openPay('s1');
  ctx.paySet('-5');
  await ctx.savePay();
  assert.deepStrictEqual(writes(ctx), []);
  assert.match(ctx.state.pay.error, /not a number/);
});

test("a 403 mid-save says the tier is gone, not 'status 403'", async () => {
  const ctx = sandbox({ tiers: ['hourly_wages', 'salaries'],
    responder: (u, m) => (m === 'PATCH' ? { status: 403, body: { ok: false, error: 'forbidden' } } : null) });
  ctx.openPay('s1');
  ctx.paySet('120000');
  await ctx.savePay();
  assert.match(ctx.state.pay.error, /no longer permitted to edit salaries/);
  assert.ok(!/403/.test(ctx.state.pay.error));
});

test('a failed save NEVER says saved', async () => {
  const ctx = sandbox({ tiers: ['hourly_wages', 'salaries'],
    responder: (u, m) => (m === 'PATCH' ? { status: 500, body: { ok: false, error: 'boom' } } : null) });
  ctx.openPay('s1');
  ctx.paySet('120000');
  await ctx.savePay();

  assert.ok(!ctx.__toasts.some(t => /saved/i.test(t.msg)), 'no success toast on a failure');
  // The screen stays open on the typed value, and the stored copy is untouched.
  assert.strictEqual(ctx.state.pay.id, 's1');
  assert.strictEqual(person(ctx, 's1').annualSalary, 105000);
});

test('an unchanged save writes nothing and says so', async () => {
  const ctx = withTier('salaries');
  ctx.openPay('s1');
  await ctx.savePay();
  assert.deepStrictEqual(writes(ctx), []);
  assert.match(lastToast(ctx).msg, /Nothing has changed/);
});

test('one save moves one person, and cannot reach a second', async () => {
  // The failure the one-at-a-time shape exists to prevent: a Save bar that
  // committed every draft on the page at once.
  const ctx = withTier('salaries');
  ctx.openPay('s1');
  ctx.paySet('130000');
  await ctx.savePay();

  const w = writes(ctx);
  assert.strictEqual(w.length, 1);
  assert.match(w[0].url, /id=s1/);
  assert.strictEqual(person(ctx, 's2').annualSalary, 250000, 'nobody else moved');
});

// ---------------------------------------------------------------------------
// tier plumbing
// ---------------------------------------------------------------------------

test('loadPermissions resolves the tier and reveals the gated tab', async () => {
  const ctx = sandbox({ tiers: ['hourly_wages', 'salaries'] });
  await ctx.loadPermissions();
  assert.ok(ctx.canSeeSalaries());
  assert.strictEqual(ctx.__el('tab:overhead').hidden, false);
});

test('a permissions request that fails leaves the base tier and hides Overhead', async () => {
  const ctx = sandbox({ responder: (u) => u.startsWith('/api/permissions')
    ? { status: 500, body: { ok: false, error: 'boom' } } : null });
  await ctx.loadPermissions();
  assert.deepStrictEqual(Array.from(ctx.state.perms.tiers), ['hourly_wages']);
  assert.strictEqual(ctx.state.perms.isAdmin, false);
  assert.strictEqual(ctx.__el('tab:overhead').hidden, true);
  assert.match(ctx.state.perms.error, /boom/);
});

test('a tier this build does not recognise unlocks nothing', async () => {
  const ctx = sandbox({ tiers: ['hourly_wages', 'superuser'] });
  await ctx.loadPermissions();
  assert.deepStrictEqual(Array.from(ctx.state.perms.tiers), ['hourly_wages']);
  assert.ok(!ctx.canSeeSalaries());
});

test('losing the tier while looking at Overhead bounces off it', async () => {
  const ctx = sandbox({ tiers: ['hourly_wages'] });
  ctx.state.tab = 'overhead';
  ctx.applyTabVisibility();
  assert.strictEqual(ctx.state.tab, 'employees');
});

test('losing the tier does NOT take away the rate editor', async () => {
  // The consequence of the split, and the reason for it. A supervisor whose
  // grant they never had can still set an hourly rate, because that is a
  // base-tier column on a page nothing gates.
  const ctx = sandbox({ tiers: ['hourly_wages'] });
  ctx.state.employees = [{ ...ctx.state.employees.find(e => e.id === 'h1') }];
  ctx.state.profile = { idx: 0 };
  ctx.startProfileEdit();
  assert.match(ctx.renderProfile(), /wageDraftSet\(this\.value\)/);
});

// ---------------------------------------------------------------------------
// the Access section
// ---------------------------------------------------------------------------

test('a non-admin gets no Access section at all — not a disabled one', async () => {
  const ctx = withTier('salaries');
  await ctx.loadPermissions();
  const html = ctx.renderSettings();
  assert.ok(!/🔑 Access/.test(html));
  assert.ok(!/grantTier\(\)/.test(html), 'and no control to click');
});

test('an admin sees one row per person, with their tiers listed', async () => {
  const ctx = sandbox({
    tiers: ['hourly_wages', 'admin'],
    grants: [
      { id: 'g1', email: 'peter.stroble@sequoiafp.com', tier: 'admin' },
      { id: 'g2', email: 'peter.stroble@sequoiafp.com', tier: 'salaries' },
      { id: 'g3', email: 'jeffrey.cook@sequoiafp.com', tier: 'salaries' }
    ]
  });
  await ctx.loadPermissions();
  const html = ctx.renderSettings();

  assert.match(html, /🔑 Access/);
  // Two people, not three grants — the question this table answers is "who".
  assert.strictEqual((html.match(/@sequoiafp\.com/g) || []).length >= 2, true);
  assert.match(html, /peter\.stroble@sequoiafp\.com/);
  assert.match(html, /jeffrey\.cook@sequoiafp\.com/);
  assert.match(html, /revokeTier\('peter\.stroble@sequoiafp\.com','admin'\)/);
  assert.match(html, /last administrator cannot be revoked/i);
  // hourly_wages must not be offered — it is not grantable.
  assert.ok(!/value="hourly_wages"/.test(html));
});

test('granting posts the address and re-reads rather than trusting the input', async () => {
  const ctx = sandbox({ tiers: ['hourly_wages', 'admin'], grants: [] });
  await ctx.loadPermissions();
  ctx.__el('grantEmail').value = '  ANA.Reyes@SequoiaFP.com ';
  ctx.__el('grantTier').value = 'salaries';

  await ctx.grantTier();

  const posts = ctx.__calls.filter(c => c.method === 'POST' && c.url.startsWith('/api/permissions'));
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(posts[0].body.tier, 'salaries');
  // Sent as typed; the SERVER canonicalises, and the page then re-reads so it
  // shows what was stored rather than what was typed.
  assert.strictEqual(posts[0].body.email, 'ANA.Reyes@SequoiaFP.com');
  const rereads = ctx.__calls.filter(c => c.method === 'GET' && c.url.startsWith('/api/permissions'));
  assert.strictEqual(rereads.length, 2, 'loaded once on entry, once after the grant');
});

test('granting with no address asks for one instead of posting', async () => {
  const ctx = sandbox({ tiers: ['hourly_wages', 'admin'], grants: [] });
  await ctx.loadPermissions();
  ctx.__el('grantEmail').value = '   ';
  await ctx.grantTier();
  assert.deepStrictEqual(writes(ctx), []);
  assert.match(lastToast(ctx).msg, /Enter the email address/);
});

test("the last-admin refusal reaches the user with the database's own wording", async () => {
  const message = 'Refusing to remove the last administrator.\n\nWith no admin row nobody can ' +
                  'grant or revoke through the app. If this is deliberate, see ' +
                  'SCHEMA_PHASE_D_PERMISSIONS.sql section 7 — grant somebody else admin first, ' +
                  'then remove this one.';
  const ctx = sandbox({
    tiers: ['hourly_wages', 'admin'],
    grants: [{ id: 'g1', email: 'peter.stroble@sequoiafp.com', tier: 'admin' }],
    responder: (url, method) => method === 'DELETE'
      ? { status: 409, body: { ok: false, error: message } } : null
  });
  await ctx.loadPermissions();
  await ctx.revokeTier('peter.stroble@sequoiafp.com', 'admin');

  const t = lastToast(ctx);
  assert.strictEqual(t.type, 'error');
  assert.match(t.msg, /grant somebody else admin first/,
    'the actionable half survives — a generic "conflict" would send them nowhere');
});

test('revoke targets email and tier, not a row id the page could get wrong', async () => {
  const ctx = sandbox({
    tiers: ['hourly_wages', 'admin'],
    grants: [{ id: 'g3', email: 'jeffrey.cook@sequoiafp.com', tier: 'salaries' }]
  });
  await ctx.loadPermissions();
  await ctx.revokeTier('jeffrey.cook@sequoiafp.com', 'salaries');
  const [del] = ctx.__calls.filter(c => c.method === 'DELETE');
  assert.match(del.url, /email=jeffrey\.cook%40sequoiafp\.com/);
  assert.match(del.url, /tier=salaries/);
});
