// Run with: npm test   (node --test, no extra dependencies)
//
// buildReport() is pure, so every case here is a literal fixture in, a literal
// number out. The last section does load payroll-report.js, to prove the HTTP
// function can tell a complete window from a truncated one; even there nothing
// touches Supabase — global fetch and payroll-db's exports are both faked.
//
// The fixture week is Mon 2026-08-03 .. Sun 2026-08-09:
//   Mon  Ana + Ben, ordinary scheduled day
//   Tue  nothing at all — a missed delivery
//   Wed  Ana with 2 OT hours
//   Thu  Ana + Eve (Eve's row carries no department)
//   Fri  an employee number nobody on the roster owns
//   Sat  Ben on maintenance, 8 hours paid entirely at the regular rate
//   Sun  nothing — which is not the same statement as "nobody worked"

const test = require('node:test');
const assert = require('node:assert');

const { weekStartFor, weekDates, buildReport, DEPARTMENTS } =
  require('../netlify/functions/ot-report-lib');

const WEEK = '2026-08-03';

// The columns a real daily_hours row carries; each fixture overrides what matters.
function dailyRow(over) {
  return Object.assign({
    work_date: WEEK,
    employee_number: '0000',
    last_name: null,
    first_name: null,
    is_salary: false,
    pay_rate: 0,
    regular_hours: 0,
    ot_hours: 0,
    total_hours: 0,
    total_earnings: 0,
    ot_dollars: 0,
    regular_dollars: 0,
    department: null,
    source: 'email',
    source_subject: 'Work Summary Payroll',
    email_received_at: null,
    file_hash: null,
    date_source: 'email_received',
    flags: [],
    upload_batch_id: '00000000-0000-0000-0000-000000000001'
  }, over);
}

// Ana's roster wage is deliberately wrong (10.00 against a real 28.00 pay rate)
// so the pre-approved dollar tests prove daily_hours wins over employees.wage.
const EMPLOYEES = [
  { id: 'e1', name: 'Ana Reyes',     employee_number: '0101', department: 'Production',  wage: '10.00', status: 'Active' },
  { id: 'e2', name: 'Ben Carter',    employee_number: '0102', department: 'Maintenance', wage: 24.5,    status: 'Active' },
  { id: 'e3', name: 'Cara Lopez',    employee_number: '0103', department: 'Shipping',    wage: '$22.00', status: 'Active' },
  { id: 'e4', name: 'Dan Whitfield', employee_number: '0104', department: 'Saw Filing',  wage: null,    status: 'Active' },
  { id: 'e5', name: 'Eve Nakamura',  employee_number: '0105', department: null,          wage: '20',    status: 'Active' }
];

const DAILY_ROWS = [
  // Ana Reyes — Production, $28.00, 32 scheduled hours, 2 of them OT.
  dailyRow({ work_date: '2026-08-03', employee_number: '0101', first_name: 'Ana', last_name: 'Reyes',
             department: 'Production', pay_rate: 28, regular_hours: 10, total_hours: 10,
             total_earnings: 280, regular_dollars: 280 }),
  dailyRow({ work_date: '2026-08-05', employee_number: '0101', first_name: 'Ana', last_name: 'Reyes',
             department: 'Production', pay_rate: 28, regular_hours: 10, ot_hours: 2, total_hours: 12,
             total_earnings: 364, regular_dollars: 280, ot_dollars: 84 }),
  dailyRow({ work_date: '2026-08-06', employee_number: '0101', first_name: 'Ana', last_name: 'Reyes',
             department: 'Production', pay_rate: 28, regular_hours: 10, total_hours: 10,
             total_earnings: 280, regular_dollars: 280 }),

  // Ben Carter — Maintenance. Monday scheduled, plus a Saturday shift that is
  // 8 hours of straight time: zero OT dollars, $196 of real payroll.
  dailyRow({ work_date: '2026-08-03', employee_number: '0102', first_name: 'Ben', last_name: 'Carter',
             department: 'Maintenance', pay_rate: 24.5, regular_hours: 10, total_hours: 10,
             total_earnings: 245, regular_dollars: 245 }),
  dailyRow({ work_date: '2026-08-08', employee_number: '0102', first_name: 'Ben', last_name: 'Carter',
             department: 'Maintenance', pay_rate: 24.5, regular_hours: 8, total_hours: 8,
             total_earnings: 196, regular_dollars: 196 }),

  // Eve Nakamura — on the roster, but the import snapshotted no department.
  dailyRow({ work_date: '2026-08-06', employee_number: '0105', first_name: 'Eve', last_name: 'Nakamura',
             department: null, pay_rate: 20, regular_hours: 10, ot_hours: 1, total_hours: 11,
             total_earnings: 230, regular_dollars: 200, ot_dollars: 30,
             flags: ['missing_department'] }),

  // An employee number nobody on the roster owns, working a Friday.
  dailyRow({ work_date: '2026-08-07', employee_number: '0999', first_name: 'Fred', last_name: 'Nobody',
             department: null, pay_rate: 20, regular_hours: 6, total_hours: 6,
             total_earnings: 120, regular_dollars: 120,
             flags: ['unknown_employee', 'missing_department'] })
];

