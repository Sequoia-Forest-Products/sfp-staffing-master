// The inputs a Manufacturing cost figure is computed from: the period, its
// daily_hours rows, the roster, the allocations, and the two reader
// assumptions (burden, MBF per labour hour).
//
// SHARED BY /api/cost-report AND /api/rate-scenario, and that is the reason it
// exists. The Rate Scenario's "current" figure has to be the figure the
// Department & Group view shows for the same period and the same assumptions —
// so the two endpoints read their inputs through one function rather than two
// copies of it that could drift.
//
// READS ONLY. Nothing in this file writes to the database.

const payrollDb = require('./payroll-db');
const { weekStartFor, weekDates } = require('./ot-report-lib');
const { fetchWeekIndex, summarizeWeeks, todayInZone, shiftDays, WINDOW_DAYS } = require('./week-index-lib');
const { parseRange, standardHoursFor } = require('./period-lib');

const TIME_ZONE = process.env.PAYROLL_TIME_ZONE || 'America/Los_Angeles';

// Bounds on the two display parameters. They arrive from a query string, so they
// are validated rather than trusted: burden is a multiplier that gets applied to
// every figure on the page, and a NaN would turn the whole report into "null"
// with nothing saying why.
const MAX_BURDEN = 5;        // 500%, far past anything real, but finite
const MAX_MBF_PER_HOUR = 1000;

function parseDecimal(raw, { min, max, fallback }) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n < min || n > max) return null;   // null => 400
  return n;
}

// burden, mbfPerHour, the range and the week — validated before anything
// touches the database, so a typo costs nothing. Returns { error } or the
// parsed values.
function parseCostParams(params = {}) {
  const burden = parseDecimal(params.burden, { min: 0, max: MAX_BURDEN, fallback: 0 });
  if (burden === null) {
    return { error: `Invalid burden "${params.burden}" — expected a decimal between 0 and ${MAX_BURDEN}` };
  }
  const mbfPerHour = parseDecimal(params.mbfPerHour, { min: 0, max: MAX_MBF_PER_HOUR, fallback: 0 });
  if (mbfPerHour === null) {
    return { error: `Invalid mbfPerHour "${params.mbfPerHour}" — expected a number between 0 and ${MAX_MBF_PER_HOUR}` };
  }

  // A DATE RANGE, or a week. The range wins when both are given — it is the
  // more specific request, and refusing the combination would only punish a UI
  // that sent a stale week alongside a deliberate range.
  const range = parseRange(params.from, params.to);
  if (range.error) return { error: range.error };

  const requestedWeek = String(params.week || '').trim();
  let snappedWeek = null;
  if (requestedWeek) {
    try {
      snappedWeek = weekStartFor(requestedWeek);
    } catch {
      return { error: `Invalid week "${requestedWeek}" — expected YYYY-MM-DD` };
    }
  }
  return { burden, mbfPerHour, range, snappedWeek };
}

// Allocations split a person's cost across departments (Task 5). The table does
// not exist yet, and this has to work both before and after it does: a missing
// table means "nobody has an allocation", which is the correct answer today and
// stops being reached the moment the table is created. Any OTHER failure
// propagates — an unreachable database must not silently flatten every split
// back to the primary department, because the numbers would look right.
async function loadAllocations() {
  try {
    const rows = await payrollDb.fetchAllocations();
    return { rows: rows || [], available: true, note: null };
  } catch (err) {
    const message = String((err && err.message) || '');
    // PostgREST answers an unknown table with 404 / PGRST205, and a schema-cache
    // miss with 'could not find the table'.
    if (/\b404\b|PGRST205|could not find the table|does not exist/i.test(message)) {
      return {
        rows: [], available: false,
        note: 'No allocations table yet — every person is costed 100% to their primary department.'
      };
    }
    throw err;
  }
}

// The period, and everything read for it.
async function loadCostInputs({ range = {}, snappedWeek = null } = {}) {
  const today = todayInZone(new Date(), TIME_ZONE);

  // Same window, same snapping and the same week list as /api/payroll-report,
  // because two tabs offering different weeks for the same table would be a bug
  // nobody could explain.
  const windowFrom = weekStartFor(shiftDays(today, -WINDOW_DAYS));
  const windowTo   = weekDates(today)[6];

  const weekIndex      = await fetchWeekIndex(windowFrom, windowTo);
  const availableWeeks = summarizeWeeks(weekIndex.rows, { weekStartFor, weekDates });

  const weekStart = snappedWeek
    || (availableWeeks.length ? availableWeeks[0].weekStart : weekStartFor(today));
  const dates = weekDates(weekStart);

  // The period actually reported: the range when one was asked for, otherwise
  // the week. Everything below reads periodFrom/periodTo, so the week is just
  // the default range rather than a separate code path.
  const periodFrom = range.from || dates[0];
  const periodTo   = range.to   || dates[6];

  // What a salaried person is costed on across this period. Exactly
  // STANDARD_WEEKLY_HOURS for a single Mon-Sun week — period-lib counts
  // scheduled Mon-Thu days — so a weekly report is unchanged, and a
  // three-week range costs them three weeks instead of one.
  const standardHours = standardHoursFor(periodFrom, periodTo);

  const [dailyRows, employees, allocations] = await Promise.all([
    payrollDb.fetchDailyHours(periodFrom, periodTo),
    payrollDb.fetchEmployees(),
    loadAllocations()
  ]);

  return {
    today, windowFrom, windowTo, weekIndex, availableWeeks, weekStart, dates,
    periodFrom, periodTo, standardHours,
    dailyRows: dailyRows || [], employees: employees || [], allocations
  };
}

module.exports = {
  parseDecimal, parseCostParams, loadAllocations, loadCostInputs,
  MAX_BURDEN, MAX_MBF_PER_HOUR, TIME_ZONE
};
