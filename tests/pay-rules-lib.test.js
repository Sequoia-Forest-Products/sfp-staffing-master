// The mill's overtime premium.
//
// This file exists because the daily payroll file's money is no longer read.
// It used to carry Total Earnings, and ot_dollars was the residual — which
// inherited the premium structure without this system knowing what it was.
// Now every dollar is our rate times the file's hours, so the tiers have to be
// modelled, and a mistake here is a wrong number in a report managers act on.

const test = require('node:test');
const assert = require('node:assert');
const { dayPay, RATE_TIME_AND_HALF, RATE_DOUBLE_TIME } = require('../netlify/functions/pay-rules-lib');

const RATE = 30;

test('a normal 10-hour day has no premium at all', () => {
  const d = dayPay(10, 0, RATE);
  assert.strictEqual(d.otHours, 0);
  assert.strictEqual(d.regularDollars, 300);
  assert.strictEqual(d.otDollars, 0);
  assert.strictEqual(d.earnings, 300);
});

test('hours 10 to 12 are time and a half', () => {
  const d = dayPay(10, 2, RATE);
  assert.strictEqual(d.timeAndHalfHours, 2);
  assert.strictEqual(d.doubleTimeHours, 0);
  assert.strictEqual(d.otDollars, 90, '2 x 30 x 1.5');
  assert.strictEqual(d.earnings, 390);
});

test('hours above 12 are DOUBLE time — the whole reason this file exists', () => {
  // 13-hour day: 10 straight, 2 at 1.5x, 1 at 2.0x.
  const d = dayPay(10, 3, RATE);
  assert.strictEqual(d.timeAndHalfHours, 2);
  assert.strictEqual(d.doubleTimeHours, 1);
  assert.strictEqual(d.otDollars, 150, '2 x 30 x 1.5 + 1 x 30 x 2.0');
  assert.strictEqual(d.earnings, 450);
});

test('a flat 1.5x would understate that day, which is the bug being avoided', () => {
  const d = dayPay(10, 3, RATE);
  const flat = 3 * RATE * RATE_TIME_AND_HALF;      // 135
  assert.strictEqual(flat, 135);
  assert.ok(d.otDollars > flat, 'the tiered figure must be higher');
  assert.strictEqual(d.otDollars - flat, 15, 'the hour above 12 earns 0.5x more');
});

test('a long day is all tiers at once', () => {
  // 16 hours: 10 straight, 2 at 1.5x, 4 at 2.0x.
  const d = dayPay(10, 6, RATE);
  assert.strictEqual(d.timeAndHalfHours, 2);
  assert.strictEqual(d.doubleTimeHours, 4);
  assert.strictEqual(d.otDollars, 90 + 240);
  assert.strictEqual(d.earnings, 300 + 330);
});

test('the split is exact at the 12-hour boundary, on both sides', () => {
  // Nothing doubles at exactly 12; the first fraction past it does. Asserted on
  // the ROUNDED figures — an earlier version of this test pinned
  // 0.010000000000000675, which is float noise, not behaviour.
  assert.strictEqual(dayPay(10, 2, RATE).doubleTimeHours, 0);
  assert.strictEqual(dayPay(10, 2.01, RATE).doubleTimeHours, 0.01);
  assert.strictEqual(dayPay(10, 2.01, RATE).timeAndHalfHours, 2);
});

test('OT on a short day is time and a half, not double time', () => {
  // A FRI-MON crew on an 8-hour day with 2 hours of OT: total 10, nowhere near
  // the daily double-time threshold. The FILE decided those 2 hours are
  // overtime — this file only decides the tier.
  const d = dayPay(8, 2, RATE);
  assert.strictEqual(d.doubleTimeHours, 0);
  assert.strictEqual(d.timeAndHalfHours, 2);
  assert.strictEqual(d.otDollars, 90);
});

test('double time is never invented out of straight-time hours', () => {
  // If the file ever classifies 13 regular hours and no OT, that is its
  // business — but this must not manufacture a premium the file did not say
  // was earned.
  const d = dayPay(13, 0, RATE);
  assert.strictEqual(d.doubleTimeHours, 0);
  assert.strictEqual(d.timeAndHalfHours, 0);
  assert.strictEqual(d.otDollars, 0);
  assert.strictEqual(d.earnings, 390, 'all 13 hours at straight time');
});

test('no rate means NULL money, not zero money', () => {
  // A person with hours and no rate is a data problem to report by name. A zero
  // folds silently into a total and understates it.
  for (const bad of [null, undefined, '', 0, -5, 'Salary', NaN]) {
    const d = dayPay(10, 2, bad);
    assert.strictEqual(d.earnings, null, String(bad));
    assert.strictEqual(d.otDollars, null, String(bad));
    assert.strictEqual(d.regularDollars, null, String(bad));
    // The HOURS still come through — they are the file's and are not in doubt.
    assert.strictEqual(d.regularHours, 10);
    assert.strictEqual(d.otHours, 2);
  }
});

test('unusable hours are treated as none, never as negative money', () => {
  const d = dayPay('nonsense', null, RATE);
  assert.strictEqual(d.regularHours, 0);
  assert.strictEqual(d.otHours, 0);
  assert.strictEqual(d.earnings, 0);
  // A negative in the file must not produce a credit.
  assert.strictEqual(dayPay(-8, -2, RATE).earnings, 0);
});

test('money is rounded to the cent, not left with float noise', () => {
  const d = dayPay(10, 1, 24.37);
  assert.strictEqual(d.regularDollars, 243.7);
  assert.strictEqual(d.otDollars, 36.56, '1 x 24.37 x 1.5 = 36.555, to the cent');
  assert.strictEqual(d.earnings, 280.26);
});

test('the multipliers are the ones the law states', () => {
  assert.strictEqual(RATE_TIME_AND_HALF, 1.5);
  assert.strictEqual(RATE_DOUBLE_TIME, 2.0);
});
