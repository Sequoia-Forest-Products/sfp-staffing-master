// THE ONE PLACE the timeclock schedule and every alert threshold live.
//
// Change a number here and nowhere else. Every consumer — the email ingester's
// late-arrival check, the alerts engine, the Alerts tab's explanations, and the
// tests — reads it from this module, so two copies cannot drift.
//
// All times are Pacific (America/Los_Angeles), which is the clock BBSI sends
// on. Netlify cron is UTC and does not follow daylight saving, which is why the
// scheduled functions run hourly and decide "is it past 9 AM Pacific yet?"
// here, rather than trying to encode a Pacific hour in a UTC cron line.

const TIME_ZONE = process.env.PAYROLL_TIME_ZONE || 'America/Los_Angeles';

// The daily file: every Active TimeNet employee, covering the PRIOR day.
// BBSI moved it from ~6:00 AM to 8:00 AM Pacific in November 2026.
const DAILY_FILE = {
  expectedHour: 8,
  // An arrival outside [earliestHour, latestHour) still imports, but is
  // flagged late_arrival: an odd hour is the best signal that "received date
  // minus one" is about to land on the wrong day.
  earliestHour: 6,
  latestHour: 12,
  // Daily file missing: no daily file for yesterday by this hour.
  missingAfterHour: 9
};

// The weekly file: the prior Monday-Sunday with punch corrections applied.
const WEEKLY_FILE = {
  dayOfWeek: 1,          // Monday (1 = Monday ... 7 = Sunday)
  expectedHour: 10,
  // Weekly file missing: no weekly file for last week by this hour on Monday.
  missingAfterHour: 11,
  // The first week BBSI's weekly file covers. It starts arriving Monday
  // 2026-11-09 with the week of 11/2; no earlier week was ever owed one, so
  // none is alerted on.
  firstWeekStart: '2026-11-02'
};

const ALERT_THRESHOLDS = {
  // Thin day: a day's counted (hourly) row count is below this fraction of
  // the trailing median for the same weekday.
  thinDayRatio: 0.6,
  thinDayLookbackWeeks: 4,
  // A weekday whose trailing median is below this many rows (Saturdays,
  // Sundays) is too small for a ratio to mean anything and is not judged.
  thinDayMinMedianRows: 5,

  // Weekly variance: a reconciliation that moves the week's labor cost by
  // more than EITHER of these.
  weeklyVariancePct: 2,
  weeklyVarianceDollars: 1000,

  // Active, no hours: an active hourly employee with no counted hours in
  // this many trailing days (ending yesterday).
  noHoursLookbackDays: 7,

  // How far back the engine looks for conditions on dated things (zero-hour
  // rows, thin days, held unknown numbers). Older days are left alone.
  evaluateLookbackDays: 45
};

// ---------------------------------------------------------------------------
// MANUAL UPLOADS (from 2026-11-24). The email import is off.
// ---------------------------------------------------------------------------
//
// BBSI's Work Summary Payroll report has no date in it, and the daily and
// weekly versions have identical columns. The email importer guessed each
// file's date from when it arrived, which is how two weekly files were stored
// as single days (11/15, 11/22). Files are now uploaded by a person who states
// what each one covers. DAILY_FILE and WEEKLY_FILE above describe the old email
// delivery and are read only by payroll-email-lib, which is switched off below.

// The switch for the old email import. OFF unless the environment says
// exactly 'true'. Off means runPayrollIngest and runMissedDeliveryCheck return
// without reading the mailbox or writing anything; the code stays in place.
const emailImportEnabled = () =>
  String(process.env.PAYROLL_EMAIL_IMPORT_ENABLED || '').trim().toLowerCase() === 'true';

// Daily: every calendar day is uploaded, on the next weekday. Monday's upload
// covers Friday, Saturday and Sunday. A day with no upload by noon Pacific on
// the day it was due raises Daily upload missing.
const DAILY_UPLOAD = {
  dueHour: 12,
  // The first day owed by upload. Everything before it was delivered by email
  // or by the corrected BBSI backfill (9/9–11/15), so it is never alerted on.
  firstWorkDate: '2026-11-16'
};

// Weekly: the previous Monday–Sunday, by noon Pacific Wednesday.
const WEEKLY_UPLOAD = {
  dueDayOfWeek: 3,       // Wednesday (1 = Monday ... 7 = Sunday)
  dueHour: 12,
  firstWeekStart: '2026-11-16',
  // A person's daily sum matches the weekly file when every one of regular,
  // overtime and total is within this many hours.
  toleranceHours: 0.02
};

// What makes a file uploaded as a DAILY look like a WEEKLY one. Either refuses.
const DAILY_GUARD = {
  // Nobody works more than 24 hours in a day.
  maxPersonHours: 24,
  // The file's total hours against the largest day in the trailing window.
  totalMultiple: 1.5,
  lookbackDays: 56,
  // With no history to compare against: a normal day is ~560 hours, a week
  // ~2,000.
  fallbackMaxTotal: 1000
};

// Who may upload and commit. Everyone else on the access list can view.
// TIMECLOCK_UPLOADERS (comma-separated) overrides the list without a deploy.
const DEFAULT_UPLOADERS = ['peter.stroble@sequoiafp.com', 'axeri.ramirez@sequoiafp.com'];
function uploaders() {
  const env = String(process.env.TIMECLOCK_UPLOADERS || '').trim();
  const list = env ? env.split(',') : DEFAULT_UPLOADERS;
  return list.map(e => String(e).trim().toLowerCase()).filter(Boolean);
}
function canUpload(email) {
  const e = String(email || '').trim().toLowerCase();
  return !!e && uploaders().includes(e);
}

module.exports = {
  TIME_ZONE, DAILY_FILE, WEEKLY_FILE, ALERT_THRESHOLDS,
  DAILY_UPLOAD, WEEKLY_UPLOAD, DAILY_GUARD,
  emailImportEnabled, uploaders, canUpload
};
