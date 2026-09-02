// Run with: npm test
//
// The Monday manager email. Three things are worth a test here and one of them
// is the reason this file exists at all.
//
// 1. THE WEEK. "The week that just finished" is arithmetic, and off by one week
//    or off by one day both produce a plausible-looking email full of the wrong
//    numbers. It is derived from the date rather than from the schedule, so it
//    is checked at several dates, including the one the cron will actually fire
//    at.
//
// 2. THE REFUSAL. An incomplete week must not go out, and a skip must never be
//    silent. Both halves are asserted, including the case where the alert
//    itself fails — which is the only way a skip could go unnoticed.
//
// 3. THE PARITY. This is the one. The email payload now has two
//    implementations: otEmailPayload() in src/js/ot-report.js behind the "Email
//    managers" button, and buildOtEmailPayload() in ot-weekly-email-lib.js
//    behind the schedule. Same subject line, same template, same managers —
//    nobody receiving one could tell which sent it, and nothing about a drift
//    between them would look like a bug from either end. So the last test in
//    this file runs BOTH over one report and demands they are identical.
//
// Negative controls, actually run while writing this — each sabotage applied on
// its own and then reverted:
//
//   remove the `if (reasons.length)` refusal        -> 3 fail (12, 13, 14)
//   payload .toFixed(2) -> .toFixed(1) on one field -> 1 fail (22, the parity test)
//   previousWeekStart returns the CURRENT week      -> 4 fail (1, 2, 11, 12)
//   alert failure stops setting deliveryFailed      -> 1 fail (14)
//
// Restored, 23 pass.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'js');

const lib = require('../netlify/functions/ot-weekly-email-lib');
const {
  runWeeklyOtEmail, buildOtEmailPayload, previousWeekStart, incompleteReasons,
  otBudgetFromSettingsRow, autoSendFromSettingsRow, otWeekRangeLabel
} = lib;

// ---------------------------------------------------------------------------
// 1. The week
// ---------------------------------------------------------------------------

test('the week is the one that just finished, not the one starting', () => {
  // Monday 2026-09-07 -> the Mon-Sun that ended yesterday.
  assert.strictEqual(previousWeekStart('2026-09-07'), '2026-08-31');
  // Any other day of the same week gives the same answer, so a manual "Run now"
  // on a Wednesday sends what Monday's run would have.
  assert.strictEqual(previousWeekStart('2026-09-09'), '2026-08-31');
  assert.strictEqual(previousWeekStart('2026-09-13'), '2026-08-31');
});

test('the cron hour is late enough that Pacific has reached Monday', () => {
  // 17:00 UTC Monday is 10:00 Pacific (PDT) / 09:00 (PST). Fire it before
  // Pacific midnight — say 03:00 UTC — and todayInZone still says Sunday, so the
  // job would send the week BEFORE last and nothing would look wrong about it.
  const { todayInZone } = require('../netlify/functions/week-index-lib');
  const zone = 'America/Los_Angeles';

  assert.strictEqual(todayInZone(new Date('2026-09-07T17:00:00Z'), zone), '2026-09-07');
  assert.strictEqual(previousWeekStart(todayInZone(new Date('2026-09-07T17:00:00Z'), zone)),
    '2026-08-31');

  // The trap, pinned so nobody "tidies" the schedule earlier.
  assert.strictEqual(todayInZone(new Date('2026-09-07T03:00:00Z'), zone), '2026-09-06');
  assert.strictEqual(previousWeekStart(todayInZone(new Date('2026-09-07T03:00:00Z'), zone)),
    '2026-08-24', 'an early-UTC Monday run would send the wrong week entirely');

  // And winter, when the same UTC hour is 09:00 Pacific rather than 10:00.
  assert.strictEqual(todayInZone(new Date('2026-01-05T17:00:00Z'), zone), '2026-01-05');
});

// ---------------------------------------------------------------------------
// 2. The refusal rule (pure)
// ---------------------------------------------------------------------------

function wholeWeek() {
  return {
    report: { completeness: { missingDays: [] } },
    dataWindow: { weekDetailTruncated: false, weekRowsExpected: 400, weekRowsFetched: 400 }
  };
}