// The standing weekly allowance. No week column, no dollars — dollars are
// derived here at 1.5x.
const OVERTIME_ROWS = [
  { id: 'o1', name: 'Ana Reyes',     ot_type: 'Pre-Shift',  hours: 2, description: 'Startup' },
  { id: 'o2', name: 'Ben Carter',    ot_type: 'Post-Shift', hours: 1, description: 'Lockout' },
  { id: 'o3', name: 'Cara Lopez',    ot_type: 'Weekend',    hours: 4, description: 'Shipping catch-up' },
  { id: 'o4', name: 'Dan Whitfield', ot_type: 'Pre-Shift',  hours: 1, description: 'Saw prep' },
  { id: 'o5', name: 'Ghost Worker',  ot_type: 'Weekend',    hours: 3, description: 'Not on the roster' }
];

function report(over = {}) {
  return buildReport(Object.assign({
    weekStart: WEEK,
    dailyRows: DAILY_ROWS,
    overtimeRows: OVERTIME_ROWS,
    employees: EMPLOYEES
  }, over));
}

const byName = (list, name) => list.find(x => x.name === name);
const byDept = (list, name) => list.find(x => x.department === name);
const dayOf  = (list, date) => list.find(x => x.date === date);

// ============================================================
// Week math
// ============================================================

test('a Sunday belongs to the week that started six days earlier', () => {
  // 2026-03-01 is a Sunday. Reading it through a local-timezone Date would shift
  // it to Feb 28 and hand back the wrong Monday entirely.
  assert.strictEqual(weekStartFor('2026-03-01'), '2026-02-23');
  assert.strictEqual(weekStartFor('2026-08-09'), '2026-08-03');
});

test('a Monday is its own week start', () => {
  assert.strictEqual(weekStartFor('2026-08-03'), '2026-08-03');
  assert.strictEqual(weekStartFor('2026-03-02'), '2026-03-02');
});

test('mid-week dates all resolve to the same Monday', () => {
  for (const d of ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08', '2026-08-09']) {
    assert.strictEqual(weekStartFor(d), '2026-08-03', `${d} should sit in the week of 2026-08-03`);
  }
});

test('weekDates spans a month boundary without an off-by-one', () => {
  assert.deepStrictEqual(weekDates('2026-03-30'), [
    '2026-03-30', '2026-03-31', '2026-04-01', '2026-04-02',
    '2026-04-03', '2026-04-04', '2026-04-05'
  ]);
});

test('weekDates spans a year boundary and accepts a mid-week argument', () => {
  // 2026-01-01 is a Thursday, so its week starts in the previous year.
  assert.strictEqual(weekStartFor('2026-01-01'), '2025-12-29');
  assert.deepStrictEqual(weekDates('2026-01-01'), [
    '2025-12-29', '2025-12-30', '2025-12-31', '2026-01-01',
    '2026-01-02', '2026-01-03', '2026-01-04'
  ]);
});

test('an unparseable date is an error, not a silent Invalid Date', () => {
  assert.throws(() => weekStartFor('not-a-date'), /weekStartFor/);
  assert.throws(() => weekStartFor('2026-02-31'), /weekStartFor/);
  assert.throws(() => weekDates(''), /weekDates/);
});

test('buildReport snaps a mid-week weekStart to its Monday', () => {
  const r = report({ weekStart: '2026-08-06' });
  assert.strictEqual(r.weekStart, '2026-08-03');
  assert.strictEqual(r.weekEnd, '2026-08-09');
});

// ============================================================
// Scheduled vs non-scheduled
// ============================================================

test('a Saturday shift paid entirely at the regular rate still shows up as earnings', () => {
  const r = report();
  // Ben's 8 Saturday hours carry no OT dollars at all...
  assert.strictEqual(r.split.nonScheduled.otDollars, 0);
  assert.strictEqual(r.split.nonScheduled.otHours, 0);
  // ...and $196 of payroll that must not disappear from the weekend view.
  assert.strictEqual(r.split.nonScheduled.earnings, 316); // Ben 196 + Fred's Friday 120
  assert.strictEqual(r.split.nonScheduled.hours, 14);
  assert.strictEqual(r.split.nonScheduled.headcount, 2);

  const saturday = dayOf(r.days, '2026-08-08');
  assert.strictEqual(saturday.dayName, 'Saturday');
  assert.strictEqual(saturday.isScheduledDay, false);
  assert.strictEqual(saturday.earnings, 196);
  assert.strictEqual(saturday.otDollars, 0);
  assert.strictEqual(saturday.workers.length, 1);
  assert.strictEqual(saturday.workers[0].name, 'Ben Carter');
});

test('scheduled and non-scheduled split adds back up to the week', () => {
  const r = report();
  assert.strictEqual(r.split.scheduled.hours + r.split.nonScheduled.hours, r.summary.totalHours);
  assert.strictEqual(r.split.scheduled.earnings + r.split.nonScheduled.earnings, r.summary.totalHourlyPayroll);
  // "weekend" in the summary is the same Fri-Sun block as split.nonScheduled.
  assert.strictEqual(r.summary.weekendHours, r.split.nonScheduled.hours);
  assert.strictEqual(r.summary.weekendDollars, r.split.nonScheduled.earnings);
  assert.strictEqual(r.summary.weekendOtDollars, 0);
  assert.strictEqual(r.summary.weekendHeadcount, 2);
});

