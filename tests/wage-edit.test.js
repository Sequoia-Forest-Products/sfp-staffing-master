// wage-edit-lib — what a rate typed into the app means, decided without a
// database.
//
// The endpoint tests in permissions.test.js assert the two writes and their
// order against real responses. These assert the DECISIONS: which edits are
// refused and why, what previous_rate is, when a move is flagged, and the one
// case that must write nothing at all.

const test = require('node:test');
const assert = require('node:assert');

// Fixed so the threshold cases do not depend on what is in the shell.
delete process.env.WAGE_CHANGE_ALERT_PCT;
process.env.PAYROLL_TIME_ZONE = 'America/Los_Angeles';

const { planWageEdit, todayInZone, SOURCE } = require('../netlify/functions/wage-edit-lib');
const { DEFAULT_THRESHOLD_PCT } = require('../netlify/functions/wage-sync');

const HOURLY = {
  id: 'h1', name: 'Bo Tran', employee_number: '0101',
  pay_type: 'Hourly', wage: '24.50'
};

const plan = (over = {}, value = '26.00', extra = {}) =>
  planWageEdit({ employee: { ...HOURLY, ...over }, value, ...extra });

// ---------------------------------------------------------------------------
// the ordinary case
// ---------------------------------------------------------------------------

test('a raise produces a history row and a two-decimal wage, in that order', () => {
  const p = plan({}, '26.00', { editorEmail: 'peter.stroble@sequoiafp.com' });
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.unchanged, false);
  assert.strictEqual(p.wage, '26.00');

  assert.strictEqual(p.history.employee_id, 'h1');
  assert.strictEqual(p.history.employee_number, '0101');
  assert.strictEqual(p.history.employee_name, 'Bo Tran');
  assert.strictEqual(p.history.rate, 26);
  assert.strictEqual(p.history.previous_rate, 24.5);
  assert.strictEqual(p.history.source, SOURCE);
  assert.strictEqual(SOURCE, 'manual', 'the import writes bbsi; these two must stay distinguishable');
  assert.match(p.history.note, /peter\.stroble@sequoiafp\.com/);
});

test('the rate is stored as text with two decimals, matching the roster', () => {
  // employees.wage is TEXT and humans read the column. '26' and '26.5' would
  // both be correct numbers and both look wrong next to '24.50'.
  assert.strictEqual(plan({}, '26').wage, '26.00');
  assert.strictEqual(plan({}, '26.5').wage, '26.50');
  assert.strictEqual(plan({}, ' $27.25 ').wage, '27.25');
});

test('change_pct is signed and relative to the previous rate', () => {
  assert.strictEqual(plan({ wage: '20.00' }, '25.00').history.change_pct, 25);
  assert.strictEqual(plan({ wage: '25.00' }, '20.00').history.change_pct, -20);
});

test('a first rate has no previous rate and no percentage', () => {
  // A new hire arrives from the daily file with no rate at all. That is the
  // first observation, not a change of zero — a change_pct computed against
  // nothing would read as a 0% move, which is a claim about a rate that never
  // existed.
  const p = plan({ wage: null }, '24.00');
  assert.strictEqual(p.history.previous_rate, null);
  assert.strictEqual(p.history.change_pct, null);
  assert.strictEqual(p.history.flagged, false);
  assert.match(p.history.note, /First rate on file/);
});

test('the effective date is today in the mill\'s zone, not the lambda\'s', () => {
  // 06:00 UTC is still the previous evening in California. A rate typed at 11pm
  // Pacific must not record itself against tomorrow.
  const p = planWageEdit({
    employee: HOURLY, value: '26.00', now: new Date('2026-08-26T06:00:00Z')
  });
  assert.strictEqual(p.history.effective_date, '2026-08-25');
  assert.strictEqual(todayInZone(new Date('2026-08-26T06:00:00Z')), '2026-08-25');
});

// ---------------------------------------------------------------------------
// nothing to do
// ---------------------------------------------------------------------------

test('the same rate retyped writes nothing', () => {
  for (const typed of ['24.50', '24.5', ' 24.50 ', '$24.50']) {
    const p = plan({}, typed);
    assert.strictEqual(p.ok, true, typed);
    assert.strictEqual(p.unchanged, true, typed);
    assert.strictEqual(p.history, undefined, typed);
  }
});

test('a change of half a cent is a change, not noise', () => {
  // The tolerance exists to absorb formatting, not to swallow a real edit.
  assert.strictEqual(plan({}, '24.51').unchanged, false);
});

