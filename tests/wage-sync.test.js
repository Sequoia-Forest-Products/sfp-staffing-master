// Run with: npm test   (node --test, no extra dependencies)
//
// The daily BBSI file is the source of truth for hourly wages, which means this
// module overwrites real payroll every morning. Every test here injects its own
// file rows, roster and work date; nothing touches Supabase, and the applier is
// exercised with fake writers so the ORDER of the writes is asserted rather than
// assumed.
//
// The cases that matter most are the ones about NOT writing: an employee absent
// from the file, and a row whose rate is missing or zero. Either mistake zeroes
// the rate of a real person, so each is tested from several directions.

const test = require('node:test');
const assert = require('node:assert');

const {
  normalizeRate,
  effectiveHourlyRate,
  planWageSync,
  isSalaried,
  isSalaryWage,
  DEFAULT_THRESHOLD_PCT,
  SALARY_HOURS_PER_YEAR
} = require('../netlify/functions/wage-sync');

// payroll-db reads these once, at require time, so they have to exist before it
// is loaded — the roster-projection tests below drive the real Supabase helper
// against a stubbed fetch and would otherwise fail on missing configuration.
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

const payrollDb = require('../netlify/functions/payroll-db');
const { applyWageSync } = payrollDb;

// The file describes Monday the 17th. "Today" is deliberately never this date —
// effective_date must be the day the file describes.
const WORK_DATE = '2026-08-17';

// The roster's awkward cases, kept from tests/payroll.test.js: two people called
// Smith, compound surnames, an unpadded employee_number, somebody with no usable
// wage yet, a salaried person in Manufacturing and a salaried person outside it.
const ROSTER = [
  { id: 'e1', name: 'Miguel Acosta Ruiz',   employee_number: '0319', department: 'Production',  cost_class: 'Manufacturing', wage: '24.50', status: 'Active' },
  { id: 'e2', name: 'Ana Smith',            employee_number: '0063', department: 'Maintenance', cost_class: 'Manufacturing', wage: '30.00', status: 'Active' },
  { id: 'e3', name: 'Dale Smith',           employee_number: '0771', department: 'Shipping',    cost_class: 'Manufacturing', wage: '28.00', status: 'Active' },
  { id: 'e4', name: 'Rosa Salazar De Leon', employee_number: '0884', department: null,          cost_class: null,            wage: '',      status: 'Active' },
  { id: 'e5', name: 'Luis Sanchez Lopez',   employee_number: '905',  department: 'Saw Filing',  cost_class: 'Manufacturing', wage: '26.00', status: 'Active' },
  { id: 'e6', name: 'Eduardo Rivera',       employee_number: '0007', department: 'Production',  cost_class: 'Manufacturing', wage: 'Salary', status: 'Active', annual_salary: 104000 },
  { id: 'e7', name: 'Axeri Ramirez',        employee_number: '0011', department: 'SG&A',        cost_class: 'SG&A',          wage: 'Salary', status: 'Active', annual_salary: 90000 },
  { id: 'e8', name: 'Gone Last Month',      employee_number: '0400', department: 'Production',  cost_class: 'Manufacturing', wage: '21.00', status: 'Terminated' }
];

// A row exactly as payroll-lib.buildImport emits it into daily_hours.
const fileRow = (employeeNumber, payRate, extra = {}) => ({
  work_date: WORK_DATE,
  employee_number: employeeNumber,
  last_name: 'Doe',
  first_name: 'Jane',
  is_salary: false,
  pay_rate: payRate,
  regular_hours: 10,
  ot_hours: 0,
  total_hours: 10,
  total_earnings: 0,
  ...extra
});

const plan = (fileRows, opts = {}) => planWageSync({
  fileRows,
  employees: ROSTER,
  workDate: WORK_DATE,
  thresholdPct: 20,
  ...opts
});

const historyFor = (result, employeeNumber) =>
  result.history.filter(h => h.employee_number === employeeNumber);

const updateFor = (result, employeeNumber) =>
  result.updates.find(u => u.employeeNumber === employeeNumber) || null;

// ============================================================
// normalizeRate — "a missing or zero rate is not a rate"
// ============================================================

test('normalizeRate reads the numbers a real file carries', () => {
  assert.strictEqual(normalizeRate(24.5), 24.5);
  assert.strictEqual(normalizeRate('24.50'), 24.5);
  assert.strictEqual(normalizeRate('$24.50'), 24.5);
  assert.strictEqual(normalizeRate(' 24.50 '), 24.5);
  assert.strictEqual(normalizeRate('1,024.50'), 1024.5);
  assert.strictEqual(normalizeRate(24.505), 24.51);
});

test('normalizeRate returns null for anything that is not a rate', () => {
  for (const value of [null, undefined, '', '   ', 0, '0', '0.00', '$0.00',
                       -5, '-5', '(24.50)', 'n/a', 'Salary', '--', '.',
                       NaN, Infinity, true, false, {}, []]) {
    assert.strictEqual(normalizeRate(value), null, `expected null for ${JSON.stringify(value)}`);
  }
});

// ============================================================
// Rule 1: overwrite only on presence
// ============================================================