test('Friday counts as non-scheduled work, not as a missing scheduled day', () => {
  const r = report();
  const friday = dayOf(r.days, '2026-08-07');
  assert.strictEqual(friday.isScheduledDay, false);
  assert.strictEqual(friday.hasData, true);
  assert.strictEqual(friday.hours, 6);
  assert.ok(!r.completeness.missingScheduledDays.includes('2026-08-07'));
});

// ============================================================
// Summary totals
// ============================================================

test('summary totals are the sum of the fixture, rounded once', () => {
  const r = report();
  assert.strictEqual(r.summary.totalHours, 67);
  assert.strictEqual(r.summary.totalHourlyPayroll, 1715);
  assert.strictEqual(r.summary.headcount, 4);
  assert.strictEqual(r.summary.allOtHours, 3);
  assert.strictEqual(r.summary.allOtDollars, 114);
  assert.strictEqual(r.summary.preApprovedHours, 11);
  assert.strictEqual(r.summary.preApprovedDollars, 252.75);
});

test('netOtPctOfPayroll is a fraction, and null rather than a divide-by-zero', () => {
  const r = report();
  assert.strictEqual(r.summary.netOtPctOfPayroll, -0.0809); // -138.75 / 1715
  assert.ok(Math.abs(r.summary.netOtPctOfPayroll) < 1, 'must be a fraction, not pre-multiplied');

  const empty = buildReport({ weekStart: WEEK, dailyRows: [], overtimeRows: [], employees: [] });
  assert.strictEqual(empty.summary.totalHourlyPayroll, 0);
  assert.strictEqual(empty.summary.netOtPctOfPayroll, null);
  assert.strictEqual(empty.summary.headcount, 0);
});

test('net OT is reported as it lands, including negative', () => {
  const r = report();
  // 3 hours of OT actually worked against an 11-hour standing allowance.
  assert.strictEqual(r.summary.netOtHours, -8);
  assert.strictEqual(r.summary.netOtDollars, -138.75);
  assert.ok(r.summary.netOtHours < 0, 'a negative net must not be clamped to zero');
});

test('rows outside the requested week are ignored', () => {
  const r = report({
    dailyRows: DAILY_ROWS.concat([
      dailyRow({ work_date: '2026-08-10', employee_number: '0101', total_hours: 10, total_earnings: 280 })
    ])
  });
  assert.strictEqual(r.summary.totalHours, 67);
});

// ============================================================
// Departments
// ============================================================

test('a null department produces an Unassigned bucket that is really in the array', () => {
  const r = report();
  const unassigned = byDept(r.departments, 'Unassigned');
  assert.ok(unassigned, 'Unassigned must be present, not dropped or folded into a real department');
  // Eve's 11 hours + Fred's 6.
  assert.strictEqual(unassigned.week.hours, 17);
  assert.strictEqual(unassigned.week.earnings, 350);
  assert.strictEqual(unassigned.week.otHours, 1);
  assert.strictEqual(unassigned.week.otDollars, 30);
  assert.strictEqual(unassigned.scheduled.hours, 11);
  assert.strictEqual(unassigned.weekend.hours, 6);
  // Nothing leaked into a real department on the way.
  assert.strictEqual(byDept(r.departments, 'Production').week.hours, 32);
  assert.strictEqual(byDept(r.departments, 'Maintenance').week.hours, 18);
});

test('Unassigned sorts last, after the canonical departments', () => {
  const r = report();
  assert.deepStrictEqual(
    r.departments.map(d => d.department),
    ['Maintenance', 'Saw Filing', 'Shipping', 'Production', 'Unassigned']
  );
});

test('department rows sum to the summary and reconciliation says so', () => {
  const r = report();
  const hours    = r.departments.reduce((s, d) => s + d.week.hours, 0);
  const earnings = r.departments.reduce((s, d) => s + d.week.earnings, 0);
  assert.strictEqual(hours, r.summary.totalHours);
  assert.strictEqual(earnings, r.summary.totalHourlyPayroll);

  const rec = r.issues.reconciliation;
  assert.strictEqual(rec.departmentHours, 67);
  assert.strictEqual(rec.summaryHours, 67);
  assert.strictEqual(rec.departmentEarnings, 1715);
  assert.strictEqual(rec.summaryEarnings, 1715);
  assert.strictEqual(rec.balanced, true);
  assert.strictEqual(rec.hoursDelta, 0);
  assert.strictEqual(rec.earningsDelta, 0);
});

test('department OT nets against that department share of the standing allowance', () => {
  const r = report();
  const maintenance = byDept(r.departments, 'Maintenance');
  assert.strictEqual(maintenance.week.hours, 18);
  assert.strictEqual(maintenance.week.otHours, 0);
  assert.strictEqual(maintenance.preApprovedHours, 1);
  assert.strictEqual(maintenance.preApprovedDollars, 36.75); // 1 * 24.50 * 1.5
  assert.strictEqual(maintenance.netOtHours, -1);
  assert.strictEqual(maintenance.netOtDollars, -36.75);

  const production = byDept(r.departments, 'Production');
  assert.strictEqual(production.week.otHours, 2);
  assert.strictEqual(production.netOtHours, 0);
  assert.strictEqual(production.netOtDollars, 0);
});

