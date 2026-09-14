// Run with: npm test
//
// Phase C Task 3 is a reorganization, not a rewrite: Pre-Approved Overtime, the
// OT Report and Points stop being top-level tabs and become sub-views of one
// Overtime tab. Nothing about how they render changes.
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
    // A real browser global, and the report loaders build their query strings
    // with it. Without it the load throws inside its own try/catch and the test
    // sees no request rather than a failure.
    URLSearchParams,
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
  // state and OVERTIME_VIEWS are declared with const, so they live in the context's
  // global LEXICAL scope and are not properties of the global object. Function
  // declarations (renderOvertime, switchOvertimeView, ...) are properties already.
  // const declarations live in the context's global LEXICAL scope, not on the
  // global object, so each view list is exposed explicitly. Function
  // declarations (overtimeView, settingsSubView, costsSubView) already are.
  vm.runInContext('globalThis.state = state; globalThis.OVERTIME_VIEWS = OVERTIME_VIEWS;' +
    'globalThis.SETTINGS_VIEWS = SETTINGS_VIEWS; globalThis.COSTS_VIEWS = COSTS_VIEWS;',
    ctx, { filename: 'expose-lexicals.js' });
  ctx.__calls = calls;
  // Toasts, recorded rather than swallowed: whether a refusal is REPORTED is
  // half of what the range control has to get right.
  ctx.__toasts = [];
  vm.runInContext('toast = (msg, type) => { globalThis.__toasts.push({ msg, type }); };',
    ctx, { filename: 'stub-toast.js' });
  return ctx;
}

const lastToast = (ctx) => ctx.__toasts[ctx.__toasts.length - 1] || {};

// ---------------------------------------------------------------------------
// The container
// ---------------------------------------------------------------------------

test('Overtime offers exactly its two views, the report first', () => {
  const ctx = sandbox();
  // Array.from is THIS realm's, deliberately. An array built inside the vm
  // context carries that context's Array.prototype, so deepStrictEqual fails on
  // prototype identity with "same structure but not reference-equal" even when
  // the contents match. Anything crossing out of the sandbox has to be rebuilt
  // here before a strict comparison.
  //
  // IT HAS BEEN FOUR AND FIVE. Daily Hours led on the order of work — hours are
  // imported, then reported on — and moved to Settings on 2026-09-15 as the
  // import it is. Points became a top-level tab the same day; it was never
  // overtime. SG&A Overtime lasted a day as a view and is a SECTION of the OT
  // Report now.
  //
  // So the report leads: it is what is left of the first argument and it is
  // what the tab is named for.
  assert.deepStrictEqual(Array.from(ctx.OVERTIME_VIEWS, v => v.key),
    ['otreport', 'preapproved']);
  assert.deepStrictEqual(Array.from(ctx.OVERTIME_VIEWS, v => v.label),
    ['OT Report', 'Pre-Approved OT']);
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
  assert.strictEqual(ctx.state.overtimeView, 'otreport');
  assert.strictEqual(typeof ctx.overtimeView('otreport').load, 'function');
  assert.strictEqual(typeof ctx.overtimeView('preapproved').load, 'function');
  // Both remaining views read an endpoint, so both have one. The hookless case
  // left with Points: it renders from state.points, loaded with the roster.
  assert.strictEqual(typeof ctx.settingsSubView('dailyhours').load, 'function',
    'Daily Hours kept its hook when it moved to Settings');
  assert.strictEqual(ctx.settingsSubView('general').load, undefined);
});

test('a load hook is guarded, so re-opening a view does not re-fetch', () => {
  // switchTab and switchOvertimeView both call load(). Without the guard, every
  // click on the tab strip fires another request.
  const ctx = sandbox();
  const src = fs.readFileSync(path.join(SRC, 'overtime.js'), 'utf8');
  for (const guard of ['!state.preLoaded && !state.preLoading',
                       '!state.otReport && !state.otReportLoading']) {
    assert.ok(src.includes(guard), `load hook is missing the guard: ${guard}`);
  }
  // Daily Hours took its guard with it to Settings.
  const settingsSrc = fs.readFileSync(path.join(SRC, 'settings-tab.js'), 'utf8');
  assert.ok(settingsSrc.includes('!state.dailyLoaded && !state.dailyLoading'),
    'the Daily Hours hook lost its guard in the move');
  void ctx;
});

test('an unknown view falls back to the first rather than rendering nothing', () => {
  const ctx = sandbox();
  assert.strictEqual(ctx.overtimeView('nonsense').key, 'otreport');
  assert.strictEqual(ctx.overtimeView(undefined).key, 'otreport');
  // Including the two keys that USED to resolve here. A deep link left pointing
  // at a moved view must not quietly land on the first one in the list.
  assert.strictEqual(ctx.overtimeView('dailyhours').key, 'otreport');
  assert.strictEqual(ctx.overtimeView('points').key, 'otreport');
});