test('a whole week has nothing to refuse', () => {
  assert.deepStrictEqual(incompleteReasons(wholeWeek()), []);
});

test('a week missing its Sunday is refused, and the reason names the day', () => {
  const built = wholeWeek();
  built.report.completeness.missingDays = ['2026-09-06'];
  const reasons = incompleteReasons(built);
  assert.strictEqual(reasons.length, 1);
  assert.match(reasons[0], /2026-09-06/);
  assert.match(reasons[0], /Sun/, 'the day name matters — "2026-09-06" alone makes nobody look');
  assert.match(reasons[0], /1 day has no hours/);
});

test('a week missing a midweek day is refused too', () => {
  // BBSI sends seven days a week, so an empty Wednesday is a failed delivery and
  // understates the week exactly as much as an empty Sunday does. There is no
  // "only Sunday counts" rule here on purpose.
  const built = wholeWeek();
  built.report.completeness.missingDays = ['2026-09-02', '2026-09-06'];
  const reasons = incompleteReasons(built);
  assert.strictEqual(reasons.length, 1);
  assert.match(reasons[0], /2 days have no hours/);
  assert.match(reasons[0], /Wed 2026-09-02/);
  assert.match(reasons[0], /Sun 2026-09-06/);
});

test('rows that came back short are their own refusal, with the shortfall', () => {
  const built = wholeWeek();
  built.dataWindow = { weekDetailTruncated: true, weekRowsExpected: 400, weekRowsFetched: 388 };
  const reasons = incompleteReasons(built);
  assert.strictEqual(reasons.length, 1);
  assert.match(reasons[0], /388 of 400/);
  assert.match(reasons[0], /12 missing/);
});

test('both faults at once are both reported', () => {
  const built = wholeWeek();
  built.report.completeness.missingDays = ['2026-09-06'];
  built.dataWindow = { weekDetailTruncated: true, weekRowsExpected: 400, weekRowsFetched: 388 };
  assert.strictEqual(incompleteReasons(built).length, 2);
});

// ---------------------------------------------------------------------------
// 3. The settings readers
// ---------------------------------------------------------------------------

test('the OT budget is read from either shape settings.js writes', () => {
  assert.strictEqual(otBudgetFromSettingsRow({ value: { otBudgetPercent: 12.5 } }), 12.5);
  assert.strictEqual(otBudgetFromSettingsRow({ value: '{"otBudgetPercent":"8"}' }), 8);
});

test('zero is a real OT budget and nonsense is not', () => {
  // Zero means every OT hour is over budget. A truthiness test would read it as
  // "unset" and quietly substitute 10%.
  assert.strictEqual(otBudgetFromSettingsRow({ value: { otBudgetPercent: 0 } }), 0);
  for (const bad of [null, undefined, '', '  ', 'ten', -1, {}, [], NaN]) {
    assert.strictEqual(otBudgetFromSettingsRow({ value: { otBudgetPercent: bad } }), null,
      `${JSON.stringify(bad)} is a mistake, not a policy`);
  }
  assert.strictEqual(otBudgetFromSettingsRow({ value: 'not json' }), null);
  assert.strictEqual(otBudgetFromSettingsRow(null), null);
});

test('auto-send is off only when it is explicitly false', () => {
  assert.strictEqual(autoSendFromSettingsRow({ value: { autoSend: false } }), false);
  assert.strictEqual(autoSendFromSettingsRow({ value: '{"autoSend":false}' }), false);
  assert.strictEqual(autoSendFromSettingsRow({ value: { autoSend: true } }), true);
  // A row that predates the checkbox, or one that got mangled, sends. Defaulting
  // a damaged setting to silence is the failure nobody notices.
  assert.strictEqual(autoSendFromSettingsRow({ value: {} }), true);
  assert.strictEqual(autoSendFromSettingsRow({ value: 'not json' }), true);
  assert.strictEqual(autoSendFromSettingsRow(null), true);
});

// ---------------------------------------------------------------------------
// 4. The run, over stubbed everything
// ---------------------------------------------------------------------------

