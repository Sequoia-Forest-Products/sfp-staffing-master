// Weekly overtime report — pure aggregation.
//
// No network, no database, no npm dependencies: every input is passed in, so
// tests/ot-report.test.js drives exactly the same code that /api/payroll-report
// runs (netlify/functions/payroll-report.js fetches the rows and calls
// buildReport). Keeping the arithmetic here and the I/O there is the same split
// birthday-lib.js uses.
//
// Inputs
//   weekStart     any 'YYYY-MM-DD' inside the wanted week; snapped to its Monday
//   dailyRows     daily_hours rows (SCHEMA_DAILY_HOURS.sql)
//   overtimeRows  overtime rows: {id, name, ot_type, hours, description}
//   employees     {id, name, employee_number, department, wage, status}
//   expectedDays  optional array of 'YYYY-MM-DD' that a delivery was expected
//                 for; defaults to the scheduled block (Mon-Thu) of the week
//
// Two things about this data that the shape of the report is built around:
//
//   1. The `overtime` table has no week column and no dollars. It is a STANDING
//      weekly allowance that applies to every week, not a per-week entry, and
//      the UI has to say so. Dollars are derived here (hours * rate * 1.5).
//   2. daily_hours carries a department SNAPSHOT taken at import. This module
//      reads that snapshot and never re-derives department from `employees`,
//      because people transfer and a live join would rewrite history. The only
//      exception is a pre-approved allowance for somebody with no rows this
//      week — there is no snapshot to read, so employees.department is the
//      honest fallback and they are listed in preApproved.withoutHoursThisWeek.
//
// "No data" NEVER means "nobody worked". Fri/Sat/Sun are legitimate work days
// (maintenance), so an empty Saturday is either a quiet Saturday or a missed
// email and completeness says exactly that ('no-data-nonscheduled'). An empty
// Mon-Thu is 'missing' — a probable missed delivery.

const DEPARTMENTS = ['Maintenance', 'Saw Filing', 'Shipping', 'Production'];
const UNASSIGNED  = 'Unassigned';
const OT_TYPES    = ['Pre-Shift', 'Post-Shift', 'Weekend'];

// Pre-approved dollars use a flat 1.5x. Unlike imported ot_dollars (which is the
// residual of the payroll system's own blended Total Earnings) there is no
// authoritative dollar figure for an allowance, so 1.5x is the stated estimate.
const PRE_APPROVED_MULTIPLIER = 1.5;

// isoDow 1..4 = Mon..Thu = the scheduled 4x10 block.
const LAST_SCHEDULED_ISO_DOW = 4;
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAY_MS = 86400000;

// Everything is rounded to 2 decimals on the way out, so any genuine
// disagreement is at least 0.01. Half a cent is comfortably inside the noise.
const TOLERANCE = 0.005;

// ============================================================
// DATE LOGIC
// ============================================================

function pad2(n) { return String(n).padStart(2, '0'); }

// 'YYYY-MM-DD' (or an ISO timestamp) -> UTC-midnight milliseconds, or null.
//
// Never `new Date(str)` for a date-only string: that parses as UTC midnight and
// then reads back through the local clock, which lands on the previous calendar
// day in every negative-offset zone — including the Pacific zone this report is
// scored in. Splitting the string and using Date.UTC (the approach
// birthday-lib.js explains at length) keeps the calendar date literal.
function dateToUTC(value) {
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
  }

  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(value == null ? '' : value).trim());
  if (!m) return null;

  const year = +m[1], month = +m[2], day = +m[3];
  const ms = Date.UTC(year, month - 1, day);
  const back = new Date(ms);

  // Rejects 2026-02-31 and friends, which Date.UTC would silently roll forward.
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) {
    return null;
  }
  return ms;
}

