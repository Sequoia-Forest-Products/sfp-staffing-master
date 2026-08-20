// Run with: npm test   (node --test, no extra dependencies)
//
// Every case builds a real .xlsx in memory (tests/helpers/make-xlsx.js) and
// feeds it to buildImport() with an injected roster, so the ZIP, the XML, the
// header matching and the dollar arithmetic are all genuinely exercised and
// nothing touches Supabase.

const test = require('node:test');
const assert = require('node:assert');

const {
  normalizeEmpNumber,
  round2,
  workDateInfo,
  hashFile,
  buildImport,
  validateWorkDate,
  EXPECTED_SHEET,
  EXPECTED_HEADERS,
  DEPARTMENTS,
  NON_PRODUCTION,
  ASSIGNABLE_DEPARTMENTS
} = require('../netlify/functions/payroll-lib');

const { buildXlsx, buildPayrollXlsx, PAYROLL_HEADERS } = require('./helpers/make-xlsx');

const TZ = 'America/Los_Angeles';

// 2026-08-17 is a Monday; the whole week is used below.
const MONDAY = '2026-08-17';

// A row as the vendor writes it: [Emp #, Last, First, Is Salary, Rate, Reg, OT, Hours, Earnings]
const row = (emp, last, first, salary, rate, reg, ot, hours, earnings) =>
  [emp, last, first, salary, rate, reg, ot, hours, earnings];

// The roster deliberately contains the awkward cases the real one has: two
// people called Smith, compound surnames spelled differently in the two
// systems, an unpadded employee_number, and somebody with no department yet.
const ROSTER = [
  { id: 'e1', name: 'Miguel Acosta Ruiz', employee_number: '0319', department: 'Production',  wage: '24.50', status: 'Active' },
  { id: 'e2', name: 'Ana Smith',          employee_number: '0063', department: 'Maintenance', wage: '30.00', status: 'Active' },
  { id: 'e3', name: 'Dale Smith',         employee_number: '0771', department: 'Shipping',    wage: '28.00', status: 'Active' },
  { id: 'e4', name: 'Rosa Salazar De Leon', employee_number: '0884', department: null,        wage: '22.00', status: 'Active' },
  { id: 'e5', name: 'Luis Sanchez Lopez', employee_number: '905',  department: 'Saw Filing',  wage: '26.00', status: 'Active' },
  { id: 'e6', name: 'No Payroll Id',      employee_number: null,   department: 'Production',  wage: '20.00', status: 'Active' }
];

const importFrom = (dataRows, opts = {}) => buildImport({
  fileBuffer: buildPayrollXlsx(dataRows),
  workDate: MONDAY,
  employees: ROSTER,
  timeZone: TZ,
  ...opts
});

const flagsFor = (result, employeeNumber) =>
  result.rows.find(r => r.employee_number === employeeNumber).flags;

// ============================================================
// Small pieces
// ============================================================

test('employee numbers normalise to four digits, but only when they are digits', () => {
  assert.strictEqual(normalizeEmpNumber('0319'), '0319');
  assert.strictEqual(normalizeEmpNumber('319'), '0319');
  assert.strictEqual(normalizeEmpNumber(319), '0319');
  assert.strictEqual(normalizeEmpNumber('  63  '), '0063');
  assert.strictEqual(normalizeEmpNumber('12345'), '12345');   // longer ids are left alone
  assert.strictEqual(normalizeEmpNumber('TEMP-4'), 'TEMP-4'); // not digits: kept verbatim
  assert.strictEqual(normalizeEmpNumber(''), '');
  assert.strictEqual(normalizeEmpNumber(null), '');
});

test('round2 rounds half away from zero and never returns -0', () => {
  assert.strictEqual(round2(336.875), 336.88);
  assert.strictEqual(round2(-336.875), -336.88);
  assert.strictEqual(round2(0.1 + 0.2), 0.3);
  assert.strictEqual(Object.is(round2(-0.001), 0), true);
});

test('hashFile is a stable sha256 of the bytes, so a re-send is detectable', () => {
  const a = buildPayrollXlsx([row('0319', 'Acosta Ruiz', 'Miguel', 'No', 24.5, 10, 0, 10, 245)]);
  assert.match(hashFile(a), /^[0-9a-f]{64}$/);
  assert.strictEqual(hashFile(a), hashFile(Buffer.from(a)));
});

test('the expected sheet and headers are the vendor file, verbatim', () => {
  assert.strictEqual(EXPECTED_SHEET, 'Work Summary Payroll');
  assert.deepStrictEqual(EXPECTED_HEADERS, PAYROLL_HEADERS);
});

// ============================================================
// Calendar
// ============================================================

test('workDateInfo classifies Mon-Thu as scheduled and Fri-Sun as not', () => {
  const monday = workDateInfo('2026-08-17', TZ);
  assert.deepStrictEqual(monday, {
    date: '2026-08-17', isoDow: 1, dayName: 'Monday', isScheduledDay: true
  });

  const thursday = workDateInfo('2026-08-20', TZ);
  assert.strictEqual(thursday.dayName, 'Thursday');
  assert.strictEqual(thursday.isoDow, 4);
  assert.strictEqual(thursday.isScheduledDay, true);

  const friday = workDateInfo('2026-08-21', TZ);
  assert.strictEqual(friday.dayName, 'Friday');
  assert.strictEqual(friday.isoDow, 5);
  assert.strictEqual(friday.isScheduledDay, false);   // maintenance day: classified, not rejected

  const sunday = workDateInfo('2026-08-23', TZ);
  assert.strictEqual(sunday.dayName, 'Sunday');
  assert.strictEqual(sunday.isoDow, 7);
  assert.strictEqual(sunday.isScheduledDay, false);
});

test('a work date is never read through the local timezone', () => {
  // new Date('2026-08-17') is UTC midnight, which is Sunday evening in Pacific.
  // Reading it that way would move the whole Monday payroll onto Sunday and
  // flip isScheduledDay to false. Prove the naive answer is the wrong one.
  const naive = new Date('2026-08-17').getDay();
  const naiveInPacific = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'long' })
    .format(new Date('2026-08-17'));
  assert.strictEqual(naiveInPacific, 'Sunday');   // what a local-time parse would give
  assert.strictEqual(naive, 1);                   // and UTC alone is not the answer either

  const info = workDateInfo('2026-08-17', TZ);
  assert.strictEqual(info.dayName, 'Monday');
  assert.strictEqual(info.isScheduledDay, true);
  assert.strictEqual(info.date, '2026-08-17');

  // Same for a date whose UTC-midnight instant lands on the previous month.
  assert.strictEqual(workDateInfo('2026-09-01', TZ).date, '2026-09-01');
});

test('validateWorkDate: the future is an error, old is a warning, Saturday is neither', () => {
  const now = new Date('2026-08-19T13:00:00Z');   // Wednesday afternoon Pacific

  const future = validateWorkDate('2026-08-20', TZ, now);
  assert.strictEqual(future.ok, false);
  assert.strictEqual(future.errors.length, 1);
  assert.match(future.errors[0], /future/i);

  const stale = validateWorkDate('2026-07-20', TZ, now);   // 30 days back
  assert.strictEqual(stale.ok, true);
  assert.strictEqual(stale.errors.length, 0);
  assert.strictEqual(stale.warnings.length, 1);
  assert.match(stale.warnings[0], /30 days old/);

  // Weekend maintenance is ordinary work here: the previous Saturday is clean.
  const saturday = validateWorkDate('2026-08-15', TZ, now);
  assert.strictEqual(workDateInfo('2026-08-15', TZ).dayName, 'Saturday');
  assert.strictEqual(saturday.ok, true);
  assert.deepStrictEqual(saturday.errors, []);
  assert.deepStrictEqual(saturday.warnings, []);

  // Today itself is always fine.
  assert.deepStrictEqual(validateWorkDate('2026-08-19', TZ, now),
    { ok: true, errors: [], warnings: [] });
});

