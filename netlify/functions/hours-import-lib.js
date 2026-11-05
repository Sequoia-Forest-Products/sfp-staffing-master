// Timeclock imports: who counts, what a dated file says, and what a
// reconciliation changed. Pure — no network, no database, no clock.
//
// WHY THIS EXISTS (2026-11-05). The October payroll reconciliation found the
// daily figures ~$37,600 short over 9/28-10/25. BBSI's answer changes the feed:
//
//   * the DAILY file now covers every Active TimeNet employee, salaried and
//     BBSI staff included — so who counts has to be decided here, by roster;
//   * a WEEKLY file with punch corrections applied arrives every Monday and
//     must overwrite the daily snapshots it covers.
//
// THREE RULES.
//
//   1. WHO COUNTS IS A ROSTER FACT, never a name or a hard-coded list. A row
//      counts toward hours, overtime and cost only when its employee number is
//      on the roster and the roster does not say salaried. Everything else is
//      STORED (daily_hours_held) and never counted:
//        salaried  the roster says Salaried, or the file says Is Salary = Yes
//        external  the number is listed in timeclock_exclusions (BBSI staff)
//        unknown   the roster has never heard of the number -> New employee alert
//      Keeping these out of daily_hours, rather than flagging them inside it,
//      is what keeps every existing reader correct without a new filter.
//
//   2. A DAY IS REPLACED, NEVER MERGED. The database function replace_hours()
//      deletes every covered date and inserts the new rows in one transaction.
//      This module only decides what goes in.
//
//   3. A DATE IS EITHER EXPLICIT OR INFERRED, and only an explicit one may
//      replace a day that already holds another file's rows. The daily file has
//      no date anywhere in it; its date is inferred from when the email arrived.
//      A dated file (one with a per-row date column — the weekly file) and a
//      manual upload with a date a person picked are explicit.

const { buildImport, normalizeEmpNumber, round2 } = require('./payroll-lib');
const { isSalaried, effectiveHourlyRate } = require('./wage-sync');
const { dayPay } = require('./pay-rules-lib');

const textOf = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};
const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

// ---------------------------------------------------------------------------
// 1. Classification
// ---------------------------------------------------------------------------

function rosterIndex(employees) {
  const byNumber = new Map();
  for (const emp of employees || []) {
    const key = normalizeEmpNumber(emp && emp.employee_number);
    if (key && !byNumber.has(key)) byNumber.set(key, emp);
  }
  return byNumber;
}

function exclusionIndex(exclusions) {
  const set = new Set();
  for (const ex of exclusions || []) {
    const key = normalizeEmpNumber(ex && ex.employee_number);
    if (key) set.add(key);
  }
  return set;
}

function heldFrom(row, reason) {
  return {
    work_date: row.work_date,
    employee_number: row.employee_number,
    last_name: row.last_name || null,
    first_name: row.first_name || null,
    is_salary: !!row.is_salary,
    regular_hours: num(row.regular_hours),
    ot_hours: num(row.ot_hours),
    total_hours: num(row.total_hours),
    reason
  };
}

// `rows` and `salariedRows` are buildImport's output. Returns the rows that go
// to daily_hours (counted) and daily_hours_held (held), plus the unknown
// numbers that need a New employee alert.
function classifyRows({ rows = [], salariedRows = [], employees = [], exclusions = [] } = {}) {
  const roster = rosterIndex(employees);
  const excluded = exclusionIndex(exclusions);

  const counted = [];
  const held = [];
  const unknown = new Map();

  const hold = (row, fileSaysSalaried) => {
    const key = normalizeEmpNumber(row.employee_number);
    const emp = roster.get(key) || null;
    if (excluded.has(key)) return held.push(heldFrom(row, 'external'));
    if (fileSaysSalaried || (emp && isSalaried(emp))) return held.push(heldFrom(row, 'salaried'));
    if (!emp) {
      held.push(heldFrom(row, 'unknown'));
      if (!unknown.has(key)) {
        unknown.set(key, {
          employeeNumber: key,
          name: [row.first_name, row.last_name].filter(Boolean).join(' ') || null,
          dates: [],
          hours: 0
        });
      }
      const u = unknown.get(key);
      u.dates.push(row.work_date);
      u.hours = round2(u.hours + num(row.total_hours));
      return;
    }
    // On the roster and not salaried: counted. The unknown_employee flag the
    // parser sets cannot apply here, so it is stripped rather than carried.
    counted.push({
      ...row,
      flags: (Array.isArray(row.flags) ? row.flags : []).filter(f => f !== 'unknown_employee')
    });
  };

  for (const row of rows) hold(row, false);
  for (const row of salariedRows) hold(row, true);

  return { counted, held, unknown: [...unknown.values()] };
}