// ============================================================
// Pre-approved (standing) allowance
// ============================================================

test('a pre-approved row for somebody with no hours this week is kept, attributed and netted', () => {
  const r = report();

  const cara = byName(r.preApproved.withoutHoursThisWeek, 'Cara Lopez');
  assert.ok(cara, 'Cara has an allowance and no hours — she must not be dropped');
  assert.strictEqual(cara.department, 'Shipping');      // from employees.department
  assert.strictEqual(cara.hours, 4);
  assert.strictEqual(cara.dollars, 132);                // 4 * 22.00 * 1.5

  // Her department still gets a row, carrying the allowance and the net.
  const shipping = byDept(r.departments, 'Shipping');
  assert.strictEqual(shipping.week.hours, 0);
  assert.strictEqual(shipping.preApprovedHours, 4);
  assert.strictEqual(shipping.preApprovedDollars, 132);
  assert.strictEqual(shipping.netOtHours, -4);
  assert.strictEqual(shipping.netOtDollars, -132);

  // And she is netted at the summary level too.
  assert.ok(r.summary.preApprovedHours >= 4);
  const caraRow = byName(r.employees, 'Cara Lopez');
  assert.strictEqual(caraRow.totalHours, 0);
  assert.strictEqual(caraRow.preApprovedHours, 4);
  assert.strictEqual(caraRow.netOtHours, -4);
  assert.strictEqual(caraRow.onRoster, true);
});

test('the pay rate comes from daily_hours first, employees.wage second, nothing third', () => {
  const r = report();
  const rows = r.preApproved.rows;

  // Ana's roster wage says 10.00; the week actually paid 28.00.
  const ana = rows.find(x => x.name === 'Ana Reyes');
  assert.strictEqual(ana.rateSource, 'daily_hours');
  assert.strictEqual(ana.dollars, 84);   // 2 * 28.00 * 1.5, not 2 * 10.00 * 1.5
  assert.strictEqual(ana.department, 'Production');
  assert.strictEqual(ana.matched, true);

  // Cara has no rows this week, so her roster wage is the only rate available.
  const cara = rows.find(x => x.name === 'Cara Lopez');
  assert.strictEqual(cara.rateSource, 'employees.wage');
  assert.strictEqual(cara.dollars, 132);

  // Dan has neither: dollars are 0 and he is named, not guessed at.
  const dan = rows.find(x => x.name === 'Dan Whitfield');
  assert.strictEqual(dan.rateSource, 'none');
  assert.strictEqual(dan.dollars, 0);
  assert.strictEqual(dan.hours, 1);
  assert.strictEqual(dan.department, 'Saw Filing');
  assert.ok(r.preApproved.rateMissing.includes('Dan Whitfield'));
  assert.ok(!r.preApproved.rateMissing.includes('Cara Lopez'));
});

test('an overtime name that matches nobody is reported, not silently dropped', () => {
  const r = report();
  assert.deepStrictEqual(r.preApproved.unmatchedNames, ['Ghost Worker']);

  const ghost = r.preApproved.rows.find(x => x.name === 'Ghost Worker');
  assert.strictEqual(ghost.matched, false);
  assert.strictEqual(ghost.department, 'Unassigned');
  assert.strictEqual(ghost.dollars, 0);

  // The hours still count, so the allowance total cannot be quietly understated.
  assert.strictEqual(r.summary.preApprovedHours, 11);
  assert.strictEqual(byDept(r.departments, 'Unassigned').preApprovedHours, 3);
});

test('byType covers all three OT types and sums to the pre-approved total', () => {
  const r = report();
  const byType = r.preApproved.byType;
  assert.deepStrictEqual(Object.keys(byType).sort(), ['Post-Shift', 'Pre-Shift', 'Weekend']);
  assert.deepStrictEqual(byType['Pre-Shift'],  { hours: 3, dollars: 84 });
  assert.deepStrictEqual(byType['Post-Shift'], { hours: 1, dollars: 36.75 });
  assert.deepStrictEqual(byType['Weekend'],    { hours: 7, dollars: 132 });

  const hours = Object.values(byType).reduce((s, t) => s + t.hours, 0);
  const dollars = Object.values(byType).reduce((s, t) => s + t.dollars, 0);
  assert.strictEqual(hours, r.summary.preApprovedHours);
  assert.strictEqual(dollars, r.summary.preApprovedDollars);
});

test('name matching against the roster ignores case and surrounding space', () => {
  const r = report({
    overtimeRows: [{ id: 'x', name: '  ANA REYES  ', ot_type: 'Pre-Shift', hours: 2 }]
  });
  const row = r.preApproved.rows[0];
  assert.strictEqual(row.matched, true);
  assert.strictEqual(row.department, 'Production');
  assert.strictEqual(row.dollars, 84);
  assert.deepStrictEqual(r.preApproved.unmatchedNames, []);
});