// ============================================================
// The vendor file
// ============================================================

test('the nine-column export parses and the seven all-zero salaried rows are skipped', () => {
  const salaried = [
    row('9001', 'Bell',    'Owen',  'Yes', 0, 0, 0, 0, 0),
    row('9002', 'Cross',   'Pat',   'Yes', 0, 0, 0, 0, 0),
    row('9003', 'Duarte',  'Kim',   'Yes', 0, 0, 0, 0, 0),
    row('9004', 'Egan',    'Sam',   'Yes', 0, 0, 0, 0, 0),
    row('9005', 'Frost',   'Lee',   'Yes', 0, 0, 0, 0, 0),
    row('9006', 'Gray',    'Jo',    'Yes', 0, 0, 0, 0, 0),
    row('9007', 'Hale',    'Robin', 'Yes', 0, 0, 0, 0, 0)
  ];
  const hourly = [
    row('0319', 'Acosta Ruiz', 'Miguel', 'No', 24.5, 10, 0, 10, 245),
    row('0063', 'Smith',       'Ana',    'No', 30,   10, 2, 12, 390)
  ];

  const result = importFrom([...salaried, ...hourly]);

  assert.strictEqual(result.counts.totalRows, 9);
  assert.strictEqual(result.counts.salariedSkipped, 7);
  assert.strictEqual(result.counts.salariedWithHoursSkipped, 0);
  // All-zero rows carried no activity, so none of them is an anomaly either.
  assert.deepStrictEqual(result.anomalies.filter(a => a.type === 'salaried_with_hours'), []);
  assert.strictEqual(result.counts.imported, 2);
  assert.strictEqual(result.rows.length, 2);

  const imported = new Set(result.rows.map(r => r.employee_number));
  for (const s of salaried) assert.strictEqual(imported.has(s[0]), false, `${s[0]} should be skipped`);

  assert.strictEqual(result.workDate, MONDAY);
  assert.strictEqual(result.dayName, 'Monday');
  assert.strictEqual(result.isScheduledDay, true);
  assert.match(result.fileHash, /^[0-9a-f]{64}$/);
  assert.strictEqual(result.sheetName, EXPECTED_SHEET);
});

test('a salaried row carrying real hours is skipped too, and reported as an anomaly', () => {
  // Salaried staff are outside this flow whatever their row carries, so 9002 is
  // dropped exactly like the all-zero 9001. It is still reported, because a
  // salaried row with activity on it means the vendor's file changed shape.
  const result = importFrom([
    row('9001', 'Bell', 'Owen', 'Yes', 0,  0,  0, 0,  0),
    row('9002', 'Cross', 'Pat', 'Yes', 40, 10, 0, 10, 400)
  ]);

  assert.strictEqual(result.counts.totalRows, 2);
  assert.strictEqual(result.counts.salariedSkipped, 2);
  assert.strictEqual(result.counts.salariedWithHoursSkipped, 1);
  assert.strictEqual(result.counts.imported, 0);
  assert.deepStrictEqual(result.rows, []);

  // Not in rows under any employee number.
  assert.strictEqual(result.rows.find(r => r.employee_number === '9002'), undefined);

  // Reported, naming the row and what it carried, worded as skipped.
  const anomaly = result.anomalies.find(a => a.type === 'salaried_with_hours');
  assert.ok(anomaly, 'expected a salaried_with_hours anomaly');
  assert.strictEqual(anomaly.employeeNumber, '9002');
  assert.match(anomaly.detail, /10 hours/);
  assert.match(anomaly.detail, /400\.00 earnings/);
  assert.match(anomaly.detail, /[Ss]kipped/);
  assert.strictEqual(/[Ii]mported anyway/.test(anomaly.detail), false);
  // The all-zero row is not reported — only the one that carried something.
  assert.strictEqual(result.anomalies.filter(a => a.type === 'salaried_with_hours').length, 1);

  // THE assertion worth having: a skipped row that still moved a total is the
  // failure this catches. 40 hours and 400 dollars are nowhere.
  assert.deepStrictEqual(result.totals, {
    regularHours: 0, otHours: 0, totalHours: 0,
    totalEarnings: 0, regularDollars: 0, otDollars: 0
  });
  assert.deepStrictEqual(result.departments, []);
  assert.deepStrictEqual(result.sample, []);
  // Nor did it turn up as an unknown employee or a missing-department case.
  assert.deepStrictEqual(result.unmatched, []);
  assert.deepStrictEqual(result.missingDepartment, []);
});

test('a salaried row with hours contributes nothing to a department the hourly rows populate', () => {
  // The same rule with a real hourly row alongside it, so the totals have a
  // non-zero value to hide inside. Only Miguel's 10 hours / 245 dollars exist.
  const result = importFrom([
    row('9002', 'Cross',       'Pat',    'Yes', 40,   10, 2, 12, 500),
    row('0319', 'Acosta Ruiz', 'Miguel', 'No',  24.5, 10, 0, 10, 245)
  ]);

  assert.strictEqual(result.counts.salariedSkipped, 1);
  assert.strictEqual(result.counts.salariedWithHoursSkipped, 1);
  assert.strictEqual(result.counts.imported, 1);
  assert.deepStrictEqual(result.rows.map(r => r.employee_number), ['0319']);

  assert.strictEqual(result.totals.totalHours, 10);
  assert.strictEqual(result.totals.regularHours, 10);
  assert.strictEqual(result.totals.otHours, 0);
  assert.strictEqual(result.totals.totalEarnings, 245);
  assert.strictEqual(result.totals.regularDollars, 245);
  assert.strictEqual(result.totals.otDollars, 0);

  assert.deepStrictEqual(result.departments.map(d => d.department), ['Production']);
  const production = result.departments[0];
  assert.strictEqual(production.employees, 1);
  assert.strictEqual(production.totalHours, 10);
  assert.strictEqual(production.totalEarnings, 245);

  assert.ok(result.anomalies.some(a => a.type === 'salaried_with_hours' && a.employeeNumber === '9002'));
});

test('a pre-parsed sheet can be imported directly, and then there is no file hash', () => {
  const sheet = require('../netlify/functions/xlsx-lite')
    .readSheet(buildPayrollXlsx([row('0319', 'Acosta Ruiz', 'Miguel', 'No', 24.5, 10, 0, 10, 245)]),
      EXPECTED_SHEET);

  const result = buildImport({ sheet, workDate: MONDAY, employees: ROSTER, timeZone: TZ });
  assert.strictEqual(result.counts.imported, 1);
  assert.strictEqual(result.fileHash, null);
  assert.strictEqual(result.rows[0].file_hash, null);
});

// ============================================================
// Dollars — the residual, not a 1.5x formula
// ============================================================

test('OT dollars are the residual, which is not the flat 1.5x answer', () => {
  // 10 regular hours at $30 = $300. The payroll system paid $480 in total, so
  // $180 is OT — 3 hours that include California double-time above 12 hours.
  // A flat 1.5x would have said 3 * 30 * 1.5 = $135 and lost $45.
  const result = importFrom([row('0063', 'Smith', 'Ana', 'No', 30, 10, 3, 13, 480)]);
  const r = result.rows[0];

  assert.strictEqual(r.regular_dollars, 300);
  assert.strictEqual(r.ot_dollars, 180);
  assert.notStrictEqual(r.ot_dollars, 135);
  assert.strictEqual(r.total_earnings, 480);      // stored verbatim, never recomputed
  assert.deepStrictEqual(r.flags, []);

  assert.strictEqual(result.totals.regularDollars, 300);
  assert.strictEqual(result.totals.otDollars, 180);
  assert.strictEqual(result.totals.totalEarnings, 480);
});

