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

const { createHmac } = require('crypto');
const payrollDb = require('./payroll-db');
const { weekStartFor, weekDates, buildReport } = require('./ot-report-lib');

const SESSION_SECRET = process.env.SESSION_SECRET;

// The payroll vendor sends at ~6:04 AM Pacific, so Pacific is the clock that
// decides what "today" means here. birthday-lib.js deliberately uses
// America/Boise for the mill's own clock — these are two different questions.
const TIME_ZONE = process.env.PAYROLL_TIME_ZONE || 'America/Los_Angeles';

// availableWeeks is derived in JS from a bounded window rather than by scanning
// the whole table. ~57 weeks of history is plenty for a week picker.
const WINDOW_DAYS = 400;

// The three columns availableWeeks is built from. The window covers ~17,000
// rows at a full mill, and pulling all 23 daily_hours columns for every one of
// them just to list the weeks that have data is most of a megabyte of payroll
// detail nobody reads.
const WEEK_INDEX_COLUMNS = 'work_date,total_hours,total_earnings';

// Page size for the window scan, and the ceiling on how many pages it will walk
// before it gives up and says so. 40 pages covers 200,000 rows outright, and
// still covers 40,000 against a project that caps responses at 1,000 rows.
const WEEK_INDEX_PAGE_SIZE = 5000;
const WEEK_INDEX_MAX_PAGES = 40;

const DAY_MS = 86400000;

function verifySession(token) {
  try {
    const [b64, sig] = token.split('.');
    const expected = createHmac('sha256', SESSION_SECRET).update(b64).digest('base64url');
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

function getCookies(event) {
  return Object.fromEntries(
    (event.headers.cookie || '').split(';').map(c => {
      const [k, ...v] = c.trim().split('=');
      return [k, v.join('=')];
    })
  );
}

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

function isoDow(dateStr) {
  const day = new Date(dateToUTC(dateStr)).getUTCDay();
  return day === 0 ? 7 : day;
}

// Today's calendar date in the payroll zone, regardless of where Netlify runs
// this. Built from Intl parts so it is a literal calendar date, not an instant.
function todayInZone(now = new Date(), timeZone = TIME_ZONE) {
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

// ---- the week index ---------------------------------------------------
//
// The one query in this file that talks to PostgREST directly instead of going
// through payroll-db.js. Its helpers return whole rows, send no limit and never
// read Content-Range, and this is the query that has to PROVE it saw everything:
//
//   * `Prefer: count=exact` makes PostgREST report the true number of matching
//     rows in Content-Range ("0-4999/17384"), so what arrived can be compared
//     against what exists instead of trusted.
//   * `order=work_date.desc` decides which end survives if something does cut
//     the result short. Ordered ascending — the way fetchDailyHours orders it —
//     a db-max-rows cap silently drops the NEWEST rows, availableWeeks loses the
//     current week, and the report quietly defaults to a stale one while still
//     answering ok:true. A missing current week is worse than a loud error.
//
// Completeness is only ever claimed, never assumed: the caller passes the flag
// straight out to the client so the UI can say the list may be incomplete.

function weekIndexHeaders() {
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!process.env.SUPABASE_URL || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  }
  // The same headers db.js and payroll-db.js send, except that a read asks for
  // the count rather than for a representation of a write.
  return {
    'Content-Type': 'application/json',
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Prefer': 'count=exact'
  };
}

// "0-4999/17384" -> 17384. A "*" total (the count was not computed) and a
// missing header both read as null, which means "not proven", never "zero".
function parseContentRangeTotal(header) {
  const m = /\/(\d+|\*)\s*$/.exec(String(header == null ? '' : header));
  if (!m || m[1] === '*') return null;
  return Number(m[1]);
}

async function fetchWeekIndexPage(fromDate, toDate, offset, limit) {
  const path = `daily_hours?select=${WEEK_INDEX_COLUMNS}` +
    `&work_date=gte.${encodeURIComponent(fromDate)}` +
    `&work_date=lte.${encodeURIComponent(toDate)}` +
    `&order=work_date.desc&offset=${offset}&limit=${limit}`;

  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    method: 'GET',
    headers: weekIndexHeaders()
  });
  if (!res.ok) throw new Error(`GET ${path} ${res.status}: ${await res.text()}`);

  const text = await res.text();
  const body = text ? JSON.parse(text) : [];
  return {
    rows: Array.isArray(body) ? body : [],
    total: parseContentRangeTotal(res.headers && res.headers.get('content-range'))
  };
}

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
    const result = await fetchWeekIndexPage(fromDate, toDate, rows.length, WEEK_INDEX_PAGE_SIZE);
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

    const [overtimeRows, employees] = await Promise.all([
      payrollDb.fetchOvertime(),
      payrollDb.fetchEmployees()
    ]);

    // A delivery is only "expected" for a scheduled day that has already
    // happened. Flagging tomorrow's Thursday as a missed delivery on Tuesday
    // would cry wolf, and the report is meant to be trusted when it does say a
    // day is missing.
    const expectedDays = dates.filter(d => isoDow(d) <= 4 && d < today);

    const report = buildReport({
      weekStart,
      dailyRows,
      overtimeRows: overtimeRows || [],
      employees: employees || [],
      expectedDays
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