// ============================================================
// Employees
// ============================================================

test('per-employee rows separate scheduled from non-scheduled money', () => {
  const r = report();
  const ben = byName(r.employees, 'Ben Carter');
  assert.strictEqual(ben.scheduledHours, 10);
  assert.strictEqual(ben.scheduledEarnings, 245);
  assert.strictEqual(ben.nonScheduledHours, 8);
  assert.strictEqual(ben.nonScheduledEarnings, 196);
  assert.strictEqual(ben.otHours, 0);
  assert.strictEqual(ben.otDollars, 0);
  assert.strictEqual(ben.totalHours, 18);
  assert.strictEqual(ben.totalEarnings, 441);
  assert.strictEqual(ben.daysWorked, 2);
  assert.strictEqual(ben.nonScheduledDaysWorked, 1);
  assert.strictEqual(ben.netOtHours, -1);
});

test('an employee whose rows carry no department reads as Unassigned', () => {
  const r = report();
  const eve = byName(r.employees, 'Eve Nakamura');
  assert.strictEqual(eve.department, 'Unassigned');
  assert.strictEqual(eve.onRoster, true);
  assert.strictEqual(eve.otHours, 1);
  assert.strictEqual(eve.otDollars, 30);
});

// ============================================================
// Completeness — "no data" never means "nobody worked"
// ============================================================

test('a scheduled day with no rows is missing; a weekend day with no rows is ambiguous', () => {
  const r = report();
  const days = r.completeness.days;

  const tuesday = dayOf(days, '2026-08-04');
  assert.strictEqual(tuesday.expected, true);
  assert.strictEqual(tuesday.hasData, false);
  assert.strictEqual(tuesday.status, 'missing');

  const sunday = dayOf(days, '2026-08-09');
  assert.strictEqual(sunday.expected, false);
  assert.strictEqual(sunday.hasData, false);
  assert.strictEqual(sunday.status, 'no-data-nonscheduled');

  assert.deepStrictEqual(r.completeness.missingScheduledDays, ['2026-08-04']);
  assert.strictEqual(r.completeness.scheduledDaysExpected, 4);
  assert.strictEqual(r.completeness.scheduledDaysWithData, 3);
});

test('an empty Saturday is no-data-nonscheduled, never a missed delivery', () => {
  const r = buildReport({
    weekStart: WEEK,
    dailyRows: [dailyRow({ work_date: '2026-08-03', employee_number: '0101',
                           department: 'Production', pay_rate: 28, regular_hours: 10,
                           total_hours: 10, total_earnings: 280 })],
    overtimeRows: [],
    employees: EMPLOYEES
  });

  assert.strictEqual(dayOf(r.completeness.days, '2026-08-08').status, 'no-data-nonscheduled');
  assert.strictEqual(dayOf(r.completeness.days, '2026-08-08').isScheduledDay, false);
  // Tue/Wed/Thu are all genuine missed deliveries here.
  assert.deepStrictEqual(r.completeness.missingScheduledDays,
    ['2026-08-04', '2026-08-05', '2026-08-06']);
  assert.strictEqual(r.completeness.days.filter(d => d.status === 'no-data-nonscheduled').length, 3);
});

test('expectedDays can be narrowed so a day that has not happened yet is not "missing"', () => {
  // What payroll-report.js does mid-week: only elapsed scheduled days are due.
  const r = report({ expectedDays: ['2026-08-03', '2026-08-04'] });
  assert.strictEqual(r.completeness.scheduledDaysExpected, 2);
  assert.deepStrictEqual(r.completeness.missingScheduledDays, ['2026-08-04']);
  const thursday = dayOf(r.completeness.days, '2026-08-06');
  assert.strictEqual(thursday.expected, false);
  assert.strictEqual(thursday.isScheduledDay, true, 'still a scheduled day, just not due yet');
});

test('every day of the week is present in days and completeness, in order', () => {
  const r = report();
  const expected = weekDates(WEEK);
  assert.deepStrictEqual(r.days.map(d => d.date), expected);
  assert.deepStrictEqual(r.completeness.days.map(d => d.date), expected);
  assert.deepStrictEqual(r.days.map(d => d.dayName), [
    'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'
  ]);
  assert.deepStrictEqual(r.days.map(d => d.isoDow), [1, 2, 3, 4, 5, 6, 7]);
});

// ============================================================
// Issues
// ============================================================

test('an employee number nobody owns is reported', () => {
  const r = report();
  assert.deepStrictEqual(r.issues.unknownEmployeeNumbers, ['0999']);
  const fred = byName(r.employees, 'Fred Nobody');
  assert.strictEqual(fred.onRoster, false);
  assert.strictEqual(fred.employeeNumber, '0999');
  assert.strictEqual(fred.totalEarnings, 120);
});

test('employee numbers match across zero padding', () => {
  const r = report({
    dailyRows: [dailyRow({ work_date: '2026-08-03', employee_number: '101',
                           department: 'Production', pay_rate: 28, regular_hours: 10,
                           total_hours: 10, total_earnings: 280 })],
    overtimeRows: []
  });
  assert.deepStrictEqual(r.issues.unknownEmployeeNumbers, []);
  assert.strictEqual(r.employees[0].employeeNumber, '0101');
  assert.strictEqual(r.employees[0].name, 'Ana Reyes');
});