test('a few cents of negative residual is rounding noise and clamps to zero', () => {
  // 10 * 24.50 = 245.00 against total earnings of 244.92: residual -0.08.
  const result = importFrom([row('0319', 'Acosta Ruiz', 'Miguel', 'No', 24.5, 10, 0, 10, 244.92)]);
  const r = result.rows[0];

  assert.strictEqual(r.regular_dollars, 245);
  assert.strictEqual(r.ot_dollars, 0);
  assert.deepStrictEqual(r.flags, []);
  assert.strictEqual(result.anomalies.length, 0);
});

test('a dollar-scale negative residual keeps its value and is flagged', () => {
  // 10 * 24.50 = 245.00 against total earnings of 240.00: residual -5.00.
  const result = importFrom([row('0319', 'Acosta Ruiz', 'Miguel', 'No', 24.5, 10, 0, 10, 240)]);
  const r = result.rows[0];

  assert.strictEqual(r.regular_dollars, 245);
  assert.strictEqual(r.ot_dollars, -5);
  assert.ok(r.flags.includes('negative_residual'));
  assert.ok(result.anomalies.some(a => a.type === 'negative_residual' && a.employeeNumber === '0319'));
});

test('the clamp boundary is exactly -1.00', () => {
  const atBoundary = importFrom([row('0319', 'A', 'B', 'No', 10, 10, 0, 10, 99)]);      // residual -1.00
  assert.strictEqual(atBoundary.rows[0].ot_dollars, 0);
  assert.deepStrictEqual(atBoundary.rows[0].flags, []);

  const pastBoundary = importFrom([row('0319', 'A', 'B', 'No', 10, 10, 0, 10, 98.99)]); // residual -1.01
  assert.strictEqual(pastBoundary.rows[0].ot_dollars, -1.01);
  assert.ok(pastBoundary.rows[0].flags.includes('negative_residual'));
});

test('dollars and hours arrive as text with currency formatting without breaking', () => {
  const result = importFrom([row('0063', 'Smith', 'Ana', 'No', ' $30.00 ', '10', '3', '13', '$1,480.00')]);
  const r = result.rows[0];
  assert.strictEqual(r.pay_rate, 30);
  assert.strictEqual(r.regular_hours, 10);
  assert.strictEqual(r.total_earnings, 1480);
  assert.strictEqual(r.ot_dollars, 1180);
  assert.deepStrictEqual(r.flags, []);
});

test('a blank number is zero, but an unreadable one is an anomaly rather than a silent zero', () => {
  const result = importFrom([
    row('0319', 'Acosta Ruiz', 'Miguel', 'No', 24.5, 10, null, 10, 245),
    row('0063', 'Smith',       'Ana',    'No', 30,   10, 'n/a', 10, 300)
  ]);

  assert.strictEqual(result.rows[0].ot_hours, 0);
  assert.deepStrictEqual(result.rows[0].flags, []);

  assert.strictEqual(result.rows[1].ot_hours, 0);
  assert.ok(result.rows[1].flags.includes('unparseable_number'));
  assert.ok(result.anomalies.some(a => a.type === 'unparseable_number' && /OT/.test(a.detail)));
});

// ============================================================
// Matching — by employee_number, never by name
// ============================================================

test('zero padding is irrelevant to matching, and the padded form is what is stored', () => {
  const result = importFrom([
    row('0319', 'Acosta Ruiz', 'Miguel', 'No', 24.5, 10, 0, 10, 245),   // padded both sides
    row('319',  'Acosta',      'Miguel', 'No', 24.5, 0,  0, 0,  0),     // duplicate, see below
    row('905',  'Sanchez Lopez', 'Luis', 'No', 26,   10, 0, 10, 260)    // unpadded on the roster
  ]);

  const acosta = result.rows.find(r => r.employee_number === '0319');
  assert.strictEqual(acosta.employee_number, '0319');   // padding preserved on the way out
  assert.strictEqual(acosta.department, 'Production');

  // '905' in the file against employee_number '905' on the roster: both sides
  // normalise to '0905', so the row matches and stores the padded form.
  const sanchez = result.rows.find(r => r.employee_number === '0905');
  assert.ok(sanchez, 'unpadded roster id should still match');
  assert.strictEqual(sanchez.department, 'Saw Filing');
  assert.deepStrictEqual(sanchez.flags, []);
});

test('an unpadded id in the file matches a padded roster id', () => {
  const result = importFrom([row('63', 'Smith', 'Ana', 'No', 30, 10, 0, 10, 300)]);
  assert.strictEqual(result.rows[0].employee_number, '0063');
  assert.strictEqual(result.rows[0].department, 'Maintenance');
  assert.deepStrictEqual(result.rows[0].flags, []);
  assert.deepStrictEqual(result.unmatched, []);
});

test('names never match: the same surname spelled differently is still unknown', () => {
  // 'Smith' is on the roster twice and this Emp # is on it nowhere. Matching on
  // name would attribute these hours to one of the two real Smiths.
  const result = importFrom([row('7777', 'Smith', 'Ana', 'No', 30, 10, 0, 10, 300)]);
  assert.strictEqual(result.rows[0].department, null);
  assert.ok(result.rows[0].flags.includes('unknown_employee'));
});

test('a duplicate Emp # in one file keeps the first row and reports the second', () => {
  const result = importFrom([
    row('0319', 'Acosta Ruiz', 'Miguel', 'No', 24.5, 10, 0, 10, 245),
    row('0319', 'Acosta Ruiz', 'Miguel', 'No', 24.5, 4,  0, 4,  98)
  ]);

  assert.strictEqual(result.counts.totalRows, 2);
  assert.strictEqual(result.counts.imported, 1);
  assert.strictEqual(result.rows.length, 1);
  assert.strictEqual(result.rows[0].regular_hours, 10);      // the first row survived
  assert.strictEqual(result.totals.totalHours, 10);

  const dup = result.anomalies.find(a => a.type === 'duplicate_employee_in_file');
  assert.ok(dup, 'the duplicate must be reported');
  assert.strictEqual(dup.employeeNumber, '0319');
});

// ============================================================
// Department snapshot
// ============================================================

test('the department snapshot comes from the roster, and gaps are visible rather than bucketed', () => {
  const result = importFrom([
    row('0319', 'Acosta Ruiz',     'Miguel', 'No', 24.5, 10, 0, 10, 245),   // Production
    row('9999', 'Nobody',          'Nadia',  'No', 20,   10, 0, 10, 200),   // not on the roster
    row('0884', 'Salazar De Leon', 'Rosa',   'No', 22,   10, 0, 10, 220)    // roster, no department
  ]);

  const matched = result.rows.find(r => r.employee_number === '0319');
  assert.strictEqual(matched.department, 'Production');
  assert.deepStrictEqual(matched.flags, []);

  const unknown = result.rows.find(r => r.employee_number === '9999');
  assert.strictEqual(unknown.department, null);
  assert.ok(unknown.flags.includes('unknown_employee'));
  assert.deepStrictEqual(result.unmatched,
    [{ employeeNumber: '9999', lastName: 'Nobody', firstName: 'Nadia' }]);

  const noDept = result.rows.find(r => r.employee_number === '0884');
  assert.strictEqual(noDept.department, null);
  assert.ok(noDept.flags.includes('missing_department'));
  assert.deepStrictEqual(result.missingDepartment,
    [{ employeeNumber: '0884', name: 'Rosa Salazar De Leon' }]);

  // Both null-department rows land in Unassigned, and Unassigned is shown.
  const names = result.departments.map(d => d.department);
  assert.ok(names.includes('Unassigned'), `Unassigned must be present, got ${names.join(', ')}`);
  assert.strictEqual(names[names.length - 1], 'Unassigned');   // and last, after the real ones

  const unassigned = result.departments.find(d => d.department === 'Unassigned');
  assert.strictEqual(unassigned.employees, 2);
  assert.strictEqual(unassigned.totalHours, 20);
  assert.strictEqual(unassigned.totalEarnings, 420);

  // Nothing was quietly filed under a real department.
  const production = result.departments.find(d => d.department === 'Production');
  assert.strictEqual(production.employees, 1);
  assert.strictEqual(production.totalEarnings, 245);
});