test('the container adds no reporting logic of its own', () => {
  // The whole point of Task 3: each view renders through the function it always
  // used. If this file starts computing anything, the OT report has two
  // implementations.
  const src = fs.readFileSync(path.join(SRC, 'overtime.js'), 'utf8');
  for (const fn of ['renderPreApproved()', 'renderOTReport()']) {
    assert.ok(src.includes(fn), `overtime.js should delegate to ${fn}`);
  }
  // No arithmetic, no data access, no fetches.
  assert.ok(!/fetch\(/.test(src), 'overtime.js must not fetch');
  assert.ok(!/state\.otReport\s*\./.test(src), 'overtime.js must not read report data');
});

// ---------------------------------------------------------------------------
// The lazy load, which is the thing most likely to break silently
// ---------------------------------------------------------------------------

test('selecting the OT Report view triggers its load', () => {
  const ctx = sandbox();
  let loaded = 0;
  ctx.loadOTReport = () => { loaded++; };
  ctx.render = () => {};

  ctx.switchOvertimeView('otreport');
  assert.strictEqual(ctx.state.overtimeView, 'otreport');
  assert.strictEqual(loaded, 1, 'the report must load when its view is opened');
});

test('the load does not re-fire when the report is already present', () => {
  const ctx = sandbox();
  let loaded = 0;
  ctx.loadOTReport = () => { loaded++; };
  ctx.render = () => {};

  ctx.state.otReport = { dateRange: 'Aug 17 – Aug 23' };
  ctx.switchOvertimeView('otreport');
  assert.strictEqual(loaded, 0, 'an already-loaded week must not reload on every click');
});

test('opening the Reports tab on the OT Report view still loads it', () => {
  // The deep-link path. goToOvertime('otreport') sets the view and then switches
  // tabs, so the load hook has to fire from switchTab too — otherwise the report
  // renders its shell and never fills in, which reads as an empty week.
  const ctx = sandbox();
  let loaded = 0;
  ctx.loadOTReport = () => { loaded++; };
  ctx.render = () => {};

  ctx.state.overtimeView = 'otreport';
  ctx.switchTab('overtime', null);
  assert.strictEqual(loaded, 1);
});

test('opening Reports on a view with no loader fires no request', () => {
  const ctx = sandbox();
  let loaded = 0;
  ctx.loadOTReport = () => { loaded++; };
  ctx.render = () => {};

  ctx.state.overtimeView = 'preapproved';
  ctx.switchTab('overtime', null);
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
// The day blocks are named for what they are
//
// "Scheduled Mon–Thu / Non-scheduled Fri–Sun" was a wrong LABEL, not a wrong
// split. Maintenance crews are scheduled Fri–Sun; what they are not is
// production. The report also carried a sentence asserting the opposite outright
// — "Nobody is scheduled on a non-scheduled day" — which was a false claim about
// the operation sitting directly above the numbers people act on.
//
// The split itself is untouched and load-bearing: it is what keeps weekend
// labour visible as its own line instead of dissolving into a weekly total. So
// these tests pin the names and, just as much, that the figures behind them did
// not move.
// ---------------------------------------------------------------------------

function otBlock(over = {}) {
  return Object.assign({ hours: 0, otHours: 0, otDollars: 0, earnings: 0, headcount: 0 }, over);
}

function withOtReport(ctx, over = {}) {
  ctx.state.otReport = {
    weekStart: '2026-08-24', weekEnd: '2026-08-30',
    summary: {
      totalHours: 100, allOtHours: 5, preApprovedHours: 2, netOtHours: 3,
      totalHourlyPayroll: 1000, allOtDollars: 100, preApprovedDollars: 40,
      netOtDollars: 60, headcount: 10,
      weekendHours: 12, weekendDollars: 400, weekendOtHours: 2,
      weekendOtDollars: 60, weekendHeadcount: 3
    },
    split: {
      scheduled: otBlock({ hours: 88, earnings: 600, headcount: 9 }),
      nonScheduled: otBlock({ hours: 12, otHours: 2, otDollars: 60, earnings: 400, headcount: 3 })
    },
    departments: [], days: [], employees: [],
    preApproved: {
      byType: [], rows: [], unmatchedNames: [], withoutHoursThisWeek: [], rateMissing: [],
      inactiveSkipped: [], byDepartment: [], standing: { hours: 0, dollars: 0 },
      grace: { hoursPerEmployee: 0.5, headcount: 10, hours: 5, dollars: 0, rateMissing: 0, byRateSource: {} }
    },
    completeness: { days: [], missingDays: [], daysWithData: 0, daysExpected: 0 },
    issues: {
      unknownEmployeeNumbers: [], unassignedEmployees: [], flagged: [],
      unassignedRows: 0, workedRateMissing: [], nonProductionWithHours: []
    }
  };
  Object.assign(ctx.state.otReport, over);
  ctx.state.otReportWeeks = [{ weekStart: '2026-08-24', weekEnd: '2026-08-30', days: 7, totalHours: 100 }];
  ctx.state.otReportWeek = '2026-08-24';
  return ctx.renderOTReport();
}

// The SG&A section of the rendered report, sliced out by its own heading so an
// assertion about it cannot accidentally be satisfied — or broken — by the rest
// of the page, which is full of dollars by design.
function sgaSection(html) {
  const start = html.indexOf('SG&amp;A overtime');
  assert.ok(start > -1, 'the report has no SG&A section');
  const next = html.indexOf('section-head', start + 1);
  return html.slice(start, next > -1 ? next : undefined);
}

test('the OT report no longer calls Fri-Sun unscheduled', () => {
  const html = withOtReport(sandbox());

  assert.doesNotMatch(html, /Non-scheduled/);
  assert.doesNotMatch(html, /non-scheduled/);
  assert.doesNotMatch(html, /Non-sched/);
  assert.doesNotMatch(html, /Nobody is scheduled/,
    'a false claim about the operation, sitting above the numbers people act on');

  assert.match(html, /Production days vs maintenance days/);
  assert.match(html, /Production · Mon–Thu/);
  assert.match(html, /Maintenance · Fri–Sun/);
});

test('the day badge names the kind of day, not who was rostered', () => {
  const ctx = sandbox();
  assert.match(ctx.schedBadge(true), /Production Mon–Thu/);
  assert.match(ctx.schedBadge(false), /Maintenance Fri–Sun/);
  assert.doesNotMatch(ctx.schedBadge(false), /scheduled/i);
});

test('every Maintenance heading says it names the day, not the department', () => {
  // The live trap. Production-department people work Fri–Sun and their rows keep
  // department = Production, so the tables below a "Maintenance · Fri–Sun"
  // heading DO show Production. Without a line saying the heading is about the
  // day block, this report reads as though production ran a weekend.
  const html = withOtReport(sandbox());

  // Both sections that carry the label carry the disclaimer — the split block,
  // and the Fri–Sun block that actually prints a Department column.
  const notes = html.match(/that names the <strong>days<\/strong>, not the departments/g) || [];
  assert.strictEqual(notes.length, 2,
    'the split block and the Fri–Sun labour block each need it — a reader who ' +
    'scrolls straight to the second one never saw the first');

  assert.match(html, /Production runs Mon–Thu/);
  assert.match(html, /still shows as Production, because that is where they work/);
  assert.match(html, /production days are Mon–Thu regardless of what it says/,
    'the table with the Department column has to say it at the column');
});

test('the maintenance figures are labelled as the day block, not the department', () => {
  const html = withOtReport(sandbox());
  // "Maintenance OT $" would read as the department's overtime. It is not — it
  // is every department's overtime on Fri–Sun.
  assert.match(html, /Maintenance-day OT \$/);
  assert.match(html, /Total maintenance-day labor \$/);
  assert.doesNotMatch(html, /<span>Maintenance OT \$<\/span>/);
});

test('renaming the blocks moved none of the figures', () => {
  // The split is the point of the section. A rename that quietly swapped which
  // side a number lands on would read as a tidy-up and be a reporting error.
  const html = withOtReport(sandbox());

  // Mon-Thu: 88 hours, 9 people. Fri-Sun: 12 hours, 2 OT hours, $60 OT, $400 total, 3 people.
  assert.match(html, /Production · Mon–Thu[\s\S]*?88\.00[\s\S]*?Maintenance · Fri–Sun/);
  assert.match(html, /Maintenance · Fri–Sun[\s\S]*?12\.00/);
  assert.match(html, /Total maintenance-day labor \$<\/span><span>\$400/);
  assert.match(html, /Maintenance-day OT \$<\/span><span>\$60/);
});

// ---------------------------------------------------------------------------
// The headline percentage is a cost share, so it is gross
// ---------------------------------------------------------------------------

test('the % of payroll card reports ALL OT, not net', () => {
  // Net OT goes negative in a week where less overtime was worked than was
  // approved, and a negative share of payroll is not a meaningful cost figure.
  // Gross answers the cost question — what share of wages went to overtime —
  // and it is the figure the OT budget threshold is measured against.
  const html = withOtReport(sandbox());
  assert.match(html, /All OT % of hourly payroll/);
  assert.match(html, /Net OT % of hourly payroll/, 'and the net card stays');
});

test('both percentage cards say they are on dollars', () => {
  // The cards show hours AND dollars, and a bare percentage does not say which
  // drives it. It is dollars, on both, and they now say so.
  const html = withOtReport(sandbox());
  const cards = html.slice(html.indexOf('All OT % of hourly payroll'));
  assert.strictEqual((cards.match(/by dollars/g) || []).length, 2);
});

test('the gross and net percentages are different numbers, computed from dollars', () => {
  const { buildReport } = require('../netlify/functions/ot-report-lib');
  const report = buildReport({
    weekStart: '2026-08-24', dailyRows: [], preApprovedRows: [], employees: [],
    expectedDays: [], graceHoursPerEmployee: 0
  });
  // An empty week has no payroll to divide by, so both are an honest null
  // rather than 0 or Infinity.
  assert.strictEqual(report.summary.allOtPctOfPayroll, null);
  assert.strictEqual(report.summary.netOtPctOfPayroll, null);

  // And the field exists on the summary at all, which is what the card reads.
  assert.ok('allOtPctOfPayroll' in report.summary);
});

test('the manager email measures the OT budget against gross, not net', () => {
  // The question was whether the "over budget" flag had been comparing the wrong
  // thing. It has not: budgetVariance is built from totalOTPercent, which is
  // pct(allOtDollars). Pinned so it stays that way — with net, a light week
  // reads as a NEGATIVE percentage against a 10% budget, which is nonsense.
  const send = fs.readFileSync(
    path.join(ROOT, 'netlify', 'functions', 'send-ot-email.js'), 'utf8');
  assert.match(send, /const budgetVariance = \(totalOTPercent - otBudgetPercent\)/);
  assert.doesNotMatch(send, /netOTPercent - otBudgetPercent/);

  const otReport = fs.readFileSync(path.join(SRC, 'ot-report.js'), 'utf8');
  assert.match(otReport, /totalOTPercent:pct\(s\.allOtDollars\)/,
    'totalOTPercent — the figure the budget is compared against — is gross dollars');

  const lib = fs.readFileSync(
    path.join(ROOT, 'netlify', 'functions', 'ot-weekly-email-lib.js'), 'utf8');
  assert.match(lib, /totalOTPercent: pct\(s\.allOtDollars\)/,
    'and the scheduled email builds it the same way');
});

test('the per-employee columns still split the two blocks apart', () => {
  const html = withOtReport(sandbox());
  assert.match(html, /Prod hrs/);
  assert.match(html, /Prod \$/);
  // Hours worked in the Fri–Sun block, by anyone — not hours worked by the
  // Maintenance department.
  assert.match(html, /Maint hrs/);
  assert.match(html, /Maint \$/);
});

// ---------------------------------------------------------------------------
// Nothing that pointed at the old tabs is left dangling
// ---------------------------------------------------------------------------

// Every tab key that was top-level once and is a sub-view or gone now. 'points'
// and 'otreport' retired in Phase C along with the old 'overtime' key — which
// meant Pre-Approved OT, and is NOT the container's key; the container is
// 'overtime' and is live, which is exactly the collision this list has to keep
// straight. 'dailyhours', 'salaries' and 'economics' retired with the
// restructure, and 'reports' is the container's own former name.
// Keys that were once top-level tabs and are not any more. 'overhead' joined
// them on 2026-09-14 — unlike the others it did not become a sub-view of
// anything, because the analysis behind it was retired rather than moved. So
// did 'sgaot', which was a sub-view for a day before becoming a section of the
// OT Report.
//
// 'points' CAME BACK on 2026-09-15 and is a live tab again: attendance points
// and disciplinary flags are not overtime, and they sat under that tab only
// because Phase C needed somewhere to put them. A key can move in both
// directions, so this list is the current answer rather than a history.
const RETIRED_TAB_KEYS =
  ['otreport', 'preapproved', 'dailyhours', 'salaries', 'economics', 'reports',
   'overhead', 'sgaot'];

test('no navigation still targets a retired tab key', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.html'), 'utf8');
  for (const key of RETIRED_TAB_KEYS) {
    assert.ok(!app.includes(`data-tab="${key}"`), `app.html still has a ${key} tab button`);
  }
  // The five that survive, and nothing else.
  const live = Array.from(app.matchAll(/data-tab="([^"]+)"/g), m => m[1]);
  assert.deepStrictEqual(live.sort(),
    ['costs', 'employees', 'overtime', 'points', 'settings']);

  // goToTab('otreport') would now silently render nothing. goToOvertime() is the
  // supported way in.
  // Comments stripped first. overtime.js documents why goToTab('otreport') no
  // longer resolves, and a substring scan over the raw file reads that
  // explanation as a call site.
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');

  for (const m of __SCRIPT_MODULES) {
    const code = stripComments(fs.readFileSync(path.join(SRC, m), 'utf8'));
    for (const key of RETIRED_TAB_KEYS) {
      assert.ok(!code.includes(`goToTab('${key}')`),
        `${m} still calls goToTab('${key}') — use goToOvertime('${key}')`);
    }
  }
});

test('render dispatches the five live tabs and no retired one', () => {
  const core = fs.readFileSync(path.join(SRC, 'core.js'), 'utf8');
  assert.ok(/state\.tab==='overtime'\)el\.innerHTML=renderOvertime\(\)/.test(core));
  assert.ok(/state\.tab==='costs'\)el\.innerHTML=renderCostsTab\(\)/.test(core));
  assert.ok(/state\.tab==='points'\)el\.innerHTML=renderPoints\(\)/.test(core),
    'Points is a top-level tab again and needs its own dispatch');
  assert.ok(/state\.tab==='settings'\)el\.innerHTML=renderSettingsTab\(\)/.test(core),
    'Settings is a container now — it must draw its sub-nav, not the page directly');
  for (const key of RETIRED_TAB_KEYS) {
    assert.ok(!new RegExp(`state\\.tab==='${key}'`).test(core),
      `core.js still dispatches the retired '${key}' tab`);
  }
});