test('rows with no department and rows with import flags are both surfaced', () => {
  const r = report();
  assert.strictEqual(r.issues.unassignedRows, 2);
  assert.deepStrictEqual(r.issues.unassignedEmployees.map(e => e.name).sort(),
    ['Eve Nakamura', 'Fred Nobody']);
  assert.strictEqual(r.issues.flagged.length, 2);
  const flagged = r.issues.flagged.find(f => f.employeeNumber === '0999');
  assert.strictEqual(flagged.workDate, '2026-08-07');
  assert.deepStrictEqual(flagged.flags, ['unknown_employee', 'missing_department']);
});

// ============================================================
// Shape
// ============================================================

test('the report survives a round trip through JSON with no NaN or Infinity', () => {
  const r = report();
  const json = JSON.stringify(r);
  assert.ok(!/NaN|Infinity/.test(json), 'no non-finite numbers may reach the client');
  assert.deepStrictEqual(JSON.parse(json).summary, r.summary);
});

test('an empty week still returns the full shape', () => {
  const r = buildReport({ weekStart: WEEK });
  assert.strictEqual(r.weekStart, '2026-08-03');
  assert.strictEqual(r.weekEnd, '2026-08-09');
  assert.deepStrictEqual(r.departments, []);
  assert.deepStrictEqual(r.employees, []);
  assert.strictEqual(r.days.length, 7);
  assert.strictEqual(r.days.every(d => d.hasData === false), true);
  assert.deepStrictEqual(r.preApproved.byType, {
    'Pre-Shift':  { hours: 0, dollars: 0 },
    'Post-Shift': { hours: 0, dollars: 0 },
    'Weekend':    { hours: 0, dollars: 0 }
  });
  assert.strictEqual(r.issues.reconciliation.balanced, true);
});

test('DEPARTMENTS is the canonical list and does not include the Unassigned bucket', () => {
  assert.deepStrictEqual(DEPARTMENTS, ['Maintenance', 'Saw Filing', 'Shipping', 'Production']);
  assert.ok(!DEPARTMENTS.includes('Unassigned'));
});

// ============================================================
// Identity — one person, one entry
// ============================================================

test('a roster employee with no employee number is one person, not two', () => {
  // Hank is on the roster with a null employee_number (nobody has filled his
  // payroll id in yet), so neither input can key on a number. The payroll export
  // shouts his name and the hand-typed overtime tab double-spaced it — two
  // spellings of one man, who both worked 12 hours and holds a 2-hour standing
  // allowance. Keyed on whichever table's text was in hand, he used to split
  // into two entries: one with the hours, one with the allowance, and the second
  // one landed in withoutHoursThisWeek as an allowance nobody worked against.
  const employees = EMPLOYEES.concat([
    { id: 'e6', name: 'Hank Boyd', employee_number: null, department: 'Shipping',
      wage: '30', status: 'Active' }
  ]);
  const dailyRows = [
    dailyRow({ work_date: '2026-08-03', employee_number: '', first_name: 'HANK', last_name: 'BOYD',
               department: 'Shipping', pay_rate: 30, regular_hours: 10, ot_hours: 2,
               total_hours: 12, total_earnings: 390, regular_dollars: 300, ot_dollars: 90 })
  ];
  const overtimeRows = [
    { id: 'o9', name: 'Hank  Boyd', ot_type: 'Pre-Shift', hours: 2, description: 'Dock prep' }
  ];

  const r = buildReport({ weekStart: WEEK, dailyRows, overtimeRows, employees });

  const hanks = r.employees.filter(e => e.name.toLowerCase().replace(/\s+/g, ' ') === 'hank boyd');
  assert.strictEqual(hanks.length, 1, 'one person must produce exactly one employee row');

  const hank = hanks[0];
  assert.strictEqual(hank.name, 'Hank Boyd', 'the roster spelling is the canonical one');
  assert.strictEqual(hank.department, 'Shipping');
  assert.strictEqual(hank.onRoster, true);
  assert.strictEqual(hank.totalHours, 12);
  assert.strictEqual(hank.otHours, 2);
  assert.strictEqual(hank.preApprovedHours, 2);
  assert.strictEqual(hank.preApprovedDollars, 90);   // 2 * 30.00 * 1.5
  assert.strictEqual(hank.netOtHours, 0);

  // He worked, so his allowance is not an "approved but never worked" finding.
  assert.deepStrictEqual(r.preApproved.withoutHoursThisWeek, []);
  // And his rate came off the week's rows, which is only possible if the
  // allowance found the same person the hours were accumulated under.
  assert.strictEqual(r.preApproved.rows[0].rateSource, 'daily_hours');
  assert.strictEqual(r.preApproved.rows[0].matched, true);
  assert.deepStrictEqual(r.preApproved.unmatchedNames, []);

  // Shipping carries the hours and the allowance, once each.
  const shipping = byDept(r.departments, 'Shipping');
  assert.strictEqual(shipping.week.hours, 12);
  assert.strictEqual(shipping.preApprovedHours, 2);
  assert.strictEqual(shipping.netOtHours, 0);
  assert.strictEqual(r.summary.headcount, 1);
});

