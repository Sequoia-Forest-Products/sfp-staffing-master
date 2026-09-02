// GET /api/payroll-report — the weekly overtime report.
//
//   ?week=YYYY-MM-DD   any date inside the wanted week (it is snapped to the
//                      Monday). Omitted => the most recent week that has data,
//                      and the current week when there is none at all.
//
// Response: { ok: true, report, availableWeeks: [...], truncated, dataWindow }
//
// This function only fetches and shapes. Every number in `report` comes out of
// ot-report-lib.js, which is pure, so the arithmetic is tested without a network
// or a database anywhere near it.

const db = require('./db');
const payrollDb = require('./payroll-db');
const { weekStartFor, weekDates, buildReport, DEFAULT_GRACE_HOURS } = require('./ot-report-lib');
const { verifySession, getCookies } = require('./session-lib');
const {
  fetchWeekIndex, summarizeWeeks, todayInZone, shiftDays, WINDOW_DAYS
} = require('./week-index-lib');

// The payroll vendor sends at ~6:04 AM Pacific, so Pacific is the clock that
// decides what "today" means here. birthday-lib.js deliberately uses
// America/Boise for the mill's own clock — these are two different questions.
const TIME_ZONE = process.env.PAYROLL_TIME_ZONE || 'America/Los_Angeles';

// The bounded window, the paging and the week summary all live in
// week-index-lib.js now — the cost report needs exactly the same week picker,
// and two endpoints deriving "the weeks you can ask about" separately is how
// they end up offering different weeks.

// ---- the timeclock grace allowance ------------------------------------
//
// How much grace time each active hourly employee is allowed per week is a
// policy number, not a constant: it changes what managers are told their net OT
// is, so it is read here, server-side, from the same `settings` row (and by the
// same mechanism) the OT budget threshold uses. The client never gets a say —
// it can only be told which value was used, via preApproved.grace.
//
// settings.js writes that row two different ways: a raw object when it inserts
// and a JSON string when it updates. Both shapes are real rows in the table, so
// both are read here — send-ot-email.js's managersFromSettingsRow copes with the
// same ambiguity for the manager list.
function graceHoursFromSettingsRow(row) {
  let value = row && row.value;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== 'object') return null;

  // Only a number or a string can be an hours figure. Everything else — null, a
  // nested object, an empty array — is rejected here rather than left to
  // Number(), which reads several of them as a convincing 0 and would switch the
  // policy off on a typo.
  const raw = value.graceHoursPerEmployee;
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  const trimmed = typeof raw === 'string' ? raw.trim() : raw;
  if (trimmed === '') return null;
  const n = Number(trimmed);
  // Zero is a real setting — it switches the allowance off — so this cannot be
  // a truthiness test. Negative, NaN and anything non-numeric are not settings,
  // they are mistakes, and a mistake falls back to the stated default rather
  // than silently reshaping every net OT figure on the page.
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

// A settings table that is missing, unreachable or holding nonsense must not
// take the report down with it: the report is the thing somebody is waiting for,
// and the default is a defensible number to fall back to.
async function loadGraceHours() {
  try {
    const rows = await db.query('settings', '?key=eq.emailSettings');
    const configured = graceHoursFromSettingsRow(rows && rows[0]);
    return configured === null ? DEFAULT_GRACE_HOURS : configured;
  } catch (err) {
    console.error('Grace hours settings read failed, using the default:', err.message);
    return DEFAULT_GRACE_HOURS;
  }
}

// ---- the standing pre-approved allowance ------------------------------
//
// Prefers `preapproved_ot`, which is keyed on employees.id, and falls back to
// the name-keyed `overtime` table when that table does not exist yet.
//
// The fallback is what makes the deploy and the migration order-independent:
// deploy first and the report keeps reading `overtime`; migrate first and the
// old code keeps reading `overtime` too. Either way nobody sees a week with no
// pre-approved OT, which would silently overstate Net OT by the whole allowance.
//
// A missing TABLE falls back. Anything else — auth, a 502, a network drop —
// propagates, because "the database is unreachable" and "the migration has not
// run" produce the same empty array and only one of them is a report worth
// showing.
function isMissingTableError(err) {
  return /\b404\b|PGRST205|could not find the table|does not exist/i.test(
    String((err && err.message) || ''));
}

async function loadStandingAllowance() {
  try {
    const rows = await payrollDb.fetchPreApprovedOt();
    return { rows: rows || [], source: 'preapproved_ot' };
  } catch (err) {
    if (!isMissingTableError(err)) throw err;
    console.warn(
      'preapproved_ot does not exist — run SCHEMA_PHASE_C_PREAPPROVED_OT.sql. ' +
      'Falling back to the name-keyed `overtime` table, so an inactive employee ' +
      `still carries an allowance and a name variant still reports unmatched. (${err.message})`);
    const rows = await payrollDb.fetchOvertime();
    return { rows: rows || [], source: 'overtime' };
  }
}

// ---- the week window and the week itself ------------------------------
//
// Both of these are exported and called by ot-weekly-email-lib.js as well as by
// the handler below. That is the whole point of them being functions: the
// Monday email states figures managers act on, and if it assembled its own week
// from its own inputs it would eventually disagree with the tab the same people
// open to check it. Same window, same fetch, same grace, same allowance, same
// pure buildReport — the only thing the two callers decide separately is WHICH
// week they want.

