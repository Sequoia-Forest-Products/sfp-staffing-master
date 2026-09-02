// The Monday manager email — all of the logic, none of the wiring.
// ot-weekly-email.js is the scheduled handler over the top of this.
//
// WHAT IT SENDS
//
// The week that just finished. Not the one starting: on Monday morning
// "this week" is one day old and empty, so the week is always the PREVIOUS
// Monday-Sunday. That is derived from today rather than from the schedule, so a
// manual "Run now" on a Wednesday sends the same week Monday's run would have.
//
// WHY IT RUNS WHEN IT RUNS
//
// Sunday's hours do not exist until Monday morning: BBSI sends the daily file at
// ~6:04 AM Pacific and payroll-email-ingest picks it up on the next :15. Send
// before that and the email is a six-day week wearing a seven-day label —
// every figure real, internally consistent, and understated. The schedule in
// netlify.toml is 17:00 UTC Monday, which is 10:00 AM Pacific in summer and
// 9:00 AM in winter: three to four hours of margin, and three or four ingest
// attempts, after the file is due.
//
// WHAT IT REFUSES TO SEND
//
// An incomplete week. Not a banner, not a footnote — it does not go out at all,
// and the alert address is told why instead. Two reasons it can refuse:
//
//   1. A day of the week has no rows. BBSI sends seven days a week, so an empty
//      day is a failed delivery and never a quiet Sunday (the same premise
//      payroll-missed-check runs on). A week short a day understates every
//      total in the email, and managers act on those totals.
//   2. The week's own rows came back short of what the week index says exist.
//      Same understatement, different cause.
//
// The manual "Email managers" button on the OT Report tab has no such rule and
// is deliberately left alone: a person looking at the truncation banner on
// screen can decide to send an admittedly-partial week. A cron cannot.

const db = require('./db');
const { weekDates, weekStartFor } = require('./ot-report-lib');
const { todayInZone, shiftDays } = require('./week-index-lib');
const { loadWeekWindow, buildWeekReport, TIME_ZONE } = require('./payroll-report');
const {
  sendEmail, generateEmailHTML, resolveRecipients, managersFromSettingsRow
} = require('./send-ot-email');
const { sendAlert } = require('./payroll-email-lib');

// The app itself. Overridable because the deploy URL is the one thing in this
// file that is not derivable from the data.
const REPORT_LINK = process.env.OT_REPORT_LINK || 'https://seq-staffing.netlify.app/app.html';

// Matches the client's OT_BUDGET_DEFAULT. It drives an over/under-budget flag
// managers act on, so a missing setting falls back to a stated number rather
// than to zero, which would read as "every week is over budget".
const OT_BUDGET_DEFAULT = 10;

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dateParts(s) {
  const p = String(s || '').slice(0, 10).split('-');
  return (p.length === 3 && p[0]) ? [+p[0], +p[1], +p[2]] : null;
}

// A date-only value, so local midnight — getDay() is the same whatever the
// server's zone happens to be.
function dayNameOf(s) {
  const p = dateParts(s);
  return p ? DAY_NAMES[new Date(p[0], p[1] - 1, p[2]).getDay()] : '';
}

// "Mon Aug 25 – Sun Aug 31, 2026". Character-for-character the label
// src/js/ot-report.js builds, because the two emails carry the same subject
// line and a reader should not be able to tell which one sent it.
function otWeekRangeLabel(a, b) {
  const pa = dateParts(a), pb = dateParts(b);
  if (!pa || !pb) return '—';
  const lbl = (iso, p) => dayNameOf(iso).slice(0, 3) + ' ' + MONTH_ABBR[p[1] - 1] + ' ' + p[2];
  return lbl(a, pa) + ' – ' + lbl(b, pb) + ', ' + pb[0];
}

// The OT budget threshold out of the same settings row the manager list and the
// grace allowance come from, read with the same care payroll-report.js reads
// grace with: only a number or a numeric string is a percentage, and anything
// else is a mistake rather than a policy of zero.
function otBudgetFromSettingsRow(row) {
  let value = row && row.value;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== 'object') return null;
  const raw = value.otBudgetPercent;
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  const trimmed = typeof raw === 'string' ? raw.trim() : raw;
  if (trimmed === '') return null;
  const n = Number(trimmed);
  // Zero is a real setting — it means every hour of OT is over budget — so this
  // cannot be a truthiness test.
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

// The Settings tab's on/off switch. It used to gate a hook in the browser that
// fired after a manual upload; it now gates this schedule, which is the only
// automatic sender left.
//
// Unset means ON. Every row this app has written since the checkbox shipped
// carries an explicit true or false, so "absent" can only be a row that predates
// it or a value that got mangled — and for a weekly summary, defaulting a
// damaged setting to silence is the failure nobody notices.
function autoSendFromSettingsRow(row) {
  let value = row && row.value;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return true; }
  }
  if (!value || typeof value !== 'object') return true;
  return value.autoSend !== false;
}