test('an overtime name that matches nobody still keys on itself', () => {
  // The other half of the same fix: unmatched names must not be swept into
  // somebody else. Ghost Worker has no roster entry, so he keys on his own name,
  // appears in unmatchedNames and lands in Unassigned.
  const r = report();
  assert.deepStrictEqual(r.preApproved.unmatchedNames, ['Ghost Worker']);
  const ghost = byName(r.employees, 'Ghost Worker');
  assert.ok(ghost, 'an unmatched allowance still gets an employee row');
  assert.strictEqual(ghost.onRoster, false);
  assert.strictEqual(ghost.department, 'Unassigned');
  assert.ok(byName(r.preApproved.withoutHoursThisWeek, 'Ghost Worker'));
});

test('a daily row whose employee number is unknown is not name-matched past the finding', () => {
  // Fred's number is not on the roster. Guessing him onto a roster entry by name
  // would hide exactly the gap issues.unknownEmployeeNumbers exists to report.
  const r = report({
    employees: EMPLOYEES.concat([
      { id: 'e7', name: 'Fred Nobody', employee_number: null, department: 'Production',
        wage: '20', status: 'Active' }
    ])
  });
  assert.deepStrictEqual(r.issues.unknownEmployeeNumbers, ['0999']);
  const fred = byName(r.employees, 'Fred Nobody');
  assert.strictEqual(fred.employeeNumber, '0999');
  assert.strictEqual(fred.onRoster, false);
});

// ============================================================
// payroll-report.js — proving the window was read whole
// ============================================================
//
// The only tests here that load the HTTP function. Nothing reaches the network:
// global fetch is replaced with a fake PostgREST that answers the week-index
// query, and payroll-db's exports are swapped for stubs. The week the fixture
// lands in is derived from the window the handler itself asks for, so these
// stay in the window whatever day they are run on.

function loadPayrollReport() {
  process.env.SESSION_SECRET = 'test-session-secret';
  process.env.SUPABASE_URL = 'https://example.invalid';
  process.env.SUPABASE_SERVICE_KEY = 'test-service-key';
  return require('../netlify/functions/payroll-report');
}

function sessionEvent() {
  const payload = Buffer.from(JSON.stringify({ user: 'tester', exp: Date.now() + 3600000 }))
    .toString('base64url');
  const sig = require('node:crypto')
    .createHmac('sha256', 'test-session-secret').update(payload).digest('base64url');
  return {
    httpMethod: 'GET',
    headers: { cookie: `sfp_session=${payload}.${sig}` },
    queryStringParameters: {}
  };
}

// A PostgREST response carrying the Content-Range header the completeness check
// reads. `contentRange` of null models a proxy that stripped it.
function fakePage(rows, contentRange) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(rows),
    headers: { get: (name) => (String(name).toLowerCase() === 'content-range' ? contentRange : null) }
  };
}

// Runs the handler against a fake Supabase. `pageFor(url, callNumber)` answers
// the week-index requests; `detailRows(from, to)` answers the week's own fetch.
async function runReport({ pageFor, detailRows }) {
  const handler = loadPayrollReport().handler;
  const payrollDb = require('../netlify/functions/payroll-db');

  const realFetch = globalThis.fetch;
  const realDaily = payrollDb.fetchDailyHours;
  const realOt    = payrollDb.fetchOvertime;
  const realEmp   = payrollDb.fetchEmployees;

  const urls = [];
  const detailCalls = [];
  globalThis.fetch = async (url) => { urls.push(String(url)); return pageFor(String(url), urls.length); };
  payrollDb.fetchDailyHours = async (from, to) => { detailCalls.push([from, to]); return detailRows(from, to); };
  payrollDb.fetchOvertime   = async () => [];
  payrollDb.fetchEmployees  = async () => EMPLOYEES;

  try {
    const res = await handler(sessionEvent());
    return { res, body: JSON.parse(res.body), urls, detailCalls };
  } finally {
    globalThis.fetch = realFetch;
    payrollDb.fetchDailyHours = realDaily;
    payrollDb.fetchOvertime = realOt;
    payrollDb.fetchEmployees = realEmp;
  }
}

// The last day of the window the handler asks for is the current week's Sunday,
// so a row dated there is always inside the window and inside the week the
// report defaults to.
function windowEnd(url) {
  return decodeURIComponent(/work_date=lte\.([^&]+)/.exec(url)[1]);
}

function indexRow(date) {
  return { work_date: date, total_hours: 10, total_earnings: 280 };
}

