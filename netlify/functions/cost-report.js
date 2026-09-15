// GET /api/cost-report — aggregated labour cost for one cost class.
//
//   ?class=Manufacturing   the only class this app costs; default and only value
//   ?week=YYYY-MM-DD   any date inside the wanted week (snapped to the Monday).
//                      Omitted => the most recent week that has data.
//   ?burden=0.44       burden multiplier, as a decimal. A display parameter the
//                      user sets on the tab; it does not come from the database.
//   ?mbfPerHour=15     thousand board feet per labour hour, for cost per MBF.
//
// Response: { ok, report, availableWeeks, week, truncated, dataWindow, allocations }
//
// WHY THIS ENDPOINT EXISTS AT ALL, rather than the tab computing from /api/data:
// it cannot. annual_salary is deliberately not in /api/data's projection, so the
// browser has no way to price a salaried person, and effectiveHourlyRate() lives
// in wage-sync.js which the browser never loads. Everything this returns is an
// aggregate — the only names in it are on the rate-gap and bullpen lists, which
// are data-quality findings and carry no money.
//
// PHASE D. There IS a permissions system now, and it changes exactly one thing
// here: the suppression floor.
//
// cost-lib.js withholds money for any grouping small enough that its average IS
// somebody's rate. That protects a figure the reader is not allowed to see —
// so for a reader who IS allowed to see it, the same dashes protect nothing and
// cost everything. Somebody holding the salaries tier can read every
// annual_salary by name on the employee's own profile card; hourly rates are
// base-tier and visible to everyone on the roster. There is no figure a small
// bucket could leak to them that they cannot already read directly.
//
// So the floor is 1 for the salaries tier and DEFAULT_MIN_BUCKET for everybody
// else, and it is decided HERE, server-side, from the caller's own tiers. A
// base-tier caller's payload still arrives with the money nulled out — the
// dashes are in the response, not in the rendering.
//
// THIS IS SLIGHTLY WIDER THAN "SHOW THE SG&A BREAKDOWN". It lifts suppression on
// every cost class for that tier, not only on Overhead, because the argument
// above does not stop at a class boundary — a one-person Manufacturing bucket
// leaks the same salary/2080 to the same reader. Narrowing it to SG&A would
// leave dashes on Manufacturing that protect nothing from the person looking at
// them.
//
// 2026-09-14: MANUFACTURING IS THE ONLY CLASS LEFT TO ASK ABOUT. The Overhead
// tab is gone and the other two classes are refused here rather than gated —
// there is no longer a tier that could unlock them, because there is nothing
// behind them to unlock. Unchanged by the 2026-09-15 narrowing that gave hourly
// SG&A staff their rate back: that rate exists for the roster and for SG&A
// overtime, and a cost report over SG&A is the analysis that stopped. The suppression floor above is untouched and still answers to the
// reader's tier: a one-person Manufacturing bucket is still somebody's rate.

const db = require('./db');
const perms = require('./permissions-lib');
const payrollDb = require('./payroll-db');
const { weekStartFor, weekDates } = require('./ot-report-lib');
const { verifySession, getCookies } = require('./session-lib');
const {
  fetchWeekIndex, summarizeWeeks, todayInZone, shiftDays, WINDOW_DAYS
} = require('./week-index-lib');
const { buildCostReport, REPORTED_COST_CLASSES, DEFAULT_MIN_BUCKET } = require('./cost-lib');
const { parseRange, standardHoursFor } = require('./period-lib');

// The cost classes this endpoint used to serve behind the salaries tier, and
// now refuses outright. Kept as a named list rather than deleted so the refusal
// can say WHICH decision removed the report — a bare "unknown cost class" for a
// value that worked last week reads as a bug and sends somebody looking for
// one.
const RETIRED_COST_CLASSES = ['Mill Overhead', 'SG&A'];

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