// The `data` object send-ot-email.js's template renders. This is the server-side
// twin of otEmailPayload() in src/js/ot-report.js; tests/ot-weekly-email.test.js
// runs both over one report and asserts they are identical, because two
// implementations of the same email is exactly how the automatic one starts
// quietly disagreeing with the manual one.
function buildOtEmailPayload(report, opts = {}) {
  if (!report) return null;
  const otBudgetPercent = Number.isFinite(Number(opts.otBudgetPercent))
    ? Number(opts.otBudgetPercent) : OT_BUDGET_DEFAULT;
  const now = opts.now || new Date();
  const timeZone = opts.timeZone || 'America/Los_Angeles';
  const reportLink = opts.reportLink || REPORT_LINK;

  const s = report.summary || {};
  const payroll = Number(s.totalHourlyPayroll) || 0;
  const pct = d => payroll > 0 ? ((Number(d) || 0) / payroll * 100).toFixed(1) : '0.0';

  const exceeded = (report.employees || [])
    .filter(e => (Number(e.netOtHours) || 0) > 0)
    .sort((a, b) => (Number(b.netOtHours) || 0) - (Number(a.netOtHours) || 0));
  const shown = exceeded.slice(0, 15);
  const regular = (Number(s.totalHours) || 0) - (Number(s.allOtHours) || 0);

  return {
    dateRange: otWeekRangeLabel(report.weekStart, report.weekEnd),
    totalPayroll: payroll.toFixed(2),
    totalOTHours: (Number(s.allOtHours) || 0).toFixed(2),
    totalRegularHours: regular.toFixed(2),
    totalPreApprovedHours: (Number(s.preApprovedHours) || 0).toFixed(2),
    netOTHours: (Number(s.netOtHours) || 0).toFixed(2),
    totalOTPercent: pct(s.allOtDollars),
    preApprovedOTPercent: pct(s.preApprovedDollars),
    netOTPercent: pct(s.netOtDollars),
    otBudgetPercent: otBudgetPercent.toFixed(1),
    employeeCount: Number(s.headcount) || 0,
    exceededEmployees: shown.map(e => ({
      name: e.name || ('#' + e.employeeNumber),
      unapprovedHours: (Number(e.netOtHours) || 0).toFixed(2)
    })),
    exceededOmitted: exceeded.length - shown.length,
    reportLink,
    uploadTime: now.toLocaleString('en-US', {
      timeZone, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'
    }) + ' PT'
  };
}

// The week that just finished, from any day inside the week after it.
function previousWeekStart(today) {
  return shiftDays(weekStartFor(today), -7);
}

// Pure, so the refusal rule is tested without a database or a mail server.
// Returns the reasons the week must not go out, most consequential first, or an
// empty array when it is whole.
function incompleteReasons({ report, dataWindow }) {
  const reasons = [];
  const missing = ((report && report.completeness) || {}).missingDays || [];
  if (missing.length) {
    reasons.push(
      `${missing.length} day${missing.length === 1 ? ' has' : 's have'} no hours on file: ` +
      missing.map(d => `${dayNameOf(d).slice(0, 3)} ${d}`).join(', ')
    );
  }
  const w = dataWindow || {};
  if (w.weekDetailTruncated) {
    const short = (w.weekRowsExpected != null && w.weekRowsFetched != null)
      ? w.weekRowsExpected - w.weekRowsFetched : null;
    reasons.push(
      `the week's rows came back short: ${w.weekRowsFetched} of ${w.weekRowsExpected} that exist` +
      (short ? ` — ${short} missing` : '')
    );
  }
  return reasons;
}

function alertBody({ weekStart, weekEnd, reasons, extra }) {
  return [
    `The Monday overtime email for ${weekStart} – ${weekEnd} was NOT sent.`,
    '',
    'Why:',
    ...reasons.map(r => `  - ${r}`),
    '',
    extra || '',
    'Nothing is lost: fix the feed and send the week by hand from the OT Report',
    'tab ("Email managers"). This job will try again next Monday with whatever',
    'the week looks like then.'
  ].filter(l => l !== null).join('\n');
}

