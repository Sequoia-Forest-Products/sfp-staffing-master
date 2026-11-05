// Run with: npm test
//
// hours-import-lib: who counts (by roster, never by name), what a dated
// (weekly) file says, and what a reconciliation changed.

const test = require('node:test');
const assert = require('node:assert');

const {
  classifyRows, buildDatedImport, parseCellDate, computeVariance, eachDate
} = require('../netlify/functions/hours-import-lib');
const { buildXlsx } = require('./helpers/make-xlsx');

const ROSTER = [
  { id: 'a', name: 'Hourly One', employee_number: '0101', pay_type: 'Hourly', wage: '20.00', status: 'Active', department: 'Production', cost_class: 'Manufacturing' },
  { id: 'b', name: 'Hourly Two', employee_number: '0202', pay_type: 'Hourly', wage: '30.00', status: 'Active', department: 'Maintenance', cost_class: 'Manufacturing' },
  { id: 'c', name: 'Salaried', employee_number: '0303', pay_type: 'Salaried', annual_salary: 104000, status: 'Active', department: 'Production', cost_class: 'Manufacturing' }
];
const r = (date, emp, reg, ot, extra = {}) => ({
  work_date: date, employee_number: emp, regular_hours: reg, ot_hours: ot,
  total_hours: reg + ot, first_name: 'F' + emp, last_name: 'L' + emp, flags: [], ...extra
});

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

test('only rostered, non-salaried numbers are counted; everything else is held with its reason', () => {
  const out = classifyRows({
    rows: [r('2026-11-02', '0101', 10, 0), r('2026-11-02', '0303', 8, 0),
           r('2026-11-02', '9001', 8, 0), r('2026-11-02', '3380', 11, 0.62, { flags: ['unknown_employee'] })],
    salariedRows: [r('2026-11-02', '0404', 0, 0)],
    employees: ROSTER,
    exclusions: [{ employee_number: '9001' }]
  });
  assert.deepStrictEqual(out.counted.map(x => x.employee_number), ['0101']);
  assert.deepStrictEqual(
    Object.fromEntries(out.held.map(h => [h.employee_number, h.reason])),
    { '0303': 'salaried', '9001': 'external', '3380': 'unknown', '0404': 'salaried' });
  assert.deepStrictEqual(out.unknown, [{ employeeNumber: '3380', name: 'F3380 L3380', dates: ['2026-11-02'], hours: 11.62 }]);
});

test('classification keys on the number, so a name never decides anything', () => {
  // Same name as a rostered person, different number: still unknown.
  const out = classifyRows({ rows: [r('2026-11-02', '7777', 10, 0, { first_name: 'Hourly', last_name: 'One' })], employees: ROSTER });
  assert.strictEqual(out.counted.length, 0);
  assert.strictEqual(out.held[0].reason, 'unknown');
});

test('an unpadded number in the file still matches the padded roster number', () => {
  const out = classifyRows({ rows: [r('2026-11-02', '101', 10, 0)], employees: ROSTER });
  assert.strictEqual(out.counted.length, 1);
});

test('the parser\'s unknown_employee flag is stripped once the roster does know the number', () => {
  const out = classifyRows({ rows: [r('2026-11-02', '0101', 10, 0, { flags: ['unknown_employee', 'long_day'] })], employees: ROSTER });
  assert.deepStrictEqual(out.counted[0].flags, ['long_day']);
});

// ---------------------------------------------------------------------------
// Dated files
// ---------------------------------------------------------------------------

test('cell dates read as Excel serials, ISO and US M/D/YYYY, and nothing else', () => {
  assert.strictEqual(parseCellDate(46328), '2026-11-02');
  assert.strictEqual(parseCellDate('2026-11-02'), '2026-11-02');
  assert.strictEqual(parseCellDate('11/2/2026'), '2026-11-02');
  assert.strictEqual(parseCellDate('11/02/26'), '2026-11-02');
  assert.strictEqual(parseCellDate('Monday'), null);
  assert.strictEqual(parseCellDate(''), null);
});

const WEEKLY_HEADERS = ['Date', 'Emp #', 'Last Name', 'First Name', 'Regular', 'OT', 'Total Hours'];

