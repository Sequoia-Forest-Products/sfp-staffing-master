// HOW LONG IS A REPORTING PERIOD, IN WEEKS?
//
// Both reports were built for one Mon–Sun week and both now accept an arbitrary
// date range. Several of the quantities inside them are defined PER WEEK, and a
// range has to scale them:
//
//   Department & Group   a salaried person is costed on a standard week, because
//                        the payroll file reports them as zeros. Over three
//                        weeks that is three standard weeks, not one.
//   OT Report            the standing pre-approved allowance and the timeclock
//                        grace are both weekly. Net OT is overtime worked MINUS
//                        those, so under-scaling them overstates Net OT — the
//                        headline figure managers act on — and does it quietly,
//                        with no error anywhere.
//
// ------------------------------------------------------------------------
// THE RULE: SCHEDULED PRODUCTION DAYS, NOT CALENDAR DAYS
// ------------------------------------------------------------------------
//
// The mill runs Mon–Thu, four ten-hour days. So a week's worth of anything is
// four scheduled days, and a period is worth (scheduled days in it ÷ 4) weeks.
//
// Counting CALENDAR days ÷ 7 was the obvious alternative and is wrong in a way
// that matters: a Mon–Thu range is a full working week at this mill, and ÷ 7
// would call it 4/7 of one — handing out 4/7 of an allowance the mill grants
// for the whole week, and overstating Net OT by the difference.
//
// The property that makes this safe to adopt: FOR A SINGLE MON–SUN WEEK IT
// RETURNS EXACTLY 1. Fri, Sat and Sun contribute nothing because no production
// is scheduled on them, so every existing weekly figure is unchanged to the
// penny. That is not a happy accident, it is the acceptance test — see
// tests/period-lib.test.js.
//
// A range covering NO scheduled day (a Fri–Sun range, say) is worth zero weeks,
// and that is the honest answer rather than a problem to round away: no
// production was scheduled, so no weekly allowance accrued. Maintenance hours
// worked on those days are still counted — they come from the payroll file, not
// from this calculation.

const DAY_MS = 86400000;

// Monday through Thursday, as getUTCDay() numbers. The mill's 4x10.
const SCHEDULED_DOW = [1, 2, 3, 4];
const SCHEDULED_DAYS_PER_WEEK = SCHEDULED_DOW.length;   // 4
const STANDARD_DAY_HOURS = 10;                          // 4 x 10 = 40
const STANDARD_WEEKLY_HOURS = SCHEDULED_DAYS_PER_WEEK * STANDARD_DAY_HOURS;

// 'YYYY-MM-DD' -> UTC ms, or null. UTC throughout: these are calendar dates, not
// instants, and parsing them in a local zone is how a date lands on the day
// before in anything west of Greenwich.
function dateToUTC(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || '').trim());
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return Number.isFinite(ms) ? ms : null;
}

function utcToDateStr(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Is production scheduled on this date? Mon–Thu. Mirrors isScheduledDate() in
// src/js/core.js and the is_scheduled_day column the import stamps — three
// copies of one rule, which is two too many, but they are in three runtimes.
function isScheduledDate(dateStr) {
  const ms = dateToUTC(dateStr);
  if (ms === null) return false;
  return SCHEDULED_DOW.includes(new Date(ms).getUTCDay());
}

// Every calendar date from `from` to `to`, inclusive. Returns [] rather than
// throwing on a reversed or unparseable range: the caller validates the input
// and this must not be a second place that decides what a bad range means.
function datesBetween(from, to) {
  const start = dateToUTC(from);
  const end = dateToUTC(to);
  if (start === null || end === null || end < start) return [];
  const out = [];
  for (let ms = start; ms <= end; ms += DAY_MS) out.push(utcToDateStr(ms));
  return out;
}

function scheduledDaysIn(from, to) {
  return datesBetween(from, to).filter(isScheduledDate).length;
}

// The period's length in weeks, for scaling anything defined per week.
//
// Exactly 1.0 for a single Mon–Sun week. Fractional for a partial week, which is
// the honest answer — two scheduled days is half a working week and half an
// allowance.
function weekEquivalent(from, to) {
  return scheduledDaysIn(from, to) / SCHEDULED_DAYS_PER_WEEK;
}

// The standard hours a salaried person is costed on across the period.
// STANDARD_WEEKLY_HOURS for one week, and no special case to get there.
function standardHoursFor(from, to) {
  return scheduledDaysIn(from, to) * STANDARD_DAY_HOURS;
}

// The longest range either report will accept, in calendar days. A year and a
// day, so "the last 12 months" fits and a typo like 2026 -> 2062 does not
// silently ask the database for forty thousand rows.
const MAX_RANGE_DAYS = 366;

// Validates a from/to pair off a query string. Returns { from, to } or
// { error } — never throws, and never half-accepts: one date without the other
// is refused rather than quietly reported as a single day, because a UI bug that
// drops one of the two would otherwise produce a plausible wrong answer.
//
// Shared by /api/cost-report and /api/payroll-report so the two cannot come to
// disagree about what a valid range is.
function parseRange(fromRaw, toRaw) {
  const from = String(fromRaw == null ? '' : fromRaw).trim();
  const to   = String(toRaw   == null ? '' : toRaw).trim();
  if (!from && !to) return { from: null, to: null };
  if (!from || !to) {
    return { error: 'Both from and to are required for a date range — one on its own is not a period.' };
  }

  const fromMs = dateToUTC(from);
  const toMs   = dateToUTC(to);
  if (fromMs === null || toMs === null) {
    return { error: `Invalid date range "${from}" to "${to}" — expected YYYY-MM-DD.` };
  }
  if (toMs < fromMs) {
    return { error: `The range ends before it starts: "${from}" to "${to}".` };
  }

  const days = Math.round((toMs - fromMs) / DAY_MS) + 1;
  if (days > MAX_RANGE_DAYS) {
    return { error: `That range is ${days} days. The most this report will read at once is ${MAX_RANGE_DAYS}.` };
  }

  return { from: utcToDateStr(fromMs), to: utcToDateStr(toMs), days };
}

module.exports = {
  MAX_RANGE_DAYS, parseRange,
  DAY_MS,
  SCHEDULED_DOW, SCHEDULED_DAYS_PER_WEEK, STANDARD_DAY_HOURS, STANDARD_WEEKLY_HOURS,
  dateToUTC, utcToDateStr,
  isScheduledDate, datesBetween, scheduledDaysIn, weekEquivalent, standardHoursFor
};