// ---------------------------------------------------------------------------
// 2. Dated files (the weekly file, and any backfill sent in that format)
// ---------------------------------------------------------------------------
//
// THE WEEKLY FILE'S SHAPE IS NOT YET KNOWN. The first one has not arrived. What
// is known is what it must contain to do its job: it overwrites the daily
// figures for every day it covers, so it has to say WHICH day each row is.
// That means a per-row date column. A file with one is a dated file and is
// imported per day; a file without one is the daily snapshot. Nothing here
// keys on the attachment name or the subject, which BBSI can change freely.
//
// If the first weekly file turns out to carry week totals rather than days, it
// will have no date column, will fail the daily path's date sanity (it covers
// seven days, not one), and is parked for a person — loudly, not imported.

const DATE_HEADERS = ['date', 'work date', 'punch date', 'day', 'work day', 'shift date',
                      'date worked', 'workdate', 'business date'];
const NUMBER_HEADERS = {
  regular: ['regular', 'regular hours', 'reg', 'reg hours', 'regular hrs'],
  ot: ['ot', 'ot hours', 'ot hrs', 'overtime', 'overtime hours'],
  total: ['total hours', 'totalhours', 'total hrs', 'hours']
};
const EMP_HEADERS = ['emp #', 'emp#', 'emp no', 'emp no.', 'emp num', 'emp number', 'employee #',
                     'employee#', 'employee no', 'employee no.', 'employee number', 'employee id'];

