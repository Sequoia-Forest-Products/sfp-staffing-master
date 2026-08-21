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

// The payroll vendor sends at ~6:04 AM Pacific, so Pacific is the clock that
// decides what "today" means here. birthday-lib.js deliberately uses
// America/Boise for the mill's own clock — these are two different questions.
const TIME_ZONE = process.env.PAYROLL_TIME_ZONE || 'America/Los_Angeles';

// availableWeeks is derived in JS from a bounded window rather than by scanning
// the whole table. ~57 weeks of history is plenty for a week picker.
const WINDOW_DAYS = 400;

// Page size for the window scan, and the ceiling on how many pages it will walk
// before it gives up and says so. 40 pages covers 200,000 rows outright, and
// still covers 40,000 against a project that caps responses at 1,000 rows.
const WEEK_INDEX_PAGE_SIZE = 5000;
const WEEK_INDEX_MAX_PAGES = 40;

const DAY_MS = 86400000;

// ---- calendar helpers -------------------------------------------------
// Same rule as ot-report-lib.js: split the string and use Date.UTC, never
// `new Date('2026-08-19')`, which is UTC midnight and reads back as Aug 18 in
// any negative-offset zone — including the one this report is scored in.

function pad2(n) { return String(n).padStart(2, '0'); }

function dateToUTC(value) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(value == null ? '' : value).trim());
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
}

