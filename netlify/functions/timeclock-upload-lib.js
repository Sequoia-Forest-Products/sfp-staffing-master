// Manual timeclock uploads: the decisions, with no network, no database and no
// clock of its own (today is always an argument).
//
// BBSI's Work Summary Payroll report has NO DATE in it. The daily and weekly
// versions carry the same nine columns, so the only thing that tells them apart
// is the period they cover — and a file cannot say what that is. The email
// importer guessed it from the arrival time, and stored two Monday weekly files
// as single days (11/15, 11/22). Here a person states what every file covers;
// this module only suggests, checks and compares.
//
//   suggestDates      a default work date per daily file (file name, else
//                     yesterday; on a Monday, Fri/Sat/Sun)
//   weeklyLook        does a file uploaded as a DAILY look like a weekly one?
//   compareWeek       the weekly file against the sum of the daily rows
//   nextWeekStatus    open / reconciled / accepted after a comparison
//
// Every threshold lives in timeclock-config.js.

const { DAILY_GUARD, WEEKLY_UPLOAD } = require('./timeclock-config');
const { normalizeEmpNumber, round2 } = require('./payroll-lib');
const { isSalaried, effectiveHourlyRate } = require('./wage-sync');

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const nameOf = r => [r && r.first_name, r && r.last_name].filter(Boolean).join(' ') || null;

// ---- calendar (ISO strings, UTC arithmetic: no time zone can shift a date) ----

function addDays(iso, n) {
  return new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
}
function isoDow(iso) {
  const d = new Date(iso + 'T00:00:00Z').getUTCDay();
  return d === 0 ? 7 : d;
}
function isIsoDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  const t = Date.parse(s + 'T00:00:00Z');
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}
function weekStartOf(iso) { return addDays(iso, -(isoDow(iso) - 1)); }
function weekDates(weekStart) { return [0, 1, 2, 3, 4, 5, 6].map(i => addDays(weekStart, i)); }
// The most recent Monday–Sunday that has fully ended.
function lastCompletedWeekStart(today) { return addDays(weekStartOf(today), -7); }

// The weekday a day's upload is due: the next weekday. Friday, Saturday and
// Sunday are all due Monday.
function dailyDueDate(workDate) {
  const dow = isoDow(workDate);
  if (dow === 5) return addDays(workDate, 3);
  if (dow === 6) return addDays(workDate, 2);
  return addDays(workDate, 1);
}
// The weekly file for Mon..Sun is due the Wednesday after.
function weeklyDueDate(weekStart) {
  return addDays(weekStart, 7 + (WEEKLY_UPLOAD.dueDayOfWeek - 1));
}

// ---------------------------------------------------------------------------
// 1. A date from the file name
// ---------------------------------------------------------------------------
//
// Only a suggestion: "11-9", "11.09", "11_9_26", "2026-11-09". With no year,
// the most recent such date that is not after today. Anything that is not a
// real calendar date is ignored rather than guessed into one.
function dateFromFileName(fileName, today) {
  const base = String(fileName || '').replace(/\.[a-z0-9]+$/i, '');
  const valid = (y, m, d) => {
    const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    return isIsoDate(iso) ? iso : null;
  };

  let m = /(?<!\d)(20\d{2})[-_. ](\d{1,2})[-_. ](\d{1,2})(?!\d)/.exec(base);
  if (m) return valid(+m[1], +m[2], +m[3]);

  m = /(?<!\d)(\d{1,2})[-_.](\d{1,2})(?:[-_.](\d{4}|\d{2}))?(?!\d)/.exec(base);
  if (!m) return null;
  const month = +m[1], day = +m[2];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (m[3]) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return valid(y, month, day);
  }
  const year = +String(today).slice(0, 4);
  const thisYear = valid(year, month, day);
  if (thisYear && (!today || thisYear <= today)) return thisYear;
  return valid(year - 1, month, day);
}

// One suggestion per file, in the order given. A date in the file name wins;
// otherwise yesterday — except on a Monday, when the files without one take
// Friday, Saturday and Sunday in turn (Monday's upload covers all three).
function suggestDates(fileNames, today) {
  const dow = isoDow(today);
  const defaults = dow === 1
    ? [addDays(today, -3), addDays(today, -2), addDays(today, -1)]
    : [addDays(today, -1)];
  const named = (fileNames || []).map(n => dateFromFileName(n, today));
  const taken = new Set(named.filter(Boolean));
  const queue = defaults.filter(d => !taken.has(d));

  return (fileNames || []).map((fileName, i) => {
    if (named[i]) return { fileName, workDate: named[i], source: 'filename', fileNameDate: named[i] };
    const next = queue.length ? queue.shift() : addDays(today, -1);
    return { fileName, workDate: next, source: 'default', fileNameDate: null };
  });
}