test('SG&A is assignable but is not one of the production departments', () => {
  // Two lists, two questions. DEPARTMENTS is what the mill is reported over —
  // Clean-up is an ordinary member of it. ASSIGNABLE_DEPARTMENTS is every value
  // employees.department may hold, which is what the back-fill screen validates
  // against, and it is the production six plus SG&A.
  //
  // The constant is still NON_PRODUCTION because it names the ROLE: SG&A is the
  // non-production bucket, and 'Non-Production' was simply its previous label.
  assert.strictEqual(NON_PRODUCTION, 'SG&A');
  assert.deepStrictEqual(DEPARTMENTS,
    ['Maintenance', 'Saw Filing', 'Shipping', 'Production', 'Log Yard', 'Clean-up']);
  assert.deepStrictEqual(ASSIGNABLE_DEPARTMENTS,
    ['Maintenance', 'Saw Filing', 'Shipping', 'Production', 'Log Yard', 'Clean-up', 'SG&A']);
  assert.strictEqual(ASSIGNABLE_DEPARTMENTS.length, 7);
  assert.ok(!DEPARTMENTS.includes('Non-Production') && !ASSIGNABLE_DEPARTMENTS.includes('Non-Production'),
    'Non-Production is a retired label and must not survive anywhere');
  assert.ok(!ASSIGNABLE_DEPARTMENTS.includes('Unassigned'),
    'Unassigned is where a missing department lands, never something to assign');
});

test('the two libraries declare identical department lists', () => {
  // payroll-lib snapshots the department that ot-report-lib then breaks the
  // week down by. If the two copies drift the report is silently wrong rather
  // than broken, so they are compared here directly — including as one joined
  // string, so an ampersand or hyphen mangled on one side alone cannot pass.
  const ot = require('../netlify/functions/ot-report-lib');
  assert.deepStrictEqual(ot.DEPARTMENTS, DEPARTMENTS);
  assert.deepStrictEqual(ot.ASSIGNABLE_DEPARTMENTS, ASSIGNABLE_DEPARTMENTS);
  assert.strictEqual(ot.NON_PRODUCTION, NON_PRODUCTION);
  assert.strictEqual(ASSIGNABLE_DEPARTMENTS.join('|'),
    'Maintenance|Saw Filing|Shipping|Production|Log Yard|Clean-up|SG&A');
});

test('an SG&A employee imports normally and sorts after the production departments', () => {
  // Department is snapshotted straight from employees.department, so this row
  // is imported exactly like anybody else's: not rejected, not blanked, no flag,
  // and the ampersand carried through byte for byte. Its only effect is where
  // the bucket sits in the breakdown. Owen's 'Kiln' is a legacy value that is
  // not assignable at all, and sorts after SG&A despite coming first
  // alphabetically.
  const result = importFrom([
    row('0319', 'Acosta Ruiz',     'Miguel', 'No', 24.5, 10, 0,   10, 245),    // Production
    row('0410', 'Ledger',          'Nora',   'No', 31,   10, 1,   11, 356.5),  // SG&A
    row('0412', 'Yardley',         'Lena',   'No', 26,   9,  0,   9,  234),    // Log Yard
    row('0413', 'Unger',           'Cliff',  'No', 21,   8,  0,   8,  168),    // Clean-up
    row('0411', 'Kane',            'Owen',   'No', 20,   10, 0,   10, 200),    // Kiln — legacy
    row('0884', 'Salazar De Leon', 'Rosa',   'No', 22,   10, 0,   10, 220)     // roster, no department
  ], {
    employees: ROSTER.concat([
      { id: 'e7',  name: 'Nora Ledger',  employee_number: '0410', department: 'SG&A',     wage: '31.00', status: 'Active' },
      { id: 'e8',  name: 'Owen Kane',    employee_number: '0411', department: 'Kiln',     wage: '20.00', status: 'Active' },
      { id: 'e9',  name: 'Lena Yardley', employee_number: '0412', department: 'Log Yard', wage: '26.00', status: 'Active' },
      { id: 'e10', name: 'Cliff Unger',  employee_number: '0413', department: 'Clean-up', wage: '21.00', status: 'Active' }
    ])
  });

  const nora = result.rows.find(r => r.employee_number === '0410');
  // The exact string, spelled out rather than rebuilt from the constant: this is
  // the assertion that catches an '&' escaped, entity-encoded or split on the
  // way through.
  assert.strictEqual(nora.department, 'SG&A');
  assert.strictEqual(nora.department.length, 4);
  assert.strictEqual(nora.department.indexOf('&'), 2);
  assert.deepStrictEqual(nora.flags, []);
  assert.strictEqual(nora.ot_dollars, 46.5);          // 356.50 - 10 x 31.00
  assert.deepStrictEqual(result.unmatched, []);
  assert.deepStrictEqual(result.missingDepartment,
    [{ employeeNumber: '0884', name: 'Rosa Salazar De Leon' }]);

  // The same for Clean-up's hyphen, which must not be normalised to a space or
  // any other dash.
  const cliff = result.rows.find(r => r.employee_number === '0413');
  assert.strictEqual(cliff.department, 'Clean-up');
  assert.deepStrictEqual(cliff.flags, []);
  assert.strictEqual(cliff.total_hours, 8);
  assert.strictEqual(cliff.total_earnings, 168);

  // Log Yard and Clean-up are ordinary production departments and keep their
  // canonical positions; SG&A follows all of them; the legacy 'Kiln' comes after
  // that despite sorting first alphabetically.
  assert.deepStrictEqual(result.departments.map(d => d.department),
    ['Production', 'Log Yard', 'Clean-up', 'SG&A', 'Kiln', 'Unassigned']);
  const logYard = result.departments.find(d => d.department === 'Log Yard');
  assert.strictEqual(logYard.employees, 1);
  assert.strictEqual(logYard.totalHours, 9);
  assert.strictEqual(logYard.totalEarnings, 234);
  assert.deepStrictEqual(result.rows.find(r => r.employee_number === '0412').flags, []);

  const cleanup = result.departments.find(d => d.department === 'Clean-up');
  assert.strictEqual(cleanup.employees, 1);
  assert.strictEqual(cleanup.totalHours, 8);
  assert.strictEqual(cleanup.totalEarnings, 168);

  const np = result.departments.find(d => d.department === 'SG&A');
  assert.strictEqual(np.employees, 1);
  assert.strictEqual(np.regularHours, 10);
  assert.strictEqual(np.otHours, 1);
  assert.strictEqual(np.totalHours, 11);
  assert.strictEqual(np.totalEarnings, 356.5);
  assert.strictEqual(np.otDollars, 46.5);

  // Nothing was folded into a production department, and the breakdown still ties.
  assert.strictEqual(result.departments.find(d => d.department === 'Production').totalHours, 10);
  const sum = key => round2(result.departments.reduce((a, d) => a + d[key], 0));
  assert.strictEqual(sum('totalHours'), result.totals.totalHours);
  assert.strictEqual(sum('totalEarnings'), result.totals.totalEarnings);
  assert.strictEqual(sum('otDollars'), result.totals.otDollars);
});

