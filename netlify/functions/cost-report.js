// GET /api/cost-report — aggregated labour cost for one cost class.
//
//   ?class=Manufacturing|Mill Overhead|SG&A   default Manufacturing
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
// There is still no permissions system, so anything here is readable by every
// signed-in sequoiafp.com account. cost-lib.js suppresses money for any grouping
// small enough that its average IS somebody's rate; see the note there.

const payrollDb = require('./payroll-db');
const { weekStartFor, weekDates } = require('./ot-report-lib');
const { verifySession, getCookies } = require('./session-lib');
const {
  fetchWeekIndex, summarizeWeeks, todayInZone, shiftDays, WINDOW_DAYS
} = require('./week-index-lib');
const { buildCostReport, COST_CLASSES, DEFAULT_MIN_BUCKET } = require('./cost-lib');

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
  if (!COST_CLASSES.includes(costClass)) {
    return {
      statusCode: 400, headers,
      body: JSON.stringify({
        ok: false,
        error: `Unknown cost class "${costClass}" — expected one of ${COST_CLASSES.join(', ')}`
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
  // only upward from the default. A caller must not be able to talk the endpoint
  // into publishing a one-person bucket by asking for minBucket=1.
  const requestedMin = parseDecimal(params.minBucket, { min: 1, max: 100, fallback: DEFAULT_MIN_BUCKET });
  const minBucketHeadcount = requestedMin === null
    ? DEFAULT_MIN_BUCKET
    : Math.max(DEFAULT_MIN_BUCKET, Math.floor(requestedMin));

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

    const [dailyRows, employees, allocations] = await Promise.all([
      payrollDb.fetchDailyHours(dates[0], dates[6]),
      payrollDb.fetchEmployees(),
      loadAllocations()
    ]);

    // Cross-check the detail fetch against the window scan, which counted the
    // same rows a cheaper way. Fewer rows than the index says exist means
    // something dropped rows and every hours figure below is understated.
    const indexedWeek = availableWeeks.find(w => w.weekStart === weekStart) || null;
    const weekRowsExpected = (!weekIndex.truncated && weekStart >= windowFrom && dates[6] <= windowTo)
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
      minBucketHeadcount
    });

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        ok: true,
        report,
        availableWeeks,
        week: { start: weekStart, end: dates[6], dates },
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