test('an active employee absent from the file is not touched at all', () => {
  // Only 0319 is in the file. Everybody else took the day off.
  const result = plan([fileRow('0319', 25.00)]);

  assert.strictEqual(result.updates.length, 1);
  assert.strictEqual(result.updates[0].employeeNumber, '0319');

  for (const absent of ['0063', '0771', '0884', '905']) {
    assert.strictEqual(updateFor(result, absent), null, `${absent} must not be updated`);
    assert.deepStrictEqual(historyFor(result, absent), [], `${absent} must have no history row`);
  }

  // 0063, 0771, 0884 and 905 are active and hourly. 0007 and 0011 are salaried
  // (outside this flow) and 0400 is terminated, so neither is counted.
  assert.strictEqual(result.skipped.absentFromFile, 4);

  // Nothing in the plan mentions an absent person, in any array.
  const touched = new Set([
    ...result.updates.map(u => u.employeeNumber),
    ...result.creates.map(c => c.employeeNumber),
    ...result.history.map(h => h.employee_number)
  ]);
  assert.deepStrictEqual([...touched], ['0319']);
});

test('an empty file moves nothing and blanks nobody', () => {
  const result = plan([]);
  assert.deepStrictEqual(result.updates, []);
  assert.deepStrictEqual(result.creates, []);
  assert.deepStrictEqual(result.history, []);
  assert.deepStrictEqual(result.ops, []);
  assert.strictEqual(result.skipped.absentFromFile, 5);   // every active hourly person
});

// ============================================================
// Rule 2: a missing or zero rate is not a rate
// ============================================================

test('a zero, blank, negative or non-numeric rate skips without writing', () => {
  const result = plan([
    fileRow('0319', 0),
    fileRow('0063', ''),
    fileRow('0771', -5),
    fileRow('905', 'n/a')
  ]);

  assert.deepStrictEqual(result.updates, []);
  assert.deepStrictEqual(result.history, []);
  assert.deepStrictEqual(result.ops, []);
  assert.strictEqual(result.skipped.noRate, 4);
  assert.strictEqual(result.skipped.unchanged, 0);
});

test('each unusable rate is counted on its own', () => {
  for (const bad of [0, '0.00', null, undefined, '', '   ', -12.5, 'x', '$0']) {
    const result = plan([fileRow('0319', bad)]);
    assert.strictEqual(result.skipped.noRate, 1, `${JSON.stringify(bad)} should count as noRate`);
    assert.strictEqual(result.updates.length, 0, `${JSON.stringify(bad)} must not write`);
  }
});

test('a row with no employee number cannot be matched and is counted separately', () => {
  const result = plan([fileRow('', 25.00), fileRow(null, 25.00)]);
  assert.strictEqual(result.skipped.noEmployeeNumber, 2);
  assert.strictEqual(result.skipped.noRate, 0);
  assert.deepStrictEqual(result.creates, []);
});

// ============================================================
// Unchanged, changed, first observation
// ============================================================

test('an unchanged rate produces no history row and no update', () => {
  const result = plan([fileRow('0319', 24.50)]);
  assert.deepStrictEqual(result.updates, []);
  assert.deepStrictEqual(result.history, []);
  assert.strictEqual(result.skipped.unchanged, 1);
});

test('a rate unchanged but differently spelled is still unchanged', () => {
  const result = plan([fileRow('0319', '$24.50')]);
  assert.strictEqual(result.skipped.unchanged, 1);
  assert.deepStrictEqual(result.history, []);
});

test('a changed rate produces exactly one history row, ordered before the update', () => {
  const result = plan([fileRow('0319', 26.00)]);

  const rows = historyFor(result, '0319');
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(rows[0], {
    employee_id: 'e1',
    employee_number: '0319',
    employee_name: 'Miguel Acosta Ruiz',
    rate: 26,
    previous_rate: 24.5,
    change_pct: 6.12,
    effective_date: WORK_DATE,
    source: 'bbsi',
    flagged: false,
    note: null
  });

  const update = updateFor(result, '0319');
  assert.deepStrictEqual(update, {
    employeeId: 'e1',
    employeeNumber: '0319',
    name: 'Miguel Acosta Ruiz',
    from: 24.5,
    to: 26,
    changePct: 6.12,
    flagged: false,
    note: null
  });

  // The history row must be planned BEFORE the wage write that makes the old
  // rate unrecoverable. This is the ordering the applier walks.
  const kinds = result.ops.map(op => op.kind);
  assert.deepStrictEqual(kinds, ['history', 'update']);
});

test('change_pct is signed', () => {
  const down = plan([fileRow('0319', 22.05)]);
  assert.strictEqual(down.updates[0].changePct, -10);
  assert.strictEqual(historyFor(down, '0319')[0].change_pct, -10);

  const up = plan([fileRow('0319', 26.95)]);
  assert.strictEqual(up.updates[0].changePct, 10);
});

test('the first observation of a rate records previous_rate null', () => {
  // 0884 is on the roster with an empty wage — the app has never held a rate.
  const result = plan([fileRow('0884', 22.00)]);

  const rows = historyFor(result, '0884');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].previous_rate, null);
  assert.strictEqual(rows[0].change_pct, null);
  assert.strictEqual(rows[0].rate, 22);
  assert.strictEqual(rows[0].flagged, false);
  assert.match(rows[0].note, /First rate observed/);

  const update = updateFor(result, '0884');
  assert.strictEqual(update.from, null);
  assert.strictEqual(update.to, 22);
  assert.strictEqual(update.changePct, null);
  assert.strictEqual(update.flagged, false);
});

test('a first observation is never flagged — there is nothing to compare it to', () => {
  const result = plan([fileRow('0884', 250.00)]);   // absurd, but not a CHANGE
  assert.strictEqual(result.updates[0].flagged, false);
  assert.deepStrictEqual(result.flagged, []);
});

// ============================================================
// Surface large changes, do not block
// ============================================================