test('goToOvertime opens the Overtime tab on the requested view', () => {
  const ctx = sandbox();
  const switched = [];
  ctx.goToTab = (t) => switched.push(t);

  ctx.goToOvertime('preapproved');
  assert.strictEqual(ctx.state.overtimeView, 'preapproved');
  assert.deepStrictEqual(switched, ['overtime']);
});

test('goToSettings opens Settings on the requested view', () => {
  // The other half of the same deep link. The OT Report's "Daily Hours" and
  // "Re-stamp departments" buttons call this; they called goToOvertime until
  // the view moved.
  const ctx = sandbox();
  const switched = [];
  ctx.goToTab = (t) => switched.push(t);

  ctx.goToSettings('dailyhours');
  assert.strictEqual(ctx.state.settingsView, 'dailyhours');
  assert.deepStrictEqual(switched, ['settings']);
});

test('the OT Report reaches Daily Hours at its new home, not its old one', () => {
  const src = fs.readFileSync(path.join(SRC, 'ot-report.js'), 'utf8');
  assert.ok(src.includes("goToSettings('dailyhours')"), 'the deep link was not repointed');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  assert.ok(!code.includes("goToOvertime('dailyhours')"),
    'a call still points at the view Overtime no longer has');
});

test('overtime.js is in the session manifest', () => {
  // Modules are listed, not discovered — a file that is not in the manifest is
  // not in the bundle, and the tab would be an undefined function at runtime.
  assert.ok(__SCRIPT_MODULES.includes('overtime.js'));
  assert.ok(__SCRIPT_MODULES.indexOf('overtime.js') > __SCRIPT_MODULES.indexOf('ot-report.js'),
    'listed after the modules it renders');
});