test("an SG&A employee's ampersand survives the whole round trip, sample included", () => {
  // The department is snapshotted onto every daily_hours row and echoed back in
  // the preview sample. Both are compared against the literal, so an '&' turned
  // into '&amp;', '%26' or a truncation at the ampersand fails here rather than
  // in production.
  const result = importFrom([
    row('0410', 'Ledger', 'Nora', 'No', 31, 10, 1, 11, 356.5)
  ], {
    employees: ROSTER.concat([
      { id: 'e7', name: 'Nora Ledger', employee_number: '0410', department: 'SG&A', wage: '31.00', status: 'Active' }
    ])
  });

  assert.strictEqual(result.rows[0].department, 'SG&A');
  assert.strictEqual(result.sample[0].department, 'SG&A');
  assert.strictEqual(result.departments[0].department, 'SG&A');
  assert.deepStrictEqual(result.rows[0].flags, []);

  // Byte for byte: four characters, one of them an ampersand, no entity anywhere.
  for (const value of [result.rows[0].department, result.sample[0].department]) {
    assert.strictEqual(JSON.stringify(value), '"SG&A"');
    assert.strictEqual(value.includes('&amp;'), false);
    assert.strictEqual(value.includes('%26'), false);
    assert.strictEqual([...value].length, 4);
  }
});

test('an all-zero salaried SG&A row is dropped, so the bucket never appears', () => {
  // The normal case for this department: everyone in it is salaried, the vendor
  // file's all-zero rows are skipped, and a bucket that does not exist is the
  // correct outcome rather than an empty row to read past.
  const result = importFrom([
    row('0410', 'Ledger',      'Nora',   'Yes', 0,    0,  0, 0,  0),
    row('0319', 'Acosta Ruiz', 'Miguel', 'No',  24.5, 10, 0, 10, 245)
  ], {
    employees: ROSTER.concat([
      { id: 'e7', name: 'Nora Ledger', employee_number: '0410', department: 'SG&A', wage: 'Salary', status: 'Active' }
    ])
  });

  assert.strictEqual(result.counts.salariedSkipped, 1);
  assert.strictEqual(result.counts.imported, 1);
  assert.strictEqual(result.rows.find(r => r.employee_number === '0410'), undefined);
  assert.strictEqual(result.departments.find(d => d.department === 'SG&A'), undefined);
  assert.deepStrictEqual(result.departments.map(d => d.department), ['Production']);
});

test('the department breakdown adds up to the totals', () => {
  const result = importFrom([
    row('0319', 'Acosta Ruiz',     'Miguel', 'No', 24.5, 10, 2.5, 12.5, 336.88),
    row('0063', 'Smith',           'Ana',    'No', 30,   10, 3,   13,   480),
    row('0771', 'Smith',           'Dale',   'No', 28,   10, 0,   10,   280),
    row('905',  'Sanchez Lopez',   'Luis',   'No', 26,   8,  0,   8,    208),
    row('0884', 'Salazar De Leon', 'Rosa',   'No', 22,   10, 1,   11,   253),
    row('9999', 'Nobody',          'Nadia',  'No', 20,   10, 0,   10,   200),
    row('9001', 'Bell',            'Owen',   'Yes', 0,   0,  0,   0,    0)
  ]);

  const sum = key => round2(result.departments.reduce((a, d) => a + d[key], 0));
  assert.strictEqual(sum('regularHours'), result.totals.regularHours);
  assert.strictEqual(sum('otHours'), result.totals.otHours);
  assert.strictEqual(sum('totalHours'), result.totals.totalHours);
  assert.strictEqual(sum('totalEarnings'), result.totals.totalEarnings);
  assert.strictEqual(sum('otDollars'), result.totals.otDollars);

  const employees = result.departments.reduce((a, d) => a + d.employees, 0);
  assert.strictEqual(employees, result.counts.imported);
});

// ============================================================
// Headers
// ============================================================

test('header aliases and stray whitespace are tolerated', () => {
  const buf = buildXlsx({
    sheetName: EXPECTED_SHEET,
    rows: [
      ['  Emp#  ', 'Last Name', 'First Name', 'Is Salary',
       'Pay Rate', 'Regular Hours', 'Overtime', 'Total Hours', 'Total Earnings'],
      ['0063', 'Smith', 'Ana', 'No', 30, 10, 3, 13, 480]
    ]
  });

  const result = buildImport({ fileBuffer: buf, workDate: MONDAY, employees: ROSTER, timeZone: TZ });
  assert.strictEqual(result.counts.imported, 1);
  assert.strictEqual(result.rows[0].employee_number, '0063');
  assert.strictEqual(result.rows[0].ot_hours, 3);
  assert.strictEqual(result.rows[0].ot_dollars, 180);
});

test('a missing required column names the column and lists what was found', () => {
  const headers = PAYROLL_HEADERS.filter(h => h !== 'Total Earnings');
  const buf = buildXlsx({
    sheetName: EXPECTED_SHEET,
    rows: [headers, ['0063', 'Smith', 'Ana', 'No', 30, 10, 3, 13]]
  });

  assert.throws(
    () => buildImport({ fileBuffer: buf, workDate: MONDAY, employees: ROSTER, timeZone: TZ }),
    err => {
      assert.match(err.message, /Total Earnings/);
      assert.match(err.message, /Emp #/);          // the headers that WERE found
      assert.match(err.message, /Total Hours/);
      return true;
    }
  );
});

test('a renamed sheet still imports but says so', () => {
  const buf = buildXlsx({
    sheetName: 'Payroll Summary 2026',
    rows: [PAYROLL_HEADERS, ['0063', 'Smith', 'Ana', 'No', 30, 10, 0, 10, 300]]
  });

  const result = buildImport({ fileBuffer: buf, workDate: MONDAY, employees: ROSTER, timeZone: TZ });
  assert.strictEqual(result.counts.imported, 1);
  assert.strictEqual(result.sheetName, 'Payroll Summary 2026');

  const warning = result.anomalies.find(a => a.type === 'sheet_name_fallback');
  assert.ok(warning, 'falling back to the first sheet must be recorded');
  assert.match(warning.detail, /Work Summary Payroll/);
});

// ============================================================
// Row shape
// ============================================================

test('rows come out as daily_hours columns, ready to POST', () => {
  const result = importFrom(
    [row('0319', 'Acosta Ruiz', 'Miguel', 'No', 24.5, 10, 2.5, 12.5, 336.88)],
    {
      source: 'email',
      sourceSubject: 'Work Summary Payroll',
      emailReceivedAt: '2026-08-18T13:04:00.000Z',
      dateSource: 'email_received',
      uploadBatchId: '11111111-2222-3333-4444-555555555555'
    }
  );

  assert.deepStrictEqual(result.rows[0], {
    work_date: MONDAY,
    employee_number: '0319',
    last_name: 'Acosta Ruiz',
    first_name: 'Miguel',
    is_salary: false,
    pay_rate: 24.5,
    regular_hours: 10,
    ot_hours: 2.5,
    total_hours: 12.5,
    total_earnings: 336.88,
    ot_dollars: 91.88,
    regular_dollars: 245,
    department: 'Production',
    source: 'email',
    source_subject: 'Work Summary Payroll',
    email_received_at: '2026-08-18T13:04:00.000Z',
    file_hash: result.fileHash,
    date_source: 'email_received',
    flags: [],
    upload_batch_id: '11111111-2222-3333-4444-555555555555'
  });

  // is_scheduled_day is a generated column — sending it would be rejected.
  assert.strictEqual('is_scheduled_day' in result.rows[0], false);

  assert.strictEqual(result.uploadBatchId, '11111111-2222-3333-4444-555555555555');
  assert.strictEqual(result.sample.length, 1);
  assert.strictEqual(result.sample[0].name, 'Miguel Acosta Ruiz');
});

test('the display sample stops at twenty rows however long the file is', () => {
  const many = Array.from({ length: 25 }, (_, i) =>
    row(String(1000 + i), 'Last' + i, 'First' + i, 'No', 20, 10, 0, 10, 200));
  const result = importFrom(many);
  assert.strictEqual(result.counts.imported, 25);
  assert.strictEqual(result.sample.length, 20);
});

test('a header-only file imports nothing rather than throwing', () => {
  const result = importFrom([]);
  assert.strictEqual(result.counts.totalRows, 0);
  assert.strictEqual(result.counts.imported, 0);
  assert.deepStrictEqual(result.rows, []);
  assert.deepStrictEqual(result.departments, []);
  assert.strictEqual(result.totals.totalEarnings, 0);
});

test('buildImport refuses to run on nothing at all', () => {
  assert.throws(() => buildImport({ workDate: MONDAY, employees: ROSTER }),
    /fileBuffer or a parsed sheet/);
});

// ============================================================
// The /api/payroll-import handler
// ============================================================
//
// The handler is exercised for real — session check, body parsing, action
// dispatch, status codes — with payroll-db swapped for stubs through the module
// cache. payroll-import calls db.<fn>() at call time, so replacing the module's
// exports is enough and nothing reaches Supabase.

process.env.SESSION_SECRET = 'test-session-secret';
process.env.PAYROLL_TIME_ZONE = TZ;
// payroll-db reads these once, at require time, so they have to exist before
// the module is loaded even though every request below goes through a stub.
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

const { createHmac } = require('node:crypto');

const payrollDb = require('../netlify/functions/payroll-db');
const REAL_DB = { ...payrollDb };
const { handler } = require('../netlify/functions/payroll-import');

// Yesterday in Pacific, so validateWorkDate is happy whenever the suite runs.
const shiftDay = (dateStr, days) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * 86400000).toISOString().slice(0, 10);
};
const WORK_DATE = shiftDay(workDateInfo(null, TZ).date, -1);
const OTHER_DATE = shiftDay(WORK_DATE, -1);

