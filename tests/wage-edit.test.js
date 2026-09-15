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

// cost_class IS PART OF THE FIXTURE, not decoration. Rule 7 refuses a rate for
// anybody outside the Manufacturing cost class, and it is checked before every
// other refusal — so a fixture without it would be refused for the wrong reason
// and every assertion below would be testing that message instead of its own.
const HOURLY = {
  id: 'h1', name: 'Bo Tran', employee_number: '0101',
  pay_type: 'Hourly', wage: '24.50', cost_class: 'Manufacturing'
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

// ---------------------------------------------------------------------------
// rule 7 — which cost classes carry an hourly rate
// ---------------------------------------------------------------------------
//
// Added 2026-09-14 with the removal of the Overhead tab: SG&A and Mill Overhead
// stopped being analysed here and held no compensation at all.
//
// Narrowed to the hourly column on 2026-09-15. SG&A overtime is still tracked —
// it was the one thing deliberately kept — and an hourly person's overtime is
// paid at an hourly rate, so the roster has to be able to say what it is. The
// SALARY half of the original decision is untouched: see pay-scope-lib, and
// data.js for the column it governs.

test('a rate is refused for Mill Overhead and accepted for Manufacturing', () => {
  const p = plan({ cost_class: 'Mill Overhead' });
  assert.strictEqual(p.ok, false, 'Mill Overhead must not accept a rate');
  assert.match(p.error, /Mill Overhead/);
  // The remedy names the fix, not the symptom.
  assert.match(p.detail, /cost class/i);
});

test('an HOURLY SG&A employee may have their rate set', () => {
  // The case the rule was narrowed for. Axeri Ramirez is the only person in it:
  // SG&A cost class, hourly, and the sole source of SG&A overtime.
  const p = plan({ cost_class: 'SG&A', pay_type: 'Hourly', wage: '24.50' }, '26.00');
  assert.strictEqual(p.ok, true, 'an hourly SG&A rate must be accepted');
  assert.strictEqual(p.wage, '26.00');
  // And it is recorded like any other rate change — the history is what makes
  // the column safe to write at all.
  assert.strictEqual(p.history.previous_rate, 24.5);
  assert.strictEqual(p.history.rate, 26);
});

test('a SALARIED SG&A employee is still refused, and the pay type is named as the blocker', () => {
  // "SG&A staff cannot have an hourly rate" would be false now — their hourly
  // colleague has one — so the refusal has to point at the pay type instead, or
  // it sends somebody to reclassify a correctly classified person.
  const p = plan({ cost_class: 'SG&A', pay_type: 'Salaried' });
  assert.strictEqual(p.ok, false);
  assert.match(p.error, /salaried SG&A/i);
  assert.match(p.detail, /pay type/i);
  assert.doesNotMatch(p.detail, /change their cost class/i);
});

test('a blank pay type in SG&A reads as hourly, the same as everywhere else', () => {
  // payTypeOf() shows 'Hourly' for a blank and the profile's select opens on
  // it. A third state here would make this file disagree with every screen.
  const p = plan({ cost_class: 'SG&A', pay_type: '', wage: '24.50' }, '26.00');
  assert.strictEqual(p.ok, true);
});

test('an unclassified person is refused, and told to classify rather than to retype', () => {
  // The state the BBSI import auto-creates: a name, a number, nothing else.
  // Refusing here is what makes classify-then-pay the order of work.
  for (const cls of [null, undefined, '', '   ']) {
    const p = plan({ cost_class: cls });
    assert.strictEqual(p.ok, false);
    assert.match(p.error, /until a cost class is chosen/);
  }
});

test('rule 7 is checked BEFORE the salaried and employee-number refusals', () => {
  // All three are true of this person. The scope is the one that matters:
  // "this rate cannot be recorded" is the wrong sentence for somebody who has
  // no rate to record, and it points at a fix that would not work.
  const p = plan({ cost_class: 'Mill Overhead', pay_type: 'Salaried', employee_number: null });
  assert.strictEqual(p.ok, false);
  assert.match(p.error, /Mill Overhead/);
  assert.doesNotMatch(p.error, /salaried employee has no hourly rate/i);
  assert.doesNotMatch(p.error, /no employee number/i);
});

test('a SALARIED MANUFACTURING person still gets rule 2, not a false claim about their class', () => {
  // This is why carriesWage() is true for every Manufacturing person whatever
  // their pay type. Rule 2's sentence is the useful one — their cost comes from
  // annual_salary / 2,080 and a rate would be counted twice. Answering
  // "Manufacturing carries no hourly rate" would be false and would send
  // somebody to change a cost class that is already right.
  const p = plan({ cost_class: 'Manufacturing', pay_type: 'Salaried' });
  assert.strictEqual(p.ok, false);
  assert.match(p.error, /salaried employee has no hourly rate/i);
  assert.doesNotMatch(p.error, /Manufacturing/);
});

test('Manufacturing still accepts a rate, whatever else changed', () => {
  // The guard against over-reading rule 7: it must refuse the other classes
  // without also refusing the class the whole mill is in.
  const p = plan({ cost_class: 'Manufacturing' }, '26.00');
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.wage, '26.00');
});
