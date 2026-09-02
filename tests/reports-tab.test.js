// Run with: npm test
//
// Phase C Task 3 is a reorganization, not a rewrite: Pre-Approved Overtime, the
// OT Report and Points stop being top-level tabs and become sub-views of one
// Reports tab. Nothing about how they render changes.
//
// The reason this file exists is the named failure mode. Rewriting the OT Report
// tab in Phase A orphaned its manager-email functions and left the Settings
// tab's manager list as inert UI — the buttons were there, the list saved, and
// nothing sent. That is invisible from the screen, so it gets a test rather than
// an eyeball. The wiring today, verified before touching anything:
//
//   sendOTReportEmail()   src/js/ot-report.js
//     <- the "Email managers" button in renderOTReport()
//     -> POST /api/send-ot-email
//
// That second caller — daily-hours.js auto-sending after an import — is gone.
// It was the only AUTOMATIC sender and it died the same quiet death this file
// was written about: hours stopped arriving by manual upload and started
// arriving through payroll-email-ingest, so the hook was simply never reached
// again. The checkbox stayed on. Nothing said anything. The automatic path is
// now netlify/functions/ot-weekly-email.js, on a Monday schedule, and it is
// pinned further down.
//
// The other thing worth pinning is the lazy load. As a top-level tab, the OT
// Report loaded via a hook in switchTab() keyed on tab==='otreport'. That key no
// longer exists. If the hook does not move, the report renders its shell and
// never loads, which looks like an empty week rather than a bug.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'js');
const { __SCRIPT_MODULES } = require('../netlify/functions/session.js');

function fakeEl() {
  return {
    textContent: '', innerHTML: '', value: '', checked: false,
    style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {}, addEventListener() {},
    appendChild() {}, querySelector: () => fakeEl(), querySelectorAll: () => []
  };
}

// Every module, in manifest order — this tab calls across most of them.
function sandbox() {
  const calls = { loadOTReport: [], loadDailyDays: [], fetches: [] };
  const ctx = {
    console,
    window: {},
    document: {
      getElementById: () => fakeEl(),
      querySelector: () => fakeEl(),
      querySelectorAll: () => []
    },
    setTimeout: (fn) => { void fn; return 0; },
    // bootstrap.js runs at load and reads stored email settings. Without this the
    // rejection surfaces inside whichever test happens to run first, which is a
    // confusing way to find out a browser global is missing.
    localStorage: {
      _v: {},
      getItem(k) { return Object.prototype.hasOwnProperty.call(this._v, k) ? this._v[k] : null; },
      setItem(k, v) { this._v[k] = String(v); },
      removeItem(k) { delete this._v[k]; }
    },
    fetch: async (url, opts) => {
      calls.fetches.push({ url: String(url), opts });
      return { ok: true, status: 200, json: async () => ({ ok: true, data: [], sent: 0, failed: 0 }) };
    }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const m of __SCRIPT_MODULES) {
    vm.runInContext(fs.readFileSync(path.join(SRC, m), 'utf8'), ctx, { filename: m });
  }
  // state and REPORT_VIEWS are declared with const, so they live in the context's
  // global LEXICAL scope and are not properties of the global object. Function
  // declarations (renderReports, switchReportView, ...) are properties already.
  vm.runInContext('globalThis.state = state; globalThis.REPORT_VIEWS = REPORT_VIEWS;',
    ctx, { filename: 'expose-lexicals.js' });
  ctx.__calls = calls;
  return ctx;
}

// ---------------------------------------------------------------------------
// The container
// ---------------------------------------------------------------------------

test('Reports offers exactly the three consolidated views', () => {
  const ctx = sandbox();
  // Array.from is THIS realm's, deliberately. An array built inside the vm
  // context carries that context's Array.prototype, so deepStrictEqual fails on
  // prototype identity with "same structure but not reference-equal" even when
  // the contents match. Anything crossing out of the sandbox has to be rebuilt
  // here before a strict comparison.
  assert.deepStrictEqual(Array.from(ctx.REPORT_VIEWS, v => v.key),
    ['preapproved', 'otreport', 'points']);
});

test('every view that reads an endpoint has a load hook', () => {
  // This test used to assert the OPPOSITE for the default view — that opening
  // Reports fired no request, because Pre-Approved OT rendered from state the
  // page had already fetched. Task 4 moved that allowance onto its own endpoint
  // (/api/preapproved-ot, keyed on employees.id), so it now loads like the OT
  // Report does. The invariant that matters is not "no request" but "a view that
  // needs data says so", since a view with no hook renders a shell that never
  // fills — which reads as an empty week rather than a bug.
  const ctx = sandbox();
  assert.strictEqual(ctx.state.reportView, 'preapproved');
  assert.strictEqual(typeof ctx.reportView('preapproved').load, 'function');
  assert.strictEqual(typeof ctx.reportView('otreport').load, 'function');
  // Points renders from state.points, loaded with the roster. No endpoint, no hook.
  assert.strictEqual(ctx.reportView('points').load, undefined);
});

