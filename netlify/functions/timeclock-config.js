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
  missingAfterHour: 11
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

module.exports = { TIME_ZONE, DAILY_FILE, WEEKLY_FILE, ALERT_THRESHOLDS };