// ---------------------------------------------------------------------------
// 2. A weekly file uploaded as a daily
// ---------------------------------------------------------------------------
//
// rows / salariedRows are buildImport's output. trailingDayTotals is the total
// counted hours of each recent day (daily_hours). Either test refuses:
//   * anybody in the file with more than 24 hours, or
//   * the file's total well above the largest recent day.
function weeklyLook({ rows = [], salariedRows = [], trailingDayTotals = [], config = DAILY_GUARD } = {}) {
  const everyone = [...rows, ...salariedRows];
  const overPeople = everyone
    .filter(r => num(r.total_hours) > config.maxPersonHours)
    .map(r => ({ employeeNumber: r.employee_number, name: nameOf(r), totalHours: round2(num(r.total_hours)) }))
    .sort((a, b) => b.totalHours - a.totalHours);

  const fileTotal = round2(rows.reduce((s, r) => s + num(r.total_hours), 0));
  const maxDay = trailingDayTotals.reduce((m, t) => Math.max(m, num(t)), 0);
  const limit = maxDay >= 100 ? round2(maxDay * config.totalMultiple) : config.fallbackMaxTotal;
  const totalTooHigh = fileTotal > limit;

  const reasons = [];
  if (overPeople.length) {
    reasons.push(`${overPeople.length} ${overPeople.length === 1 ? 'person has' : 'people have'} more than ` +
      `${config.maxPersonHours} hours (highest: ${overPeople[0].name || '#' + overPeople[0].employeeNumber}, ` +
      `${overPeople[0].totalHours}).`);
  }
  if (totalTooHigh) {
    reasons.push(`The file totals ${fileTotal} hours; no recent day is above ${round2(maxDay || 0)}` +
      ` (limit ${limit}).`);
  }
  return { blocked: reasons.length > 0, overPeople, fileTotal, maxDay: round2(maxDay), limit, reasons };
}

