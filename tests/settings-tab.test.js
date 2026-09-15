// The Settings tab: what it offers, and what a refusal looks like.
//
// THE ADMIN GATE IS GONE, 2026-09-15. /api/settings refused a POST from anybody
// without the admin tier; access is an explicit list now and everyone on it
// holds the same rights, so half of what this file used to test does not exist.
//
// What remains is the half that always mattered: when a save is refused it is
// REPORTED rather than swallowed. saveEmailSettings used to ignore every
// failure and write to localStorage instead, so a refused save showed "OT
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

// `tiers` is gone with the tier model. Nothing about this sandbox varies by
// caller any more — that is the change.
function sandbox({ responder = null } = {}) {
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
          ok: true, caller: 'me@sequoiafp.com', hasAccess: true,
          list: ['me@sequoiafp.com', 'ryley@sequoiafp.com'] }) };
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
  ctx.state.perms.list = ['me@sequoiafp.com', 'ryley@sequoiafp.com'];
  ctx.state.perms.hasAccess = true;
  ctx.state.perms.email = 'me@sequoiafp.com';
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

// There is no admin since 2026-09-15 — one access list, no roles. Kept as an
// alias so the tests that used it read as what they now assert: everybody gets
// the controls.
const admin = () => sandbox();
const lastToast = (ctx) => ctx.__toasts[ctx.__toasts.length - 1] || {};
const writes = (ctx) => ctx.__calls.filter(c => c.method !== 'GET');

// ---------------------------------------------------------------------------
// what the page offers
// ---------------------------------------------------------------------------

