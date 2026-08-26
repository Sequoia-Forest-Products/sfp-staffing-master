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
  //
  // "Not touched" is now the answer for EVERYBODY on the roster, present or
  // absent — this plan writes nothing to an existing person. What still varies
  // is the counting, and absentFromFile is the count that means "the file did
  // not mention them", which is different from "the file mentioned them and
  // there was nothing to do".
  const result = plan([fileRow('0319', 25.00)]);

  assert.deepStrictEqual(result.updates, [], 'no existing employee is ever updated now');
  assert.deepStrictEqual(result.history, [], 'and no history row comes from the file');

  // 0063, 0771, 0884 and 905 are active and hourly. 0007 and 0011 are salaried
  // (outside this flow) and 0400 is terminated, so neither is counted.
  assert.strictEqual(result.skipped.absentFromFile, 4);
  // 0319 was in the file and is on the roster: nothing to do, counted as such.
  assert.strictEqual(result.skipped.unchanged, 1);

  // Nothing in the plan mentions anybody at all: no creates either, because
  // every number in the file is already known.
  assert.deepStrictEqual(result.creates, []);
  assert.deepStrictEqual(result.ops, []);
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



test('a row with no employee number cannot be matched and is counted separately', () => {
  const result = plan([fileRow('', 25.00), fileRow(null, 25.00)]);
  assert.strictEqual(result.skipped.noEmployeeNumber, 2);
  assert.strictEqual(result.skipped.noRate, 0);
  assert.deepStrictEqual(result.creates, []);
});

// ============================================================
// Unchanged, changed, first observation
// ============================================================







// ============================================================
// Surface large changes, do not block
// ============================================================







// ============================================================
// Auto-create unknown people
// ============================================================

test('an unknown employee number creates a person and a setup task — and NO rate', () => {
  // Arrival detection is all that is left of this plan, and it was never about
  // money. The create carries identity only: the file's rate is not read, so
  // somebody has to type one on Salaries & Wages before this person's cost can
  // be computed. The task says exactly that.
  const result = plan([
    fileRow('0999', 23.75, { first_name: 'Nueva', last_name: 'Persona' })
  ]);

  assert.deepStrictEqual(result.creates, [{
    employeeNumber: '0999',
    name: 'Nueva Persona',
    firstName: 'Nueva',
    lastName: 'Persona'
  }], 'no rate key at all — not a null one');

  const [task] = result.setupTasks;
  assert.deepStrictEqual({
    employee_id: task.employee_id,
    employee_number: task.employee_number,
    employee_name: task.employee_name,
    first_seen_date: task.first_seen_date,
    source: task.source
  }, {
    employee_id: null,          // filled in by the applier from the new row
    employee_number: '0999',
    employee_name: 'Nueva Persona',
    first_seen_date: WORK_DATE,
    source: 'bbsi'
  });
  assert.match(task.note, /Needs a pay rate/);
  assert.match(task.note, /cost cannot be computed/);

  // No history row: there is no rate to record. The create must come first so
  // the task can reference the new id.
  assert.deepStrictEqual(result.history, []);
  assert.deepStrictEqual(result.ops.map(o => o.kind), ['create', 'setupTask']);
  assert.deepStrictEqual(result.updates, []);
});

test('two rows for the same unknown number produce one create and one setup task', () => {
  const result = plan([
    fileRow('0999', 23.75, { first_name: 'Nueva', last_name: 'Persona' }),
    fileRow('0999', 25.00, { first_name: 'Nueva', last_name: 'Persona' })
  ]);

  assert.strictEqual(result.creates.length, 1);
  assert.strictEqual(result.setupTasks.length, 1);
  assert.deepStrictEqual(result.history, []);
  assert.strictEqual(result.skipped.duplicateInFile, 1);
  // The two rows differ only in a rate nobody reads, so which one wins cannot
  // matter any more — but the dedupe still has to happen, or the create would
  // be attempted twice against a unique employee_number.
  assert.ok(!('rate' in result.creates[0]));
});