test('a dated file imports per day, covers every day in its range, and sums split punches', () => {
  const file = buildXlsx({ sheetName: 'Weekly', rows: [
    WEEKLY_HEADERS,
    ['11/2/2026', '0101', 'L', 'F', 6, 0, 6],
    ['11/2/2026', '0101', 'L', 'F', 4, 0.5, 4.5],   // second punch, same day
    ['11/2/2026', '0202', 'L', 'F', 10, 0, 10],
    ['11/4/2026', '0101', 'L', 'F', 10, 0, 10]
  ] });
  const out = buildDatedImport({ fileBuffer: file, employees: ROSTER, source: 'email' });
  assert.deepStrictEqual(out.dates, ['2026-11-02', '2026-11-03', '2026-11-04'],
    '11/3 has no rows and is still covered, so the replace empties it');
  const d1 = out.days[0].rows;
  const one = d1.find(x => x.employee_number === '0101');
  assert.strictEqual(one.regular_hours, 10);
  assert.strictEqual(one.ot_hours, 0.5);
  assert.strictEqual(one.total_hours, 10.5);
  assert.strictEqual(out.days[1].rows.length, 0);
  assert.strictEqual(out.days[0].rows[0].date_source, 'file');
});

test('a file with no date column is refused as a dated file', () => {
  const file = buildXlsx({ rows: [['Emp #', 'Is Salary', 'Regular', 'OT', 'Total Hours'], ['0101', 'No', 10, 0, 10]] });
  assert.throws(() => buildDatedImport({ fileBuffer: file, employees: ROSTER }), /no per-row date column/);
});

test('one unreadable date refuses the whole file — it cannot be allowed to replace any day', () => {
  const file = buildXlsx({ rows: [WEEKLY_HEADERS, ['11/2/2026', '0101', 'L', 'F', 10, 0, 10], ['someday', '0202', 'L', 'F', 10, 0, 10]] });
  assert.throws(() => buildDatedImport({ fileBuffer: file, employees: ROSTER }), /cannot read/);
});

test('eachDate is inclusive and steps whole days', () => {
  assert.deepStrictEqual(eachDate('2026-10-31', '2026-11-02'), ['2026-10-31', '2026-11-01', '2026-11-02']);
});

// ---------------------------------------------------------------------------
// Variance
// ---------------------------------------------------------------------------

test('variance prices hours with the PR #59 rule and finds the fixed punches', () => {
  const before = [r('2026-11-02', '0101', 10, 0), r('2026-11-03', '0101', 0, 0)];
  const after = [r('2026-11-02', '0101', 10, 2), r('2026-11-03', '0101', 10, 0), r('2026-11-03', '0202', 10, 0)];
  const v = computeVariance({ before, after, employees: ROSTER, dates: ['2026-11-02', '2026-11-03'] });

  // 11/2: 10 reg @20 -> 10 reg + 2 OT @ 1.5x = 200 -> 260.
  assert.strictEqual(v.days[0].dollarsBefore, 200);
  assert.strictEqual(v.days[0].dollarsAfter, 260);
  // 11/3: 0 -> 200 + 300.
  assert.strictEqual(v.days[1].dollarsChange, 500);
  assert.strictEqual(v.totals.dollarsChange, 560);
  assert.strictEqual(v.totals.hoursChange, 22);
  assert.deepStrictEqual(v.changedDays, ['2026-11-02', '2026-11-03']);
  assert.deepStrictEqual(v.fixedPunches.map(f => [f.date, f.employeeNumber, f.wasMissing]),
    [['2026-11-03', '0101', false], ['2026-11-03', '0202', true]]);
  assert.strictEqual(v.totals.dollarsChangePct, 280);
});

test('a person with no rate changes the hours but is reported, not priced at zero', () => {
  const v = computeVariance({ before: [], after: [r('2026-11-02', '5555', 10, 0)],
    employees: [{ employee_number: '5555', pay_type: 'Hourly', wage: null, status: 'Active' }], dates: ['2026-11-02'] });
  assert.strictEqual(v.totals.hoursChange, 10);
  assert.deepStrictEqual(v.ratesMissing, ['5555']);
  assert.strictEqual(v.employees[0].dollarsChange, null);
});

// ---------------------------------------------------------------------------
// Day status
// ---------------------------------------------------------------------------

const { summarizeDayStatus } = require('../netlify/functions/hours-import-lib');

test('day status counts provisional, reconciled and nothing-imported, and never a future day', () => {
  const s = summarizeDayStatus([
    { work_date: '2026-11-02', status: 'reconciled', last_import_id: 'w1' },
    { work_date: '2026-11-03', status: 'reconciled', last_import_id: 'w1' },
    { work_date: '2026-11-04', status: 'provisional' }
  ], ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'], '2026-11-06');
  assert.strictEqual(s.reconciled, 2);
  assert.strictEqual(s.provisional, 1);
  assert.strictEqual(s.none, 1, '11/5 has happened and nothing is imported');
  assert.strictEqual(s.days.length, 4, '11/6 is today and is not counted');
  assert.deepStrictEqual(s.reconciliationImportIds, ['w1']);
});
