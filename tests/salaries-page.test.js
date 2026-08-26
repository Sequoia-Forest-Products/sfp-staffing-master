// The Salaries & Wages page, and the Access section that grants entry to it.
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

test('only ACTIVE employees are listed, and the omission is stated', () => {
  const ctx = withTier('salaries');
  const html = ctx.renderSalaries();

  assert.match(html, /Ana Reyes/);
  assert.match(html, /Eduardo Rivera/);
  assert.ok(!/Gone Hourly/.test(html), 'an inactive hourly person is listed');
  assert.ok(!/Gone Salaried/.test(html), 'an inactive salaried person is listed');
  // Not silently: "where is everybody" has an answer on the page.
  assert.match(html, /2 inactive people are not listed/);
});

test('a blank status reads as active rather than hiding a real person', () => {
  // Matches isActive() in ot-report-lib and wage-sync. Guessing "inactive"
  // would drop somebody off the page with no way to notice.
  const ctx = sandbox();
  ctx.state.employees = [{ id: 'h9', name: 'No Status', payType: 'Hourly', wage: '20.00',
                           empNum: '0909', status: '' }];
  assert.match(ctx.renderSalaries(), /No Status/);
});

test('an inactive person cannot be opened by id', () => {
  // The list excludes them, but openPay is reachable from a row rendered
  // before a status changed. The list is not the gate.
  const ctx = withTier('salaries');
  ctx.openPay('h3');
  assert.strictEqual(ctx.state.pay.id, null, 'the detail screen opened for an inactive person');
  assert.match(lastToast(ctx).msg, /not active/);
  assert.ok(!/Gone Hourly/.test(ctx.renderSalaries()));
});

// ---------------------------------------------------------------------------
// the gate, on the page itself
// ---------------------------------------------------------------------------

test('without the tier the salaried SECTION is refused, and no salary is in the HTML', () => {
  const ctx = sandbox();                       // base tier only
  const html = ctx.renderSalaries();

  assert.match(html, /Annual salaries need the salaries tier/i);
  assert.ok(!html.includes('105,000') && !html.includes('105000'), 'no figure');
  assert.ok(!html.includes('250,000') && !html.includes('250000'), 'no figure');
  assert.ok(!/Eduardo Rivera|Jeff Cook/.test(html), 'nor the names of the people who have one');

  // The hourly half is fully there, for the same user, in the same render.
  assert.match(html, /Ana Reyes/);
  assert.match(html, /openPay\('h1'\)/);
});

test('the admin tier alone does not open the salaried section', () => {
  const ctx = withTier('admin');
  assert.match(ctx.renderSalaries(), /Annual salaries need the salaries tier/i);
});

test('without the tier a salaried person cannot be opened by id either', () => {
  // The refusal is not just the section declining to draw. openPay is reachable
  // from a stale row and from the console, and must refuse the same way.
  const ctx = sandbox();
  ctx.openPay('s1');
  assert.strictEqual(ctx.state.pay.id, null, 'the detail screen opened without the tier');
  assert.match(lastToast(ctx).msg, /salaries tier/);
});

// ---------------------------------------------------------------------------
// the list is read-only
// ---------------------------------------------------------------------------
//
// This is the change. Every row used to be an open input and one Save
// committed all of them, so a mis-click was indistinguishable from an edit and
// a single Save could move several people's pay at once — each writing a
// wage_history row attributing the change to whoever clicked.