// ============================================================
// Salaried staff are outside this flow
// ============================================================


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

test('a salaried employee outside Manufacturing IS costed — the cost class is not asked here', () => {
  // THE REVERSE OF WHAT THIS TEST USED TO ASSERT, and the old assertion was
  // pinning a live bug.
  //
  // effectiveHourlyRate returned null for any salaried person outside cost
  // class Manufacturing, before it looked at annual_salary. The rule it was
  // reaching for is real — such a person does not belong in MANUFACTURING cost
  // — but buildCostReport already filters its members by cost class before
  // pricing anybody, so this was answering a question the caller had answered
  // and overruling it.
  //
  // The effect: nobody salaried outside Manufacturing was costed anywhere.
  // Mill Overhead is three salaried people; SG&A is almost entirely salaried.
  // Both tabs reported almost none of their own cost, and cost-lib's gap
  // message blamed a missing annual_salary for a figure that was on file.
  assert.deepStrictEqual(
    effectiveHourlyRate({ wage: 'Salary', cost_class: 'SG&A', annual_salary: 90000 }),
    { rate: 43.27, source: 'salary/2080' }
  );
  assert.deepStrictEqual(
    effectiveHourlyRate({ wage: 'Salary', cost_class: 'Mill Overhead', annual_salary: 90000 }),
    { rate: 43.27, source: 'salary/2080' }
  );
  // No cost class at all is still a rate: which report they belong in is a
  // separate question from what an hour of them costs, and it is not this
  // function's to answer.
  assert.deepStrictEqual(
    effectiveHourlyRate({ wage: 'Salary', cost_class: null, annual_salary: 90000 }),
    { rate: 43.27, source: 'salary/2080' }
  );

  // WHAT DID NOT CHANGE. A missing salary is still the one reason a salaried
  // person has no rate, and the file still buys them nothing.
  assert.deepStrictEqual(
    effectiveHourlyRate({ wage: 'Salary', cost_class: 'SG&A' }),
    { rate: null, source: 'none' }
  );
  assert.deepStrictEqual(
    effectiveHourlyRate({ wage: 'Salary', cost_class: 'SG&A', pay_rate: 61.25 }),
    { rate: null, source: 'none' }
  );
  assert.deepStrictEqual(
    effectiveHourlyRate({ wage: 'Salary', cost_class: 'SG&A', annual_salary: 0, pay_rate: 61.25 }),
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

test('an hourly employee is priced from employees.wage, and it says so', () => {
  // The source used to read 'file', because employees.wage held nothing but
  // what the BBSI file last put there. It holds what somebody typed now.
  assert.deepStrictEqual(effectiveHourlyRate({ wage: '24.50' }),
    { rate: 24.5, source: 'employees.wage' });
  assert.deepStrictEqual(effectiveHourlyRate({ wage: '$24.50', cost_class: 'SG&A' }),
    { rate: 24.5, source: 'employees.wage' });
});

test('a file rate can no longer outrank the stored wage', () => {
  // The regression this guards is precise: for a year the file's rate won, and
  // it was a transcription nobody maintained. An employee object carrying BOTH
  // must price at ours.
  assert.deepStrictEqual(
    effectiveHourlyRate({ wage: '24.50', pay_rate: 99.99, cost_class: 'Manufacturing' }),
    { rate: 24.5, source: 'employees.wage' });
  // And a file rate on somebody with no stored wage buys nothing: null, not
  // the file's number and not zero.
  assert.deepStrictEqual(
    effectiveHourlyRate({ wage: null, pay_rate: 99.99, cost_class: 'Manufacturing' }),
    { rate: null, source: 'none' });
});


// ============================================================
// Employee-number matching
// ============================================================

test('an unpadded number in the file matches a padded roster record', () => {
  // 0319 on the roster, '319' in the file.
  const result = plan([fileRow('319', 26.00)]);
  assert.deepStrictEqual(result.creates, [], 'must not auto-create a duplicate');
  assert.strictEqual(result.skipped.unchanged, 1);
});

test('a padded number in the file matches an unpadded roster record', () => {
  // '905' on the roster, 0905 in the file. Matching by normalised number is
  // what keeps this from auto-creating a duplicate of somebody already there,
  // and that is the whole job of the plan now.
  const result = plan([fileRow('0905', 27.00)]);
  assert.deepStrictEqual(result.creates, []);
  assert.strictEqual(result.skipped.unchanged, 1);
});

test('a terminated employee still in the file is not re-created', () => {
  // Somebody terminated mid-week still has hours on that week's file. They are
  // on the roster, so the one thing this plan does — create people it has never
  // heard of — must not fire for them.
  const result = plan([fileRow('0400', 22.00)]);
  assert.deepStrictEqual(result.creates, []);
  assert.strictEqual(result.skipped.unchanged, 1);
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
  // Read off the setup task now that no history row is written. The date still
  // has to be a calendar date: employee_setup_tasks.first_seen_date is a DATE
  // and unique per person, so a timestamp would make one arrival look like two.
  const result = planWageSync({
    fileRows: [fileRow('0999', 26.00)],
    employees: ROSTER,
    workDate: '2026-08-17T00:00:00.000Z'
  });
  assert.strictEqual(result.setupTasks[0].first_seen_date, '2026-08-17');
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
    createEmployee: async row => {
      calls.push(['create', row]);
      return { id: `new-${row.employee_number}`, ...row };
    },
    upsertSetupTask: async row => { calls.push(['setupTask', row]); return row; },
    ...overrides
  };
  return { calls, writers };
}



test('one bad create does not stop the rest of the day', async () => {
  // The applier's isolation still matters: two new arrivals in one file, and
  // the first failing must not cost the second its row. There is no wage update
  // to fail any more, so the failure under test is the create.
  let call = 0;
  const { calls, writers } = fakeWriters({
    createEmployee: async (row) => {
      if (++call === 1) throw new Error('supabase exploded');
      calls.push(['create', row]);
      return { id: 'new-' + row.employee_number, ...row };
    }
  });
  const applied = await applyWageSync(
    plan([fileRow('0998', 26.00, { last_name: 'One' }),
          fileRow('0999', 32.00, { last_name: 'Two' })]), writers);

  assert.strictEqual(applied.created.length, 1);
  assert.strictEqual(applied.errors.length, 1);
  assert.deepStrictEqual(calls.filter(c => c[0] === 'create').map(c => c[1].employee_number),
    ['0999']);
});

test('the applier fills in the new employee id the plan could not know', async () => {
  const { calls, writers } = fakeWriters();
  const applied = await applyWageSync(
    plan([fileRow('0999', 23.75, { first_name: 'Nueva', last_name: 'Persona' })]), writers);

  // Two ops, not three: no history row, because no rate was read.
  assert.deepStrictEqual(calls.map(c => c[0]), ['create', 'setupTask']);

  const created = calls[0][1];
  assert.strictEqual(created.employee_number, '0999');
  assert.strictEqual(created.status, 'Active');
  assert.strictEqual(created.department, null);
  assert.strictEqual(created.cost_class, null);
  assert.strictEqual(created.position_group, null);
  // NO WAGE. The person arrives with no rate and cannot be costed until
  // somebody types one; the setup task is what says so.
  assert.ok(created.wage === null || created.wage === undefined,
    'the create must not invent a rate: ' + JSON.stringify(created.wage));

  assert.strictEqual(calls[1][1].employee_id, 'new-0999');
  assert.deepStrictEqual(applied.created, [{
    employeeNumber: '0999', name: 'Nueva Persona', firstName: 'Nueva',
    lastName: 'Persona', employeeId: 'new-0999'
  }]);
});

test('a failed create blocks the setup task that references it', async () => {
  const { calls, writers } = fakeWriters({
    createEmployee: async () => { throw new Error('cost_class does not exist'); }
  });
  const applied = await applyWageSync(plan([fileRow('0999', 23.75)]), writers);

  assert.deepStrictEqual(calls, []);
  assert.strictEqual(applied.setupTasks, 0);
  assert.strictEqual(applied.errors.length, 1);
  // One dependent op now, not two — the history row went with the rate.
  assert.strictEqual(applied.blocked.length, 1);
});

test('the import has no way to write a rate at all', async () => {
  // Not "does not currently write one" — HAS NO WAY TO. payroll-db reached
  // employees.wage with the service key, which no permission gate touches, and
  // ran every morning off the file. The writer is deleted, not merely unused:
  // employees.wage is typed in the app now, and the app records a wage_history
  // row before it writes the rate, which this path never could.
  const payrollDb = require('../netlify/functions/payroll-db');
  assert.strictEqual(payrollDb.updateEmployeeWage, undefined,
    'the service-key rate writer is back');

  // And the applier cannot be talked into one by a plan that carries the op
  // shape the deleted branch used to handle.
  const { calls, writers } = fakeWriters();
  const applied = await applyWageSync({
    workDate: '2026-08-25',
    ops: [{ kind: 'update', employeeNumber: '0319',
            update: { employeeId: 'e1', to: 99.99, from: 24.5, flagged: true } }],
    skipped: {}
  }, writers);

  assert.deepStrictEqual(calls, [], 'an update op wrote something');
  assert.deepStrictEqual(applied.flagged, []);
  assert.deepStrictEqual(applied.errors, []);
});

test('a plan with nothing in it makes no requests at all', async () => {
  const { calls, writers } = fakeWriters();
  const applied = await applyWageSync(plan([fileRow('0319', 24.50)]), writers);
  assert.deepStrictEqual(calls, []);
  assert.strictEqual(applied.historyWritten, 0);
  assert.deepStrictEqual(applied.errors, []);
  assert.strictEqual(applied.skipped.unchanged, 1);
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
  // Outside Manufacturing they are costed the same way — see the cost-class
  // test above for why that reversed.
  assert.deepStrictEqual(
    effectiveHourlyRate({ pay_type: 'Salaried', wage: null,
                          cost_class: 'SG&A', annual_salary: 90000 }),
    { rate: 43.27, source: 'salary/2080' }
  );
  // A stale sentinel under an explicit Hourly does NOT divert into the salaried
  // branch — the stored wage is unreadable as a rate, so there is no rate.
  assert.deepStrictEqual(
    effectiveHourlyRate({ pay_type: 'Hourly', wage: 'Salary',
                          cost_class: 'Manufacturing', annual_salary: 104000 }),
    { rate: null, source: 'none' }
  );
  // ...and a file rate does not rescue them. It used to: this same call
  // returned { rate: 26.75, source: 'file' } while the file was believed.
  assert.deepStrictEqual(
    effectiveHourlyRate({ pay_type: 'Hourly', wage: 'Salary', cost_class: 'Manufacturing',
                          annual_salary: 104000, pay_rate: 26.75 }),
    { rate: null, source: 'none' }
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

test('the roster read asks for pay_type, cost_class, annual_salary, position_group and position', async (t) => {
  const calls = stubRosterFetch(t, () => [{ id: 'e1', name: 'Ana Smith', pay_type: 'Hourly' }]);

  const rows = await payrollDb.fetchEmployees();

  assert.strictEqual(calls.length, 1, 'one request when the columns are there');
  for (const column of ['id', 'name', 'employee_number', 'department', 'wage', 'status',
                        'pay_type', 'cost_class', 'annual_salary',
                        // Read for the cost report: it groups by position group and
                        // names a person's position when it lists somebody with none.
                        'position_group', 'position']) {
    assert.ok(calls[0].url.includes(column), `the projection must name ${column}`);
  }
  assert.match(calls[0].url, /order=name\.asc/);
  assert.deepStrictEqual(rows, [{ id: 'e1', name: 'Ana Smith', pay_type: 'Hourly' }]);
});

const missingColumnError = (column) =>
  new Error('{"code":"42703","details":null,"hint":null,' +
            `"message":"column employees.${column} does not exist"}`);

test('a missing `position` costs the cost report and nothing else', async (t) => {
  // This is why the fallback is a ladder rather than a single retry. `position`
  // arrived in Phase B; a database without it must not lose pay_type, cost_class
  // and annual_salary on the way down, because the payroll import reads those to
  // decide who is salaried. The old binary fallback did exactly that.
  const rows = [{ id: 'e1', name: 'Ana Smith', pay_type: 'Salaried', annual_salary: 105000 }];
  const calls = stubRosterFetch(t, (call, n) => n === 1 ? missingColumnError('position') : rows);

  const got = await payrollDb.fetchEmployees();

  assert.strictEqual(calls.length, 2, 'one step down, not all the way');
  assert.ok(!calls[1].url.includes('position&') && !calls[1].url.endsWith('position'),
    'the retry drops `position`');
  for (const kept of ['pay_type', 'cost_class', 'annual_salary', 'position_group']) {
    assert.ok(calls[1].url.includes(kept), `the retry must keep ${kept}`);
  }
  assert.deepStrictEqual(got, rows);
});

test('a column that does not exist falls back to the pre-migration projection', async (t) => {
  const legacyRows = [{ id: 'e1', name: 'Ana Smith', wage: 'Salary', status: 'Active' }];
  const calls = stubRosterFetch(t, (call, n) => {
    // pay_type is on both of the upper rungs, so a database without it walks
    // both of them before landing on pre-v2.
    if (n <= 2) return missingColumnError('pay_type');
    return legacyRows;
  });

  // The whole point: a database where SCHEMA_V2_MODEL.sql has not been run still
  // returns a roster instead of throwing, and the legacy wage marker still says
  // who is salaried.
  const rows = await payrollDb.fetchEmployees();

  assert.strictEqual(calls.length, 3, 'down the ladder once, not a loop');
  assert.ok(calls[0].url.includes('pay_type'));
  assert.ok(!calls[2].url.includes('pay_type'), 'the last rung drops the new columns');
  assert.ok(!calls[2].url.includes('cost_class'));
  assert.ok(!calls[2].url.includes('annual_salary'));
  assert.ok(!calls[2].url.includes('position_group'));
  assert.ok(calls[2].url.includes('wage'), 'everything that did exist is still read');
  assert.deepStrictEqual(rows, legacyRows);
  assert.strictEqual(isSalaried(rows[0]), true,
    'on the pre-migration projection the wage marker is all there is, and it still works');
});

test('each rung drops only what the rung above it added', async (t) => {
  // Pinned as a property rather than three string literals: a future column added
  // to the top rung and forgotten on the one below would widen a fallback rather
  // than narrow it, and nothing else would notice.
  const cols = (s) => s.split(',');
  const full = cols(payrollDb.EMPLOYEE_COLUMNS);
  const mid = cols(payrollDb.EMPLOYEE_COLUMNS_PRE_PHASE_B);
  const base = cols(payrollDb.EMPLOYEE_COLUMNS_PRE_V2);

  for (const [wider, narrower, label] of [[full, mid, 'full -> pre-Phase-B'],
                                          [mid, base, 'pre-Phase-B -> pre-v2']]) {
    assert.ok(narrower.length < wider.length, `${label} must be narrower`);
    for (const c of narrower) {
      assert.ok(wider.includes(c), `${label}: ${c} is not in the rung above`);
    }
  }
});

test('a failure that is not a missing column is not downgraded into a narrower read', async (t) => {
  // Auth, a 502, a network drop: propagate. Retrying with fewer columns would
  // hide a broken database behind a roster that looks merely out of date.
  const calls = stubRosterFetch(t, () => new Error('JWT expired'));

  await assert.rejects(() => payrollDb.fetchEmployees(), /JWT expired/);
  assert.strictEqual(calls.length, 1, 'no retry on an unrelated failure');
});
