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

const SALARIED = [
  { id: 's1', name: 'Eduardo Rivera', payType: 'Salaried', wage: '', annualSalary: 105000,
    position: 'Plant Superintendent', department: 'Production', empNum: '0101' },
  { id: 's2', name: 'Jeff Cook', payType: 'Salaried', wage: '', annualSalary: 250000,
    position: 'CEO', department: 'Corporate', empNum: '' },
  { id: 's3', name: 'No Salary Yet', payType: 'Salaried', wage: '', annualSalary: null,
    position: 'Controller', department: 'Accounting', empNum: '' }
];
const HOURLY = [
  { id: 'h1', name: 'Ana Reyes', payType: 'Hourly', wage: 22, annualSalary: null,
    position: 'Puller', department: 'Production', empNum: '0201' },
  { id: 'h2', name: 'No Rate', payType: 'Hourly', wage: '', annualSalary: null,
    position: 'Utility', department: 'Production', empNum: '0202' }
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

// ---------------------------------------------------------------------------
// the gate, on the page itself
// ---------------------------------------------------------------------------

test('without the tier the page refuses to draw, and no salary is in the HTML', () => {
  const ctx = sandbox();                       // base tier only
  const html = ctx.renderSalaries();

  assert.match(html, /needs the salaries tier/i);
  assert.ok(!html.includes('105,000') && !html.includes('105000'), 'no figure');
  assert.ok(!html.includes('250,000') && !html.includes('250000'), 'no figure');
  assert.ok(!html.includes('<input'), 'and nothing to type into');
});

test('with the tier the figures render and are editable', () => {
  const ctx = withTier('salaries');
  const html = ctx.renderSalaries();

  assert.match(html, /Eduardo Rivera/);
  assert.match(html, /105000/);                 // the input's value
  assert.match(html, /salarySet\('s1'/);        // and it is an input
  // The hourly equivalent the costing reports will use, shown so the two cannot
  // disagree: 105000 / 2080 = 50.48.
  assert.match(html, /\$50\.48/);
});

test('the admin tier alone does not open the page', () => {
  // Admin grants access; it does not itself read pay. Mirrors the server-side
  // assertion in permissions.test.js.
  const ctx = withTier('admin');
  assert.match(ctx.renderSalaries(), /needs the salaries tier/i);
});

test('the hourly section has no inputs at all', () => {
  const ctx = withTier('salaries');
  const html = ctx.renderSalaries();
  const hourlySection = html.slice(html.indexOf('>Hourly<'));
  assert.match(hourlySection, /Ana Reyes/);
  assert.match(hourlySection, /\$22\.00/);
  assert.ok(!hourlySection.includes('<input'), 'BBSI owns the column; there is nothing to type');
  assert.match(hourlySection, /replaced\s+overnight/);
});

test('people with nothing on file are surfaced rather than shown as zero', () => {
  const ctx = withTier('salaries');
  const html = ctx.renderSalaries();
  assert.match(html, /1 person has no salary on file/);
  assert.match(html, /1 person has no rate on file/);
  // The total excludes them rather than treating null as 0.
  assert.match(html, /\$355,000/);             // 105000 + 250000
  assert.match(html, /excluding 1 with none/);
});

// ---------------------------------------------------------------------------
// saving
// ---------------------------------------------------------------------------

test('only changed rows are written, and only annual_salary goes', async () => {
  const ctx = withTier('salaries');
  ctx.salarySet('s1', '110000');
  await ctx.saveSalaries();

  const w = writes(ctx);
  assert.strictEqual(w.length, 1, 'one row changed, one write');
  assert.match(w[0].url, /table=employees&id=s1/);
  assert.strictEqual(w[0].method, 'PATCH');
  assert.deepStrictEqual(Object.keys(w[0].body), ['annual_salary'],
    'nothing else rides along on a salary edit');
  assert.strictEqual(w[0].body.annual_salary, 110000);
  assert.strictEqual(ctx.state.employees[0].annualSalary, 110000);
});

test('retyping the same number in a different format is not a change', async () => {
  const ctx = withTier('salaries');
  ctx.salarySet('s1', '$105,000.00');
  await ctx.saveSalaries();
  assert.deepStrictEqual(writes(ctx), [], 'no row, no audit entry, no write');
  assert.match(lastToast(ctx).msg, /Nothing has changed/);
});

test('clearing a salary writes null — a real instruction, not a mistake', async () => {
  const ctx = withTier('salaries');
  ctx.salarySet('s1', '');
  await ctx.saveSalaries();
  const [w] = writes(ctx);
  assert.strictEqual(w.body.annual_salary, null);
});

test('an unparseable figure stops the WHOLE save, and writes nothing', async () => {
  const ctx = withTier('salaries');
  ctx.salarySet('s1', '110000');          // good
  ctx.salarySet('s2', 'about 250k');      // not a number
  await ctx.saveSalaries();

  assert.deepStrictEqual(writes(ctx), [],
    'the good row is NOT written either — a partial save nobody asked for is how ' +
    'somebody walks away believing all of it landed');
  assert.match(lastToast(ctx).msg, /Not a number: Jeff Cook \("about 250k"\)/);
  assert.strictEqual(lastToast(ctx).type, 'error');
  // And the typed values survive, so nothing has to be retyped.
  assert.strictEqual(ctx.state.salaryDrafts.s1, '110000');
});

test('a negative salary is refused as unparseable rather than stored', async () => {
  const ctx = withTier('salaries');
  ctx.salarySet('s1', '-5000');
  await ctx.saveSalaries();
  assert.deepStrictEqual(writes(ctx), []);
  assert.match(lastToast(ctx).msg, /Not a number/);
});

test('a partial failure names who did not save, and never says Saved', async () => {
  const ctx = sandbox({
    tiers: ['hourly_wages', 'salaries'],
    responder: (url, method) => (method === 'PATCH' && url.includes('id=s2'))
      ? { status: 500, body: { error: 'database unavailable' } } : null
  });
  ctx.salarySet('s1', '110000');
  ctx.salarySet('s2', '260000');
  await ctx.saveSalaries();

  const t = lastToast(ctx);
  assert.strictEqual(t.type, 'error');
  assert.match(t.msg, /Saved 1 of 2/);
  assert.match(t.msg, /NOT saved: Jeff Cook/);
  assert.ok(!/^Saved \d+ salaries/.test(t.msg), 'no success claim');
  // The one that landed is cleared; the one that did not keeps its draft.
  assert.ok(!('s1' in ctx.state.salaryDrafts));
  assert.strictEqual(ctx.state.salaryDrafts.s2, '260000');
});

test('a 403 mid-save says the tier is gone, not "status 403"', async () => {
  const ctx = sandbox({
    tiers: ['hourly_wages', 'salaries'],
    responder: (url, method) => method === 'PATCH'
      ? { status: 403, body: { error: 'Not permitted to write: annual_salary' } } : null
  });
  ctx.salarySet('s1', '110000');
  await ctx.saveSalaries();
  assert.match(lastToast(ctx).msg, /no longer permitted to edit salaries/);
  assert.strictEqual(ctx.state.employees[0].annualSalary, 105000, 'the local copy is not advanced');
});

test('Discard drops every draft and writes nothing', async () => {
  const ctx = withTier('salaries');
  ctx.salarySet('s1', '999');
  ctx.salarySet('s2', '888');
  ctx.salaryCancel();
  assert.strictEqual(Object.keys(ctx.state.salaryDrafts).length, 0,
    'compared by key count: deepStrictEqual across vm realms compares prototypes');
  assert.deepStrictEqual(writes(ctx), []);
});

// ---------------------------------------------------------------------------
// tier plumbing
// ---------------------------------------------------------------------------

test('loadPermissions resolves the tier and reveals the tab', async () => {
  const ctx = sandbox({ tiers: ['hourly_wages', 'salaries'] });
  await ctx.loadPermissions();
  assert.ok(ctx.canSeeSalaries());
  assert.strictEqual(ctx.__el('tab:salaries').hidden, false);
});

test('a permissions request that fails leaves the base tier and hides the tab', async () => {
  const ctx = sandbox({ responder: (u) => u.startsWith('/api/permissions')
    ? { status: 500, body: { ok: false, error: 'boom' } } : null });
  await ctx.loadPermissions();
  assert.deepStrictEqual(Array.from(ctx.state.perms.tiers), ['hourly_wages']);
  assert.strictEqual(ctx.state.perms.isAdmin, false);
  assert.strictEqual(ctx.__el('tab:salaries').hidden, true);
  assert.match(ctx.state.perms.error, /boom/);
});

test('a tier this build does not recognise unlocks nothing', async () => {
  const ctx = sandbox({ tiers: ['hourly_wages', 'superuser'] });
  await ctx.loadPermissions();
  assert.deepStrictEqual(Array.from(ctx.state.perms.tiers), ['hourly_wages']);
  assert.ok(!ctx.canSeeSalaries());
});

test('losing the tier while looking at the page bounces off it', async () => {
  const ctx = sandbox({ tiers: ['hourly_wages'] });
  ctx.state.tab = 'salaries';
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