test('a change past the threshold is APPLIED and flagged', () => {
  const result = plan([fileRow('0063', 37.50)]);    // Ana Smith, 30.00 -> +25%

  const update = updateFor(result, '0063');
  assert.strictEqual(update.to, 37.5);              // applied, not blocked
  assert.strictEqual(update.changePct, 25);
  assert.strictEqual(update.flagged, true);
  assert.match(update.note, /beyond the 20% alert threshold/);

  assert.strictEqual(historyFor(result, '0063')[0].flagged, true);
  assert.deepStrictEqual(result.flagged, [update]);
  assert.deepStrictEqual(result.ops.map(o => o.kind), ['history', 'update']);
});

test('a change inside the threshold is applied and NOT flagged', () => {
  const result = plan([fileRow('0063', 34.50)]);    // 30.00 -> +15%
  const update = updateFor(result, '0063');
  assert.strictEqual(update.changePct, 15);
  assert.strictEqual(update.flagged, false);
  assert.strictEqual(update.note, null);
  assert.deepStrictEqual(result.flagged, []);
});

test('a large CUT is flagged too — the threshold is on magnitude, not direction', () => {
  const result = plan([fileRow('0063', 22.50)]);    // 30.00 -> -25%
  const update = updateFor(result, '0063');
  assert.strictEqual(update.changePct, -25);
  assert.strictEqual(update.flagged, true);
  assert.strictEqual(update.to, 22.5);              // still applied
  assert.strictEqual(result.flagged.length, 1);
  assert.match(update.note, /-25.00%/);
});

test('a change exactly ON the threshold does not exceed it', () => {
  const result = plan([fileRow('0063', 36.00)]);    // exactly +20.00%
  assert.strictEqual(result.updates[0].changePct, 20);
  assert.strictEqual(result.updates[0].flagged, false);
});

test('the threshold is configurable and reports what it used', () => {
  const strict = plan([fileRow('0319', 26.00)], { thresholdPct: 5 });   // +6.12%
  assert.strictEqual(strict.thresholdPct, 5);
  assert.strictEqual(strict.updates[0].flagged, true);

  const loose = plan([fileRow('0319', 26.00)], { thresholdPct: 50 });
  assert.strictEqual(loose.updates[0].flagged, false);
});

test('the threshold falls back to WAGE_CHANGE_ALERT_PCT and then to 20', () => {
  assert.strictEqual(DEFAULT_THRESHOLD_PCT, 20);
  const before = process.env.WAGE_CHANGE_ALERT_PCT;
  try {
    delete process.env.WAGE_CHANGE_ALERT_PCT;
    const dflt = planWageSync({ fileRows: [fileRow('0063', 37.50)], employees: ROSTER, workDate: WORK_DATE });
    assert.strictEqual(dflt.thresholdPct, 20);
    assert.strictEqual(dflt.updates[0].flagged, true);

    process.env.WAGE_CHANGE_ALERT_PCT = '40';
    const env = planWageSync({ fileRows: [fileRow('0063', 37.50)], employees: ROSTER, workDate: WORK_DATE });
    assert.strictEqual(env.thresholdPct, 40);
    assert.strictEqual(env.updates[0].flagged, false);

    // An explicit argument always wins over the environment.
    const explicit = planWageSync({
      fileRows: [fileRow('0063', 37.50)], employees: ROSTER, workDate: WORK_DATE, thresholdPct: 20
    });
    assert.strictEqual(explicit.thresholdPct, 20);
    assert.strictEqual(explicit.updates[0].flagged, true);
  } finally {
    if (before === undefined) delete process.env.WAGE_CHANGE_ALERT_PCT;
    else process.env.WAGE_CHANGE_ALERT_PCT = before;
  }
});

// ============================================================
// Auto-create unknown people
// ============================================================

test('an unknown employee number creates a person, a setup task and a history row', () => {
  const result = plan([
    fileRow('0999', 23.75, { first_name: 'Nueva', last_name: 'Persona' })
  ]);

  assert.deepStrictEqual(result.creates, [{
    employeeNumber: '0999',
    name: 'Nueva Persona',
    firstName: 'Nueva',
    lastName: 'Persona',
    rate: 23.75
  }]);

  assert.deepStrictEqual(result.setupTasks.map(t => ({
    employee_id: t.employee_id,
    employee_number: t.employee_number,
    employee_name: t.employee_name,
    first_seen_date: t.first_seen_date,
    source: t.source
  })), [{
    employee_id: null,          // filled in by the applier from the new row
    employee_number: '0999',
    employee_name: 'Nueva Persona',
    first_seen_date: WORK_DATE,
    source: 'bbsi'
  }]);

  const rows = historyFor(result, '0999');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].previous_rate, null);
  assert.strictEqual(rows[0].rate, 23.75);
  assert.strictEqual(rows[0].effective_date, WORK_DATE);

  // No update op: the create carries the rate. The create must come first, so
  // the history row and the task can reference the new id.
  assert.deepStrictEqual(result.ops.map(o => o.kind), ['create', 'history', 'setupTask']);
  assert.deepStrictEqual(result.updates, []);
});

test('two rows for the same unknown number produce one create and one setup task', () => {
  const result = plan([
    fileRow('0999', 23.75, { first_name: 'Nueva', last_name: 'Persona' }),
    fileRow('0999', 25.00, { first_name: 'Nueva', last_name: 'Persona' })
  ]);

  assert.strictEqual(result.creates.length, 1);
  assert.strictEqual(result.setupTasks.length, 1);
  assert.strictEqual(historyFor(result, '0999').length, 1);
  assert.strictEqual(result.creates[0].rate, 23.75);   // first row wins
  assert.strictEqual(result.skipped.duplicateInFile, 1);
});

