// Run with: npm test
//
// The timeclock schedule lives in ONE module, timeclock-config.js. BBSI moved
// the daily file from ~6:04 AM to 8:00 AM Pacific and added a weekly file at
// 10:00 AM Pacific Monday (November 2026).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { DAILY_FILE, WEEKLY_FILE, ALERT_THRESHOLDS } = require('../netlify/functions/timeclock-config');
const { deriveWorkDate } = require('../netlify/functions/payroll-email-lib');

const TZ = 'America/Los_Angeles';

test('the daily file is due at 8:00 AM Pacific and covers the prior day', () => {
  assert.strictEqual(DAILY_FILE.expectedHour, 8);
  assert.strictEqual(DAILY_FILE.missingAfterHour, 9);
  // 8:00 PST on Thu Nov 5 = 16:00 UTC.
  const d = deriveWorkDate('2026-11-05T16:00:00Z', TZ);
  assert.strictEqual(d.workDate, '2026-11-04');
  assert.strictEqual(d.lateArrival, false);
});

test('the weekly file is due Mondays at 10:00 AM Pacific, missing after 11:00', () => {
  assert.strictEqual(WEEKLY_FILE.dayOfWeek, 1);
  assert.strictEqual(WEEKLY_FILE.expectedHour, 10);
  assert.strictEqual(WEEKLY_FILE.missingAfterHour, 11);
});

test('the alert thresholds are the ones the brief set', () => {
  assert.strictEqual(ALERT_THRESHOLDS.thinDayRatio, 0.6);
  assert.strictEqual(ALERT_THRESHOLDS.thinDayLookbackWeeks, 4);
  assert.strictEqual(ALERT_THRESHOLDS.weeklyVariancePct, 2);
  assert.strictEqual(ALERT_THRESHOLDS.weeklyVarianceDollars, 1000);
});

test('the old 6:04 AM arrival is gone from the code and the schedule', () => {
  const root = path.join(__dirname, '..');
  const files = [
    'netlify.toml',
    ...fs.readdirSync(path.join(root, 'netlify/functions'))
      .filter(f => f.endsWith('.js')).map(f => 'netlify/functions/' + f)
  ];
  for (const f of files) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(!/6:04/.test(text), `${f} still says 6:04`);
  }
});

test('the Monday manager email fires after the weekly file, not before it', () => {
  const toml = fs.readFileSync(path.join(__dirname, '..', 'netlify.toml'), 'utf8');
  const m = /\[functions\."ot-weekly-email"\]\s*\n\s*schedule = "(\d+) (\d+) \* \* 1"/.exec(toml);
  assert.ok(m, 'weekly email schedule found');
  const utcMinutes = Number(m[2]) * 60 + Number(m[1]);
  // Weekly file + 1 hour grace in PST (UTC-8) is the later of the two offsets.
  const missingAtUtcWinter = (WEEKLY_FILE.missingAfterHour + 8) * 60;
  assert.ok(utcMinutes >= missingAtUtcWinter,
    'the email must not go out before the weekly file is due and past its grace hour');
});