const FILE_BASE64 = buildPayrollXlsx([
  row('0319', 'Acosta Ruiz', 'Miguel', 'No', 24.5, 10, 0, 10, 245),
  row('0063', 'Smith',       'Ana',    'No', 30,   10, 2, 12, 390)
]).toString('base64');

function sessionCookie() {
  const b64 = Buffer.from(JSON.stringify({
    email: 'peter.stroble@sequoiafp.com', exp: Date.now() + 3600000
  })).toString('base64url');
  const sig = createHmac('sha256', process.env.SESSION_SECRET).update(b64).digest('base64url');
  return `sfp_session=${b64}.${sig}`;
}

const invoke = async body => {
  const res = await handler({
    httpMethod: 'POST',
    headers: { cookie: sessionCookie() },
    body: JSON.stringify(body)
  });
  return { statusCode: res.statusCode, body: JSON.parse(res.body) };
};

// A stored daily_hours row, as PostgREST hands it back.
const storedRow = (empNumber, workDate, batch) => ({
  id: `id-${empNumber}-${workDate}`,
  work_date: workDate,
  employee_number: empNumber,
  upload_batch_id: batch,
  source: 'manual',
  created_at: '2026-08-18T09:00:00.000Z',
  total_hours: 10,
  total_earnings: 250,
  file_hash: null,
  flags: [],
  department: 'Production'
});

// Installs stub db functions for one test and restores the real module after.
function stubDb(t, overrides = {}) {
  const calls = { order: [], upserts: [], deletedDates: [], pruned: [], ledger: [] };
  Object.assign(payrollDb, {
    fetchEmployees: async () => ROSTER,
    fetchDailyHours: async () => [],
    fetchDailyHoursForDate: async () => [],
    findRowsByFileHash: async () => [],
    upsertDailyHours: async rows => {
      calls.order.push('upsert');
      calls.upserts.push(rows);
      return rows.map((r, i) => ({ id: `new-${i}`, ...r }));
    },
    deleteDailyHoursForDate: async date => {
      calls.order.push('deleteDay');
      calls.deletedDates.push(date);
      return 2;
    },
    deleteOtherBatchesForDate: async (date, batch) => {
      calls.order.push('prune');
      calls.pruned.push({ date, batch });
      return 1;
    },
    getProcessedEmail: async () => null,
    upsertProcessedEmail: async record => { calls.ledger.push(record); return record; },
    listProcessedEmails: async () => []
  }, overrides);
  t.after(() => { Object.assign(payrollDb, REAL_DB); });
  return calls;
}

function captureConsoleError(t) {
  const original = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  t.after(() => { console.error = original; });
  return logged;
}

const commitBody = extra => ({
  action: 'commit', fileName: 'payroll.xlsx', fileBase64: FILE_BASE64, workDate: WORK_DATE, ...extra
});

test('a failed write during an overwrite leaves the existing day intact', async (t) => {
  // The day is modelled as an array so a delete really removes it. Under the
  // old delete-then-insert order this ends up empty and unreplaced: a day of
  // payroll destroyed by one transient 5xx.
  const day = [storedRow('0319', WORK_DATE, 'old-batch')];
  const calls = stubDb(t, {
    fetchDailyHoursForDate: async () => day.slice(),
    upsertDailyHours: async () => {
      calls.order.push('upsert');
      throw new Error('POST daily_hours 503: <html>upstream connect error</html>');
    },
    deleteDailyHoursForDate: async () => { calls.order.push('deleteDay'); day.length = 0; return 1; },
    deleteOtherBatchesForDate: async () => { calls.order.push('prune'); day.length = 0; return 1; }
  });
  const logged = captureConsoleError(t);

  const res = await invoke(commitBody({ confirmOverwrite: true }));

  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(res.body.ok, false);
  assert.strictEqual(day.length, 1, 'the previous day must survive a failed write');
  assert.deepStrictEqual(calls.order, ['upsert'], 'nothing may be deleted before the write lands');
  assert.strictEqual(logged.length, 1);
});

test('a successful overwrite writes first, then prunes only the rows the new batch did not write', async (t) => {
  const calls = stubDb(t, {
    fetchDailyHoursForDate: async () => [
      storedRow('0319', WORK_DATE, 'old-batch'),
      storedRow('0771', WORK_DATE, 'old-batch')
    ]
  });

  const res = await invoke(commitBody({ confirmOverwrite: true }));

  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(calls.order, ['upsert', 'prune']);
  assert.deepStrictEqual(calls.deletedDates, [], 'the whole day must never be deleted');
  assert.strictEqual(calls.pruned.length, 1);
  assert.strictEqual(calls.pruned[0].date, WORK_DATE);
  assert.strictEqual(calls.pruned[0].batch, res.body.uploadBatchId);
  assert.strictEqual(res.body.inserted, 2);
  assert.strictEqual(res.body.replaced, 2);
  assert.strictEqual(res.body.removed, 1);
});

test('a first import of a date writes without pruning anything', async (t) => {
  const calls = stubDb(t);

  const res = await invoke(commitBody({}));

  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(calls.order, ['upsert']);
  assert.strictEqual(res.body.replaced, 0);
  assert.strictEqual(res.body.removed, 0);
  assert.strictEqual(res.body.inserted, 2);
});

test('an empty representation from a non-empty write is a failure, not a silent no-op', async (t) => {
  const calls = stubDb(t, { upsertDailyHours: async () => { calls.order.push('upsert'); return []; } });
  const logged = captureConsoleError(t);

  const res = await invoke(commitBody({}));

  assert.strictEqual(res.statusCode, 500);
  assert.match(res.body.error, /did not take effect/);
  assert.deepStrictEqual(calls.order, ['upsert'], 'a failed write must not trigger the prune');
  assert.strictEqual(logged.length, 1);
});