// ---------------------------------------------------------------------------
// SG&A Overtime — the one thing still tracked about a class this app stopped
// costing (2026-09-14)
// ---------------------------------------------------------------------------
//
// The join is the part worth pinning. ot-report-lib has a NON_PRODUCTION bucket
// whose value is the literal string 'SG&A', which looks like this view already
// built — but that bucket is keyed on employees.DEPARTMENT, and 'SG&A' was
// retired as a department value when the v2 model gave the class five
// departments of its own. Nobody on the roster holds it. So the filter has to be
// the COST CLASS, read off the roster, and a test that does not distinguish the
// two would pass against either.

function sgaSandbox() {
  const ctx = sandbox();
  ctx.state.employees = [
    // Hourly, SG&A, department 'Accounting' — NOT the literal 'SG&A' department.
    { id: 'g1', name: 'Axeri Ramirez', empNum: '1643', status: 'Active',
      department: 'Accounting', costClass: 'SG&A', payType: 'Hourly', position: 'Administrative' },
    // Salaried SG&A: dropped at import, cannot earn an OT hour.
    { id: 'g2', name: 'Adam Coppini', empNum: '', status: 'Active',
      department: 'Sales & Marketing', costClass: 'SG&A', payType: 'Salaried' },
    // Hourly SG&A but inactive.
    { id: 'g3', name: 'Gone Clerk', empNum: '1644', status: 'Inactive',
      department: 'Accounting', costClass: 'SG&A', payType: 'Hourly' },
    // Manufacturing, and the one with the big overtime — a view that showed him
    // would be reading the wrong axis.
    { id: 'm1', name: 'Mill Hand', empNum: '0201', status: 'Active',
      department: 'Production', costClass: 'Manufacturing', payType: 'Hourly' }
  ];
  ctx.state.otReport = {
    weekStart: '2026-09-07', weekEnd: '2026-09-13',
    employees: [
      { employeeNumber: '1643', name: 'Axeri Ramirez', department: 'Accounting',
        totalHours: 43.5, otHours: 3.5, daysWorked: 4 },
      { employeeNumber: '0201', name: 'Mill Hand', department: 'Production',
        totalHours: 52, otHours: 12, daysWorked: 5 }
    ]
  };
  ctx.state.otReportWeek = '2026-09-07';
  ctx.state.otReportWeeks = [{ weekStart: '2026-09-07', weekEnd: '2026-09-13' }];
  return ctx;
}