// dryRun composes everything and sends nothing — same meaning as PAYROLL_DRY_RUN
// in the ingest. The injectables exist for the tests; production passes none.
async function runWeeklyOtEmail({
  dryRun = false,
  now = new Date(),
  deps = {}
} = {}) {
  const _db = deps.db || db;
  const _loadWeekWindow = deps.loadWeekWindow || loadWeekWindow;
  const _buildWeekReport = deps.buildWeekReport || buildWeekReport;
  const _sendEmail = deps.sendEmail || sendEmail;
  const _sendAlert = deps.sendAlert || sendAlert;

  const today = todayInZone(now, TIME_ZONE);
  const weekStart = previousWeekStart(today);
  const dates = weekDates(weekStart);
  const weekEnd = dates[6];

  const result = {
    weekStart, weekEnd, dryRun,
    sent: 0, failed: 0, recipients: [], skipped: null, reasons: [],
    alertError: null, deliveryFailed: false
  };

  // Refuse and alert, in one place, so a skip can never be silent.
  const refuse = async (skipped, reasons, extra) => {
    result.skipped = skipped;
    result.reasons = reasons;
    console.warn(`Weekly OT email skipped (${skipped}):`, reasons.join(' | '));
    try {
      await _sendAlert(
        `OT email NOT sent for ${weekStart} – ${weekEnd}`,
        alertBody({ weekStart, weekEnd, reasons, extra })
      );
    } catch (err) {
      // The one thing worse than skipping is skipping quietly. Netlify alerts on
      // a function error, not on a log line, so this has to reach the handler as
      // a failure.
      result.alertError = err.message;
      result.deliveryFailed = true;
    }
    return result;
  };

  // One read of the settings row for both values it holds, rather than two
  // round trips that could see different versions of it.
  let settingsRow = null;
  try {
    const rows = await _db.query('settings', '?key=eq.emailSettings');
    settingsRow = (rows && rows[0]) || null;
  } catch (err) {
    return refuse('settings-unreadable', [`the settings row could not be read: ${err.message}`]);
  }

  // Switched off deliberately is not a failure and gets no alert — an admin
  // turned it off and knows. It is still logged, so a "why did nobody get the
  // email" question has an answer in the function log.
  if (!autoSendFromSettingsRow(settingsRow)) {
    result.skipped = 'auto-send-off';
    console.log(`Weekly OT email is switched off on the Settings tab — ${weekStart} – ${weekEnd} not sent.`);
    return result;
  }

  const managers = managersFromSettingsRow(settingsRow);
  if (!managers.length) {
    return refuse('no-recipients', ['no manager recipients are configured on the Settings tab']);
  }

  // null, not the manager list: the server owns the recipients here. There is no
  // client in this path to propose anything, and resolveRecipients treats an
  // empty proposal as "whoever is configured".
  const resolved = resolveRecipients(null, managers);
  if (!resolved.ok) {
    return refuse('recipients-rejected', [resolved.error]);
  }

  let built;
  try {
    const weekWindow = await _loadWeekWindow(today);
    built = await _buildWeekReport({ weekStart, today, weekWindow });
  } catch (err) {
    return refuse('report-failed', [`the week could not be built: ${err.message}`]);
  }

  const reasons = incompleteReasons(built);
  if (reasons.length) {
    return refuse('incomplete-week', reasons,
      'The most likely cause is that BBSI\'s file for the last day of the week had\n' +
      'not arrived and been ingested by the time this ran.\n');
  }

  const payload = buildOtEmailPayload(built.report, {
    otBudgetPercent: otBudgetFromSettingsRow(settingsRow),
    reportLink: REPORT_LINK,
    now,
    timeZone: TIME_ZONE
  });
  const subject = `OT Report: ${payload.dateRange}`;

  if (dryRun) {
    result.skipped = 'dry-run';
    result.recipients = resolved.recipients;
    console.log(`DRY RUN — would send "${subject}" to ${resolved.recipients.join(', ')}`);
    return result;
  }

  const html = generateEmailHTML(payload);
  const failures = [];
  for (const email of resolved.recipients) {
    try {
      await _sendEmail(email, subject, html);
      result.sent += 1;
      result.recipients.push(email);
      console.log(`Weekly OT email sent to ${email}`);
    } catch (err) {
      result.failed += 1;
      failures.push(`${email}: ${err.message}`);
      console.error(`Weekly OT email failed for ${email}:`, err.message);
    }
  }

  // Some managers got the week and some did not, which is worse than nobody
  // getting it because it is invisible from either end. Say so.
  if (failures.length) {
    result.deliveryFailed = true;
    try {
      await _sendAlert(
        `OT email partly undelivered for ${weekStart} – ${weekEnd}`,
        [`Sent to ${result.sent} of ${resolved.recipients.length} managers.`, '', 'Failed:',
          ...failures.map(f => `  - ${f}`)].join('\n')
      );
    } catch (err) {
      result.alertError = err.message;
    }
  }

  return result;
}

module.exports = {
  runWeeklyOtEmail,
  buildOtEmailPayload,
  otBudgetFromSettingsRow,
  autoSendFromSettingsRow,
  otWeekRangeLabel,
  previousWeekStart,
  incompleteReasons,
  OT_BUDGET_DEFAULT,
  REPORT_LINK
};