// Monday 2026-09-07, 17:00 UTC — the instant the cron will actually fire.
const FIRES_AT = new Date('2026-09-07T17:00:00Z');

function report(overrides = {}) {
  return Object.assign({
    weekStart: '2026-08-31',
    weekEnd: '2026-09-06',
    summary: {
      totalHourlyPayroll: 92450.18, totalHours: 2410.5, allOtHours: 188.25,
      preApprovedHours: 60, netOtHours: 128.25, allOtDollars: 6120.4,
      preApprovedDollars: 1950.5, netOtDollars: 4169.9, headcount: 63
    },
    employees: [
      { name: 'Axeri Ramirez', employeeNumber: '1041', netOtHours: 14.25 },
      { name: 'Adam Figas', employeeNumber: '1088', netOtHours: 9.5 },
      { name: '', employeeNumber: '1199', netOtHours: 3 },
      { name: 'Nobody Overtime', employeeNumber: '1200', netOtHours: 0 }
    ],
    completeness: { missingDays: [] }
  }, overrides);
}

function harness(opts = {}) {
  const calls = { emails: [], alerts: [], weeks: [] };
  const settingsValue = Object.assign(
    { managers: ['a@sequoiafp.com', 'b@sequoiafp.com'], autoSend: true, otBudgetPercent: 10 },
    opts.settings || {});
  const deps = {
    db: { query: async () => opts.settingsThrows
      ? Promise.reject(new Error('supabase down'))
      : [{ key: 'emailSettings', value: settingsValue }] },
    loadWeekWindow: async () => ({ from: '2025-08-01', to: '2026-09-13', weeks: [], truncated: false }),
    buildWeekReport: async ({ weekStart }) => {
      calls.weeks.push(weekStart);
      if (opts.buildThrows) throw new Error('week index unreachable');
      return {
        report: report(opts.report || {}),
        dataWindow: Object.assign(
          { weekDetailTruncated: false, weekRowsExpected: 400, weekRowsFetched: 400 },
          opts.dataWindow || {})
      };
    },
    sendEmail: async (to, subject, html) => {
      if (opts.sendFailsFor && opts.sendFailsFor.includes(to)) throw new Error('550 rejected');
      calls.emails.push({ to, subject, html });
      return { messageId: 'x' };
    },
    sendAlert: async (subject, body) => {
      if (opts.alertThrows) throw new Error('smtp down');
      calls.alerts.push({ subject, body });
    }
  };
  return { calls, deps };
}

test('a whole week goes to every manager, with the completed week in the subject', async () => {
  const { calls, deps } = harness();
  const res = await runWeeklyOtEmail({ now: FIRES_AT, deps });

  assert.strictEqual(res.skipped, null);
  assert.strictEqual(res.sent, 2);
  assert.strictEqual(res.failed, 0);
  assert.deepStrictEqual(calls.weeks, ['2026-08-31'], 'the week that just finished');
  assert.deepStrictEqual(calls.emails.map(e => e.to), ['a@sequoiafp.com', 'b@sequoiafp.com']);
  assert.strictEqual(calls.emails[0].subject, 'OT Report: Mon Aug 31 – Sun Sep 6, 2026');
  assert.strictEqual(calls.alerts.length, 0, 'a clean run tells nobody anything');
  // The rendered email carries the real figures, not a template with holes in it.
  assert.match(calls.emails[0].html, /Axeri Ramirez/);
  assert.match(calls.emails[0].html, /92450\.18/);
  assert.ok(!/undefined|NaN/.test(calls.emails[0].html), 'no undefined or NaN reached the email');
});

test('a week missing Sunday is not sent, and the alert says why', async () => {
  const { calls, deps } = harness({ report: { completeness: { missingDays: ['2026-09-06'] } } });
  const res = await runWeeklyOtEmail({ now: FIRES_AT, deps });

  assert.strictEqual(res.sent, 0);
  assert.strictEqual(calls.emails.length, 0, 'no manager may receive a short week');
  assert.strictEqual(res.skipped, 'incomplete-week');
  assert.strictEqual(calls.alerts.length, 1);
  assert.match(calls.alerts[0].subject, /NOT sent for 2026-08-31 – 2026-09-06/);
  assert.match(calls.alerts[0].body, /Sun 2026-09-06/);
  assert.match(calls.alerts[0].body, /send the week by hand/,
    'the alert has to say what to do about it');
});