async function loadWeekWindow(today) {
  // Snapped to whole weeks — back to a Monday, forward to the current week's
  // Sunday — so every week it reports is a complete week.
  const from = weekStartFor(shiftDays(today, -WINDOW_DAYS));
  const to   = weekDates(today)[6];
  const index = await fetchWeekIndex(from, to);
  return {
    from,
    to,
    weeks: summarizeWeeks(index.rows, { weekStartFor, weekDates }),
    rowsScanned: index.rows.length,
    rowsAvailable: index.total,   // null when the count could not be read
    truncated: index.truncated
  };
}

async function buildWeekReport({ weekStart, today, weekWindow }) {
  const dates = weekDates(weekStart);

  // The seven days being reported are always fetched in full and on their
  // own. They are what every number is built from, so they get every column
  // and their own bounded query — ~60 people across 7 days, small enough that
  // no row cap can reach it — rather than being sifted out of the
  // deliberately narrow window scan.
  const dailyRows = await payrollDb.fetchDailyHours(dates[0], dates[6]) || [];

  // ...and then cross-checked against the window scan, which counted the same
  // rows a second, cheaper way. If the detail fetch came back with fewer rows
  // than the index says exist for these seven days, something dropped rows and
  // every total is understated. Only meaningful when the index is itself
  // complete and the week sits inside the window; otherwise there is nothing to
  // compare against and the answer is an honest null.
  const indexedWeek = weekWindow.weeks.find(w => w.weekStart === weekStart) || null;
  const weekRowsExpected = (!weekWindow.truncated && weekStart >= weekWindow.from && dates[6] <= weekWindow.to)
    ? (indexedWeek ? indexedWeek.rows : 0)
    : null;
  const weekDetailTruncated = weekRowsExpected !== null && dailyRows.length < weekRowsExpected;

  const [standing, employees, graceHoursPerEmployee] = await Promise.all([
    loadStandingAllowance(),
    payrollDb.fetchEmployees(),
    loadGraceHours()
  ]);

  // A delivery is expected for every day that has already happened — BBSI
  // sends the report seven days a week, so Saturday is owed one just like
  // Tuesday. The `d < today` half stays: flagging tomorrow as a missed
  // delivery would cry wolf, and the report is meant to be trusted when it
  // does say a day is missing.
  const expectedDays = dates.filter(d => d < today);

  const report = buildReport({
    weekStart,
    dailyRows,
    preApprovedRows: standing.rows,
    employees: employees || [],
    expectedDays,
    graceHoursPerEmployee
  });

  return {
    report,
    // Which table the standing allowance came from. The UI says so when it is
    // still the old one, because "pre-approved OT is not per-employee yet" is
    // not something a reader can otherwise tell from the numbers.
    preApprovedSource: standing.source,
    // dataWindow carries the numbers behind the truncation banner, so it can
    // say which half is short and by how much.
    dataWindow: {
      from: weekWindow.from,
      to: weekWindow.to,
      rowsScanned: weekWindow.rowsScanned,
      rowsAvailable: weekWindow.rowsAvailable,
      weekIndexTruncated: weekWindow.truncated,
      weekRowsExpected,                      // null when there is nothing to compare against
      weekRowsFetched: dailyRows.length,
      weekDetailTruncated
    }
  };
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

  try {
    const params  = event.queryStringParameters || {};
    const today   = todayInZone(new Date(), TIME_ZONE);

    // Validate ?week= before touching the database, so a typo costs nothing.
    const requested = String(params.week || '').trim();
    let requestedWeek = null;
    if (requested) {
      try {
        requestedWeek = weekStartFor(requested);
      } catch {
        return {
          statusCode: 400, headers,
          body: JSON.stringify({ ok: false, error: `Invalid week "${requested}" — expected YYYY-MM-DD` })
        };
      }
    }

    const weekWindow = await loadWeekWindow(today);
    const availableWeeks = weekWindow.weeks;

    // No ?week=: the most recent week that actually has data, and failing that
    // the current week (which then reports honestly as having nothing in it).
    const weekStart = requestedWeek
      || (availableWeeks.length ? availableWeeks[0].weekStart : weekStartFor(today));

    const { report, preApprovedSource, dataWindow } =
      await buildWeekReport({ weekStart, today, weekWindow });

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        ok: true,
        report,
        availableWeeks,
        preApprovedSource,
        // `truncated` is the one flag the page needs to decide whether to show a
        // "this may be incomplete" banner.
        truncated: weekWindow.truncated || dataWindow.weekDetailTruncated,
        dataWindow
      })
    };

  } catch (err) {
    console.error('Payroll report error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};

// Exported so the settings-shape rule can be exercised without a handler around
// it, the way send-ot-email.js exports managersFromSettingsRow.
module.exports.graceHoursFromSettingsRow = graceHoursFromSettingsRow;

// Exported so the Monday manager email assembles its week through exactly this
// code rather than through a second copy of it. See the note above
// loadWeekWindow.
module.exports.loadWeekWindow = loadWeekWindow;
module.exports.buildWeekReport = buildWeekReport;
module.exports.TIME_ZONE = TIME_ZONE;