test('an unknown row with no usable rate creates nobody', () => {
  const result = plan([fileRow('0999', 0)]);
  assert.deepStrictEqual(result.creates, []);
  assert.deepStrictEqual(result.setupTasks, []);
  assert.deepStrictEqual(result.history, []);
  assert.strictEqual(result.skipped.noRate, 1);
});

// ============================================================
// Salaried staff are outside this flow
// ============================================================

test('a salaried employee in the file never receives an hourly rate', () => {
  // Eduardo Rivera is salaried in Manufacturing. Even carrying a rate and
  // hours, his employees.wage must keep its 'Salary' sentinel.
  const result = plan([
    fileRow('0007', 45.00, { is_salary: true }),
    fileRow('0011', 60.00, { is_salary: true })
  ]);

  assert.deepStrictEqual(result.updates, []);
  assert.deepStrictEqual(result.history, []);
  assert.deepStrictEqual(result.ops, []);
  assert.strictEqual(result.skipped.salaried, 2);
  assert.strictEqual(result.skipped.noRate, 0);
});

test('the roster deciding somebody is salaried is enough on its own', () => {
  // The file forgot to set Is Salary. employees.wage still says 'Salary'.
  const result = plan([fileRow('0007', 45.00, { is_salary: false })]);
  assert.deepStrictEqual(result.updates, []);
  assert.strictEqual(result.skipped.salaried, 1);
});

test('a salaried row is counted as salaried, not as a missing rate', () => {
  // The real file sends salaried people with $0 and zero hours.
  const result = plan([fileRow('0007', 0, { is_salary: true, total_hours: 0 })]);
  assert.strictEqual(result.skipped.salaried, 1);
  assert.strictEqual(result.skipped.noRate, 0);
});

test('a salaried row carrying a real pay rate produces no write of any kind', () => {
  // The whole plan, proved empty rather than read: no update, no create, no
  // wage_history row, no setup task, no flag and no op — for a salaried person
  // the app already knows (0007) AND for one it has never seen (9500), which is
  // the path that would otherwise auto-create somebody off a salaried row.
  const result = plan([
    fileRow('0007', 45.00, { is_salary: true, regular_hours: 10, total_hours: 10, total_earnings: 450 }),
    fileRow('9500', 52.00, { is_salary: true, regular_hours: 8,  total_hours: 8,  total_earnings: 416 })
  ]);

  assert.deepStrictEqual(result.updates, []);
  assert.deepStrictEqual(result.creates, []);
  assert.deepStrictEqual(result.history, []);
  assert.deepStrictEqual(result.setupTasks, []);
  assert.deepStrictEqual(result.flagged, []);
  assert.deepStrictEqual(result.ops, []);

  // Counted as salaried and as nothing else.
  assert.strictEqual(result.skipped.salaried, 2);
  assert.strictEqual(result.skipped.noRate, 0);
  assert.strictEqual(result.skipped.unchanged, 0);
  assert.strictEqual(result.skipped.noEmployeeNumber, 0);
  assert.strictEqual(result.skipped.duplicateInFile, 0);

  // And the effective rate for the one in Manufacturing is still the app's
  // salary / 2080, not the 45.00 that was sitting in the file.
  assert.deepStrictEqual(
    effectiveHourlyRate({ ...ROSTER.find(e => e.employee_number === '0007'), pay_rate: 45.00 }),
    { rate: 50, source: 'salary/2080' }
  );
});

// ============================================================
// effectiveHourlyRate
// ============================================================

test('a salaried Manufacturing employee converts at annual_salary / 2080', () => {
  assert.strictEqual(SALARY_HOURS_PER_YEAR, 2080);
  assert.deepStrictEqual(
    effectiveHourlyRate({ wage: 'Salary', cost_class: 'Manufacturing', annual_salary: 104000 }),
    { rate: 50, source: 'salary/2080' }
  );
  assert.deepStrictEqual(
    effectiveHourlyRate({ wage: 'salary', cost_class: 'Manufacturing', annual_salary: '104000' }),
    { rate: 50, source: 'salary/2080' }
  );
  // Not a rounded number, and still not rounded away.
  assert.strictEqual(
    effectiveHourlyRate({ wage: 'Salary', cost_class: 'Manufacturing', annual_salary: 95000 }).rate,
    45.67
  );
});

test('a file rate on a salaried employee is ignored — salary / 2080 still wins', () => {
  // THE regression this exists to catch. Salaried staff are skipped at import
  // whatever their row carries, so a Pay Rate sitting on one of them is not
  // their wage: it is a number in a column nobody maintains for them. The
  // effective rate is the salary entered in the app, divided by 2080, and the
  // file is not consulted on any branch.
  for (const key of ['pay_rate', 'payRate', 'file_rate', 'fileRate']) {
    assert.deepStrictEqual(
      effectiveHourlyRate({
        wage: 'Salary', cost_class: 'Manufacturing', annual_salary: 104000, [key]: 61.25
      }),
      { rate: 50, source: 'salary/2080' },
      `${key} must not override salary / 2080`
    );
  }
  // Including the shape the live file actually sends: salaried rows at $0.
  assert.deepStrictEqual(
    effectiveHourlyRate({ wage: 'Salary', cost_class: 'Manufacturing', annual_salary: 104000, pay_rate: 0 }),
    { rate: 50, source: 'salary/2080' }
  );
});