test('the list has no inputs at all — a row opens a screen instead', () => {
  const ctx = withTier('salaries');
  const html = ctx.renderSalaries();

  assert.ok(!/<input/.test(html), 'the list still has an editable field on it');
  assert.ok(!/salarySet\(|wageSet\(/.test(html), 'the old per-row setters are still wired');
  assert.ok(!/saveSalaries\(\)|saveWages\(\)/.test(html), 'a bulk Save survives');

  assert.match(html, /onclick="openPay\('h1'\)"/);
  assert.match(html, /onclick="openPay\('s1'\)"/);
});

test('somebody with no employee number has no way in, and the row says why', () => {
  // wage_history.employee_number is NOT NULL and the server refuses the write.
  const ctx = sandbox();
  ctx.state.employees = [{ id: 'h9', name: 'Unnumbered', payType: 'Hourly', wage: '20.00',
                           empNum: '', status: 'Active', position: 'Utility', department: 'Production' }];
  const html = ctx.renderSalaries();

  assert.ok(!/openPay\('h9'\)/.test(html), 'the row is clickable');
  assert.match(html, /\$20\.00/, 'the rate is still shown');
  assert.match(html, /needs Emp #/);
});

test('opening an unnumbered person by id is refused with the remedy', () => {
  const ctx = sandbox();
  ctx.state.employees = [{ id: 'h9', name: 'Unnumbered', payType: 'Hourly', wage: '20.00',
                           empNum: '', status: 'Active' }];
  ctx.openPay('h9');
  assert.strictEqual(ctx.state.pay.id, null);
  assert.match(lastToast(ctx).msg, /Emp #/);
});

test('people with nothing on file are surfaced rather than shown as zero', () => {
  const ctx = withTier('salaries');
  const html = ctx.renderSalaries();
  assert.match(html, /1 person has no salary on file/);
  assert.match(html, /1 person has no rate on file/);
  assert.match(html, /no rate/);
  assert.match(html, /none on file/);
  assert.match(html, /\$355,000/);             // 105000 + 250000
  assert.match(html, /excluding 1 with none/);
});

// ---------------------------------------------------------------------------
// the detail screen
// ---------------------------------------------------------------------------

test('opening a row shows that person and nobody else', () => {
  const ctx = withTier('salaries');
  ctx.openPay('h1');
  const html = ctx.renderSalaries();

  assert.match(html, /Ana Reyes/);
  assert.ok(!/Eduardo Rivera|No Rate/.test(html), 'the detail screen is showing other people');
  assert.match(html, /Hourly rate/);
  assert.match(html, /savePay\(\)/);
  assert.match(html, /closePay\(\)/);
});

test('the field starts at what is stored, not blank', () => {
  // Correcting 22.00 to 23.00 should not mean retyping the part already right.
  const ctx = withTier('salaries');
  ctx.openPay('h1');
  assert.strictEqual(ctx.state.pay.draft, '22.00');

  ctx.openPay('s1');
  assert.strictEqual(ctx.state.pay.draft, '105000');
});

test('a salaried person gets the salary field and the hourly equivalent', () => {
  const ctx = withTier('salaries');
  ctx.openPay('s1');
  const html = ctx.renderSalaries();
  assert.match(html, /Annual salary/);
  assert.ok(!/Hourly rate/.test(html));
  assert.match(html, /\$50\.48/);              // 105000 / 2080
});

test('Save is disabled until something actually changes', () => {
  const ctx = withTier('salaries');
  ctx.openPay('h1');
  assert.match(ctx.renderSalaries(), /savePay\(\)" disabled/, 'Save is live on an unchanged field');

  ctx.paySet('23.00');
  assert.ok(!/savePay\(\)" disabled/.test(ctx.renderSalaries()));
});

test('retyping the same value in a different format is not a change', () => {
  const ctx = withTier('salaries');
  ctx.openPay('h1');
  for (const typed of ['22', '22.00', ' $22.00 ']) {
    ctx.paySet(typed);
    assert.strictEqual(ctx.payDirty(), false, typed);
  }
});

test('Cancel leaves without writing, and drops the draft', async () => {
  const ctx = withTier('salaries');
  ctx.openPay('h1');
  ctx.paySet('99.00');
  ctx.closePay();

  assert.strictEqual(ctx.state.pay.id, null);
  assert.strictEqual(ctx.state.pay.draft, '');
  assert.deepStrictEqual(writes(ctx), []);
  assert.strictEqual(person(ctx, 'h1').wage, 22, 'the local copy moved on a Cancel');
});

// ---------------------------------------------------------------------------
// saving
// ---------------------------------------------------------------------------

test('a base-tier user saves a rate, and only `wage` goes', async () => {
  const ctx = sandbox();                       // no grant at all
  ctx.openPay('h1');
  ctx.paySet('26');
  await ctx.savePay();

  const w = writes(ctx);
  assert.strictEqual(w.length, 1, 'one person open, one write');
  assert.match(w[0].url, /table=employees&id=h1/);
  assert.strictEqual(w[0].method, 'PATCH');
  assert.deepStrictEqual(Object.keys(w[0].body), ['wage'], 'nothing else rides along');
  assert.strictEqual(w[0].body.wage, '26.00', 'two decimals, matching the roster');

  assert.strictEqual(person(ctx, 'h1').wage, '26.00');
  assert.strictEqual(ctx.state.pay.id, null, 'a successful save returns to the list');
  assert.match(lastToast(ctx).msg, /Rate saved/);
});

test('a salary save sends only annual_salary', async () => {
  const ctx = withTier('salaries');
  ctx.openPay('s1');
  ctx.paySet('110000');
  await ctx.savePay();

  const [w] = writes(ctx);
  assert.deepStrictEqual(Object.keys(w.body), ['annual_salary']);
  assert.strictEqual(w.body.annual_salary, 110000);
  assert.strictEqual(person(ctx, 's1').annualSalary, 110000);
});

test('clearing a salary writes null — a real instruction, not a mistake', async () => {
  const ctx = withTier('salaries');
  ctx.openPay('s1');
  ctx.paySet('');
  await ctx.savePay();
  const [w] = writes(ctx);
  assert.strictEqual(w.body.annual_salary, null);
});

test('clearing a RATE is refused, because it could not be recorded', async () => {
  // The asymmetry with salary above is deliberate: wage_history.rate is NOT
  // NULL, so a rate that went away cannot be recorded at all.
  const ctx = sandbox();
  ctx.openPay('h1');
  ctx.paySet('');
  await ctx.savePay();

  assert.deepStrictEqual(writes(ctx), []);
  assert.match(ctx.state.pay.error, /cannot be cleared/i);
  assert.strictEqual(ctx.state.pay.id, 'h1', 'a refusal keeps you on the screen');
  assert.match(ctx.renderSalaries(), /Not saved/);
});

test('zero, negative and unparseable rates are refused with their own sentence', async () => {
  for (const bad of ['0', '-5', 'about 26']) {
    const ctx = sandbox();
    ctx.openPay('h1');
    ctx.paySet(bad);
    await ctx.savePay();
    assert.deepStrictEqual(writes(ctx), [], bad);
    assert.match(ctx.state.pay.error, /not an hourly rate/i, bad);
  }
});

test('a negative salary is refused as unparseable rather than stored', async () => {
  const ctx = withTier('salaries');
  ctx.openPay('s1');
  ctx.paySet('-5000');
  await ctx.savePay();
  assert.deepStrictEqual(writes(ctx), []);
  assert.match(ctx.state.pay.error, /not a number/i);
});

test("a 409 shows the server's sentence, not 'status 409'", async () => {
  const ctx = sandbox({
    responder: (url, method) => method === 'PATCH'
      ? { status: 409, body: { error: 'A salaried employee has no hourly rate.',
                               detail: 'Their cost comes from Annual salary / 2,080.' } } : null
  });
  ctx.openPay('h1');
  ctx.paySet('26.00');
  await ctx.savePay();

  assert.match(ctx.state.pay.error, /Annual salary \/ 2,080/);
  assert.strictEqual(ctx.state.pay.id, 'h1', 'the screen stays open so the value is not lost');
  assert.strictEqual(ctx.state.pay.draft, '26.00');
  assert.strictEqual(person(ctx, 'h1').wage, 22, 'the local copy is not advanced');
});

test("a 403 mid-save says the tier is gone, not 'status 403'", async () => {
  const ctx = sandbox({
    tiers: ['hourly_wages', 'salaries'],
    responder: (url, method) => method === 'PATCH'
      ? { status: 403, body: { error: 'Not permitted to write: annual_salary' } } : null
  });
  ctx.openPay('s1');
  ctx.paySet('110000');
  await ctx.savePay();

  assert.match(ctx.state.pay.error, /no longer permitted to edit salaries/);
  assert.strictEqual(person(ctx, 's1').annualSalary, 105000, 'the local copy is not advanced');
});

test('a failed save NEVER says saved', async () => {
  const ctx = sandbox({
    responder: (url, method) => method === 'PATCH'
      ? { status: 500, body: { error: 'database unavailable' } } : null
  });
  ctx.openPay('h1');
  ctx.paySet('26.00');
  await ctx.savePay();

  assert.ok(!ctx.__toasts.some(t => /saved/i.test(t.msg)), 'a success toast fired on a failure');
  assert.match(ctx.state.pay.error, /database unavailable/);
  assert.strictEqual(ctx.state.pay.saving, false, 'the screen is stuck in Saving');
});

test('an unchanged save writes nothing and says so', async () => {
  const ctx = sandbox();
  ctx.openPay('h1');
  ctx.paySet('22.00');
  await ctx.savePay();
  assert.deepStrictEqual(writes(ctx), []);
  assert.match(lastToast(ctx).msg, /Nothing has changed/);
});

test('one save moves one person, and cannot reach a second', async () => {
  // The property the old page could not offer: there is one draft because
  // there is one field, so nothing else can ride along on the click.
  const ctx = withTier('salaries');
  ctx.openPay('h1');
  ctx.paySet('26.00');
  await ctx.savePay();

  assert.strictEqual(writes(ctx).length, 1);
  assert.strictEqual(person(ctx, 'h2').wage, '', 'the other hourly row moved');
  assert.strictEqual(person(ctx, 's1').annualSalary, 105000, 'a salary moved on a rate save');
});

test('a move past the threshold is warned about before the click, not blocked', async () => {
  // The classic typo, 2200 for 22.00. The server applies it and flags it —
  // blocking would stall a real raise — so the screen says so while it can
  // still be fixed.
  const ctx = sandbox();
  ctx.openPay('h1');
  ctx.paySet('2200');
  assert.match(ctx.renderSalaries(), /will be flagged/);

  await ctx.savePay();
  assert.strictEqual(writes(ctx).length, 1, 'warned, not blocked');
});

test('an ordinary raise shows its size and no warning', () => {
  const ctx = sandbox();
  ctx.openPay('h1');
  ctx.paySet('23.00');
  const html = ctx.renderSalaries();
  assert.match(html, /\+4\.55%/);
  assert.ok(!/will be flagged/.test(html));
});

test('a first rate says so rather than showing a percentage of nothing', () => {
  const ctx = sandbox();
  ctx.openPay('h2');                            // No Rate, empNum 0202
  ctx.paySet('19.75');
  assert.match(ctx.renderSalaries(), /First rate on file/);
});

// ---------------------------------------------------------------------------
// tier plumbing
// ---------------------------------------------------------------------------

test('loadPermissions resolves the tier and reveals the gated tab', async () => {
  const ctx = sandbox({ tiers: ['hourly_wages', 'salaries'] });
  await ctx.loadPermissions();
  assert.ok(ctx.canSeeSalaries());
  assert.strictEqual(ctx.__el('tab:economics').hidden, false);
  assert.strictEqual(ctx.__el('tab:salaries').hidden, false);
});

test('a permissions request that fails leaves the base tier and hides Economics', async () => {
  const ctx = sandbox({ responder: (u) => u.startsWith('/api/permissions')
    ? { status: 500, body: { ok: false, error: 'boom' } } : null });
  await ctx.loadPermissions();
  assert.deepStrictEqual(Array.from(ctx.state.perms.tiers), ['hourly_wages']);
  assert.strictEqual(ctx.state.perms.isAdmin, false);
  assert.strictEqual(ctx.__el('tab:economics').hidden, true);
  // Salaries & Wages opens anyway. Losing the tab because a request failed
  // would mean nobody could set a pay rate until it recovered.
  assert.strictEqual(ctx.__el('tab:salaries').hidden, false);
  assert.match(ctx.state.perms.error, /boom/);
});

test('a tier this build does not recognise unlocks nothing', async () => {
  const ctx = sandbox({ tiers: ['hourly_wages', 'superuser'] });
  await ctx.loadPermissions();
  assert.deepStrictEqual(Array.from(ctx.state.perms.tiers), ['hourly_wages']);
  assert.ok(!ctx.canSeeSalaries());
});

test('losing the tier while looking at the page LEAVES you on it', async () => {
  // The reverse of what this asserted before. The page is no longer the tier's
  // page, and bouncing somebody off it would take away the rate editor as well
  // as the salaries they can no longer see.
  const ctx = sandbox({ tiers: ['hourly_wages'] });
  ctx.state.tab = 'salaries';
  ctx.applyTabVisibility();
  assert.strictEqual(ctx.state.tab, 'salaries');
  assert.match(ctx.renderSalaries(), /Annual salaries need the salaries tier/i);
});

test('losing the tier while looking at Staffing Economics still bounces', async () => {
  const ctx = sandbox({ tiers: ['hourly_wages'] });
  ctx.state.tab = 'economics';
  ctx.applyTabVisibility();
  assert.strictEqual(ctx.state.tab, 'employees');
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