test('the same file under a different date is refused, and named, unless confirmed', async (t) => {
  const stubs = { findRowsByFileHash: async () => [storedRow('0319', OTHER_DATE, 'earlier-batch')] };
  const calls = stubDb(t, stubs);

  const refused = await invoke(commitBody({}));
  assert.strictEqual(refused.statusCode, 400);
  assert.match(refused.body.error, new RegExp(OTHER_DATE));
  assert.match(refused.body.error, /twice/);
  assert.strictEqual(calls.upserts.length, 0, 'nothing may be written while the duplicate stands');

  const allowed = await invoke(commitBody({ confirmDuplicateFile: true }));
  assert.strictEqual(allowed.statusCode, 200);
  assert.strictEqual(calls.upserts.length, 1);
});

test('the same file re-uploaded under the SAME date needs no duplicate confirmation', async (t) => {
  const sameDay = [storedRow('0319', WORK_DATE, 'earlier-batch')];
  const calls = stubDb(t, {
    fetchDailyHoursForDate: async () => sameDay.slice(),
    findRowsByFileHash: async () => sameDay.slice()
  });

  const res = await invoke(commitBody({ confirmOverwrite: true }));

  assert.strictEqual(res.statusCode, 200, res.body.error);
  assert.strictEqual(calls.upserts.length, 1);
});

test('a Supabase failure that mentions a column is a 500 and reaches the log', async (t) => {
  // PGRST204 is a schema-cache miss — an outage, not bad input. Matching the
  // word "column" in the message used to answer it as a 400 and log nothing,
  // so Netlify's alerting never saw it.
  const calls = stubDb(t, {
    upsertDailyHours: async () => {
      calls.order.push('upsert');
      throw new Error(`POST daily_hours 400: {"code":"PGRST204","message":` +
        `"Could not find the 'is_scheduled_day' column of 'daily_hours' in the schema cache"}`);
    }
  });
  const logged = captureConsoleError(t);

  const res = await invoke(commitBody({}));

  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(logged.length, 1, 'a server failure must be logged');
  assert.match(String(logged[0][0]), /payroll-import commit failed/);
});

test('a roster read that fails is a 500 and reaches the log even when it mentions a sheet', async (t) => {
  stubDb(t, {
    fetchEmployees: async () => { throw new Error('GET employees 502: bad gateway (sheet cache)'); }
  });
  const logged = captureConsoleError(t);

  const res = await invoke(commitBody({}));

  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(logged.length, 1);
});

test('an unreadable upload is still a 400, and is not logged as a server failure', async (t) => {
  stubDb(t);
  const logged = captureConsoleError(t);

  const res = await invoke(commitBody({ fileBase64: Buffer.from('not a workbook').toString('base64') }));

  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(logged.length, 0);
});

test('resolveEmail closes a queue entry without losing the audit trail', async (t) => {
  const stored = {
    message_id: '<msg-7@centralservers.com>',
    processed_at: '2026-08-18T13:10:00.000Z',
    work_date: OTHER_DATE,
    status: 'pending_review',
    error: 'two attachments with different bytes — imported neither',
    subject: 'Work Summary Payroll',
    from_address: 'no-reply@centralservers.com',
    received_at: '2026-08-18T13:04:00.000Z',
    file_hash: 'abc123',
    upload_batch_id: null,
    rows_imported: 0,
    flags: ['duplicate_day'],
    notified_at: '2026-08-18T13:10:00.000Z'
  };
  const calls = stubDb(t, { getProcessedEmail: async () => ({ ...stored }) });

  const res = await invoke({ action: 'resolveEmail', messageId: stored.message_id, note: 'imported by hand' });

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(res.body.messageId, stored.message_id);
  assert.strictEqual(res.body.status, 'resolved');

  const written = calls.ledger[0];
  assert.strictEqual(written.status, 'resolved');
  assert.notStrictEqual(written.processed_at, stored.processed_at);
  assert.match(written.error, /^Resolved /);
  assert.match(written.error, /imported by hand/);
  assert.match(written.error, /two attachments/);      // the original detail is kept
  assert.strictEqual(written.subject, stored.subject); // and so is every other column
  assert.strictEqual(written.file_hash, stored.file_hash);
  assert.deepStrictEqual(written.flags, stored.flags);
});

test('resolveEmail refuses an unknown message id', async (t) => {
  const calls = stubDb(t, { getProcessedEmail: async () => null });
  const logged = captureConsoleError(t);

  const res = await invoke({ action: 'resolveEmail', messageId: '<nope@example.com>' });

  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.error, /No ingestion record/);
  assert.strictEqual(calls.ledger.length, 0);
  assert.strictEqual(logged.length, 0);
});

test('the pending queue marks which rows are actually waiting on a person', async (t) => {
  stubDb(t, {
    listProcessedEmails: async () => [
      { message_id: '<a>', status: 'pending_review' },
      { message_id: '<b>', status: 'error' },
      { message_id: '<c>', status: 'duplicate_file' },
      { message_id: '<d>', status: 'rejected' },
      { message_id: '<e>', status: 'resolved' }
    ]
  });

  const res = await invoke({ action: 'pending' });

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.emails.length, 5, 'everything is still listed');
  assert.deepStrictEqual(
    res.body.emails.map(e => [e.message_id, e.actionable]),
    [['<a>', true], ['<b>', true], ['<c>', false], ['<d>', false], ['<e>', false]]
  );
});

test('an unknown action names the ones that exist, including resolveEmail', async (t) => {
  stubDb(t);
  const res = await invoke({ action: 'nope' });
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.error, /resolveEmail/);
});

// ============================================================
// payroll-db against a stubbed fetch
// ============================================================

// Everything below drives the real Supabase helpers with globalThis.fetch
// replaced, so the URLs, the request bodies and the chunking are checked
// exactly as PostgREST would receive them.
function stubFetch(t, respond) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const call = {
      url: String(url),
      method: opts.method || 'GET',
      body: opts.body === undefined ? undefined : JSON.parse(opts.body)
    };
    calls.push(call);
    const payload = await respond(call);
    return { ok: true, status: 200, text: async () => JSON.stringify(payload || []) };
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

test('deleteOtherBatchesForDate deletes the date except the batch just written', async (t) => {
  const calls = stubFetch(t, () => [{ id: 'x' }, { id: 'y' }]);

  const deleted = await payrollDb.deleteOtherBatchesForDate('2026-08-17', 'batch-9');

  assert.strictEqual(deleted, 2);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].method, 'DELETE');
  assert.match(calls[0].url, /daily_hours\?work_date=eq\.2026-08-17/);
  assert.match(calls[0].url, /upload_batch_id=neq\.batch-9/);
});

test('a network failure says what actually broke instead of just "fetch failed"', async (t) => {
  stubFetch(t, () => { throw Object.assign(new TypeError('fetch failed'), {
    cause: new Error('getaddrinfo ENOTFOUND example.supabase.co')
  }); });

  await assert.rejects(
    () => payrollDb.fetchEmployees(),
    err => {
      assert.match(err.message, /ENOTFOUND example\.supabase\.co/);
      assert.match(err.message, /GET employees/);
      return true;
    }
  );
});