test('SG&A Overtime lists the hourly SG&A roster, by cost class and not department', () => {
  const ctx = sgaSandbox();
  // Array.from is THIS realm's, for the reason documented at the top of this
  // file: an array built inside the vm context carries that context's
  // Array.prototype and fails deepStrictEqual on prototype identity.
  const rows = ctx.sgaOtRows();
  assert.deepStrictEqual(Array.from(rows, r => r.name), ['Axeri Ramirez']);
  assert.strictEqual(rows[0].otHours, 3.5);
  assert.strictEqual(rows[0].hours, 43.5);
  assert.strictEqual(rows[0].department, 'Accounting',
    'the department is shown — it is the line the cost belongs to — but is not the filter');
});

test('salaried, inactive and Manufacturing people are all left off', () => {
  const ctx = sgaSandbox();
  const names = ctx.sgaOtRows().map(r => r.name);
  assert.ok(!names.includes('Adam Coppini'), 'salaried staff earn no OT hour and are dropped at import');
  assert.ok(!names.includes('Gone Clerk'), 'inactive');
  assert.ok(!names.includes('Mill Hand'), 'Manufacturing belongs on the OT Report, not here');
});

test('somebody absent from the file this week is a zero, not a gap', () => {
  // The file carries every employee who clocked in, so absence IS the answer.
  // Listing them at zero is what lets a reader tell "no overtime" from "not
  // looked at".
  const ctx = sgaSandbox();
  ctx.state.otReport.employees = [];
  const rows = ctx.sgaOtRows();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].otHours, 0);
  assert.strictEqual(rows[0].inFile, false);
});

