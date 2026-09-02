// The Settings tab: who may change what, and what a refusal looks like.
//
// The gate is server-side — /api/settings refuses a POST from anybody without
// the admin tier, above any parsing or database access, and
// tests/settings-api.test.js asserts that against real responses. What is
// tested here is the other half:
//
//   1. the page does not OFFER a control the server would refuse, and
//   2. when a refusal happens anyway it is REPORTED rather than swallowed.
//
// (2) is the one that matters. saveEmailSettings used to ignore every failure
// and write to localStorage instead, so a refused save would have shown "OT
// budget saved" and left the browser holding a private copy of a setting the
// server rejected.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'src', 'js');
const { __SCRIPT_MODULES } = require('../netlify/functions/session.js');

function fakeEl(id) {
  return {
    id, textContent: '', innerHTML: '', value: '', checked: false, hidden: false,
    style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {}, addEventListener() {},
    appendChild() {}, querySelector: () => fakeEl(), querySelectorAll: () => []
  };
}

function sandbox({ tiers = ['hourly_wages'], responder = null } = {}) {
  const calls = [];
  const toasts = [];
  const stored = new Map();
  const els = new Map();
  const getEl = (id) => {
    if (!els.has(id)) els.set(id, fakeEl(id));
    return els.get(id);
  };
  const ctx = {
    console: { ...console, error() {}, warn() {} },
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
    // Recorded, not stubbed away: whether a refused save leaves a private copy
    // in the browser is the point of two of these tests.
    localStorage: {
      getItem: k => (stored.has(k) ? stored.get(k) : null),
      setItem: (k, v) => stored.set(k, v),
      removeItem: k => stored.delete(k)
    },
    fetch: async (url, opts = {}) => {
      const u = String(url);
      const method = opts.method || 'GET';
      calls.push({ url: u, method, body: opts.body ? JSON.parse(opts.body) : null });
      const over = responder ? responder(u, method, calls.length) : null;
      if (over) return { ok: over.status < 400, status: over.status, json: async () => over.body };
      if (u.startsWith('/api/permissions')) {
        return { ok: true, status: 200, json: async () => ({
          ok: true, email: 'me@sequoiafp.com', tiers, grants: null,
          isAdmin: tiers.includes('admin'), grantableTiers: ['salaries', 'admin'] }) };
      }
      if (u.startsWith('/api/settings')) {
        // serverSettings(), not the shared literal. state.emailSettings is a
        // SHALLOW copy of it, so addManager's push mutated the fixture itself
        // and the reload then handed back the value it was supposed to undo —
        // a test that passed by agreeing with the bug.
        return { ok: true, status: 200, json: async () => ({
          data: { key: 'emailSettings', value: JSON.stringify(serverSettings()) } }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, data: [] }) };
    }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const m of __SCRIPT_MODULES) {
    if (m === 'bootstrap.js') continue;
    vm.runInContext(fs.readFileSync(path.join(SRC, m), 'utf8'), ctx, { filename: m });
  }
  vm.runInContext('globalThis.state = state;', ctx, { filename: 'expose.js' });
  vm.runInContext('toast = (msg, type) => { globalThis.__toasts.push({ msg, type }); };',
    ctx, { filename: 'stub-toast.js' });
  ctx.__toasts = toasts;
  ctx.__calls = calls;
  ctx.__stored = stored;
  ctx.__el = getEl;
  ctx.state.employees = [];
  ctx.state.loading = false;
  ctx.state.perms.tiers = tiers.slice();
  ctx.state.perms.isAdmin = tiers.includes('admin');
  ctx.state.perms.loaded = true;
  ctx.state.emailSettings = { ...ctx.EMAIL_SETTINGS_DEFAULTS, ...serverSettings() };
  return ctx;
}

// What the server holds. A refused save must leave the page showing these.
// A FUNCTION, not a constant: every caller gets its own arrays, so one test's
// edit cannot reach another test or the fixture the reload reads back.
const serverSettings = () => ({
  managers: ['ryley@sequoiafp.com'],
  autoSend: true,
  otBudgetPercent: 5,
  graceHoursPerEmployee: 0.5
});