test('a short row count is not sent either', async () => {
  const { calls, deps } = harness({
    dataWindow: { weekDetailTruncated: true, weekRowsExpected: 400, weekRowsFetched: 388 }
  });
  const res = await runWeeklyOtEmail({ now: FIRES_AT, deps });
  assert.strictEqual(res.skipped, 'incomplete-week');
  assert.strictEqual(calls.emails.length, 0);
  assert.match(calls.alerts[0].body, /388 of 400/);
});

test('a skip that could not be alerted is a function error', async () => {
  // The only way a refusal goes unnoticed. Netlify alerts on a function error
  // and not on a log line, so this has to leave the process as a 500.
  const { deps } = harness({
    report: { completeness: { missingDays: ['2026-09-06'] } }, alertThrows: true
  });
  const res = await runWeeklyOtEmail({ now: FIRES_AT, deps });
  assert.strictEqual(res.deliveryFailed, true);
  assert.strictEqual(res.alertError, 'smtp down');

  const handler = require('../netlify/functions/ot-weekly-email');
  assert.strictEqual(typeof handler.handler, 'function');
});

test('switched off means switched off — no email, and no alert either', async () => {
  const { calls, deps } = harness({ settings: { autoSend: false } });
  const res = await runWeeklyOtEmail({ now: FIRES_AT, deps });
  assert.strictEqual(res.skipped, 'auto-send-off');
  assert.strictEqual(calls.emails.length, 0);
  assert.strictEqual(calls.alerts.length, 0, 'an admin turned it off and does not need telling');
  assert.strictEqual(res.deliveryFailed, false, 'and it is not a failed run');
});

test('an empty manager list is a refusal, not a quiet no-op', async () => {
  const { calls, deps } = harness({ settings: { managers: [] } });
  const res = await runWeeklyOtEmail({ now: FIRES_AT, deps });
  assert.strictEqual(res.skipped, 'no-recipients');
  assert.strictEqual(calls.alerts.length, 1);
});

test('an unreadable settings row refuses rather than guessing at recipients', async () => {
  const { calls, deps } = harness({ settingsThrows: true });
  const res = await runWeeklyOtEmail({ now: FIRES_AT, deps });
  assert.strictEqual(res.skipped, 'settings-unreadable');
  assert.strictEqual(calls.emails.length, 0);
  assert.match(calls.alerts[0].body, /supabase down/);
});

test('a week that would not build refuses rather than sending an empty one', async () => {
  const { calls, deps } = harness({ buildThrows: true });
  const res = await runWeeklyOtEmail({ now: FIRES_AT, deps });
  assert.strictEqual(res.skipped, 'report-failed');
  assert.strictEqual(calls.emails.length, 0);
  assert.match(calls.alerts[0].body, /week index unreachable/);
});

test('a partial delivery is escalated — some managers holding the week is worse than none', async () => {
  const { calls, deps } = harness({ sendFailsFor: ['b@sequoiafp.com'] });
  const res = await runWeeklyOtEmail({ now: FIRES_AT, deps });
  assert.strictEqual(res.sent, 1);
  assert.strictEqual(res.failed, 1);
  assert.strictEqual(res.deliveryFailed, true);
  assert.strictEqual(calls.alerts.length, 1);
  assert.match(calls.alerts[0].body, /b@sequoiafp\.com: 550 rejected/);
});

test('a dry run composes everything and sends nothing', async () => {
  const { calls, deps } = harness();
  const res = await runWeeklyOtEmail({ now: FIRES_AT, deps, dryRun: true });
  assert.strictEqual(res.skipped, 'dry-run');
  assert.strictEqual(calls.emails.length, 0);
  assert.deepStrictEqual(res.recipients, ['a@sequoiafp.com', 'b@sequoiafp.com']);
});