test('a salaried Manufacturing employee with no annual_salary is null, even carrying a file rate', () => {
  // Audit query 8e's finding: the conversion cannot be computed, so this
  // person's cost is missing from the manufacturing figures. Saying so is the
  // point — falling back to the file rate would hide a missing salary behind a
  // number nobody entered.
  assert.deepStrictEqual(
    effectiveHourlyRate({ wage: 'Salary', cost_class: 'Manufacturing', pay_rate: 61.25 }),
    { rate: null, source: 'none' }
  );
  assert.deepStrictEqual(
    effectiveHourlyRate({ wage: 'Salary', cost_class: 'Manufacturing', annual_salary: 0, fileRate: 61.25 }),
    { rate: null, source: 'none' }
  );
});

test('a salaried employee outside Manufacturing has no effective hourly rate', () => {
  assert.deepStrictEqual(
    effectiveHourlyRate({ wage: 'Salary', cost_class: 'SG&A', annual_salary: 90000 }),
    { rate: null, source: 'none' }
  );
  assert.deepStrictEqual(
    effectiveHourlyRate({ wage: 'Salary', cost_class: 'Mill Overhead', annual_salary: 90000 }),
    { rate: null, source: 'none' }
  );
  assert.deepStrictEqual(
    effectiveHourlyRate({ wage: 'Salary', cost_class: null, annual_salary: 90000 }),
    { rate: null, source: 'none' }
  );
  // A file rate does not buy them one either — the cost class is the whole rule.
  assert.deepStrictEqual(
    effectiveHourlyRate({ wage: 'Salary', cost_class: 'SG&A', annual_salary: 90000, pay_rate: 61.25 }),
    { rate: null, source: 'none' }
  );
  assert.deepStrictEqual(
    effectiveHourlyRate({ wage: 'Salary', cost_class: 'SG&A', pay_rate: 61.25 }),
    { rate: null, source: 'none' }
  );
});

test('no salary and no rate is null, not zero', () => {
  assert.deepStrictEqual(effectiveHourlyRate({ wage: 'Salary', cost_class: 'Manufacturing' }),
    { rate: null, source: 'none' });
  assert.deepStrictEqual(effectiveHourlyRate({ wage: 'Salary', cost_class: 'Manufacturing', annual_salary: 0 }),
    { rate: null, source: 'none' });
  assert.deepStrictEqual(effectiveHourlyRate({ wage: '' }), { rate: null, source: 'none' });
  assert.deepStrictEqual(effectiveHourlyRate({}), { rate: null, source: 'none' });
  assert.deepStrictEqual(effectiveHourlyRate(null), { rate: null, source: 'none' });
});

test('an hourly employee reports the rate the file last put in employees.wage', () => {
  assert.deepStrictEqual(effectiveHourlyRate({ wage: '24.50' }), { rate: 24.5, source: 'file' });
  assert.deepStrictEqual(effectiveHourlyRate({ wage: '$24.50', cost_class: 'SG&A' }),
    { rate: 24.5, source: 'file' });
});

test("an hourly employee's file rate beats the stored wage, and neither is null", () => {
  // Unchanged by the salaried correction, kept as a regression lock: the file
  // IS the source of truth for hourly staff, which is exactly why it is not
  // one for salaried staff.
  assert.deepStrictEqual(
    effectiveHourlyRate({ wage: '24.50', cost_class: 'Manufacturing', pay_rate: 26.75 }),
    { rate: 26.75, source: 'file' }
  );
  assert.deepStrictEqual(
    effectiveHourlyRate({ wage: '24.50', cost_class: 'Manufacturing', fileRate: 26.75 }),
    { rate: 26.75, source: 'file' }
  );
  // A $0 or unparseable file rate is not a rate; the stored wage stands.
  assert.deepStrictEqual(
    effectiveHourlyRate({ wage: '24.50', cost_class: 'Manufacturing', pay_rate: 0 }),
    { rate: 24.5, source: 'file' }
  );
  // Neither: null, never zero.
  assert.deepStrictEqual(
    effectiveHourlyRate({ wage: null, cost_class: 'Manufacturing', annual_salary: 104000 }),
    { rate: null, source: 'none' }
  );
});

// ============================================================
// Employee-number matching
// ============================================================

test('an unpadded number in the file matches a padded roster record', () => {
  // 0319 on the roster, '319' in the file.
  const result = plan([fileRow('319', 26.00)]);
  assert.strictEqual(result.creates.length, 0, 'must not auto-create a duplicate');
  assert.strictEqual(result.updates.length, 1);
  assert.strictEqual(result.updates[0].employeeId, 'e1');
  assert.strictEqual(result.updates[0].employeeNumber, '0319');
  assert.strictEqual(historyFor(result, '0319')[0].previous_rate, 24.5);
});

test('a padded number in the file matches an unpadded roster record', () => {
  // '905' on the roster, 0905 in the file.
  const result = plan([fileRow('0905', 27.00)]);
  assert.strictEqual(result.creates.length, 0);
  assert.strictEqual(result.updates[0].employeeId, 'e5');
  assert.strictEqual(result.updates[0].from, 26);
  assert.strictEqual(result.updates[0].employeeNumber, '0905');
});

test('a terminated employee still in the file is synced like anybody else', () => {
  // Somebody terminated mid-week still has hours, and a rate, on that week's
  // file. Presence in the file is what drives this, not roster status.
  const result = plan([fileRow('0400', 22.00)]);
  assert.strictEqual(result.updates.length, 1);
  assert.strictEqual(result.updates[0].from, 21);
});

// ============================================================
// The effective date is the file's work date
// ============================================================