test('the SG&A section shows hours and never money', () => {
  // These people have no wage in this system by design, so there is no rate to
  // multiply by. A dollar sign in THIS section would mean somebody had put one
  // back — the rest of the report is money throughout, which is why the
  // assertion is scoped to the slice.
  const ctx = sgaSandbox();
  const html = withOtReport(ctx, {
    employees: [{ employeeNumber: '1643', name: 'Axeri Ramirez', department: 'Accounting',
                  totalHours: 43.5, otHours: 3.5, daysWorked: 4 }]
  });
  const section = sgaSection(html);
  assert.match(section, /Axeri Ramirez/);
  assert.match(section, /3\.50/);
  assert.ok(!/\$/.test(section), 'no currency in the SG&A section');
  assert.match(section, /Hours only/, 'and it says why');
});

test('the SG&A section is part of the report, not a second request', () => {
  // It was a sub-view of its own for a day and read the same report; now it is
  // a section of it. Either way the guarantee is that opening the report costs
  // one fetch — the roster join happens in the browser.
  const ctx = sgaSandbox();
  const before = ctx.__calls.fetches.length;
  withOtReport(ctx, {
    employees: [{ employeeNumber: '1643', name: 'Axeri Ramirez', department: 'Accounting',
                  totalHours: 43.5, otHours: 3.5, daysWorked: 4 }]
  });
  assert.strictEqual(ctx.__calls.fetches.length, before, 'render fetches nothing');
});