// ---------------------------------------------------------------------------
// the refusals, each for its own reason
// ---------------------------------------------------------------------------

test('a salaried employee is refused, whichever way they are marked salaried', () => {
  for (const emp of [{ pay_type: 'Salaried', wage: null }, { pay_type: null, wage: 'Salary' }]) {
    const p = plan(emp, '30.00');
    assert.strictEqual(p.ok, false, JSON.stringify(emp));
    assert.match(p.error, /salaried/i);
    assert.match(p.detail, /2,080/);
  }
});

test('an explicitly hourly person is NOT read as salaried by a stale sentinel', () => {
  // pay_type wins over the retired 'Salary' marker left in wage, or the
  // migration that nulls those wages would lock every one of them out.
  const p = plan({ pay_type: 'Hourly', wage: 'Salary' }, '30.00');
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.history.previous_rate, null);
});

test('no employee number is refused, because the history is keyed by it', () => {
  for (const number of [null, '', '   ']) {
    const p = plan({ employee_number: number }, '30.00');
    assert.strictEqual(p.ok, false, JSON.stringify(number));
    assert.match(p.error, /employee number/i);
  }
});

test('clearing a rate is refused with its own sentence, not read as zero', () => {
  // planWageEdit directly, not the plan() helper: its default value would
  // stand in for undefined and the last case would test nothing.
  for (const blank of ['', '   ', null, undefined]) {
    const p = planWageEdit({ employee: HOURLY, value: blank });
    assert.strictEqual(p.ok, false, JSON.stringify(blank));
    assert.match(p.error, /cannot be cleared/i);
  }
});

test('zero, negative and unparseable are all refused', () => {
  // Rule 2 of wage-sync, on this side of the system: a rate of zero prices a
  // day's work at nothing and reads downstream exactly like a real figure.
  for (const bad of ['0', '0.00', '-5', 'abc', '$0']) {
    const p = plan({}, bad);
    assert.strictEqual(p.ok, false, bad);
    assert.match(p.error, /not an hourly rate/i);
  }
});

test('a missing employee is refused rather than assumed', () => {
  for (const emp of [null, undefined, {}]) {
    const p = planWageEdit({ employee: emp, value: '26.00' });
    assert.strictEqual(p.ok, false);
    assert.match(p.error, /no longer exists/i);
  }
});

test('a refusal carries no history and no wage, so nothing can be half-written', () => {
  const p = plan({ pay_type: 'Salaried' }, '30.00');
  assert.strictEqual(p.history, undefined);
  assert.strictEqual(p.wage, undefined);
});

// ---------------------------------------------------------------------------
// flagged, never blocked
// ---------------------------------------------------------------------------

test('a move past the threshold is applied AND flagged', () => {
  // The classic typo: 2450 for 24.50. It is applied — blocking would stall a
  // real raise on a Friday afternoon — and flagged, because a typo and a raise
  // are indistinguishable in the data and one of them wants looking at.
  const p = plan({}, '2450');
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.wage, '2450.00');
  assert.strictEqual(p.flagged, true);
  assert.strictEqual(p.history.flagged, true);
  assert.match(p.history.note, /Flagged/);
});

test('an ordinary raise is not flagged', () => {
  const p = plan({ wage: '24.00' }, '25.00');   // ~4.2%
  assert.strictEqual(p.flagged, false);
  assert.strictEqual(p.history.flagged, false);
  assert.ok(!/Flagged/.test(p.history.note));
});

test('the threshold is the same one the import uses, and is overridable', () => {
  assert.strictEqual(plan({}, '26.00').thresholdPct, DEFAULT_THRESHOLD_PCT);

  // Just past a 1% threshold, nowhere near the default.
  const p = planWageEdit({ employee: HOURLY, value: '25.00', thresholdPct: 1 });
  assert.strictEqual(p.flagged, true);
  assert.strictEqual(p.thresholdPct, 1);

  // A threshold of 0 flags every move; it must not be read as "unset".
  assert.strictEqual(planWageEdit({ employee: HOURLY, value: '24.51', thresholdPct: 0 }).flagged, true);
});

test('a cut past the threshold is flagged too, not only a rise', () => {
  const p = plan({ wage: '40.00' }, '20.00');
  assert.strictEqual(p.history.change_pct, -50);
  assert.strictEqual(p.flagged, true);
});