test('effective_date is the day the file describes, not the day it is processed', () => {
  const late = planWageSync({
    fileRows: [fileRow('0319', 26.00), fileRow('0999', 20.00)],
    employees: ROSTER,
    workDate: '2026-07-04',            // a file that arrived a month late
    thresholdPct: 20
  });

  assert.strictEqual(late.workDate, '2026-07-04');
  const today = new Date().toISOString().slice(0, 10);
  for (const row of late.history) {
    assert.strictEqual(row.effective_date, '2026-07-04');
    assert.notStrictEqual(row.effective_date, today);
  }
  assert.strictEqual(late.setupTasks[0].first_seen_date, '2026-07-04');
});

test('a timestamp work date is reduced to its calendar date', () => {
  const result = planWageSync({
    fileRows: [fileRow('0319', 26.00)],
    employees: ROSTER,
    workDate: '2026-08-17T00:00:00.000Z'
  });
  assert.strictEqual(result.history[0].effective_date, '2026-08-17');
});

test('a missing or unusable work date is refused, never guessed', () => {
  for (const bad of [null, undefined, '', 'yesterday', '08/17/2026']) {
    assert.throws(
      () => planWageSync({ fileRows: [fileRow('0319', 26.00)], employees: ROSTER, workDate: bad }),
      /work date/i
    );
  }
});

// ============================================================
// The applier — order of writes, and what happens when one fails
// ============================================================

// Records every write in the order it was made, so the ordering guarantee is
// asserted rather than assumed. No network anywhere.
function fakeWriters(overrides = {}) {
  const calls = [];
  const writers = {
    insertWageHistory: async rows => { calls.push(['history', rows[0]]); return rows; },
    updateEmployeeWage: async (id, wage) => { calls.push(['update', id, wage]); return [{ id, wage }]; },
    createEmployee: async row => {
      calls.push(['create', row]);
      return { id: `new-${row.employee_number}`, ...row };
    },
    upsertSetupTask: async row => { calls.push(['setupTask', row]); return row; },
    ...overrides
  };
  return { calls, writers };
}

test('the applier writes the history row before it moves the wage', async () => {
  const { calls, writers } = fakeWriters();
  const applied = await applyWageSync(plan([fileRow('0319', 26.00)]), writers);

  assert.deepStrictEqual(calls.map(c => c[0]), ['history', 'update']);
  assert.strictEqual(calls[0][1].previous_rate, 24.5);
  assert.deepStrictEqual(calls[1].slice(1), ['e1', '26.00']);
  assert.strictEqual(applied.ratesUpdated, 1);
  assert.strictEqual(applied.historyWritten, 1);
  assert.deepStrictEqual(applied.errors, []);
});

test('a failed history insert blocks the wage update behind it', async () => {
  const { calls, writers } = fakeWriters({
    insertWageHistory: async () => { throw new Error('append-only trigger fired'); }
  });
  const applied = await applyWageSync(plan([fileRow('0319', 26.00)]), writers);

  assert.deepStrictEqual(calls.map(c => c[0]), []);
  assert.strictEqual(applied.ratesUpdated, 0, 'the old rate must survive');
  assert.strictEqual(applied.errors.length, 1);
  assert.match(applied.errors[0], /append-only trigger fired/);
  assert.strictEqual(applied.blocked.length, 1);
});

test('one bad row does not stop the rest of the day', async () => {
  let call = 0;
  const { calls, writers } = fakeWriters({
    updateEmployeeWage: async (id, wage) => {
      if (++call === 1) throw new Error('supabase exploded');
      calls.push(['update', id, wage]);
      return [];
    }
  });
  const applied = await applyWageSync(
    plan([fileRow('0319', 26.00), fileRow('0063', 32.00)]), writers);

  assert.strictEqual(applied.ratesUpdated, 1);
  assert.strictEqual(applied.errors.length, 1);
  assert.deepStrictEqual(calls.filter(c => c[0] === 'update').map(c => c[1]), ['e2']);
});

test('the applier fills in the new employee id the plan could not know', async () => {
  const { calls, writers } = fakeWriters();
  const applied = await applyWageSync(
    plan([fileRow('0999', 23.75, { first_name: 'Nueva', last_name: 'Persona' })]), writers);

  assert.deepStrictEqual(calls.map(c => c[0]), ['create', 'history', 'setupTask']);

  const created = calls[0][1];
  assert.strictEqual(created.employee_number, '0999');
  assert.strictEqual(created.wage, '23.75');
  assert.strictEqual(created.status, 'Active');
  assert.strictEqual(created.department, null);
  assert.strictEqual(created.cost_class, null);
  assert.strictEqual(created.position_group, null);

  assert.strictEqual(calls[1][1].employee_id, 'new-0999');
  assert.strictEqual(calls[2][1].employee_id, 'new-0999');
  assert.deepStrictEqual(applied.created, [{
    employeeNumber: '0999', name: 'Nueva Persona', firstName: 'Nueva',
    lastName: 'Persona', rate: 23.75, employeeId: 'new-0999'
  }]);
});

test('a failed create blocks the history row and the setup task that reference it', async () => {
  const { calls, writers } = fakeWriters({
    createEmployee: async () => { throw new Error('cost_class does not exist'); }
  });
  const applied = await applyWageSync(plan([fileRow('0999', 23.75)]), writers);

  assert.deepStrictEqual(calls, []);
  assert.strictEqual(applied.historyWritten, 0);
  assert.strictEqual(applied.setupTasks, 0);
  assert.strictEqual(applied.errors.length, 1);
  assert.strictEqual(applied.blocked.length, 2);
});

test('a plan with nothing in it makes no requests at all', async () => {
  const { calls, writers } = fakeWriters();
  const applied = await applyWageSync(plan([fileRow('0319', 24.50)]), writers);
  assert.deepStrictEqual(calls, []);
  assert.strictEqual(applied.ratesUpdated, 0);
  assert.strictEqual(applied.historyWritten, 0);
  assert.deepStrictEqual(applied.errors, []);
  assert.strictEqual(applied.skipped.unchanged, 1);
});