// ---------------------------------------------------------------------------
// 3. The weekly file against the daily rows
// ---------------------------------------------------------------------------
//
// Who is compared: everyone the daily data would COUNT — hourly people on the
// roster, plus numbers the roster does not know yet (their daily rows are held
// as 'unknown', and they are owed the same check). Salaried staff (by the file
// or the roster) and BBSI staff are left out on both sides.
//
// Dollars are priced the way the cost report prices them: the roster's rate,
// overtime at 1.5x (a week total cannot say which OT hours were double time).
// A person with no roster rate falls back to the file's pay rate; with neither,
// dollars are null.
function compareWeek({
  weekStart, weeklyRows = [], dailyRows = [], heldRows = [], employees = [], exclusions = [],
  uploadedDates = [], tolerance = WEEKLY_UPLOAD.toleranceHours
} = {}) {
  const dates = weekDates(weekStart);
  const inWeek = d => dates.includes(String(d).slice(0, 10));
  const roster = new Map();
  for (const e of employees) {
    const k = normalizeEmpNumber(e && e.employee_number);
    if (k && !roster.has(k)) roster.set(k, e);
  }
  const excluded = new Set(exclusions.map(x => normalizeEmpNumber(x.employee_number)));
  const uploaded = new Set(uploadedDates.map(d => String(d).slice(0, 10)));

  const people = new Map();
  const person = (key, src) => {
    if (!people.has(key)) {
      people.set(key, {
        employeeNumber: key, name: nameOf(src), filePayRate: null,
        weekly: null, daily: { regular: 0, ot: 0, total: 0 },
        byDay: Object.fromEntries(dates.map(d => [d, null]))
      });
    }
    const p = people.get(key);
    if (!p.name) p.name = nameOf(src);
    return p;
  };
  const eligible = (key, fileSaysSalaried) => {
    if (!key || excluded.has(key) || fileSaysSalaried) return false;
    const emp = roster.get(key);
    return !(emp && isSalaried(emp));
  };

  for (const r of weeklyRows) {
    const key = normalizeEmpNumber(r.employee_number);
    if (!eligible(key, !!r.is_salary)) continue;
    const p = person(key, r);
    p.weekly = p.weekly || { regular: 0, ot: 0, total: 0 };
    p.weekly.regular = round2(p.weekly.regular + num(r.regular_hours));
    p.weekly.ot = round2(p.weekly.ot + num(r.ot_hours));
    p.weekly.total = round2(p.weekly.total + num(r.total_hours));
    if (r.pay_rate != null && num(r.pay_rate) > 0) p.filePayRate = num(r.pay_rate);
  }

  const addDaily = r => {
    const date = String(r.work_date).slice(0, 10);
    if (!inWeek(date)) return;
    const key = normalizeEmpNumber(r.employee_number);
    if (!eligible(key, false)) return;
    const p = person(key, r);
    p.daily.regular = round2(p.daily.regular + num(r.regular_hours));
    p.daily.ot = round2(p.daily.ot + num(r.ot_hours));
    p.daily.total = round2(p.daily.total + num(r.total_hours));
    p.byDay[date] = round2((p.byDay[date] || 0) + num(r.total_hours));
  };
  dailyRows.forEach(addDaily);
  heldRows.filter(h => h.reason === 'unknown').forEach(addDaily);

  const list = [];
  for (const p of people.values()) {
    const w = p.weekly || { regular: 0, ot: 0, total: 0 };
    const diff = {
      regular: round2(w.regular - p.daily.regular),
      ot: round2(w.ot - p.daily.ot),
      total: round2(w.total - p.daily.total)
    };
    const matched = Math.abs(diff.regular) <= tolerance && Math.abs(diff.ot) <= tolerance &&
      Math.abs(diff.total) <= tolerance;
    const emp = roster.get(p.employeeNumber) || null;
    const rosterRate = emp ? effectiveHourlyRate(emp).rate : null;
    const rate = rosterRate != null ? rosterRate : p.filePayRate;
    const dollars = rate == null ? null : round2(rate * diff.regular + rate * 1.5 * diff.ot);
    // Where to look in TimeNet: the days this person shows no hours.
    const zeroDays = dates
      .filter(d => !(p.byDay[d] > 0))
      .map(d => ({ date: d, state: !uploaded.has(d) ? 'not_uploaded' : p.byDay[d] === 0 ? 'zero' : 'none' }));
    list.push({
      employeeNumber: p.employeeNumber,
      name: p.name || (emp && emp.name) || null,
      onRoster: !!emp,
      inWeeklyFile: !!p.weekly,
      weekly: w,
      daily: p.daily,
      diff,
      dollarsDiff: dollars,
      rate,
      matched,
      byDay: p.byDay,
      zeroDays
    });
  }
  list.sort((a, b) => Math.abs(b.diff.total) - Math.abs(a.diff.total) ||
    String(a.name || '').localeCompare(String(b.name || '')));

  const variances = list.filter(p => !p.matched);
  const sum = (arr, f) => round2(arr.reduce((s, x) => s + num(f(x)), 0));
  return {
    weekStart,
    weekEnd: dates[6],
    dates,
    daysNotUploaded: dates.filter(d => !uploaded.has(d)),
    people: list,
    variances,
    matched: variances.length === 0,
    totals: {
      people: list.length,
      varianceCount: variances.length,
      weeklyHours: sum(list, p => p.weekly.total),
      dailyHours: sum(list, p => p.daily.total),
      hoursDiff: sum(variances, p => p.diff.total),
      dollarsDiff: sum(variances, p => p.dollarsDiff || 0),
      absHoursOff: sum(variances, p => Math.abs(p.diff.total))
    }
  };
}

// The variances a person accepted, reduced to what has to stay the same for
// the acceptance to still stand.
function varianceSignature(variances) {
  return (variances || [])
    .map(v => [v.employeeNumber, round2(v.diff && v.diff.regular), round2(v.diff && v.diff.ot),
      round2(v.diff && v.diff.total)].join(':'))
    .sort()
    .join('|');
}

// Reconciled when everyone matches. Accepted stays accepted only while the
// variances are exactly the ones that were accepted; any change re-opens it.
function nextWeekStatus({ week, comparison }) {
  if (comparison && comparison.matched) return 'reconciled';
  if (week && week.status === 'accepted' &&
      varianceSignature(week.accepted_variances) === varianceSignature(comparison && comparison.variances)) {
    return 'accepted';
  }
  return 'open';
}

module.exports = {
  addDays,
  isoDow,
  isIsoDate,
  weekStartOf,
  weekDates,
  lastCompletedWeekStart,
  dailyDueDate,
  weeklyDueDate,
  dateFromFileName,
  suggestDates,
  weeklyLook,
  compareWeek,
  varianceSignature,
  nextWeekStatus
};
