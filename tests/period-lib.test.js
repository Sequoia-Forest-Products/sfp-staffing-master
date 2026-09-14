// How long a reporting period is, in weeks.
//
// THE ACCEPTANCE TEST IS THE FIRST ONE: a single Mon–Sun week is worth exactly
// 1.0 week. Both reports were built for one week and every figure they produce
// for one week has to stay identical to the penny now that they accept a range.
// If that first test ever fails, every weekly number in the app has moved.

const test = require('node:test');
const assert = require('node:assert');

const {
  SCHEDULED_DAYS_PER_WEEK, STANDARD_WEEKLY_HOURS,
  isScheduledDate, datesBetween, scheduledDaysIn, weekEquivalent, standardHoursFor
} = require('../netlify/functions/period-lib');

// 2026-09-07 is a Monday; 2026-09-13 the Sunday that closes its week.
const MON = '2026-09-07';
const SUN = '2026-09-13';

test('a single Mon-Sun week is exactly one week, and exactly 40 hours', () => {
  assert.strictEqual(weekEquivalent(MON, SUN), 1);
  assert.strictEqual(standardHoursFor(MON, SUN), STANDARD_WEEKLY_HOURS);
  assert.strictEqual(scheduledDaysIn(MON, SUN), SCHEDULED_DAYS_PER_WEEK);
});

test('Friday, Saturday and Sunday contribute nothing', () => {
  // Which is WHY the week comes to exactly 1: production runs Mon-Thu, so the
  // other three days carry no weekly allowance and no standard hours.
  for (const d of ['2026-09-11', '2026-09-12', '2026-09-13']) {
    assert.strictEqual(isScheduledDate(d), false, d);
  }
  assert.strictEqual(weekEquivalent('2026-09-11', '2026-09-13'), 0);
  assert.strictEqual(standardHoursFor('2026-09-11', '2026-09-13'), 0);
});

test('Monday through Thursday are the scheduled days', () => {
  for (const d of ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10']) {
    assert.strictEqual(isScheduledDate(d), true, d);
  }
});

test('a Mon-Thu range is a FULL week, not four sevenths of one', () => {
  // The whole reason this counts scheduled days rather than calendar days. A
  // calendar-days/7 rule would call this 0.571 of a week and hand out 4/7 of an
  // allowance the mill grants for the whole week — understating the allowance
  // and overstating Net OT, silently.
  assert.strictEqual(weekEquivalent('2026-09-07', '2026-09-10'), 1);
  assert.strictEqual(standardHoursFor('2026-09-07', '2026-09-10'), 40);
});

test('three whole weeks are worth three', () => {
  assert.strictEqual(weekEquivalent('2026-09-07', '2026-09-27'), 3);
  assert.strictEqual(standardHoursFor('2026-09-07', '2026-09-27'), 120);
});

test('a partial week pro-rates rather than rounding', () => {
  // Mon + Tue = half a working week, so half an allowance. Rounding either way
  // would be inventing or discarding hours somebody is owed.
  assert.strictEqual(weekEquivalent('2026-09-07', '2026-09-08'), 0.5);
  assert.strictEqual(standardHoursFor('2026-09-07', '2026-09-08'), 20);
  assert.strictEqual(weekEquivalent('2026-09-07', '2026-09-09'), 0.75);
});

test('a single day is a single day', () => {
  assert.strictEqual(scheduledDaysIn(MON, MON), 1);
  assert.strictEqual(weekEquivalent(MON, MON), 0.25);
  assert.strictEqual(standardHoursFor(MON, MON), 10);
  // A Friday on its own is zero scheduled days, not an error.
  assert.strictEqual(scheduledDaysIn('2026-09-11', '2026-09-11'), 0);
});

test('a range that crosses a month and a year boundary still counts correctly', () => {
  // 2026-12-28 is a Monday. Mon-Thu that week, then Mon-Thu the next.
  assert.strictEqual(scheduledDaysIn('2026-12-28', '2027-01-10'), 8);
  assert.strictEqual(weekEquivalent('2026-12-28', '2027-01-10'), 2);
});

test('a reversed or unparseable range is empty, not an exception', () => {
  // The endpoints validate their input; this must not be a second place that
  // decides what a bad range means, or the two will eventually disagree.
  assert.deepStrictEqual(datesBetween(SUN, MON), []);
  assert.deepStrictEqual(datesBetween('nonsense', MON), []);
  assert.deepStrictEqual(datesBetween(null, undefined), []);
  assert.strictEqual(weekEquivalent(SUN, MON), 0);
  assert.strictEqual(scheduledDaysIn('nonsense', 'rubbish'), 0);
});

test('dates are counted in UTC, so no timezone can drop one', () => {
  // These are calendar dates, not instants. Parsing them in a local zone is how
  // a date lands on the day before anywhere west of Greenwich — and the mill is
  // seven hours west of it.
  const days = datesBetween(MON, SUN);
  assert.strictEqual(days.length, 7);
  assert.strictEqual(days[0], MON);
  assert.strictEqual(days[6], SUN);
});
