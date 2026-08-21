// The week index: which weeks have daily_hours data, and did we see all of them.
//
// Extracted from payroll-report.js when the cost report needed the same week
// picker. Two endpoints deriving "the weeks you can ask about" from the same
// table by two different pieces of code is how they end up offering different
// weeks, and the calendar helpers here are the ones with the sharp edge —
// `new Date('2026-08-19')` is UTC midnight and reads back as Aug 18 in any
// negative-offset zone, including the one this data is scored in.
//
// Nothing here talks to the network directly: it calls payroll-db, which owns
// the projection, the ordering and the exact-count header.

const payrollDb = require('./payroll-db');

const DAY_MS = 86400000;

// ~57 weeks of history is plenty for a week picker.
const WINDOW_DAYS = 400;

// Page size for the window scan, and the ceiling on how many pages it will walk
// before it gives up and says so. 40 pages covers 200,000 rows outright, and
// still covers 40,000 against a project that caps responses at 1,000 rows.
const WEEK_INDEX_PAGE_SIZE = 5000;
const WEEK_INDEX_MAX_PAGES = 40;

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

// Today's calendar date in a named zone, regardless of where Netlify runs this.
// Built from Intl parts so it is a literal calendar date, not an instant.
function todayInZone(now = new Date(), timeZone = 'America/Los_Angeles') {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
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

// Pages the window until it can show it is complete: either the exact count says
// so, or an empty page proves the offset ran past the end. Anything else — the
// page ceiling, or a count that insists there is more than paging can reach —
// comes back as truncated rather than as a shorter answer that looks whole.
//
// Completeness is only ever claimed, never assumed: the flag goes out to the
// client so the UI can say the list may be incomplete.
async function fetchWeekIndex(fromDate, toDate, {
  pageSize = WEEK_INDEX_PAGE_SIZE,
  maxPages = WEEK_INDEX_MAX_PAGES
} = {}) {
  const rows = [];
  let total = null;
  let complete = false;

  for (let page = 0; page < maxPages; page++) {
    // The offset is the number of rows already held, never page * pageSize: a
    // server-side row cap hands back fewer rows than were asked for, and
    // stepping by the requested size would skip everything the cap withheld.
    const result = await payrollDb.fetchDailyHoursIndex(fromDate, toDate, {
      offset: rows.length,
      limit: pageSize
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
//
// weekStartFor / weekDates are passed in rather than imported so this stays a
// pure shaping function and the definition of "a week" lives in one place
// (ot-report-lib.js) rather than being reimplemented here.
function summarizeWeeks(rows, { weekStartFor, weekDates }) {
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

module.exports = {
  fetchWeekIndex,
  summarizeWeeks,
  todayInZone,
  dateOnly,
  shiftDays,
  utcToDateStr,
  dateToUTC,
  round2,
  num,
  pad2,
  DAY_MS,
  WINDOW_DAYS,
  WEEK_INDEX_PAGE_SIZE,
  WEEK_INDEX_MAX_PAGES
};
