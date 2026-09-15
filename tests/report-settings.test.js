// The settings the OT report reads server-side, and what a malformed one does.
//
// Both live in the SAME settings row and are read by the same one query. The
// client never gets a say in either — it can only be told which value was used.

const test = require('node:test');
const assert = require('node:assert');

const { graceHoursFromSettingsRow, holidaysFromSettingsRow } =
  require('../netlify/functions/payroll-report');

// settings.js writes the row two different ways: a raw object when it inserts
// and a JSON string when it updates. Both are real rows in the table.
const asObject = (value) => ({ key: 'emailSettings', value });
const asString = (value) => ({ key: 'emailSettings', value: JSON.stringify(value) });

test('holidays are read from both shapes the settings row is written in', () => {
  const value = { holidays: ['2026-09-07', '2026-11-26'] };
  for (const row of [asObject(value), asString(value)]) {
    assert.deepStrictEqual(holidaysFromSettingsRow(row), ['2026-09-07', '2026-11-26']);
  }
});

test('no holidays configured is an empty list, never a guess', () => {
  // A wrong exclusion removes real production from every figure — the same
  // failure the holiday list exists to fix, pointed the other way. So the
  // absent case is "exclude nothing", and it is reached from every shape of
  // missing: no row, no key, a null, a string that is not JSON.
  for (const row of [null, undefined, {}, asObject(null), asObject({}), asObject({ holidays: null }),
                     { key: 'emailSettings', value: 'not json' }]) {
    assert.deepStrictEqual(holidaysFromSettingsRow(row), [], JSON.stringify(row));
  }
});

test('a malformed date is dropped rather than passed through', () => {
  // An entry that reached buildReport and never matched a row would be a silent
  // no-op, and a holiday that silently does nothing is worse than one that was
  // never saved: somebody would believe the day was excluded.
  const row = asObject({ holidays: [
    '2026-09-07',          // good
    '9/7/2026',            // the format a person would type
    '2026-9-7',            // nearly
    '',
    null,
    42,
    '2026-09-07T00:00:00', // a timestamp, not a date
    { date: '2026-12-25' }, // an object shape, accepted
    '2026-09-07'           // a duplicate
  ] });
  assert.deepStrictEqual(holidaysFromSettingsRow(row), ['2026-09-07', '2026-12-25']);
});

test('the grace hours reader is unchanged by the holidays living beside it', () => {
  const row = asObject({ graceHoursPerEmployee: 0.75, holidays: ['2026-09-07'] });
  assert.strictEqual(graceHoursFromSettingsRow(row), 0.75);
  assert.deepStrictEqual(holidaysFromSettingsRow(row), ['2026-09-07']);

  // And a broken holiday list does not take the grace hours down with it.
  const halfBroken = asObject({ graceHoursPerEmployee: 0.5, holidays: 'nope' });
  assert.strictEqual(graceHoursFromSettingsRow(halfBroken), 0.5);
  assert.deepStrictEqual(holidaysFromSettingsRow(halfBroken), []);
});