test('everybody signed in gets every control — there are no roles', () => {
  // The reversal, 2026-09-15. These controls were admin-only because sign-in
  // was the whole sequoiafp.com domain. Access is an explicit list now and
  // everyone on it holds the same rights, so a gate here would be a role.
  const ctx = sandbox();
  const html = ctx.renderSettings();

  assert.match(html, /setOTBudgetPercent\(/);
  assert.match(html, /setGraceHours\(/);
  assert.match(html, /addHoliday\(\)/);
  assert.ok(!/read-only/.test(html));
  assert.ok(!/administrator/i.test(html), 'nothing on the page still talks about admins');
});

test('THE AUTO-SEND CHECKBOX IS GONE — the Monday email always sends', () => {
  // Removed 2026-09-15. The people who could have turned it off are exactly the
  // people who receive it, and a weekly report that stops arriving because
  // somebody unticked a box a month ago is a failure nobody notices.
  const ctx = sandbox();
  const html = ctx.renderSettings();

  assert.ok(!/type="checkbox"/.test(html), 'a checkbox is back on this page');
  assert.ok(!/autoSend/.test(html));
  // The paragraph explaining the removal came out on 2026-09-15 — the switch
  // being gone is what matters, not the note about it.
  assert.ok(!/There is no switch/.test(html));
  assert.ok(!/emailed every Monday morning/.test(html));
});

test('the recipient list is NOT edited here — it is the access list', () => {
  // There were two lists both meaning "the managers", and the live data had
  // jeffrey.cook@ on one and jefrey.cook@ — one f — on the other.
  const ctx = sandbox();
  const html = ctx.renderSettings();

  assert.ok(!/addManager\(\)/.test(html), 'the second recipient list is editable again');
  assert.ok(!/removeManager\(/.test(html));
  assert.ok(!/id="newManagerEmail"/.test(html));
  // No Report Recipients block either: the access list above IS the list, and
  // the paragraph saying so was removed on 2026-09-15.
  assert.ok(!/Report Recipients/.test(html));
  assert.ok(!/Everyone on the access list receives the Monday OT email/.test(html));
});

// ---------------------------------------------------------------------------
// what a refusal does
// ---------------------------------------------------------------------------

// The server no longer refuses a save on permissions grounds — this is any
// refusal, which the page must report rather than claim success for.
const refuse403 = (url, method) => (url.startsWith('/api/settings') && method === 'POST')
  ? { status: 403, body: { error: 'Not permitted.', detail: 'The save was refused.' } }
  : null;

test('a refused save says so, and never claims success', async () => {
  const ctx = sandbox({ responder: refuse403 });
  await ctx.setOTBudgetPercent(99);

  const t = lastToast(ctx);
  assert.strictEqual(t.type, 'error');
  assert.match(t.msg, /The save was refused/, "the server's own words, not a generic failure");
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

test('a refused holiday add does not add the holiday', async () => {
  // The same rule the manager list used to pin: the success toast is BEHIND the
  // save, and a refusal must leave the local state alone. addManager and
  // removeManager went with the recipient list on 2026-09-15; addHoliday is the
  // control that now has this shape.
  const ctx = sandbox({ responder: refuse403 });
  ctx.__el('newHolidayDate').value = '2026-09-07';
  await ctx.addHoliday();

  // Array.from: deepStrictEqual compares prototypes, and an array built inside
  // the vm realm is not reference-equal to one built out here.
  assert.deepStrictEqual(Array.from(ctx.state.emailSettings.holidays || []), []);
  assert.strictEqual(lastToast(ctx).type, 'error');
  assert.ok(!ctx.__toasts.some(x => /marked as a mill holiday/.test(x.msg)));
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

const outage500 = (url, method) => (url.startsWith('/api/settings') && method === 'POST')
  ? { status: 500, body: { error: 'database unavailable' } } : null;

test('a 500 is still cached locally — a refusal and an outage are not the same', async () => {
  // The localStorage fallback exists for the case where the browser holds the
  // only copy of what somebody typed. That is a transient failure, not a
  // decision, and removing the fallback with the 403 would lose real edits.
  const ctx = sandbox({ tiers: ['hourly_wages', 'admin'], responder: outage500 });
  await ctx.setOTBudgetPercent(7);

  assert.ok(ctx.__stored.get('emailSettings'), 'a transient failure lost the edit');
});

test('a 500 does NOT report success — the claim is what was wrong', async () => {
  // THIS TEST USED TO ASSERT THE OPPOSITE. It pinned "OT budget saved" after a
  // 500, on the reasoning that the edit was safe in localStorage. The edit was;
  // the sentence was not.
  //
  // public.settings did not exist for months, so EVERY save took this path and
  // every one of them said it had worked — while the Monday OT email, reading
  // the server's copy, had no recipients and refused to send. The local cache
  // stays. The claim of success does not.
  const ctx = sandbox({ tiers: ['hourly_wages', 'admin'], responder: outage500 });
  await ctx.setOTBudgetPercent(7);

  assert.ok(!ctx.__toasts.some(x => /saved/i.test(x.msg) && x.type === 'success'),
    'a write the server never took was reported as saved');
  assert.strictEqual(lastToast(ctx).type, 'error');
  assert.match(lastToast(ctx).msg, /Not saved/);
  assert.match(lastToast(ctx).msg, /this browser only/);
  assert.strictEqual(ctx.state.settingsLocalOnly, true,
    'the page has to be able to say the server does not have this');
});

test('the page says so, not just the toast', async () => {
  // A toast vanishes. The fault this banner exists for lasted months, so it has
  // to be somewhere a person will still see it tomorrow.
  const ctx = sandbox({ tiers: ['hourly_wages', 'admin'], responder: outage500 });
  await ctx.setOTBudgetPercent(7);

  const html = ctx.renderSettings();
  assert.match(html, /this browser holds and the server does not/);
  assert.match(html, /save again/, 'and says how to clear it');
});

test('an unreadable settings row is named on the page, not swallowed', async () => {
  // The exact shape of the real fault: /api/settings answers 200 with
  // unavailable:true rather than pretending the row is merely absent.
  const ctx = sandbox({ responder: (url) => url.startsWith('/api/settings')
    ? { status: 200, body: { data: null, unavailable: true,
        reason: "Could not find the table 'public.settings' in the schema cache" } } : null });
  await ctx.loadEmailSettings();

  assert.strictEqual(ctx.state.settingsUnavailable, true);
  const html = ctx.renderSettings();
  assert.match(html, /not being saved/);
  assert.match(html, /public\.settings/, 'the reason is shown, because it names the fix');
  assert.match(html, /refuse to send/, 'and it connects the dots to the Monday email');
});

test('an absent row is NOT an unreadable one', async () => {
  // The distinction the old endpoint could not draw. A first run has no row and
  // is perfectly healthy; it must not raise the alarm.
  const ctx = sandbox({ responder: (url) => url.startsWith('/api/settings')
    ? { status: 200, body: { data: null } } : null });
  await ctx.loadEmailSettings();

  assert.strictEqual(ctx.state.settingsUnavailable, false);
  assert.strictEqual(ctx.state.settingsLocalOnly, false);
  assert.ok(!/not being saved|server does not/.test(ctx.renderSettings()));
});

test('a successful save clears the local copy and the banner', async () => {
  // The outage is transient: the first POST fails, the second succeeds. The
  // responder is captured by the sandbox, so the switch is a counter rather
  // than a reassignment.
  let posts = 0;
  const recovers = (url, method) => {
    if (!(url.startsWith('/api/settings') && method === 'POST')) return null;
    return ++posts === 1 ? { status: 500, body: { error: 'database unavailable' } } : null;
  };
  const ctx = sandbox({ tiers: ['hourly_wages', 'admin'], responder: recovers });

  await ctx.setOTBudgetPercent(7);
  assert.strictEqual(ctx.state.settingsLocalOnly, true);
  assert.ok(ctx.__stored.get('emailSettings'));

  await ctx.setOTBudgetPercent(8);
  assert.strictEqual(ctx.state.settingsLocalOnly, false);
  assert.strictEqual(ctx.__stored.get('emailSettings'), undefined,
    'a stale local copy could be read back after some later failure');
  assert.match(lastToast(ctx).msg, /OT budget saved/);
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

  assert.deepStrictEqual(Array.from(ctx.state.perms.list), [], 'it still fails closed');

  const html = ctx.renderSettings();
  assert.match(html, /The access list could not be read/);
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