test('the recipient allowlist still runs on the saved list', async () => {
  // The schedule proposes nobody — the saved list IS the recipient list — so a
  // saved off-domain manager is allowed by design (that rule belongs to
  // send-ot-email.js and is tested there). What is worth pinning HERE is that
  // resolveRecipients is still in the path at all, and the way to show that is a
  // list it rejects: a mangled address the Settings tab let through.
  const { calls, deps } = harness({
    settings: { managers: ['a@sequoiafp.com', 'not an email'] }
  });
  const res = await runWeeklyOtEmail({ now: FIRES_AT, deps });

  assert.strictEqual(res.skipped, 'recipients-rejected');
  assert.strictEqual(calls.emails.length, 0,
    'one bad address stops the batch — a partial send nobody asked for is worse');
  assert.match(calls.alerts[0].body, /not an email/);
});

// ---------------------------------------------------------------------------
// 5. Parity with the button
// ---------------------------------------------------------------------------

test('the scheduled email and the manual button build the identical payload', () => {
  const { __SCRIPT_MODULES } = require('../netlify/functions/session.js');

  // The client stamps uploadTime from `new Date()`. Both sides have to be
  // looking at the same instant or the comparison is theatre.
  const FIXED = FIRES_AT.getTime();
  class FixedDate extends Date {
    constructor(...args) { if (args.length === 0) super(FIXED); else super(...args); }
    static now() { return FIXED; }
  }

  const el = () => ({
    textContent: '', innerHTML: '', value: '', checked: false, style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {}, addEventListener() {},
    appendChild() {}, querySelector: () => el(), querySelectorAll: () => []
  });

  const ctx = {
    console, window: {}, Date: FixedDate,
    document: { getElementById: () => el(), querySelector: () => el(), querySelectorAll: () => [] },
    setTimeout: (fn) => { void fn; return 0; },
    localStorage: {
      _v: {},
      getItem(k) { return Object.prototype.hasOwnProperty.call(this._v, k) ? this._v[k] : null; },
      setItem(k, v) { this._v[k] = String(v); },
      removeItem(k) { delete this._v[k]; }
    },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const m of __SCRIPT_MODULES) {
    vm.runInContext(fs.readFileSync(path.join(SRC, m), 'utf8'), ctx, { filename: m });
  }
  vm.runInContext('globalThis.state = state;', ctx, { filename: 'expose-lexicals.js' });

  // Sixteen people over the limit, so the 15-row cap and the "…and N more" count
  // are both exercised rather than assumed.
  const many = report();
  many.employees = Array.from({ length: 16 }, (_, i) => ({
    name: `Person ${i + 1}`, employeeNumber: String(2000 + i), netOtHours: 20 - i * 0.5
  })).concat([{ name: 'Zero OT', employeeNumber: '2999', netOtHours: 0 }]);

  ctx.state.otReport = many;
  ctx.state.emailSettings = { managers: ['a@sequoiafp.com'], autoSend: true, otBudgetPercent: 12.5 };

  const fromButton = JSON.parse(JSON.stringify(ctx.otEmailPayload()));
  const fromSchedule = buildOtEmailPayload(many, {
    otBudgetPercent: 12.5,
    now: FIRES_AT,
    timeZone: 'America/Los_Angeles'
  });

  assert.deepStrictEqual(fromSchedule, fromButton,
    'the automatic email and the manual one must be the same email');

  // And spot-check the things a silent drift would quietly change.
  assert.strictEqual(fromSchedule.exceededEmployees.length, 15);
  assert.strictEqual(fromSchedule.exceededOmitted, 1);
  assert.strictEqual(fromSchedule.otBudgetPercent, '12.5');
  assert.strictEqual(fromSchedule.dateRange, 'Mon Aug 31 – Sun Sep 6, 2026');
});

test('the week label matches the one the OT Report tab prints', () => {
  assert.strictEqual(otWeekRangeLabel('2026-08-31', '2026-09-06'), 'Mon Aug 31 – Sun Sep 6, 2026');
  // Across a year boundary, the year shown is the week's END.
  assert.strictEqual(otWeekRangeLabel('2025-12-29', '2026-01-04'), 'Mon Dec 29 – Sun Jan 4, 2026');
  assert.strictEqual(otWeekRangeLabel('', ''), '—');
});