test('the SG&A hours are kept out of the department table they are not in', () => {
  // The section sits under "By department" and could be misread as one more
  // department. It says so in words; this pins that the figures are separate —
  // Axeri's 3.5 OT hours are not in any department row.
  const ctx = sgaSandbox();
  const html = withOtReport(ctx, {
    departments: [{ department: 'Production', week: otBlock({ otHours: 12, otDollars: 400, earnings: 5000 }),
                    scheduled: otBlock({ hours: 88 }), weekend: otBlock(),
                    preApprovedHours: 0, preApprovedDollars: 0, netOtHours: 12, netOtDollars: 400 }],
    employees: [{ employeeNumber: '1643', name: 'Axeri Ramirez', department: 'Accounting',
                  totalHours: 43.5, otHours: 3.5, daysWorked: 4 }]
  });
  const deptTable = html.slice(html.indexOf('By department'), html.indexOf('SG&amp;A overtime'));
  assert.ok(!/Axeri Ramirez|Accounting/.test(deptTable),
    'an SG&A person appeared in the production department table');
  assert.match(sgaSection(html), /NOT in the department table/);
});

// ---------------------------------------------------------------------------
// Settings is a container now (2026-09-15)
// ---------------------------------------------------------------------------

test('Settings offers General and Daily Hours, in that order', () => {
  const ctx = sandbox();
  assert.deepStrictEqual(Array.from(ctx.SETTINGS_VIEWS, v => v.key), ['general', 'dailyhours']);
  assert.deepStrictEqual(Array.from(ctx.SETTINGS_VIEWS, v => v.label), ['General', 'Daily Hours']);
  assert.strictEqual(ctx.state.settingsView, 'general', 'the settings page proper is the default');
});

test('the Settings container delegates and computes nothing', () => {
  // Daily Hours moved as a container change only: renderDailyHours() and its
  // loaders are untouched in daily-hours.js. If settings-tab.js starts doing
  // anything with an upload, the import has two implementations.
  const src = fs.readFileSync(path.join(SRC, 'settings-tab.js'), 'utf8');
  assert.ok(src.includes('renderDailyHours()'), 'settings-tab.js should delegate to renderDailyHours()');
  assert.ok(!/state\.dailyPreview|commitDaily|uploadDaily/.test(src),
    'the import path must stay in daily-hours.js');
});

test('opening Settings on Daily Hours fires its load, like any sub-view', () => {
  // The bug this shape exists to prevent: a load hook keyed on a tab name in
  // switchTab() stops firing the moment that tab becomes a sub-view. Daily
  // Hours has now been on both sides of that, so it is worth pinning twice.
  const ctx = sandbox();
  let loaded = 0;
  ctx.loadDailyDays = () => { loaded++; };
  ctx.render = () => {};

  ctx.switchSettingsView('dailyhours');
  assert.strictEqual(ctx.state.settingsView, 'dailyhours');
  assert.strictEqual(loaded, 1, 'the import must load when its view is opened');

  ctx.state.dailyLoaded = true;
  ctx.switchSettingsView('dailyhours');
  assert.strictEqual(loaded, 1, 'an already-loaded list must not reload on every click');
});

test('switchTab fires the load for the Settings view already selected', () => {
  // The deep-link path, and the one that breaks silently: goToSettings sets the
  // view and then switches tabs, so switchTab has to fire the hook too.
  const ctx = sandbox();
  let loaded = 0;
  ctx.loadDailyDays = () => { loaded++; };
  ctx.render = () => {};

  ctx.state.settingsView = 'dailyhours';
  ctx.switchTab('settings', null);
  assert.strictEqual(loaded, 1, 'the view renders its shell and never fills without this');
});

// ---------------------------------------------------------------------------
// Manufacturing Costs — Staffing leads (2026-09-15)
// ---------------------------------------------------------------------------