function utcToDateStr(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function normalizeDate(value) {
  const ms = dateToUTC(value);
  return ms === null ? null : utcToDateStr(ms);
}

// ISO weekday: Monday 1 ... Sunday 7. getUTCDay() calls Sunday 0.
function isoDowFromMs(ms) {
  const day = new Date(ms).getUTCDay();
  return day === 0 ? 7 : day;
}

function mondayMs(ms) {
  return ms - (isoDowFromMs(ms) - 1) * DAY_MS;
}

// Monday of the ISO week containing dateStr. A Sunday belongs to the week that
// started six days earlier, not to the one starting the next day.
function weekStartFor(dateStr) {
  const ms = dateToUTC(dateStr);
  if (ms === null) throw new Error(`weekStartFor: not a YYYY-MM-DD date: ${JSON.stringify(String(dateStr))}`);
  return utcToDateStr(mondayMs(ms));
}

// Mon..Sun as seven calendar strings. Tolerates a mid-week argument (it snaps to
// the Monday first) so callers can hand it a raw ?week= value.
function weekDates(weekStart) {
  const ms = dateToUTC(weekStart);
  if (ms === null) throw new Error(`weekDates: not a YYYY-MM-DD date: ${JSON.stringify(String(weekStart))}`);
  const start = mondayMs(ms);
  const out = [];
  for (let i = 0; i < 7; i++) out.push(utcToDateStr(start + i * DAY_MS));
  return out;
}

// ============================================================
// NUMBERS
// ============================================================

// The single rounding point for the whole report. Sign-aware so -0.005 does not
// come back as -0, which JSON.stringify would emit as a confusing "0" that
// compares unequal in a strict test.
function round2(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  const r = (Math.round(Math.abs(v) * 100 + Number.EPSILON) / 100) * Math.sign(v);
  return r === 0 ? 0 : r;
}

// numeric(10,2) arrives from PostgREST as a JSON number, but hand-entered
// columns (employees.wage) are free text like "$24.50", so strip the decoration.
function num(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// A usable pay rate, or null. Zero and negative rates are "no rate", not a rate.
function toRate(value) {
  const n = num(value);
  return n > 0 ? n : null;
}

// Matches payroll-lib's normalizeEmpNumber: the live export sends zero-padded
// four-character ids ('0319'), an older export sent them unpadded ('319').
// Both sides of every comparison go through this.
function normalizeEmpNumber(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  return /^\d+$/.test(raw) ? raw.padStart(4, '0') : raw;
}

function cleanText(value) {
  const s = String(value == null ? '' : value).trim();
  return s || null;
}

// null department => the "Unassigned" bucket. Never guess a real department.
function departmentBucket(value) {
  return cleanText(value) || UNASSIGNED;
}

// ============================================================
// ACCUMULATORS
// ============================================================
//
// A "block" is the {hours, otHours, otDollars, earnings, headcount} shape that
// repeats all over the report. Totals accumulate unrounded and are rounded once
// by finishBlock, so a long column of cents cannot drift.

function newBlock() {
  return { hours: 0, otHours: 0, otDollars: 0, earnings: 0, people: new Set() };
}

function addRow(block, row) {
  block.hours     += row.hours;
  block.otHours   += row.otHours;
  block.otDollars += row.otDollars;
  block.earnings  += row.earnings;
  block.people.add(row.key);
}

function finishBlock(block) {
  return {
    hours:     round2(block.hours),
    otHours:   round2(block.otHours),
    otDollars: round2(block.otDollars),
    earnings:  round2(block.earnings),
    headcount: block.people.size
  };
}

// DEPARTMENTS first in their canonical order, then anything unexpected that the
// data actually contains, then Unassigned last so it reads as the remainder.
function sortDepartments(names) {
  const rank = (name) => {
    if (name === UNASSIGNED) return DEPARTMENTS.length + 1;
    const i = DEPARTMENTS.indexOf(name);
    return i === -1 ? DEPARTMENTS.length : i;
  };
  return names.slice().sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

function displayName(row) {
  const name = `${cleanText(row.first_name) || ''} ${cleanText(row.last_name) || ''}`.trim();
  if (name) return name;
  const number = normalizeEmpNumber(row.employee_number);
  return number ? `Employee ${number}` : '(unnamed)';
}

// ============================================================
// REPORT
// ============================================================

function buildReport({
  weekStart,
  dailyRows = [],
  overtimeRows = [],
  employees = [],
  expectedDays = null
} = {}) {
  const dates    = weekDates(weekStart);
  const dateSet  = new Set(dates);
  const monday   = dates[0];
  const sunday   = dates[6];

  // ---- roster indexes -------------------------------------------------
  // employee_number matches daily_hours; the lowercased name matches the
  // overtime table, which has no id and no employee number at all. Duplicate
  // names keep the first roster entry — nothing else can disambiguate them.
  const byNumber = new Map();
  const byName   = new Map();
  for (const emp of employees || []) {
    const number = normalizeEmpNumber(emp.employee_number);
    if (number && !byNumber.has(number)) byNumber.set(number, emp);
    const name = String(emp.name || '').trim().toLowerCase();
    if (name && !byName.has(name)) byName.set(name, emp);
  }

  // ---- normalize the daily rows ---------------------------------------
  const rows = [];
  for (const raw of dailyRows || []) {
    const date = normalizeDate(raw.work_date);
    if (!date || !dateSet.has(date)) continue; // defensive: the caller may over-fetch

    const isoDow          = isoDowFromMs(dateToUTC(date));
    const employeeNumber  = normalizeEmpNumber(raw.employee_number);
    const rosterEmp       = employeeNumber ? byNumber.get(employeeNumber) : null;
    const name            = rosterEmp ? String(rosterEmp.name || '').trim() || displayName(raw) : displayName(raw);
    const hasDepartment   = cleanText(raw.department) !== null;

    // total_hours is authoritative; regular + ot is only a fallback for a row
    // that somehow arrived without it.
    const hours = (raw.total_hours === null || raw.total_hours === undefined)
      ? num(raw.regular_hours) + num(raw.ot_hours)
      : num(raw.total_hours);

    rows.push({
      date,
      isoDow,
      isScheduledDay: isoDow <= LAST_SCHEDULED_ISO_DOW,
      employeeNumber: employeeNumber || null,
      // Rows with no employee number still need to count as one person.
      key: employeeNumber || `name:${name.toLowerCase()}`,
      name,
      department: departmentBucket(raw.department),
      hasDepartment,
      onRoster: !!rosterEmp,
      hours,
      otHours: num(raw.ot_hours),
      otDollars: num(raw.ot_dollars),
      earnings: num(raw.total_earnings),
      payRate: toRate(raw.pay_rate),
      flags: Array.isArray(raw.flags) ? raw.flags.filter(Boolean) : [],
      source: cleanText(raw.source),
      dateSource: cleanText(raw.date_source)
    });
  }

  // ---- per employee ----------------------------------------------------
  const people = new Map();
  const personFor = (key) => {
    if (!people.has(key)) {
      people.set(key, {
        key,
        employeeNumber: null,
        name: '',
        onRoster: false,
        departmentHours: new Map(), // department -> hours, to pick the dominant one
        payRate: null,
        scheduled: newBlock(),
        nonScheduled: newBlock(),
        days: new Set(),
        nonScheduledDays: new Set(),
        preApprovedHours: 0,
        preApprovedDollars: 0,
        hasHoursThisWeek: false
      });
    }
    return people.get(key);
  };

  for (const row of rows) {
    const person = personFor(row.key);
    person.employeeNumber = person.employeeNumber || row.employeeNumber;
    person.name = person.name || row.name;
    person.onRoster = person.onRoster || row.onRoster;
    person.hasHoursThisWeek = true;
    person.departmentHours.set(row.department, (person.departmentHours.get(row.department) || 0) + row.hours);
    if (row.payRate !== null) person.payRate = Math.max(person.payRate || 0, row.payRate);
    addRow(row.isScheduledDay ? person.scheduled : person.nonScheduled, row);
    person.days.add(row.date);
    if (!row.isScheduledDay) person.nonScheduledDays.add(row.date);
  }

  // The department a person is reported under: the snapshot carrying the most of
  // their hours this week. Ties fall back to the canonical department order, so
  // the answer is stable rather than dependent on row order.
  for (const person of people.values()) {
    const names = sortDepartments([...person.departmentHours.keys()]);
    let best = null, bestHours = -1;
    for (const name of names) {
      const hours = person.departmentHours.get(name);
      if (hours > bestHours) { best = name; bestHours = hours; }
    }
    person.department = best || UNASSIGNED;
  }

  // ---- pre-approved (standing) allowances ------------------------------
  const preRows            = [];
  const preByType          = {};
  const preByDepartment    = new Map();
  const unmatchedNames     = [];
  const rateMissing        = [];
  const seenUnmatched      = new Set();
  const seenRateMissing    = new Set();
  let preApprovedHours     = 0;
  let preApprovedDollars   = 0;

  for (const type of OT_TYPES) preByType[type] = { hours: 0, dollars: 0 };

  for (const raw of overtimeRows || []) {
    const name = String(raw.name || '').trim();
    if (!name) continue; // a blank row in the OT tab attributes to nobody

    const hours    = num(raw.hours);
    const rosterEmp = byName.get(name.toLowerCase()) || null;
    const number    = rosterEmp ? normalizeEmpNumber(rosterEmp.employee_number) : '';
    const key       = number || `name:${name.toLowerCase()}`;
    const worked    = people.get(key);
    const hasHours  = !!(worked && worked.hasHoursThisWeek);

    // Department: the snapshot on this week's rows when there is one, otherwise
    // the roster's current department. An unmatched name has neither, so it
    // lands in Unassigned rather than being dropped from the totals.
    const department = hasHours
      ? worked.department
      : (rosterEmp ? departmentBucket(rosterEmp.department) : UNASSIGNED);

    // Rate: the highest pay_rate seen in daily_hours this week, else the
    // roster wage, else nothing — in which case the dollars are honestly 0 and
    // the name is reported in rateMissing instead of being invented.
    let rate = hasHours ? worked.payRate : null;
    let rateSource = 'none';
    if (rate) {
      rateSource = 'daily_hours';
    } else {
      rate = toRate(rosterEmp && rosterEmp.wage);
      if (rate) rateSource = 'employees.wage';
    }

    const dollars = rate ? round2(hours * rate * PRE_APPROVED_MULTIPLIER) : 0;

    if (rateSource === 'none' && !seenRateMissing.has(name.toLowerCase())) {
      seenRateMissing.add(name.toLowerCase());
      rateMissing.push(name);
    }
    if (!rosterEmp && !seenUnmatched.has(name.toLowerCase())) {
      seenUnmatched.add(name.toLowerCase());
      unmatchedNames.push(name);
    }

    // An ot_type outside the three known values still counts; it gets its own
    // byType key so byType always sums to the pre-approved totals.
    const otType = cleanText(raw.ot_type) || 'Unspecified';
    if (!preByType[otType]) preByType[otType] = { hours: 0, dollars: 0 };
    preByType[otType].hours   += hours;
    preByType[otType].dollars += dollars;

    preApprovedHours   += hours;
    preApprovedDollars += dollars;

    const deptTotals = preByDepartment.get(department) || { hours: 0, dollars: 0 };
    deptTotals.hours   += hours;
    deptTotals.dollars += dollars;
    preByDepartment.set(department, deptTotals);

    const person = personFor(key);
    person.name           = person.name || name;
    person.employeeNumber = person.employeeNumber || (number || null);
    person.onRoster       = person.onRoster || !!rosterEmp;
    person.department     = person.department || department;
    person.preApprovedHours   += hours;
    person.preApprovedDollars += dollars;

    preRows.push({
      name,
      otType,
      hours: round2(hours),
      dollars: round2(dollars),
      department,
      rateSource,
      matched: !!rosterEmp
    });
  }

  // Standing allowances for people with no rows this week are netted anyway —
  // that is what makes net OT go negative, and clamping it would hide the fact
  // that an allowance is being carried against nothing.
  const withoutHoursThisWeek = [];
  for (const person of people.values()) {
    if (person.hasHoursThisWeek) continue;
    withoutHoursThisWeek.push({
      name: person.name,
      department: person.department || UNASSIGNED,
      hours: round2(person.preApprovedHours),
      dollars: round2(person.preApprovedDollars)
    });
  }
  withoutHoursThisWeek.sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name));

  const byTypeOut = {};
  for (const type of Object.keys(preByType)) {
    byTypeOut[type] = { hours: round2(preByType[type].hours), dollars: round2(preByType[type].dollars) };
  }

  // ---- per day ---------------------------------------------------------
  const rowsByDate = new Map(dates.map(d => [d, []]));
  for (const row of rows) rowsByDate.get(row.date).push(row);

  const days = dates.map((date) => {
    const dayRows = rowsByDate.get(date);
    const isoDow  = isoDowFromMs(dateToUTC(date));
    const block   = newBlock();
    const workers = new Map();

    for (const row of dayRows) {
      addRow(block, row);
      const w = workers.get(row.key) || {
        employeeNumber: row.employeeNumber,
        name: row.name,
        department: row.department,
        hours: 0, otHours: 0, otDollars: 0, earnings: 0
      };
      w.hours     += row.hours;
      w.otHours   += row.otHours;
      w.otDollars += row.otDollars;
      w.earnings  += row.earnings;
      workers.set(row.key, w);
    }

    const distinct = (field) => {
      const values = [...new Set(dayRows.map(r => r[field]).filter(Boolean))];
      if (values.length === 0) return null;
      return values.length === 1 ? values[0] : values.join(', ');
    };

    const totals = finishBlock(block);
    return {
      date,
      dayName: DAY_NAMES[isoDow - 1],
      isoDow,
      isScheduledDay: isoDow <= LAST_SCHEDULED_ISO_DOW,
      hasData: dayRows.length > 0,
      rowCount: dayRows.length,
      hours: totals.hours,
      otHours: totals.otHours,
      otDollars: totals.otDollars,
      earnings: totals.earnings,
      headcount: totals.headcount,
      source: distinct('source'),
      dateSource: distinct('dateSource'),
      workers: [...workers.values()]
        .map(w => ({
          employeeNumber: w.employeeNumber,
          name: w.name,
          department: w.department,
          hours: round2(w.hours),
          otHours: round2(w.otHours),
          otDollars: round2(w.otDollars),
          earnings: round2(w.earnings)
        }))
        .sort((a, b) => b.otHours - a.otHours || b.hours - a.hours || a.name.localeCompare(b.name))
    };
  });

  // ---- per department --------------------------------------------------
  const deptAcc = new Map();
  const deptFor = (name) => {
    if (!deptAcc.has(name)) {
      deptAcc.set(name, { week: newBlock(), scheduled: newBlock(), weekend: newBlock() });
    }
    return deptAcc.get(name);
  };

  for (const row of rows) {
    const acc = deptFor(row.department);
    addRow(acc.week, row);
    addRow(row.isScheduledDay ? acc.scheduled : acc.weekend, row);
  }
  // A department that only shows up through a standing allowance still gets a
  // row, otherwise its pre-approved hours would vanish from the department view
  // while still counting in the summary.
  for (const name of preByDepartment.keys()) deptFor(name);

  const departments = sortDepartments([...deptAcc.keys()]).map((name) => {
    const acc = deptAcc.get(name);
    const pre = preByDepartment.get(name) || { hours: 0, dollars: 0 };
    const week = finishBlock(acc.week);
    return {
      department: name,
      week,
      scheduled: finishBlock(acc.scheduled),
      weekend: finishBlock(acc.weekend),
      preApprovedHours: round2(pre.hours),
      preApprovedDollars: round2(pre.dollars),
      netOtHours: round2(acc.week.otHours - pre.hours),
      netOtDollars: round2(acc.week.otDollars - pre.dollars)
    };
  });

  // ---- summary + split -------------------------------------------------
  const weekBlock         = newBlock();
  const scheduledBlock    = newBlock();
  const nonScheduledBlock = newBlock();
  for (const row of rows) {
    addRow(weekBlock, row);
    addRow(row.isScheduledDay ? scheduledBlock : nonScheduledBlock, row);
  }

  const week         = finishBlock(weekBlock);
  const scheduled    = finishBlock(scheduledBlock);
  // "weekend" and "nonScheduled" are the same Fri-Sun block under two names, so
  // scheduled + weekend is always exactly the week. Friday belongs here: the
  // scheduled week is Mon-Thu, and Friday work is maintenance work.
  const nonScheduled = finishBlock(nonScheduledBlock);

  const totalHourlyPayroll = week.earnings;
  const netOtHours   = round2(week.otHours - preApprovedHours);
  const netOtDollars = round2(week.otDollars - preApprovedDollars);

  const summary = {
    allOtHours: week.otHours,
    allOtDollars: week.otDollars,
    preApprovedHours: round2(preApprovedHours),
    preApprovedDollars: round2(preApprovedDollars),
    // Net OT is reported exactly as it lands. A standing allowance larger than
    // the OT actually worked makes this negative, and that is the finding.
    netOtHours,
    netOtDollars,
    totalHourlyPayroll,
    // A fraction (0.0731), not a percentage. null rather than 0 or Infinity when
    // there is no payroll to divide by — a week with no data has no percentage.
    netOtPctOfPayroll: totalHourlyPayroll === 0 ? null : round2Pct(netOtDollars / totalHourlyPayroll),
    totalHours: week.hours,
    headcount: week.headcount,
    weekendHours: nonScheduled.hours,
    weekendDollars: nonScheduled.earnings,
    weekendOtHours: nonScheduled.otHours,
    weekendOtDollars: nonScheduled.otDollars,
    weekendHeadcount: nonScheduled.headcount
  };

  const split = {
    scheduled: {
      hours: scheduled.hours, otHours: scheduled.otHours, otDollars: scheduled.otDollars,
      earnings: scheduled.earnings, headcount: scheduled.headcount
    },
    nonScheduled: {
      // earnings, not otDollars: a Saturday maintenance shift paid entirely at
      // the regular rate has 0 OT dollars and still costs real money.
      hours: nonScheduled.hours, otHours: nonScheduled.otHours, otDollars: nonScheduled.otDollars,
      earnings: nonScheduled.earnings, headcount: nonScheduled.headcount
    }
  };

  // ---- employees -------------------------------------------------------
  const employeeList = [...people.values()].map((person) => {
    const scheduledTotals    = finishBlock(person.scheduled);
    const nonScheduledTotals = finishBlock(person.nonScheduled);
    const otHours   = round2(person.scheduled.otHours + person.nonScheduled.otHours);
    const otDollars = round2(person.scheduled.otDollars + person.nonScheduled.otDollars);
    return {
      employeeNumber: person.employeeNumber,
      name: person.name,
      department: person.department || UNASSIGNED,
      onRoster: person.onRoster,
      scheduledHours: scheduledTotals.hours,
      scheduledEarnings: scheduledTotals.earnings,
      nonScheduledHours: nonScheduledTotals.hours,
      nonScheduledEarnings: nonScheduledTotals.earnings,
      otHours,
      otDollars,
      totalHours: round2(person.scheduled.hours + person.nonScheduled.hours),
      totalEarnings: round2(person.scheduled.earnings + person.nonScheduled.earnings),
      preApprovedHours: round2(person.preApprovedHours),
      preApprovedDollars: round2(person.preApprovedDollars),
      netOtHours: round2(person.scheduled.otHours + person.nonScheduled.otHours - person.preApprovedHours),
      netOtDollars: round2(person.scheduled.otDollars + person.nonScheduled.otDollars - person.preApprovedDollars),
      daysWorked: person.days.size,
      nonScheduledDaysWorked: person.nonScheduledDays.size
    };
  }).sort((a, b) => b.otHours - a.otHours || b.totalHours - a.totalHours || a.name.localeCompare(b.name));

  // ---- completeness ----------------------------------------------------
  // "Expected" defaults to the scheduled block (Mon-Thu). Fri/Sat/Sun are never
  // expected but absolutely can have data, so an empty one is reported as
  // ambiguous rather than as a missed delivery. Callers can narrow the expected
  // set (payroll-report.js drops days that have not happened yet).
  const expectedSet = Array.isArray(expectedDays)
    ? new Set(expectedDays.map(normalizeDate).filter(Boolean))
    : new Set(dates.filter(d => isoDowFromMs(dateToUTC(d)) <= LAST_SCHEDULED_ISO_DOW));

  const completenessDays = days.map(day => {
    const expected = expectedSet.has(day.date);
    return {
      date: day.date,
      dayName: day.dayName,
      isScheduledDay: day.isScheduledDay,
      hasData: day.hasData,
      rowCount: day.rowCount,
      expected,
      // 'data'                 rows are present
      // 'missing'              expected (scheduled) and empty — a probable missed delivery
      // 'no-data-nonscheduled' Fri-Sun and empty — either nobody worked or the
      //                        email never arrived; this does NOT mean nobody worked
      status: day.hasData ? 'data' : (expected ? 'missing' : 'no-data-nonscheduled')
    };
  });

  const expectedDayList = completenessDays.filter(d => d.expected);
  const completeness = {
    days: completenessDays,
    missingScheduledDays: expectedDayList.filter(d => !d.hasData).map(d => d.date),
    scheduledDaysWithData: expectedDayList.filter(d => d.hasData).length,
    scheduledDaysExpected: expectedDayList.length
  };

  // ---- issues ----------------------------------------------------------
  const unknownEmployeeNumbers = [];
  const seenUnknown = new Set();
  const unassignedEmployees = [];
  const seenUnassigned = new Set();
  const flagged = [];
  let unassignedRows = 0;

  for (const row of rows) {
    if (!row.onRoster) {
      const label = row.employeeNumber || `(no number) ${row.name}`;
      if (!seenUnknown.has(label)) { seenUnknown.add(label); unknownEmployeeNumbers.push(label); }
    }
    if (!row.hasDepartment) {
      unassignedRows++;
      if (!seenUnassigned.has(row.key)) {
        seenUnassigned.add(row.key);
        unassignedEmployees.push({ employeeNumber: row.employeeNumber, name: row.name });
      }
    }
    if (row.flags.length) {
      flagged.push({
        workDate: row.date,
        employeeNumber: row.employeeNumber,
        name: row.name,
        flags: row.flags.slice()
      });
    }
  }

  // Reconciliation compares the rounded department figures — the ones a reader
  // can add up on screen — against the rounded summary. Anything that does not
  // tie is reported with its delta rather than quietly absorbed.
  const departmentHours    = round2(departments.reduce((sum, d) => sum + d.week.hours, 0));
  const departmentEarnings = round2(departments.reduce((sum, d) => sum + d.week.earnings, 0));
  const hoursDelta         = round2(departmentHours - summary.totalHours);
  const earningsDelta      = round2(departmentEarnings - totalHourlyPayroll);

  const issues = {
    unknownEmployeeNumbers,
    unassignedRows,
    unassignedEmployees,
    flagged,
    reconciliation: {
      departmentHours,
      summaryHours: summary.totalHours,
      departmentEarnings,
      summaryEarnings: totalHourlyPayroll,
      hoursDelta,
      earningsDelta,
      balanced: Math.abs(hoursDelta) < TOLERANCE && Math.abs(earningsDelta) < TOLERANCE
    }
  };

  return {
    weekStart: monday,
    weekEnd: sunday,
    summary,
    split,
    departments,
    days,
    employees: employeeList,
    preApproved: {
      byType: byTypeOut,
      rows: preRows,
      unmatchedNames,
      withoutHoursThisWeek,
      rateMissing
    },
    completeness,
    issues
  };
}

// Percentages are fractions, and 2 decimals would flatten every realistic OT
// share to 0.07. Four keeps a tenth of a percent visible.
function round2Pct(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  const r = (Math.round(Math.abs(v) * 10000 + Number.EPSILON) / 10000) * Math.sign(v);
  return r === 0 ? 0 : r;
}

module.exports = { weekStartFor, weekDates, buildReport, DEPARTMENTS };