function utcToDateStr(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function dateOnly(value) {
  const ms = dateToUTC(value);
  return ms === null ? null : utcToDateStr(ms);
}

function shiftDays(dateStr, days) {
  return utcToDateStr(dateToUTC(dateStr) + days * DAY_MS);
}

// Today's calendar date in the payroll zone, regardless of where Netlify runs
// this. Built from Intl parts so it is a literal calendar date, not an instant.
function todayInZone(now = new Date(), timeZone = TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

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

function round2(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  const r = (Math.round(Math.abs(v) * 100 + Number.EPSILON) / 100) * Math.sign(v);
  return r === 0 ? 0 : r;
}

function num(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// ---- the week index ---------------------------------------------------
//
// The window scan asks payroll-db for a narrow, ordered, counted page —
// fetchDailyHoursIndex is where the projection, `order=work_date.desc` and
// `Prefer: count=exact` live, and why each of the three matters. What is left
// here is the only part that is this function's business: how many pages it is
// willing to walk, and what it is willing to call complete.
//
// Completeness is only ever claimed, never assumed: the flag goes straight out
// to the client so the UI can say the list may be incomplete.

// Pages the window until it can show it is complete: either the exact count says
// so, or an empty page proves the offset ran past the end. Anything else — the
// page ceiling, or a count that insists there is more than paging can reach —
// comes back as truncated rather than as a shorter answer that looks whole.
async function fetchWeekIndex(fromDate, toDate) {
  const rows = [];
  let total = null;
  let complete = false;

  for (let page = 0; page < WEEK_INDEX_MAX_PAGES; page++) {
    // The offset is the number of rows already held, never page * pageSize: a
    // server-side row cap hands back fewer rows than were asked for, and
    // stepping by the requested size would skip everything the cap withheld.
    const result = await payrollDb.fetchDailyHoursIndex(fromDate, toDate, {
      offset: rows.length,
      limit: WEEK_INDEX_PAGE_SIZE
    });
    if (result.total !== null) total = result.total;

    if (!result.rows.length) {
      // Nothing left to read. When the count disagrees with that, believe the
      // count and report the shortfall — the rows we are missing are exactly
      // the ones a silent cap would have taken.
      complete = (total === null || rows.length >= total);
      break;
    }

    rows.push(...result.rows);
    if (total !== null && rows.length >= total) { complete = true; break; }
  }

  return { rows, total, truncated: !complete };
}

// Every week in the window that has at least one daily_hours row, newest first —
// which is also why picking availableWeeks[0] gives "the most recent week with
// data". Weeks with no rows are simply absent; the picker should not offer them.
function summarizeWeeks(rows) {
  const weeks = new Map();

  for (const row of rows) {
    const date = dateOnly(row.work_date);
    if (!date) continue;
    const weekStart = weekStartFor(date);
    const week = weeks.get(weekStart) || {
      weekStart,
      weekEnd: weekDates(weekStart)[6],
      dates: new Set(),
      rows: 0,
      totalHours: 0,
      totalEarnings: 0
    };
    week.dates.add(date);
    week.rows += 1;
    week.totalHours += num(row.total_hours);
    week.totalEarnings += num(row.total_earnings);
    weeks.set(weekStart, week);
  }

  return [...weeks.values()]
    .sort((a, b) => (a.weekStart < b.weekStart ? 1 : a.weekStart > b.weekStart ? -1 : 0))
    .map(w => ({
      weekStart: w.weekStart,
      weekEnd: w.weekEnd,
      days: w.dates.size,
      rows: w.rows,
      totalHours: round2(w.totalHours),
      totalEarnings: round2(w.totalEarnings)
    }));
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
    const today   = todayInZone();

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

    // The window is snapped to whole weeks — back to a Monday, forward to the
    // current week's Sunday — so every week it reports is a complete week.
    const windowFrom = weekStartFor(shiftDays(today, -WINDOW_DAYS));
    const windowTo   = weekDates(today)[6];

    const weekIndex      = await fetchWeekIndex(windowFrom, windowTo);
    const availableWeeks = summarizeWeeks(weekIndex.rows);

    // No ?week=: the most recent week that actually has data, and failing that
    // the current week (which then reports honestly as having nothing in it).
    const weekStart = requestedWeek
      || (availableWeeks.length ? availableWeeks[0].weekStart : weekStartFor(today));

    const dates = weekDates(weekStart);

    // The seven days being reported are always fetched in full and on their
    // own. They are what every number on the page is built from, so they get
    // every column and their own bounded query — ~60 people across 7 days,
    // small enough that no row cap can reach it — rather than being sifted out
    // of the deliberately narrow window scan.
    const dailyRows = await payrollDb.fetchDailyHours(dates[0], dates[6]) || [];

    // ...and then cross-checked against the window scan, which counted the same
    // rows a second, cheaper way. If the detail fetch came back with fewer rows
    // than the index says exist for these seven days, something dropped rows
    // and every total below is understated. Only meaningful when the index is
    // itself complete and the week sits inside the window; otherwise there is
    // nothing to compare against and the answer is an honest null.
    const indexedWeek = availableWeeks.find(w => w.weekStart === weekStart) || null;
    const weekRowsExpected = (!weekIndex.truncated && weekStart >= windowFrom && dates[6] <= windowTo)
      ? (indexedWeek ? indexedWeek.rows : 0)
      : null;
    const weekDetailTruncated = weekRowsExpected !== null && dailyRows.length < weekRowsExpected;

    const [overtimeRows, employees, graceHoursPerEmployee] = await Promise.all([
      payrollDb.fetchOvertime(),
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
      overtimeRows: overtimeRows || [],
      employees: employees || [],
      expectedDays,
      graceHoursPerEmployee
    });

    // `truncated` is the one flag the page needs to decide whether to show a
    // "this may be incomplete" banner; dataWindow carries the numbers behind it
    // so the banner can say which half is short and by how much.
    const dataWindow = {
      from: windowFrom,
      to: windowTo,
      rowsScanned: weekIndex.rows.length,
      rowsAvailable: weekIndex.total,        // null when the count could not be read
      weekIndexTruncated: weekIndex.truncated,
      weekRowsExpected,                      // null when there is nothing to compare against
      weekRowsFetched: dailyRows.length,
      weekDetailTruncated
    };

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        ok: true,
        report,
        availableWeeks,
        truncated: weekIndex.truncated || weekDetailTruncated,
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
