// The annual-salary field on the employee profile card, and the Access section
// that grants entry to it.
//
// IT WAS A PAGE, TWICE. 'Salaries & Wages' held both pay columns; it was split,
// the hourly half landing on the profile card and the salaried half becoming
// Overhead → Salaries; that tab was removed on 2026-09-14 and the salary came
// back to the card beside the rate. So this file covers a FIELD now, not a
// screen, and the list-page assertions that came with the screen are gone with
// it — what survived is every rule about who may see the figure, what a save
// sends, and the fact that a refusal is reported rather than swallowed.
//
// The hourly rate's own rules live in profile-wage-edit.test.js, and the
// cost-class scope that governs both columns is asserted in both files.
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
// cost_class is part of every fixture: since 2026-09-14 pay is only held for
// Manufacturing, so a fixture without one would get no pay field at all and
// every assertion below would be testing that message instead of its own.
const SALARIED = [
  { id: 's1', name: 'Eduardo Rivera', payType: 'Salaried', wage: '', annualSalary: 105000,
    position: 'Production Lead', department: 'Production', empNum: '0101', status: 'Active',
    costClass: 'Manufacturing' },
  { id: 's3', name: 'No Salary Yet', payType: 'Salaried', wage: '', annualSalary: null,
    position: 'Shift Supervisor', department: 'Production', empNum: '0104', status: 'Active',
    costClass: 'Manufacturing' },
  // Inactive, and carrying a real salary — so a test that finds this figure on
  // a page is finding a leak, not an empty row.
  { id: 's4', name: 'Gone Salaried', payType: 'Salaried', wage: '', annualSalary: 90000,
    position: 'Former', department: 'Production', empNum: '', status: 'Inactive',
    costClass: 'Manufacturing' }
];
const HOURLY = [
  { id: 'h1', name: 'Ana Reyes', payType: 'Hourly', wage: 22, annualSalary: null,
    position: 'Puller', department: 'Production', empNum: '0201', status: 'Active',
    costClass: 'Manufacturing' },
  { id: 'h2', name: 'No Rate', payType: 'Hourly', wage: '', annualSalary: null,
    position: 'Utility', department: 'Production', empNum: '0202', status: 'Active',
    costClass: 'Manufacturing' },
  { id: 'h3', name: 'Gone Hourly', payType: 'Hourly', wage: '18.00', annualSalary: null,
    position: 'Former', department: 'Production', empNum: '0203', status: 'Inactive',
    costClass: 'Manufacturing' }
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
// the card, in edit mode, on one person
// ---------------------------------------------------------------------------

function editCard(ctx, id) {
  const idx = ctx.state.employees.findIndex(e => String(e.id) === id);
  ctx.state.profile = { idx };
  ctx.startProfileEdit();
  return ctx.renderProfile();
}

function readCard(ctx, id) {
  const idx = ctx.state.employees.findIndex(e => String(e.id) === id);
  ctx.state.profile = { idx };
  ctx.state.editing = null;
  return ctx.renderProfile();
}

const patches = (ctx) => ctx.__calls.filter(c => c.method === 'PATCH');

// ---------------------------------------------------------------------------
// who may see the figure
// ---------------------------------------------------------------------------

test('without the tier a salary never appears in the HTML, read or edit', () => {
  // The load-bearing one. The fixture carries a salary the server would not
  // have sent, so a figure appearing here is a leak rather than an empty field.
  const ctx = sandbox({ tiers: ['hourly_wages'] });
  for (const html of [readCard(ctx, 's1'), editCard(ctx, 's1')]) {
    assert.ok(!/105000|105,000/.test(html));
    assert.ok(!/salaryDraftSet/.test(html), 'and no input that would post one');
    assert.match(html, /salaries tier/, 'it says what is missing rather than nothing');
  }
});

test('the admin tier alone does not open it', () => {
  // Admin grants access; it does not itself read pay. Same rule as the column
  // registry on the server.
  const ctx = sandbox({ tiers: ['hourly_wages', 'admin'] });
  assert.ok(!/105000|105,000/.test(readCard(ctx, 's1')));
});

test('with the tier the figure and its hourly equivalent both show', () => {
  const ctx = withTier('salaries');
  const html = readCard(ctx, 's1');
  assert.match(html, /\$105,000/);
  // 105000 / 2080 = 50.48. Shown because it is what the costing report divides
  // by — this page and that report cannot then disagree about what a salary
  // means.
  assert.match(html, /50\.48/);
});

test('somebody with no salary on file is surfaced, not shown as zero', () => {
  const ctx = withTier('salaries');
  const html = readCard(ctx, 's3');
  assert.match(html, /none on file/);
  assert.ok(!/\$0/.test(html), 'a missing salary is not a salary of nothing');
});

// ---------------------------------------------------------------------------
// the field
// ---------------------------------------------------------------------------

test('the field starts at what is stored, not blank', () => {
  // Correcting 105,000 to 110,000 should not mean retyping the part that is
  // already right.
  const ctx = withTier('salaries');
  assert.match(editCard(ctx, 's1'), /value="105000"/);
});

test('the hourly equivalent updates from the draft, and names the divisor', () => {
  const ctx = withTier('salaries');
  editCard(ctx, 's1');
  ctx.state.editing.annualSalary = '124800';
  assert.match(ctx.profileSalaryNote(person(ctx, 's1')), /60\.00/);   // 124800 / 2080
});

test('an unparseable salary is called out before the click', () => {
  const ctx = withTier('salaries');
  editCard(ctx, 's1');
  ctx.state.editing.annualSalary = 'one hundred thousand';
  assert.match(ctx.profileSalaryNote(person(ctx, 's1')), /Not a number/);
});

// ---------------------------------------------------------------------------
// what the save sends
// ---------------------------------------------------------------------------

test('a save that does not touch pay sends NO salary at all', async () => {
  // The same objection the wage field had to answer: a card that saves every
  // field at once must not rewrite somebody's pay as a side effect of a phone
  // number.
  const ctx = withTier('salaries');
  editCard(ctx, 's1');
  ctx.state.editing.phone = '555-0100';
  await ctx.saveEdit();

  const w = patches(ctx).filter(c => /table=employees/.test(c.url));
  assert.strictEqual(w.length, 1);
  assert.ok(!('annual_salary' in w[0].body));
  assert.strictEqual(w[0].body.phone, '555-0100');
});

test('retyping the same salary sends nothing either', async () => {
  const ctx = withTier('salaries');
  editCard(ctx, 's1');
  ctx.state.editing.annualSalary = '105000';
  await ctx.saveEdit();
  const w = patches(ctx).filter(c => /table=employees/.test(c.url));
  assert.ok(!('annual_salary' in w[0].body));
});

test('a real change sends annual_salary as a number', async () => {
  const ctx = withTier('salaries');
  editCard(ctx, 's1');
  ctx.state.editing.annualSalary = '112000';
  await ctx.saveEdit();
  const w = patches(ctx).filter(c => /table=employees/.test(c.url));
  assert.strictEqual(w[0].body.annual_salary, 112000);
});

test('clearing a salary writes null — a real instruction, not a mistake', async () => {
  // Allowed here and refused for the hourly rate, which is not an
  // inconsistency: wage_history.rate is NOT NULL so a removed RATE cannot be
  // recorded at all, and annual_salary has no history table to lie to. The
  // costing report reports a missing salary by name rather than costing that
  // person at zero.
  const ctx = withTier('salaries');
  editCard(ctx, 's1');
  ctx.state.editing.annualSalary = '';
  await ctx.saveEdit();
  const w = patches(ctx).filter(c => /table=employees/.test(c.url));
  assert.strictEqual(w[0].body.annual_salary, null);
});

test('a salary that is not a number refuses the save and never says saved', async () => {
  const ctx = withTier('salaries');
  editCard(ctx, 's1');
  ctx.state.editing.annualSalary = 'abc';
  await ctx.saveEdit();

  assert.strictEqual(patches(ctx).length, 0, 'nothing reached the database');
  assert.strictEqual(lastToast(ctx).type, 'error');
  assert.match(lastToast(ctx).msg, /not an annual salary/);
  // It says "nothing was saved", which is the opposite claim — what must never
  // happen is a SUCCESS toast for a save that did not land.
  assert.match(lastToast(ctx).msg, /nothing was saved/);
  assert.ok(!ctx.__toasts.some(t => t.type === 'success'));
});

test('a reader without the tier cannot post a salary even by editing state', async () => {
  // The client gate is cosmetic and this asserts the cosmetic part only — the
  // server refuses the column outright. What matters here is that a draft left
  // in state by some other path does not ride along on an ordinary save.
  const ctx = sandbox({ tiers: ['hourly_wages'] });
  editCard(ctx, 's1');
  ctx.state.editing.annualSalary = '999999';
  await ctx.saveEdit();
  const w = patches(ctx).filter(c => /table=employees/.test(c.url));
  assert.ok(!('annual_salary' in w[0].body));
});

test('an inactive person\'s salary is still editable, and still theirs', async () => {
  // The list page used to exclude them, because a terminated person's pay is
  // history and a list of open inputs invited a mis-click. A card is opened
  // deliberately, on one person, so the exclusion has nothing left to protect —
  // and refusing the edit would leave a wrong figure uncorrectable.
  const ctx = withTier('salaries');
  const html = editCard(ctx, 's4');
  assert.match(html, /salaryDraftSet/);
});

// ---------------------------------------------------------------------------
// tier plumbing
// ---------------------------------------------------------------------------

test('loadPermissions resolves the tier', async () => {
  // It used to reveal a tab as well. There is no gated tab any more — the
  // salary is a field, and the staffing plan is a sub-view — so what the tier
  // unlocks is asserted where it is drawn, above.
  const ctx = sandbox({ tiers: ['hourly_wages', 'salaries'] });
  await ctx.loadPermissions();
  assert.ok(ctx.canSeeSalaries());
});

test('a permissions request that fails leaves the base tier, and says so', async () => {
  const ctx = sandbox({ responder: (u) => u.startsWith('/api/permissions')
    ? { status: 500, body: { ok: false, error: 'boom' } } : null });
  await ctx.loadPermissions();
  assert.deepStrictEqual(Array.from(ctx.state.perms.tiers), ['hourly_wages']);
  assert.strictEqual(ctx.state.perms.isAdmin, false);
  assert.match(ctx.state.perms.error, /boom/);
  // Failing closed is right; failing closed SILENTLY is not — the error has a
  // surface on Settings.
  assert.match(ctx.renderPermsError(), /boom/);
});

test('a tier this build does not recognise unlocks nothing', async () => {
  const ctx = sandbox({ tiers: ['hourly_wages', 'superuser'] });
  await ctx.loadPermissions();
  assert.deepStrictEqual(Array.from(ctx.state.perms.tiers), ['hourly_wages']);
  assert.ok(!ctx.canSeeSalaries());
});

test('a session left on the retired Overhead tab bounces off it', async () => {
  // A page open across the 2026-09-14 deploy. render() has no branch for that
  // key any more, so without the bounce the content would stay as it was with
  // nothing explaining why.
  const ctx = withTier('salaries');
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