const admin = () => sandbox({ tiers: ['hourly_wages', 'admin'] });
const lastToast = (ctx) => ctx.__toasts[ctx.__toasts.length - 1] || {};
const writes = (ctx) => ctx.__calls.filter(c => c.method !== 'GET');

// ---------------------------------------------------------------------------
// what the page offers
// ---------------------------------------------------------------------------

test('a non-admin sees every figure and no control to change one', () => {
  const ctx = sandbox();
  const html = ctx.renderSettings();

  // The values are all there — they are on every report that uses them, and
  // hiding them would make those reports less legible while protecting nothing.
  assert.match(html, /ryley@sequoiafp\.com/);
  assert.match(html, /0\.5/);
  assert.match(html, /Email the completed week to managers every Monday morning/);

  // And nothing to type into or click.
  assert.ok(!/setOTBudgetPercent\(/.test(html), 'the OT budget is editable');
  assert.ok(!/setGraceHours\(/.test(html), 'the grace allowance is editable');
  assert.ok(!/addManager\(\)/.test(html), 'the recipient list can be added to');
  assert.ok(!/removeManager\(/.test(html), 'a recipient can be removed');
  assert.ok(!/saveEmailSettings\(\)/.test(html), 'the auto-send checkbox is live');
  assert.ok(!/<input/.test(html), 'a field the server would refuse is on the page');

  assert.match(html, /read-only/);
  assert.match(html, /only an\s+administrator may change them/i);
});

test('an admin gets the controls back', () => {
  const ctx = admin();
  const html = ctx.renderSettings();

  assert.match(html, /setOTBudgetPercent\(/);
  assert.match(html, /setGraceHours\(/);
  assert.match(html, /addManager\(\)/);
  assert.match(html, /removeManager\(0\)/);
  assert.match(html, /id="newManagerEmail"/);
  assert.ok(!/read-only/.test(html));
});

test('the salaries tier alone does not unlock the settings', () => {
  // Mirrors the server: this endpoint is about who may change what the report
  // says, which is a different question from who may read pay.
  const ctx = sandbox({ tiers: ['hourly_wages', 'salaries'] });
  const html = ctx.renderSettings();
  assert.ok(!/setGraceHours\(/.test(html));
  assert.match(html, /read-only/);
});

test('an empty recipient list reads differently for someone who cannot fix it', () => {
  const ctx = sandbox();
  ctx.state.emailSettings = { ...ctx.state.emailSettings, managers: [] };
  const html = ctx.renderSettings();

  // "Add email addresses above" points at a control that is not there.
  assert.ok(!/Add email addresses above/.test(html));
  assert.match(html, /not being emailed to anyone/);
});

// ---------------------------------------------------------------------------
// what a refusal does
// ---------------------------------------------------------------------------

const refuse403 = (url, method) => (url.startsWith('/api/settings') && method === 'POST')
  ? { status: 403, body: { error: 'Only an administrator may change these settings.',
                           detail: 'The manager recipient list, the timeclock grace allowance and the OT budget all change what the weekly report says and who receives it.' } }
  : null;

test('a refused save says so, and never claims success', async () => {
  const ctx = sandbox({ responder: refuse403 });
  await ctx.setOTBudgetPercent(99);

  const t = lastToast(ctx);
  assert.strictEqual(t.type, 'error');
  assert.match(t.msg, /weekly report says and who receives it/);
  assert.ok(!ctx.__toasts.some(x => /OT budget saved/.test(x.msg)),
    'the success toast fired after a refusal');
});

test('a refused save leaves NO private copy in the browser', async () => {
  // The old saveEmailSettings wrote to localStorage on every failure, and
  // loadEmailSettings reads it back when the server has nothing. That would let
  // a refused user keep their own recipient list and grace allowance across
  // reloads — a setting the server rejected, applied anyway, on their machine.
  const ctx = sandbox({ responder: refuse403 });
  await ctx.setGraceHours(8);

  assert.strictEqual(ctx.__stored.get('emailSettings'), undefined,
    'the refused value was cached locally');
  assert.strictEqual(ctx.__stored.size, 0);
});

test('a refused save puts the server\'s value back on the page', async () => {
  const ctx = sandbox({ responder: refuse403 });
  await ctx.setGraceHours(8);
  assert.strictEqual(ctx.state.emailSettings.graceHoursPerEmployee, 0.5,
    'the page kept showing the value the server refused');
});

test('a refused Add Manager does not add the manager', async () => {
  const ctx = sandbox({ responder: refuse403 });
  ctx.__el('newManagerEmail').value = 'outsider@sequoiafp.com';
  await ctx.addManager();

  // Array.from: deepStrictEqual compares prototypes, and an array built inside
  // the vm realm is not reference-equal to one built out here.
  assert.deepStrictEqual(Array.from(ctx.state.emailSettings.managers), ['ryley@sequoiafp.com']);
  assert.strictEqual(lastToast(ctx).type, 'error');
  assert.ok(!ctx.__toasts.some(x => /Manager added/.test(x.msg)));
});

test('a refused Remove does not remove the manager', async () => {
  const ctx = sandbox({ responder: refuse403 });
  await ctx.removeManager(0);
  assert.deepStrictEqual(Array.from(ctx.state.emailSettings.managers), ['ryley@sequoiafp.com']);
  assert.ok(!ctx.__toasts.some(x => /Manager removed/.test(x.msg)));
});

test('an admin save still reports success and writes once', async () => {
  const ctx = admin();
  await ctx.setOTBudgetPercent(7);

  const w = writes(ctx);
  assert.strictEqual(w.length, 1);
  assert.strictEqual(w[0].url, '/api/settings');
  assert.strictEqual(w[0].body.value.otBudgetPercent, 7);
  assert.match(lastToast(ctx).msg, /OT budget saved/);
});

test('a 500 is still cached locally — a refusal and an outage are not the same', async () => {
  // The localStorage fallback exists for the case where the browser holds the
  // only copy of what somebody typed. That is a transient failure, not a
  // decision, and removing the fallback with the 403 would lose real edits.
  const ctx = admin();
  ctx.state.perms.tiers = ['hourly_wages', 'admin'];
  const outage = (url, method) => (url.startsWith('/api/settings') && method === 'POST')
    ? { status: 500, body: { error: 'database unavailable' } } : null;
  const ctx2 = sandbox({ tiers: ['hourly_wages', 'admin'], responder: outage });
  await ctx2.setOTBudgetPercent(7);

  assert.ok(ctx2.__stored.get('emailSettings'), 'a transient failure lost the edit');
  assert.match(lastToast(ctx2).msg, /OT budget saved/);
  void ctx;
});

// ---------------------------------------------------------------------------
// the permissions read that failed
// ---------------------------------------------------------------------------

test('a failed permissions load is SAID, not just acted on', async () => {
  // Failing closed is right. Failing closed silently is how somebody spends an
  // afternoon on a transient network error: the Access section disappears,
  // Staffing Economics disappears, and the obvious reading is that their
  // access was revoked.
  const ctx = sandbox({ responder: (u) => u.startsWith('/api/permissions')
    ? { status: 500, body: { ok: false, error: 'upstream timeout' } } : null });
  await ctx.loadPermissions();

  assert.deepStrictEqual(Array.from(ctx.state.perms.tiers), ['hourly_wages'], 'it still fails closed');

  const html = ctx.renderSettings();
  assert.match(html, /Your access could not be checked/);
  assert.match(html, /Nothing has been revoked/);
  assert.match(html, /Reload the page/);
  assert.match(html, /upstream timeout/, 'the underlying error is quoted');
});

test('a successful permissions load says nothing at all', async () => {
  const ctx = sandbox({ tiers: ['hourly_wages', 'admin'] });
  await ctx.loadPermissions();
  assert.strictEqual(ctx.state.perms.error, '');
  assert.ok(!/Your access could not be checked/.test(ctx.renderSettings()));
});

test('the error is escaped, not injected', async () => {
  const ctx = sandbox({ responder: (u) => u.startsWith('/api/permissions')
    ? { status: 500, body: { ok: false, error: '<img src=x onerror=alert(1)>' } } : null });
  await ctx.loadPermissions();

  const html = ctx.renderSettings();
  assert.ok(!/<img src=x/.test(html), 'the error was rendered as markup');
  assert.match(html, /&lt;img/);
});