test('the applier reports flagged changes it actually applied', async () => {
  const { writers } = fakeWriters();
  const applied = await applyWageSync(plan([fileRow('0063', 37.50)]), writers);
  assert.strictEqual(applied.flagged.length, 1);
  assert.strictEqual(applied.flagged[0].employeeNumber, '0063');
  assert.strictEqual(applied.thresholdPct, 20);
  assert.strictEqual(applied.workDate, WORK_DATE);
});

test('a flagged change whose write failed is not reported as applied', async () => {
  const { writers } = fakeWriters({
    updateEmployeeWage: async () => { throw new Error('nope'); }
  });
  const applied = await applyWageSync(plan([fileRow('0063', 37.50)]), writers);
  assert.deepStrictEqual(applied.flagged, []);
  assert.strictEqual(applied.errors.length, 1);
});


// ============================================================
// isSalaried — the ordering the migration depends on
// ============================================================
//
// SCHEMA_V2_MODEL.sql section 5b moves the salaried marker out of employees.wage
// into employees.pay_type and then NULLS wage for salaried people. The code has
// to be right on BOTH sides of that, so each case below is one of the two shapes
// the roster can be in, and the pay_type-first order is what makes them agree.

test('pay_type Salaried with a null wage is salaried — the post-migration shape', () => {
  // The case the whole change exists for. Read the wage instead and this person
  // is hourly, which puts them in the clock-grace headcount and hands them a
  // rate off the daily file.
  assert.strictEqual(isSalaried({ pay_type: 'Salaried', wage: null }), true);
  assert.strictEqual(isSalaried({ pay_type: 'Salaried', wage: '' }), true);
  assert.strictEqual(isSalaried({ payType: 'Salaried', wage: null }), true,
    'camelCase is read too, for a caller that has not been through PostgREST');
});

test('pay_type Hourly beats a stale Salary left in the wage column', () => {
  // A row the migration has classified as Hourly whose wage was never cleaned.
  // pay_type is the stated fact; the wage marker is only a fallback for rows
  // that have no pay_type at all.
  assert.strictEqual(isSalaried({ pay_type: 'Hourly', wage: 'Salary' }), false);
  assert.strictEqual(isSalaried({ pay_type: 'Hourly', wage: '25.00' }), false);
});

test('with no pay_type at all the legacy wage marker still decides', () => {
  // The pre-migration shape. This is what makes the code safe to deploy BEFORE
  // section 5b runs.
  assert.strictEqual(isSalaried({ wage: 'Salary' }), true);
  assert.strictEqual(isSalaried({ wage: '25.00' }), false);
  assert.strictEqual(isSalaried({ wage: '' }), false);
  assert.strictEqual(isSalaried({ wage: null }), false,
    'a new hire with no rate yet is hourly without a rate, not of unknown pay type');
  assert.strictEqual(isSalaried({}), false);
  assert.strictEqual(isSalaried(null), false);
  // An empty or unrecognised pay_type is the same as none: fall back, do not
  // guess, and do not read a blank column as a decision.
  assert.strictEqual(isSalaried({ pay_type: '', wage: 'Salary' }), true);
  assert.strictEqual(isSalaried({ pay_type: null, wage: 'Salary' }), true);
  assert.strictEqual(isSalaried({ pay_type: 'Contractor', wage: 'Salary' }), true);
});

test('pay_type and the wage marker are both trimmed and case-insensitive', () => {
  assert.strictEqual(isSalaried({ pay_type: 'salaried', wage: null }), true);
  assert.strictEqual(isSalaried({ pay_type: '  Salaried  ', wage: null }), true);
  assert.strictEqual(isSalaried({ pay_type: 'SALARIED', wage: null }), true);
  assert.strictEqual(isSalaried({ pay_type: '  hourly  ', wage: 'Salary' }), false);
  assert.strictEqual(isSalaried({ wage: '  SALARY  ' }), true);
});

test('isSalaryWage is the narrow value-only test, and post-migration it is blind', () => {
  // Kept for callers holding nothing but a wage string. It answers a smaller
  // question than isSalaried, which is exactly why no decision is made on it.
  assert.strictEqual(isSalaryWage('Salary'), true);
  assert.strictEqual(isSalaryWage(' salary '), true);
  assert.strictEqual(isSalaryWage(null), false);
  assert.strictEqual(isSalaryWage('25.00'), false);
});

test('effectiveHourlyRate is keyed on pay_type, not on the wage sentinel', () => {
  // Post-migration: pay_type says salaried and wage is null. salary / 2080 for
  // Manufacturing, exactly as before the migration.
  assert.deepStrictEqual(
    effectiveHourlyRate({ pay_type: 'Salaried', wage: null,
                          cost_class: 'Manufacturing', annual_salary: 104000 }),
    { rate: 50, source: 'salary/2080' }
  );
  // And the file is still not consulted for them, rate or no rate.
  assert.deepStrictEqual(
    effectiveHourlyRate({ pay_type: 'Salaried', wage: null, cost_class: 'Manufacturing',
                          annual_salary: 104000, pay_rate: 45.00 }),
    { rate: 50, source: 'salary/2080' }
  );
  // Outside Manufacturing there is still no hourly rate to give them.
  assert.deepStrictEqual(
    effectiveHourlyRate({ pay_type: 'Salaried', wage: null,
                          cost_class: 'SG&A', annual_salary: 90000 }),
    { rate: null, source: 'none' }
  );
  // A stale sentinel under an explicit Hourly does NOT divert into the salaried
  // branch — the stored wage is unreadable as a rate, so there is no rate.
  assert.deepStrictEqual(
    effectiveHourlyRate({ pay_type: 'Hourly', wage: 'Salary',
                          cost_class: 'Manufacturing', annual_salary: 104000 }),
    { rate: null, source: 'none' }
  );
  assert.deepStrictEqual(
    effectiveHourlyRate({ pay_type: 'Hourly', wage: 'Salary', cost_class: 'Manufacturing',
                          annual_salary: 104000, pay_rate: 26.75 }),
    { rate: 26.75, source: 'file' }
  );
});