// Allocations split a person's cost across departments (Task 5). The table does
// not exist yet, and this endpoint has to work both before and after it does:
// a missing table means "nobody has an allocation", which is the correct answer
// today and stops being reached the moment the table is created. Any OTHER
// failure propagates — an unreachable database must not silently flatten every
// split back to the primary department, because the numbers would look right.
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

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  const session = verifySession(getCookies(event).sfp_session || '');
  if (!session) {
    return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'Unauthorized' }) };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'Method not allowed' }) };
  }

  const params = event.queryStringParameters || {};

  // ---- validate everything before touching the database, so a typo costs nothing ----

  const costClass = String(params.class || params.costClass || 'Manufacturing').trim();
  if (RETIRED_COST_CLASSES.includes(costClass)) {
    return {
      statusCode: 400, headers,
      body: JSON.stringify({
        ok: false,
        error: `${costClass} is no longer costed in this app.`,
        detail: 'The Overhead tab was removed on 2026-09-14. Those employees are still on the ' +
                'roster and their hours and overtime are still reported; their pay is not held ' +
                'here any more, so there is no cost to report.'
      })
    };
  }
  if (!REPORTED_COST_CLASSES.includes(costClass)) {
    return {
      statusCode: 400, headers,
      body: JSON.stringify({
        ok: false,
        error: `Unknown cost class "${costClass}" — expected one of ${REPORTED_COST_CLASSES.join(', ')}`
      })
    };
  }

  const burden = parseDecimal(params.burden, { min: 0, max: MAX_BURDEN, fallback: 0 });
  if (burden === null) {
    return {
      statusCode: 400, headers,
      body: JSON.stringify({ ok: false, error: `Invalid burden "${params.burden}" — expected a decimal between 0 and ${MAX_BURDEN}` })
    };
  }

  const mbfPerHour = parseDecimal(params.mbfPerHour, { min: 0, max: MAX_MBF_PER_HOUR, fallback: 0 });
  if (mbfPerHour === null) {
    return {
      statusCode: 400, headers,
      body: JSON.stringify({ ok: false, error: `Invalid mbfPerHour "${params.mbfPerHour}" — expected a number between 0 and ${MAX_MBF_PER_HOUR}` })
    };
  }

  // The suppression threshold is a disclosure judgement, so it is settable — but
  // only upward from the caller's FLOOR. A caller must not be able to talk the
  // endpoint into publishing a one-person bucket by asking for minBucket=1;
  // whether 1 is even a floor for them is decided below, from their tiers, and
  // never from anything in the query string.
  const requestedMin = parseDecimal(params.minBucket, { min: 1, max: 100, fallback: null });

  // A DATE RANGE, or a week. The range wins when both are given — it is the
  // more specific request, and refusing the combination would only punish a UI
  // that sent a stale week alongside a deliberate range.
  const range = parseRange(params.from, params.to);
  if (range.error) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: range.error }) };
  }

  const requestedWeek = String(params.week || '').trim();
  let snappedWeek = null;
  if (requestedWeek) {
    try {
      snappedWeek = weekStartFor(requestedWeek);
    } catch {
      return {
        statusCode: 400, headers,
        body: JSON.stringify({ ok: false, error: `Invalid week "${requestedWeek}" — expected YYYY-MM-DD` })
      };
    }
  }

  try {
    // Fails closed to the base tier, which here means full suppression — the
    // safe direction. A permissions read that breaks costs somebody their
    // breakdown; it cannot publish one.
    const tiers = await perms.fetchTiers(session.email, db);

    // THE OVERHEAD CLASSES WERE GATED HERE, WHOLE, and the gate is gone with
    // the classes: RETIRED_COST_CLASSES is refused above, before a permissions
    // read is even worth doing, because no tier unlocks a report that no longer
    // exists. Manufacturing stays open to every signed-in account and is
    // protected by suppression, the way it always was.

    const floor = perms.has(tiers, perms.TIER_SALARIES) ? 1 : DEFAULT_MIN_BUCKET;
    const minBucketHeadcount = requestedMin === null
      ? floor
      : Math.max(floor, Math.floor(requestedMin));

    const today = todayInZone(new Date(), TIME_ZONE);

    // Same window, same snapping and the same week list as /api/payroll-report,
    // because the two tabs offering different weeks for the same table would be
    // a bug nobody could explain.
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

    // Cross-check the detail fetch against the window scan, which counted the
    // same rows a cheaper way. Fewer rows than the index says exist means
    // something dropped rows and every hours figure below is understated.
    //
    // ONLY FOR A WHOLE WEEK. The index counts rows per Mon-Sun week, so it has
    // nothing to say about an arbitrary range; comparing one against the weeks
    // it overlaps would report a shortfall on every partial week. Null is the
    // honest answer.
    const isWholeWeek = !range.from;
    const indexedWeek = isWholeWeek ? (availableWeeks.find(w => w.weekStart === weekStart) || null) : null;
    const weekRowsExpected = (isWholeWeek && !weekIndex.truncated
        && weekStart >= windowFrom && periodTo <= windowTo)
      ? (indexedWeek ? indexedWeek.rows : 0)
      : null;
    const rowsFetched = (dailyRows || []).length;
    const weekDetailTruncated = weekRowsExpected !== null && rowsFetched < weekRowsExpected;

    const report = buildCostReport({
      employees: employees || [],
      dailyRows: dailyRows || [],
      costClass,
      burden,
      mbfPerHour,
      allocations: allocations.rows,
      minBucketHeadcount,
      standardHours
    });

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        ok: true,
        report,
        // So the page can say WHY a figure is missing, and stop offering a
        // breakdown it would only render as dashes. Not a gate — the gate
        // already happened, above, and the money is already null in `report`.
        disclosure: {
          minBucketHeadcount,
          suppressionLifted: floor === 1,
          tiers: Array.from(tiers)
        },
        availableWeeks,
        // `week` is the Mon-Sun week when one was reported and the range
        // otherwise, so a caller reading .start/.end gets the period either way.
        // `period` says which of the two it was, and what the salaried scaling
        // came to, so the page can show its working.
        week: { start: periodFrom, end: periodTo, dates },
        period: {
          from: periodFrom, to: periodTo,
          isRange: !!range.from,
          days: range.days || dates.length,
          standardHours
        },
        truncated: weekIndex.truncated || weekDetailTruncated,
        dataWindow: {
          from: windowFrom,
          to: windowTo,
          rowsScanned: weekIndex.rows.length,
          rowsAvailable: weekIndex.total,
          weekIndexTruncated: weekIndex.truncated,
          weekRowsExpected,
          weekRowsFetched: rowsFetched,
          weekDetailTruncated
        },
        allocations: {
          available: allocations.available,
          count: allocations.rows.length,
          note: allocations.note
        }
      })
    };

  } catch (err) {
    console.error('Cost report error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