test('Staffing Economics is first, and named what it is called on screen', () => {
  const ctx = sandbox();
  assert.deepStrictEqual(Array.from(ctx.COSTS_VIEWS, v => v.key), ['staffing', 'deptgroup']);
  assert.deepStrictEqual(Array.from(ctx.COSTS_VIEWS, v => v.label),
    ['Staffing Economics', 'Department & Group']);
  // The key is the distinctive word of the label, so searching either finds the
  // other. What it must never be is a word appearing nowhere on screen, which
  // is what 'staff' had become.
  const src = fs.readFileSync(path.join(SRC, 'costs.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  assert.ok(!/'staff'/.test(src), "the old 'staff' key is still in costs.js");
});

test('the landing view follows the reader tier, because the first view is gated', () => {
  // state.costsView starts EMPTY and resolves at render time. Hardcoding a
  // default would open the tab on the SECOND item for exactly the people who
  // can read the first — and on a refusal for everybody else if it named the
  // first.
  const base = sandbox();
  assert.strictEqual(base.state.costsView, '', 'the default names no view');
  assert.strictEqual(base.costsSubView(base.state.costsView).key, 'deptgroup',
    'without the tier, Staffing is not in the sub-nav at all');

  const salaried = sandbox();
  salaried.state.perms.tiers = ['hourly_wages', 'salaries'];
  assert.strictEqual(salaried.costsSubView(salaried.state.costsView).key, 'staffing',
    'with the tier, the tab opens on the view that leads it');
});

// ---------------------------------------------------------------------------
// The date range control (2026-09-15)
// ---------------------------------------------------------------------------
//
// Both reports keep the week dropdown and gain a range. The two cannot both
// drive, so the rules are: a range wins when complete, picking a week clears
// the range, and an incomplete range drives nothing at all.

test('the OT report sends a range when one is set, and a week otherwise', async () => {
  const ctx = sandbox();
  ctx.render = () => {};

  await ctx.loadOTReport('2026-08-24');
  let url = ctx.__calls.fetches.filter(f => f.url.startsWith('/api/payroll-report')).pop().url;
  assert.match(url, /week=2026-08-24/);
  assert.ok(!/from=/.test(url), 'no range was set');

  ctx.state.otFrom = '2026-09-07';
  ctx.state.otTo = '2026-09-27';
  await ctx.loadOTReport('2026-08-24');
  url = ctx.__calls.fetches.filter(f => f.url.startsWith('/api/payroll-report')).pop().url;
  assert.match(url, /from=2026-09-07/);
  assert.match(url, /to=2026-09-27/);
  assert.ok(!/week=/.test(url), 'the range wins, so no week is sent alongside it');
});

test('an incomplete range drives nothing and says why', async () => {
  // One date without the other is not a period. Firing the request would let
  // the server fall back to a week and produce a plausible wrong answer.
  const ctx = sandbox();
  ctx.render = () => {};
  const before = ctx.__calls.fetches.length;

  ctx.state.otFrom = '2026-09-07';
  ctx.state.otTo = '';
  ctx.otApplyRange();

  assert.strictEqual(ctx.__calls.fetches.length, before, 'a half-typed range fired a request');
  assert.strictEqual(lastToast(ctx).type, 'error');
  assert.match(lastToast(ctx).msg, /both a from and a to/i);
});

test('typing a date does not fire a request on its own', async () => {
  // Every keystroke in a date field would otherwise be a report load, and a
  // re-render mid-edit takes the focus out of the input.
  const ctx = sandbox();
  ctx.render = () => {};
  const before = ctx.__calls.fetches.length;

  ctx.otSetRangePart('from', '2026-09-07');
  ctx.otSetRangePart('to', '2026-09-27');

  assert.strictEqual(ctx.__calls.fetches.length, before);
  assert.strictEqual(ctx.state.otFrom, '2026-09-07');
  assert.strictEqual(ctx.state.otTo, '2026-09-27');
});

test('clearing the range goes back to the week that was showing', async () => {
  const ctx = sandbox();
  ctx.render = () => {};
  ctx.state.otReportWeek = '2026-08-24';
  ctx.state.otFrom = '2026-09-07';
  ctx.state.otTo = '2026-09-27';

  await ctx.otClearRange();

  assert.strictEqual(ctx.state.otFrom, '');
  const url = ctx.__calls.fetches.filter(f => f.url.startsWith('/api/payroll-report')).pop().url;
  assert.match(url, /week=2026-08-24/, 'Clear has to return to the week, not to the newest one');
});

test('a range does not overwrite the week the dropdown is showing', async () => {
  // The report's weekStart is the range's first date when a range was asked
  // for. Storing that would leave the dropdown pointing at a week nobody chose
  // and Clear returning to it.
  const ctx = sandbox();
  ctx.render = () => {};
  ctx.state.otReportWeek = '2026-08-24';
  ctx.state.otFrom = '2026-09-07';
  ctx.state.otTo = '2026-09-27';

  await ctx.loadOTReport('');
  assert.strictEqual(ctx.state.otReportWeek, '2026-08-24');
});

test('the cost report follows the same rules', async () => {
  const ctx = sandbox();
  ctx.render = () => {};

  ctx.state.costFrom = '2026-09-07';
  ctx.state.costTo = '2026-09-27';
  await ctx.loadCostReport('Manufacturing', '2026-08-24');
  const url = ctx.__calls.fetches.filter(f => f.url.startsWith('/api/cost-report')).pop().url;
  assert.match(url, /from=2026-09-07/);
  assert.ok(!/week=/.test(url));

  // Picking a week clears the range — a dropdown that silently did nothing
  // would be the worse of the two failures.
  ctx.costSetWeek(['Manufacturing'], '2026-08-24');
  assert.strictEqual(ctx.state.costFrom, '');
  assert.strictEqual(ctx.state.costTo, '');
});