test('planWageSync still skips a post-migration salaried person, and counts them as salaried', () => {
  // The same two people as the pre-migration test above, in the shape section 5b
  // leaves them in: pay_type set, wage nulled. Nothing may be written to them,
  // and they must be counted as salaried rather than as a missing rate — a
  // "no rate" count is a data problem somebody would go and fix.
  const roster = ROSTER.map(e => (e.wage === 'Salary'
    ? { ...e, pay_type: 'Salaried', wage: null }
    : { ...e, pay_type: 'Hourly' }));

  const result = plan([fileRow('0007', 45.00, { is_salary: false }),
                       fileRow('0011', 43.27, { is_salary: false })],
                      { employees: roster });

  assert.deepStrictEqual(result.updates, []);
  assert.deepStrictEqual(result.creates, []);
  assert.deepStrictEqual(result.history, []);
  assert.deepStrictEqual(result.ops, []);
  assert.strictEqual(result.skipped.salaried, 2);
  assert.strictEqual(result.skipped.noRate, 0);
});

test('a post-migration salaried person absent from the file is not counted as absent', () => {
  // absentFromFile is the population rule 1 protects. Salaried staff are outside
  // this flow, so reading their nulled wage as hourly would add every one of
  // them to that count, every single day.
  const roster = ROSTER.map(e => (e.wage === 'Salary'
    ? { ...e, pay_type: 'Salaried', wage: null }
    : { ...e, pay_type: 'Hourly' }));

  const result = plan([fileRow('0319', 24.50)], { employees: roster });

  // 0063, 0771, 0884 and 905 are active and hourly and were not in the file.
  // 0007 and 0011 are salaried; 0400 is terminated.
  assert.strictEqual(result.skipped.absentFromFile, 4);
});

// ============================================================
// fetchEmployees — the roster projection
// ============================================================
//
// The new columns have to be asked for, or effectiveHourlyRate can never see a
// cost class or a salary. But they do not exist until the migration runs, and
// PostgREST answers a select naming a missing column with a 400 and no rows at
// all — which would take the payroll import down rather than degrade it.

function stubRosterFetch(t, reply) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const call = { url: String(url), method: opts.method || 'GET' };
    calls.push(call);
    const answer = reply(call, calls.length);
    if (answer instanceof Error) {
      return { ok: false, status: 400, text: async () => answer.message };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(answer || []) };
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

test('the roster read asks for pay_type, cost_class and annual_salary', async (t) => {
  const calls = stubRosterFetch(t, () => [{ id: 'e1', name: 'Ana Smith', pay_type: 'Hourly' }]);

  const rows = await payrollDb.fetchEmployees();

  assert.strictEqual(calls.length, 1, 'one request when the columns are there');
  for (const column of ['id', 'name', 'employee_number', 'department', 'wage', 'status',
                        'pay_type', 'cost_class', 'annual_salary']) {
    assert.ok(calls[0].url.includes(column), `the projection must name ${column}`);
  }
  assert.match(calls[0].url, /order=name\.asc/);
  assert.deepStrictEqual(rows, [{ id: 'e1', name: 'Ana Smith', pay_type: 'Hourly' }]);
});

test('a column that does not exist falls back to the pre-migration projection', async (t) => {
  const legacyRows = [{ id: 'e1', name: 'Ana Smith', wage: 'Salary', status: 'Active' }];
  const calls = stubRosterFetch(t, (call, n) => {
    if (n === 1) {
      return new Error('{"code":"42703","details":null,"hint":null,' +
                       '"message":"column employees.pay_type does not exist"}');
    }
    return legacyRows;
  });

  // The whole point: a database where SCHEMA_V2_MODEL.sql has not been run still
  // returns a roster instead of throwing, and the legacy wage marker still says
  // who is salaried.
  const rows = await payrollDb.fetchEmployees();

  assert.strictEqual(calls.length, 2, 'one retry, not a loop');
  assert.ok(calls[0].url.includes('pay_type'));
  assert.ok(!calls[1].url.includes('pay_type'), 'the retry drops the new columns');
  assert.ok(!calls[1].url.includes('cost_class'));
  assert.ok(!calls[1].url.includes('annual_salary'));
  assert.ok(calls[1].url.includes('wage'), 'everything that did exist is still read');
  assert.deepStrictEqual(rows, legacyRows);
  assert.strictEqual(isSalaried(rows[0]), true,
    'on the pre-migration projection the wage marker is all there is, and it still works');
});

test('a failure that is not a missing column is not downgraded into a narrower read', async (t) => {
  // Auth, a 502, a network drop: propagate. Retrying with fewer columns would
  // hide a broken database behind a roster that looks merely out of date.
  const calls = stubRosterFetch(t, () => new Error('JWT expired'));

  await assert.rejects(() => payrollDb.fetchEmployees(), /JWT expired/);
  assert.strictEqual(calls.length, 1, 'no retry on an unrelated failure');
});