test('a re-stamp clears the flags that said the row had no department', async (t) => {
  const stored = [
    { id: 'r1', work_date: '2026-08-17', employee_number: '0884', department: null,
      flags: ['missing_department'] },
    { id: 'r2', work_date: '2026-08-17', employee_number: '9999', department: null,
      flags: ['unknown_employee', 'negative_residual'] }
  ];
  const roster = [
    { id: 'e4', name: 'Rosa Salazar De Leon', employee_number: '0884', department: 'Shipping' },
    { id: 'e9', name: 'Nadia Nobody',         employee_number: '9999', department: 'Production' }
  ];
  const calls = stubFetch(t, call => {
    if (call.method === 'GET' && call.url.includes('daily_hours')) return stored;
    if (call.method === 'GET' && call.url.includes('employees')) return roster;
    return [{ id: 'patched' }];
  });

  const result = await payrollDb.restampDepartments('2026-08-17', '2026-08-17');

  assert.strictEqual(result.updated, 2);
  const patches = calls.filter(c => c.method === 'PATCH');
  assert.strictEqual(patches.length, 2, 'the two rows keep different flags, so two bodies');

  const shipping = patches.find(p => p.body.department === 'Shipping');
  assert.deepStrictEqual(shipping.body.flags, [],
    'missing_department is no longer true once a department is stamped on');

  const production = patches.find(p => p.body.department === 'Production');
  assert.deepStrictEqual(production.body.flags, ['negative_residual'],
    'unrelated flags must survive');
});

test('the id filter is chunked small enough to leave the proxy real headroom', async (t) => {
  const stored = Array.from({ length: 150 }, (_, i) => ({
    id: `4f1c9d2e-0000-4000-8000-${String(i).padStart(12, '0')}`,
    work_date: '2026-08-17',
    employee_number: String(1000 + i),
    department: null,
    flags: []
  }));
  const roster = stored.map(r => ({
    id: `e${r.employee_number}`, name: `Person ${r.employee_number}`,
    employee_number: r.employee_number, department: 'Production'
  }));
  const calls = stubFetch(t, call => {
    if (call.method === 'GET' && call.url.includes('daily_hours')) return stored;
    if (call.method === 'GET' && call.url.includes('employees')) return roster;
    return call.url.slice(call.url.indexOf('in.(')).split(',').map(() => ({ id: 'patched' }));
  });

  await payrollDb.restampDepartments('2026-08-17', '2026-08-17');

  const patches = calls.filter(c => c.method === 'PATCH');
  assert.strictEqual(patches.length, 2, '150 ids at 100 per request is two requests');
  const longest = Math.max(...patches.map(p => Buffer.byteLength(p.url, 'utf8')));
  assert.ok(longest < 4096,
    `an id filter must stay well inside an 8 KB header buffer, measured ${longest}`);
});

// ------------------------------------------------------------
// request() options and the week index
// ------------------------------------------------------------
//
// The report's week index is the one read that has to prove it saw everything,
// so payroll-db is what emits the projection, the ordering, the page and the
// count preference — these check the URL and headers PostgREST would receive,
// and what a Content-Range is read back as.

// Like stubFetch above, but it also records the request headers and answers with
// a Content-Range, which is where PostgREST puts an exact count.
function stubFetchWithHeaders(t, reply) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', headers: opts.headers || {} });
    const { rows = [], contentRange } = reply(calls.length) || {};
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(rows),
      headers: contentRange === undefined
        ? undefined   // a proxy that stripped the header, or a response with none
        : { get: name => (String(name).toLowerCase() === 'content-range' ? contentRange : null) }
    };
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

test('request() turns select/order/limit/offset into a query string and asks for the count', async (t) => {
  const calls = stubFetchWithHeaders(t, () => ({ rows: [{ work_date: '2026-08-17' }], contentRange: '0-0/1' }));

  const page = await payrollDb.request('GET', 'daily_hours?work_date=gte.2026-08-01', {
    select: 'work_date,total_hours',
    order: 'work_date.desc',
    offset: 10,
    limit: 500,
    count: 'exact'
  });

  assert.strictEqual(calls.length, 1);
  assert.match(calls[0].url, /daily_hours\?work_date=gte\.2026-08-01&select=work_date,total_hours&order=work_date\.desc&offset=10&limit=500$/);
  assert.strictEqual(calls[0].headers.Prefer, 'count=exact',
    'a counted read asks for the count, not for a representation of a write');
  assert.strictEqual(calls[0].headers.apikey, 'service-key');
  assert.match(calls[0].headers.Authorization, /^Bearer /);

  assert.deepStrictEqual(page.rows, [{ work_date: '2026-08-17' }]);
  assert.strictEqual(page.contentRange, '0-0/1');
  assert.strictEqual(page.total, 1);
});

test('request() without options is the plain call the other helpers make', async (t) => {
  const calls = stubFetchWithHeaders(t, () => ({ rows: [] }));

  const page = await payrollDb.request('GET', 'employees?select=id');

  assert.match(calls[0].url, /employees\?select=id$/, 'no options, no extra query string');
  assert.strictEqual(calls[0].headers.Prefer, 'return=representation',
    'the default Prefer is untouched when no count is asked for');
  assert.strictEqual(page.total, null, 'a response with no headers at all proves nothing');
});

test('a Prefer set by the caller survives, with the count appended', async (t) => {
  const calls = stubFetchWithHeaders(t, () => ({ rows: [], contentRange: '*/*' }));

  await payrollDb.request('POST', 'daily_hours?on_conflict=work_date,employee_number', {
    body: [{ work_date: '2026-08-17' }],
    headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' },
    count: 'exact'
  });

  assert.strictEqual(calls[0].headers.Prefer,
    'resolution=merge-duplicates,return=representation,count=exact');
});

test('fetchDailyHoursIndex reads three columns, newest first, one counted page', async (t) => {
  const calls = stubFetchWithHeaders(t, () => ({
    rows: [{ work_date: '2026-08-17', total_hours: 10, total_earnings: 280 }],
    contentRange: '0-9/17384'
  }));

  const page = await payrollDb.fetchDailyHoursIndex('2025-07-14', '2026-08-23', { offset: 0, limit: 5000 });

  assert.strictEqual(calls.length, 1);
  assert.match(calls[0].url, /select=work_date,total_hours,total_earnings/);
  assert.ok(!/pay_rate|ot_dollars|employee_number/.test(calls[0].url),
    'the index must not drag the payroll detail columns through the window scan');
  // Descending, so a server-side row cap drops the OLDEST weeks, never the one
  // the report is about to default to.
  assert.match(calls[0].url, /order=work_date\.desc/);
  assert.match(calls[0].url, /offset=0&limit=5000/);
  assert.match(calls[0].url, /work_date=gte\.2025-07-14&work_date=lte\.2026-08-23/);
  assert.strictEqual(calls[0].headers.Prefer, 'count=exact');

  // "0-9/17384" is the shape a capped page has: ten rows in hand, 17,384 that
  // exist. The count is what lets the caller tell those apart.
  assert.strictEqual(page.total, 17384);
  assert.strictEqual(page.rows.length, 1);
});

test('an unparseable or missing Content-Range reads as null, never as zero', async (t) => {
  stubFetchWithHeaders(t, call => ({
    rows: [],
    // First call: PostgREST answered without computing a count. Second: a proxy
    // dropped the header entirely.
    contentRange: call === 1 ? '*/*' : undefined
  }));

  const starred = await payrollDb.fetchDailyHoursIndex('2026-08-01', '2026-08-07');
  assert.strictEqual(starred.total, null, '"*" is "not counted", not "none"');

  const stripped = await payrollDb.fetchDailyHoursIndex('2026-08-01', '2026-08-07');
  assert.strictEqual(stripped.total, null, 'a missing header proves nothing either');
  assert.strictEqual(stripped.contentRange, null);
});

test('fetchDailyHoursIndex defaults to a single full page', async (t) => {
  const calls = stubFetchWithHeaders(t, () => ({ rows: [], contentRange: '*/0' }));

  await payrollDb.fetchDailyHoursIndex('2026-08-01', '2026-08-07');

  assert.match(calls[0].url, /offset=0&limit=5000/);
});