const norm = h => String(h ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

function findHeader(headers, aliases) {
  for (const h of headers || []) if (aliases.includes(norm(h))) return h;
  return null;
}

function dateColumnOf(sheet) {
  return findHeader(sheet && sheet.headers, DATE_HEADERS);
}

// Excel serial (days since 1899-12-30), ISO, or US M/D/YYYY. Anything else is
// null — and a null date on a row refuses the whole file, because a weekly file
// that cannot say which day a row is cannot be allowed to replace any day.
function parseCellDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value) && value > 20000 && value < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  const s = String(value).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s.split(/\s+/)[0]);
  if (m) {
    const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return `${year}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
  }
  if (/^\d+(\.\d+)?$/.test(s)) return parseCellDate(Number(s));
  return null;
}

function eachDate(from, to) {
  const out = [];
  let cur = Date.parse(from + 'T00:00:00Z');
  const end = Date.parse(to + 'T00:00:00Z');
  for (let guard = 0; cur <= end && guard < 400; guard++, cur += 86400000) {
    out.push(new Date(cur).toISOString().slice(0, 10));
  }
  return out;
}

// Parse a dated file into one buildImport() result per day, plus the full
// range it covers. The range is from the first date to the last date in the
// file, every day in between included: a day inside the week with no rows is a
// day the corrected file says nobody worked, and the replace must empty it.
function buildDatedImport({ fileBuffer, sheet, employees, source, sourceSubject, emailReceivedAt,
                            timeZone, uploadBatchId } = {}) {
  let parsed = sheet;
  if (!parsed) {
    const { readSheet } = require('./xlsx-lite');
    parsed = readSheet(fileBuffer);
  }
  const dateCol = dateColumnOf(parsed);
  if (!dateCol) throw new Error('This file has no per-row date column, so it is not a dated (weekly) file.');

  const empCol = findHeader(parsed.headers, EMP_HEADERS);
  const regCol = findHeader(parsed.headers, NUMBER_HEADERS.regular);
  const otCol = findHeader(parsed.headers, NUMBER_HEADERS.ot);
  const totCol = findHeader(parsed.headers, NUMBER_HEADERS.total);

  // One row per (date, employee). A weekly export may list a person's day as
  // several punch rows; those are summed rather than refused as duplicates.
  const byDate = new Map();
  const badDates = [];
  let rowIndex = 0;
  for (const record of parsed.rows || []) {
    rowIndex++;
    const date = parseCellDate(record[dateCol]);
    if (!date) {
      // A totals or blank row at the foot of an export carries no employee.
      if (!empCol || !textOf(record[empCol])) continue;
      badDates.push({ row: rowIndex, value: record[dateCol] });
      continue;
    }
    if (!byDate.has(date)) byDate.set(date, new Map());
    const day = byDate.get(date);
    const key = empCol ? normalizeEmpNumber(record[empCol]) || `row${rowIndex}` : `row${rowIndex}`;
    if (!day.has(key)) { day.set(key, { ...record }); continue; }
    const acc = day.get(key);
    for (const col of [regCol, otCol, totCol]) {
      if (col) acc[col] = round2(num(acc[col]) + num(record[col]));
    }
  }

  if (badDates.length) {
    throw new Error(
      `${badDates.length} row(s) have a date this import cannot read ` +
      `(first: row ${badDates[0].row}, ${JSON.stringify(badDates[0].value)}). Nothing imported.`
    );
  }
  if (!byDate.size) throw new Error('The dated file has no rows with a date. Nothing imported.');

  const dates = [...byDate.keys()].sort();
  const range = eachDate(dates[0], dates[dates.length - 1]);
  const headers = (parsed.headers || []).filter(h => h !== dateCol);
  // The daily file says Is Salary; a weekly export may not. The roster decides
  // salaried either way (rule 1), so an absent column reads as "No" rather
  // than refusing a file over a fact this import does not need from it.
  const salaryCol = findHeader(headers, ['is salary', 'issalary', 'salary', 'salaried', 'is salaried']);
  if (!salaryCol) headers.push('Is Salary');

  const days = range.map(date => {
    const rows = [...(byDate.get(date) || new Map()).values()]
      .map(r => (salaryCol ? r : { ...r, 'Is Salary': 'No' }));
    return buildImport({
      sheet: { sheetName: parsed.sheetName, headers, rows },
      workDate: date,
      employees,
      source,
      sourceSubject,
      emailReceivedAt,
      dateSource: 'file',
      uploadBatchId,
      timeZone
    });
  });

  return { from: range[0], to: range[range.length - 1], dates: range, days };
}

// ---------------------------------------------------------------------------
// 3. Variance: what a reconciliation changed
// ---------------------------------------------------------------------------
//
// Dollars use the SAME pricing as the cost report and the OT report: the
// roster's rate, overtime tiered by pay-rules-lib. PR #59 settled that rule and
// this does not restate it. A person with no rate contributes hours to the
// variance and null dollars, and is counted in ratesMissing rather than as $0.

function rowKey(r) { return `${String(r.work_date).slice(0, 10)}|${normalizeEmpNumber(r.employee_number)}`; }

function computeVariance({ before = [], after = [], employees = [], dates = [] } = {}) {
  const roster = rosterIndex(employees);
  const rateOf = (empNum) => {
    const emp = roster.get(normalizeEmpNumber(empNum));
    return emp ? effectiveHourlyRate(emp).rate : null;
  };
  const price = (r) => {
    const rate = rateOf(r.employee_number);
    return dayPay(num(r.regular_hours), num(r.ot_hours), rate).earnings;
  };

  const oldBy = new Map(before.map(r => [rowKey(r), r]));
  const newBy = new Map(after.map(r => [rowKey(r), r]));
  const keys = [...new Set([...oldBy.keys(), ...newBy.keys()])].sort();

  const perDay = new Map(dates.map(d => [d, { date: d, hoursBefore: 0, hoursAfter: 0,
    dollarsBefore: 0, dollarsAfter: 0, rowsBefore: 0, rowsAfter: 0 }]));
  const perEmployee = [];
  const fixedPunches = [];
  const ratesMissing = new Set();

  for (const key of keys) {
    const [date, empNum] = key.split('|');
    const o = oldBy.get(key) || null;
    const n = newBy.get(key) || null;
    if (!perDay.has(date)) perDay.set(date, { date, hoursBefore: 0, hoursAfter: 0,
      dollarsBefore: 0, dollarsAfter: 0, rowsBefore: 0, rowsAfter: 0 });
    const day = perDay.get(date);

    const hb = o ? num(o.total_hours) : 0;
    const ha = n ? num(n.total_hours) : 0;
    const db = o ? price(o) : 0;
    const da = n ? price(n) : 0;
    if ((o && db === null) || (n && da === null)) ratesMissing.add(empNum);

    day.hoursBefore = round2(day.hoursBefore + hb);
    day.hoursAfter = round2(day.hoursAfter + ha);
    day.dollarsBefore = round2(day.dollarsBefore + (db || 0));
    day.dollarsAfter = round2(day.dollarsAfter + (da || 0));
    if (o) day.rowsBefore++;
    if (n) day.rowsAfter++;

    if (round2(ha - hb) !== 0) {
      const src = n || o;
      perEmployee.push({
        date, employeeNumber: empNum,
        name: [src.first_name, src.last_name].filter(Boolean).join(' ') || null,
        hoursBefore: hb, hoursAfter: ha, hoursChange: round2(ha - hb),
        dollarsChange: (db === null || da === null) ? null : round2((da || 0) - (db || 0)),
        wasMissing: !o
      });
    }
    // A fixed punch: the snapshot said 0.00 (or had no row) and the corrected
    // file says the person worked.
    if (ha > 0 && (!o || hb === 0)) {
      fixedPunches.push({ date, employeeNumber: empNum,
        name: [n.first_name, n.last_name].filter(Boolean).join(' ') || null,
        hours: ha, wasMissing: !o });
    }
  }

  const days = [...perDay.values()].sort((a, b) => a.date.localeCompare(b.date)).map(d => ({
    ...d,
    hoursChange: round2(d.hoursAfter - d.hoursBefore),
    dollarsChange: round2(d.dollarsAfter - d.dollarsBefore)
  }));
  const totals = days.reduce((t, d) => ({
    hoursBefore: round2(t.hoursBefore + d.hoursBefore),
    hoursAfter: round2(t.hoursAfter + d.hoursAfter),
    dollarsBefore: round2(t.dollarsBefore + d.dollarsBefore),
    dollarsAfter: round2(t.dollarsAfter + d.dollarsAfter)
  }), { hoursBefore: 0, hoursAfter: 0, dollarsBefore: 0, dollarsAfter: 0 });
  totals.hoursChange = round2(totals.hoursAfter - totals.hoursBefore);
  totals.dollarsChange = round2(totals.dollarsAfter - totals.dollarsBefore);
  totals.dollarsChangePct = totals.dollarsBefore > 0
    ? round2((totals.dollarsChange / totals.dollarsBefore) * 100) : null;

  return {
    from: dates[0] || (days[0] && days[0].date) || null,
    to: dates[dates.length - 1] || (days.length ? days[days.length - 1].date : null),
    totals,
    days,
    changedDays: days.filter(d => d.hoursChange !== 0 || d.rowsBefore !== d.rowsAfter).map(d => d.date),
    employees: perEmployee,
    fixedPunches,
    ratesMissing: [...ratesMissing].sort()
  };
}

// ---------------------------------------------------------------------------
// 4. Day status, for every screen that shows daily figures
// ---------------------------------------------------------------------------
//
// provisional = the daily snapshot only (open punches may read 0.00);
// reconciled  = the weekly file, with punch corrections, has been applied.
// A day with no hours_days row has had nothing imported. Only days that have
// already happened are counted, so tomorrow is never "provisional".
function summarizeDayStatus(hoursDays, dates, today) {
  const by = new Map((hoursDays || []).map(d => [String(d.work_date).slice(0, 10), d]));
  const days = [];
  let provisional = 0, reconciled = 0, none = 0;
  const imports = new Set();
  for (const date of dates || []) {
    if (today && date >= today) continue;
    const row = by.get(date);
    const status = row ? row.status : null;
    if (status === 'reconciled') {
      reconciled++;
      if (row.last_import_id) imports.add(row.last_import_id);
    } else if (status === 'provisional') provisional++;
    else none++;
    days.push({ date, status, importId: row && status === 'reconciled' ? row.last_import_id || null : null });
  }
  return { days, provisional, reconciled, none, reconciliationImportIds: [...imports] };
}

module.exports = {
  summarizeDayStatus,
  classifyRows,
  buildDatedImport,
  dateColumnOf,
  parseCellDate,
  computeVariance,
  eachDate,
  DATE_HEADERS
};