test('the week index reads three columns, newest first, and proves it saw them all', async () => {
  const { res, body, urls, detailCalls } = await runReport({
    pageFor: (url) => fakePage([indexRow(windowEnd(url)), indexRow(windowEnd(url)), indexRow(windowEnd(url))],
                               '0-2/3'),
    detailRows: (from, to) => [
      dailyRow({ work_date: to, employee_number: '0101', first_name: 'Ana', last_name: 'Reyes',
                 department: 'Production', pay_rate: 28, regular_hours: 10, total_hours: 10,
                 total_earnings: 280, regular_dollars: 280 }),
      dailyRow({ work_date: to, employee_number: '0102', first_name: 'Ben', last_name: 'Carter',
                 department: 'Maintenance', pay_rate: 24.5, regular_hours: 8, total_hours: 8,
                 total_earnings: 196, regular_dollars: 196 }),
      dailyRow({ work_date: to, employee_number: '0105', first_name: 'Eve', last_name: 'Nakamura',
                 department: null, pay_rate: 20, regular_hours: 6, total_hours: 6,
                 total_earnings: 120, regular_dollars: 120 })
    ]
  });

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(body.ok, true);

  // A narrow projection, not every column of every row.
  assert.strictEqual(urls.length, 1, 'an exact count that matches needs no second page');
  assert.match(urls[0], /select=work_date,total_hours,total_earnings/);
  assert.ok(!/pay_rate|total_earnings,ot_dollars/.test(urls[0].split('&')[0]),
    'the week index must not pull the payroll detail columns');
  // Descending, so a server-side cap would drop the OLDEST rows, never the week
  // the report is about to default to.
  assert.match(urls[0], /order=work_date\.desc/);
  assert.match(urls[0], new RegExp(`limit=\\d+`));

  assert.strictEqual(body.truncated, false);
  assert.strictEqual(body.dataWindow.rowsScanned, 3);
  assert.strictEqual(body.dataWindow.rowsAvailable, 3);
  assert.strictEqual(body.dataWindow.weekIndexTruncated, false);
  assert.strictEqual(body.dataWindow.weekRowsExpected, 3);
  assert.strictEqual(body.dataWindow.weekRowsFetched, 3);
  assert.strictEqual(body.dataWindow.weekDetailTruncated, false);

  // The seven days being reported are fetched exactly, on their own.
  assert.strictEqual(detailCalls.length, 1);
  assert.strictEqual(weekStartFor(detailCalls[0][0]), body.report.weekStart);
  assert.deepStrictEqual(detailCalls[0], [body.report.weekStart, body.report.weekEnd]);
  assert.strictEqual(body.availableWeeks[0].weekStart, body.report.weekStart);
  assert.strictEqual(body.availableWeeks[0].rows, 3);
  assert.strictEqual(body.report.summary.totalHours, 24);
});

test('a silently truncated week index is reported as truncated, not as an authoritative list', async () => {
  // What a project with db-max-rows set actually does: the body stops at the
  // cap while the exact count keeps telling the truth. Believe the count.
  const { res, body, urls } = await runReport({
    pageFor: (url, call) => (call === 1
      ? fakePage(Array.from({ length: 10 }, () => indexRow(windowEnd(url))), '0-9/17384')
      : fakePage([], '0-9/17384')),
    detailRows: () => []
  });

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(body.ok, true, 'the report is still served — with a warning, not a lie');
  assert.strictEqual(body.truncated, true);
  assert.strictEqual(body.dataWindow.weekIndexTruncated, true);
  assert.strictEqual(body.dataWindow.rowsScanned, 10);
  assert.strictEqual(body.dataWindow.rowsAvailable, 17384);
  // With the week list unproven there is nothing to check the detail fetch
  // against, and the response says so rather than inventing a comparison.
  assert.strictEqual(body.dataWindow.weekRowsExpected, null);
  assert.strictEqual(body.dataWindow.weekDetailTruncated, false);
  assert.ok(urls.length >= 2, 'it must try to page past the cap before giving up');
  assert.ok(Array.isArray(body.availableWeeks) && body.availableWeeks.length,
    'the weeks it did see are still offered');
});

test('a week whose detail rows come back short of the index count is flagged', async () => {
  const { body } = await runReport({
    pageFor: (url) => fakePage(Array.from({ length: 5 }, () => indexRow(windowEnd(url))), '0-4/5'),
    detailRows: (from, to) => [
      dailyRow({ work_date: to, employee_number: '0101', department: 'Production',
                 pay_rate: 28, regular_hours: 10, total_hours: 10, total_earnings: 280 })
    ]
  });

  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.dataWindow.weekRowsExpected, 5);
  assert.strictEqual(body.dataWindow.weekRowsFetched, 1);
  assert.strictEqual(body.dataWindow.weekDetailTruncated, true);
  assert.strictEqual(body.truncated, true);
});

test('the window scan pages until the exact count is satisfied', async () => {
  // A capped page that still honours offset: page twice, then stop because the
  // count says everything is in hand — no empty third request.
  const { body, urls } = await runReport({
    pageFor: (url, call) => (call === 1
      ? fakePage(Array.from({ length: 4 }, () => indexRow(windowEnd(url))), '0-3/6')
      : fakePage(Array.from({ length: 2 }, () => indexRow(windowEnd(url))), '4-5/6')),
    detailRows: () => []
  });

  assert.strictEqual(urls.length, 2);
  assert.match(urls[0], /offset=0&/);
  assert.match(urls[1], /offset=4&/, 'the offset advances by rows received, not by page size');
  assert.strictEqual(body.dataWindow.rowsScanned, 6);
  assert.strictEqual(body.dataWindow.weekIndexTruncated, false, 'both pages arrived, so the window is proven');
});