test('a load hook is guarded, so re-opening a view does not re-fetch', () => {
  // switchTab and switchReportView both call load(). Without the guard, every
  // click on the tab strip fires another request.
  const ctx = sandbox();
  const src = fs.readFileSync(path.join(SRC, 'reports.js'), 'utf8');
  for (const guard of ['!state.preLoaded && !state.preLoading',
                       '!state.otReport && !state.otReportLoading']) {
    assert.ok(src.includes(guard), `load hook is missing the guard: ${guard}`);
  }
  void ctx;
});

test('an unknown view falls back to the first rather than rendering nothing', () => {
  const ctx = sandbox();
  assert.strictEqual(ctx.reportView('nonsense').key, 'preapproved');
  assert.strictEqual(ctx.reportView(undefined).key, 'preapproved');
});

test('the container adds no reporting logic of its own', () => {
  // The whole point of Task 3: each view renders through the function it always
  // used. If this file starts computing anything, the OT report has two
  // implementations.
  const src = fs.readFileSync(path.join(SRC, 'reports.js'), 'utf8');
  for (const fn of ['renderPreApproved()', 'renderOTReport()', 'renderPoints()']) {
    assert.ok(src.includes(fn), `reports.js should delegate to ${fn}`);
  }
  // No arithmetic, no data access, no fetches.
  assert.ok(!/fetch\(/.test(src), 'reports.js must not fetch');
  assert.ok(!/state\.otReport\s*\./.test(src), 'reports.js must not read report data');
});

// ---------------------------------------------------------------------------
// The lazy load, which is the thing most likely to break silently
// ---------------------------------------------------------------------------

test('selecting the OT Report view triggers its load', () => {
  const ctx = sandbox();
  let loaded = 0;
  ctx.loadOTReport = () => { loaded++; };
  ctx.render = () => {};

  ctx.switchReportView('otreport');
  assert.strictEqual(ctx.state.reportView, 'otreport');
  assert.strictEqual(loaded, 1, 'the report must load when its view is opened');
});

test('the load does not re-fire when the report is already present', () => {
  const ctx = sandbox();
  let loaded = 0;
  ctx.loadOTReport = () => { loaded++; };
  ctx.render = () => {};

  ctx.state.otReport = { dateRange: 'Aug 17 – Aug 23' };
  ctx.switchReportView('otreport');
  assert.strictEqual(loaded, 0, 'an already-loaded week must not reload on every click');
});

test('opening the Reports tab on the OT Report view still loads it', () => {
  // The deep-link path. goToReport('otreport') sets the view and then switches
  // tabs, so the load hook has to fire from switchTab too — otherwise the report
  // renders its shell and never fills in, which reads as an empty week.
  const ctx = sandbox();
  let loaded = 0;
  ctx.loadOTReport = () => { loaded++; };
  ctx.render = () => {};

  ctx.state.reportView = 'otreport';
  ctx.switchTab('reports', null);
  assert.strictEqual(loaded, 1);
});

test('opening Reports on a view with no loader fires no request', () => {
  const ctx = sandbox();
  let loaded = 0;
  ctx.loadOTReport = () => { loaded++; };
  ctx.render = () => {};

  ctx.state.reportView = 'preapproved';
  ctx.switchTab('reports', null);
  assert.strictEqual(loaded, 0);
});

// ---------------------------------------------------------------------------
// The manager email — the named regression
// ---------------------------------------------------------------------------

test('sendOTReportEmail still exists and still posts to /api/send-ot-email', async () => {
  const ctx = sandbox();
  ctx.state.emailSettings = { managers: ['a@sequoiafp.com', 'b@sequoiafp.com'], autoSend: false };
  ctx.render = () => {};
  ctx.toast = () => {};
  // The body is built by otEmailPayload(), which assembles a fair amount of the
  // report. Stubbing it keeps this test about the WIRING — that the function
  // exists, reads the Settings manager list and posts to the endpoint — rather
  // than about the payload's shape, which the OT report tests already cover.
  ctx.otEmailPayload = () => ({ dateRange: 'Aug 17 – Aug 23' });

  assert.strictEqual(typeof ctx.sendOTReportEmail, 'function',
    'the manager email function must exist — Phase A lost it once already');

  await ctx.sendOTReportEmail({ auto: true });

  const posts = ctx.__calls.fetches.filter(f => f.url.includes('/api/send-ot-email'));
  assert.strictEqual(posts.length, 1, 'exactly one send');
  const body = JSON.parse(posts[0].opts.body);
  assert.deepStrictEqual(body.to, ['a@sequoiafp.com', 'b@sequoiafp.com'],
    'it must send to the Settings manager list, not a hardcoded address');
  assert.ok(body.subject.includes('Aug 17'), 'and name the week it is reporting');
});

test('with no managers configured it does not send', async () => {
  const ctx = sandbox();
  ctx.state.emailSettings = { managers: [], autoSend: false };
  ctx.render = () => {};
  ctx.toast = () => {};
  ctx.otEmailPayload = () => ({ dateRange: 'Aug 17 – Aug 23' });

  const sent = await ctx.sendOTReportEmail({ auto: true });
  assert.strictEqual(sent, false);
  assert.strictEqual(ctx.__calls.fetches.filter(f => f.url.includes('send-ot-email')).length, 0);
});

test('the Email managers button is still rendered by the OT Report view', () => {
  // The button lives in renderOTReport(), which Reports delegates to. It is now
  // the ONLY way to send a week on demand — the schedule sends last week, on
  // Monday, and nothing else sends at all — so losing it loses a capability
  // rather than a convenience.
  const src = fs.readFileSync(path.join(SRC, 'ot-report.js'), 'utf8');
  assert.ok(/onclick="sendOTReportEmail\(\)"/.test(src),
    'the Email managers button must still call sendOTReportEmail()');
});

test('the Settings manager list is still live, not inert UI', () => {
  // The Phase A failure was a list that saved and was read by nothing.
  const settings = fs.readFileSync(path.join(SRC, 'settings-tab.js'), 'utf8');
  assert.ok(/state\.emailSettings\.managers\.push/.test(settings), 'add still writes');
  assert.ok(/state\.emailSettings\.managers\.splice/.test(settings), 'remove still writes');

  const otReport = fs.readFileSync(path.join(SRC, 'ot-report.js'), 'utf8');
  assert.ok(/state\.emailSettings\.managers/.test(otReport),
    'and something must READ the list, or it is decoration again');
});

// This test used to assert the OPPOSITE: that commitDailyImport() still called
// sendOTReportEmail({auto:true}). That hook was the only automatic sender, and it
// died quietly when hours moved to the hourly email ingest — a browser hook cannot
// fire on a path that never opens a browser. The checkbox stayed on and nothing
// went out.
//
// So the invariant being pinned is not "the import sends" but the one that was
// actually violated: SOMETHING automatic must reach the manager list. It is now a
// schedule, which no change to how the data arrives can walk away from.
test('an automatic sender still exists, and it is the schedule rather than the import', () => {
  const daily = fs.readFileSync(path.join(SRC, 'daily-hours.js'), 'utf8');
  assert.ok(!/sendOTReportEmail\(/.test(daily),
    'the browser-side auto-send is gone; two automatic senders would cover different weeks');

  const toml = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');
  assert.ok(/\[functions\."ot-weekly-email"\]/.test(toml),
    'the weekly email must be a scheduled function');
  assert.ok(/schedule = "0 17 \* \* 1"/.test(toml),
    'Monday 17:00 UTC — late enough that Sunday\'s hours have been ingested');

  // And the schedule has to actually reach the saved manager list, which is the
  // Phase A failure this whole file exists to prevent.
  const lib = fs.readFileSync(
    path.join(ROOT, 'netlify', 'functions', 'ot-weekly-email-lib.js'), 'utf8');
  assert.ok(/managersFromSettingsRow/.test(lib), 'the schedule must read the manager list');
  assert.ok(/sendEmail/.test(lib), 'and must actually send');
});

// ---------------------------------------------------------------------------
// Nothing that pointed at the old tabs is left dangling
// ---------------------------------------------------------------------------

test('no navigation still targets the three retired tab keys', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.html'), 'utf8');
  for (const key of ['overtime', 'points', 'otreport']) {
    assert.ok(!app.includes(`data-tab="${key}"`), `app.html still has a ${key} tab button`);
  }
  assert.ok(app.includes('data-tab="reports"'), 'and Reports must be there');

  // goToTab('otreport') would now silently render nothing. goToReport() is the
  // supported way in.
  // Comments stripped first. reports.js documents why goToTab('otreport') no
  // longer resolves, and a substring scan over the raw file reads that
  // explanation as a call site.
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');

  for (const m of __SCRIPT_MODULES) {
    const code = stripComments(fs.readFileSync(path.join(SRC, m), 'utf8'));
    for (const key of ['overtime', 'points', 'otreport']) {
      assert.ok(!code.includes(`goToTab('${key}')`),
        `${m} still calls goToTab('${key}') — use goToReport('${key}')`);
    }
  }
});

test('render dispatches Reports and no longer dispatches the three', () => {
  const core = fs.readFileSync(path.join(SRC, 'core.js'), 'utf8');
  assert.ok(/state\.tab==='reports'\)el\.innerHTML=renderReports\(\)/.test(core));
  for (const key of ['overtime', 'points', 'otreport']) {
    assert.ok(!new RegExp(`state\\.tab==='${key}'`).test(core),
      `core.js still dispatches the retired '${key}' tab`);
  }
});

test('goToReport opens the Reports tab on the requested view', () => {
  const ctx = sandbox();
  const switched = [];
  ctx.goToTab = (t) => switched.push(t);

  ctx.goToReport('points');
  assert.strictEqual(ctx.state.reportView, 'points');
  assert.deepStrictEqual(switched, ['reports']);
});

test('reports.js is in the session manifest', () => {
  // Modules are listed, not discovered — a file that is not in the manifest is
  // not in the bundle, and the tab would be an undefined function at runtime.
  assert.ok(__SCRIPT_MODULES.includes('reports.js'));
  assert.ok(__SCRIPT_MODULES.indexOf('reports.js') > __SCRIPT_MODULES.indexOf('ot-report.js'),
    'listed after the modules it renders');
});
