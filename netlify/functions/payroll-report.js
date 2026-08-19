// GET /api/payroll-report — the weekly overtime report.
//
//   ?week=YYYY-MM-DD   any date inside the wanted week (it is snapped to the
//                      Monday). Omitted => the most recent week that has data,
//                      and the current week when there is none at all.
//
// Response: { ok: true, report, availableWeeks: [...] }
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

// availableWeeks is derived in JS from one bounded fetch rather than scanning the
// whole table. ~57 weeks of history is plenty for a week picker and keeps the
// request to a single round trip that also serves the selected week's rows.
const WINDOW_DAYS = 400;

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
    // current week's Sunday — so every week it reports is a complete week and
    // the selected week's rows are already in hand.
    const windowFrom = weekStartFor(shiftDays(today, -WINDOW_DAYS));
    const windowTo   = weekDates(today)[6];

    const windowRows     = await payrollDb.fetchDailyHours(windowFrom, windowTo) || [];
    const availableWeeks = summarizeWeeks(windowRows);

    // No ?week=: the most recent week that actually has data, and failing that
    // the current week (which then reports honestly as having nothing in it).
    const weekStart = requestedWeek
      || (availableWeeks.length ? availableWeeks[0].weekStart : weekStartFor(today));

    const dates = weekDates(weekStart);

    // Inside the window the rows are already loaded; an explicit ?week= outside
    // it (deep history) costs one extra targeted fetch.
    const dailyRows = (weekStart >= windowFrom && dates[6] <= windowTo)
      ? windowRows.filter(r => {
          const d = dateOnly(r.work_date);
          return d && d >= dates[0] && d <= dates[6];
        })
      : (await payrollDb.fetchDailyHours(dates[0], dates[6]) || []);

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

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, report, availableWeeks }) };

  } catch (err) {
    console.error('Payroll report error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
