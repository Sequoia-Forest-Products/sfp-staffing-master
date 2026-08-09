// Run with: npm test   (node --test, no extra dependencies)
//
// Every case drives runBirthdayNotifications() with an injected `now` and a
// fake roster, so nothing touches Supabase or Gmail.

const test = require('node:test');
const assert = require('node:assert');

const {
  calendarDateInZone,
  buildTargetDates,
  parseBirthday,
  isSendableAddress,
  buildRecipients,
  runBirthdayNotifications
} = require('../netlify/functions/birthday-lib');

const tb = n => `+1509555${String(n).padStart(4, '0')}@sendemailtotext.com`;

// Mar 11 2026 = Wed, Mar 12 = Thu, Mar 13 = Fri, Mar 14 = Sat, Mar 15 = Sun.
const ROSTER = [
  { name: 'Ana Reyes',      birthday: '1990-03-11', text_bolt: tb(1), status: 'Active' },
  { name: 'Ben Carter',     birthday: '3/11/1985',  text_bolt: tb(2), status: 'Active' },
  { name: 'Cara Lopez',     birthday: '1992-03-14', text_bolt: tb(3), status: 'Active' },
  { name: 'Dan Whitfield',  birthday: '3/15',       text_bolt: tb(4), status: 'Active' },
  { name: 'Eve Nakamura',   birthday: '1988-07-04', text_bolt: tb(5), status: 'Active' },
  { name: 'Frank Osei',     birthday: '1975-01-20', text_bolt: 'STOP', status: 'Active' },
  { name: 'Gina Alvarez',   birthday: '1991-02-02', text_bolt: '#ERROR!', status: 'Active' },
  { name: 'Hank Moore',     birthday: '',           text_bolt: tb(8), status: 'Active' }
];

// Collect log output instead of printing it, and never allow a real send.
function harness(iso, roster = ROSTER, opts = {}) {
  const sends = [];
  const logs = [];
  return runBirthdayNotifications({
    now: new Date(iso),
    employees: roster,
    log: (...a) => logs.push(a.join(' ')),
    send: async (to, subject, body) => { sends.push({ to, subject, body }); },
    ...opts
  }).then(result => ({ result, sends, logs }));
}

// ============================================================
// Date parsing
// ============================================================

test('a Postgres DATE string matches its literal month/day with no UTC shift', () => {
  assert.deepStrictEqual(parseBirthday('1990-08-09'), { month: 8, day: 9 });
  assert.deepStrictEqual(parseBirthday('2001-01-01'), { month: 1, day: 1 });
  assert.deepStrictEqual(parseBirthday('1999-12-31'), { month: 12, day: 31 });
});

test('free-text birthdays from the Employees tab parse as month/day', () => {
  assert.deepStrictEqual(parseBirthday('3/15'), { month: 3, day: 15 });
  assert.deepStrictEqual(parseBirthday('3/15/1990'), { month: 3, day: 15 });
  assert.deepStrictEqual(parseBirthday('12/1/85'), { month: 12, day: 1 });
});

test('junk birthdays are ignored rather than throwing', () => {
  for (const v of ['', null, undefined, '#ERROR!', 'n/a', '13/45', '0/0']) {
    assert.strictEqual(parseBirthday(v), null, `expected null for ${JSON.stringify(v)}`);
  }
});

test('"today" is read in Mountain Time, not UTC', () => {
  // 04:00 UTC on Mar 12 is still 10 PM Mar 11 in Boise — must not roll to Thursday.
  assert.deepStrictEqual(
    calendarDateInZone(new Date('2026-03-12T04:00:00Z')),
    { year: 2026, month: 3, day: 11 }
  );
});

// ============================================================
// Look-ahead window
// ============================================================

test('Mon-Wed looks at today only', () => {
  const w = buildTargetDates({ year: 2026, month: 3, day: 11 });
  assert.strictEqual(w.daysToLookAhead, 0);
  assert.deepStrictEqual(w.targets, [{ month: 3, date: 11, isUpcoming: false }]);
});

test('Thursday looks ahead 3 days and Friday 2 days', () => {
  assert.strictEqual(buildTargetDates({ year: 2026, month: 3, day: 12 }).daysToLookAhead, 3);
  assert.strictEqual(buildTargetDates({ year: 2026, month: 3, day: 13 }).daysToLookAhead, 2);
});

test('the look-ahead rolls across a month boundary', () => {
  // Thu Apr 30 2026 → May 1, 2, 3.
  const w = buildTargetDates({ year: 2026, month: 4, day: 30 });
  assert.deepStrictEqual(w.targets.map(t => `${t.month}/${t.date}`), ['4/30', '5/1', '5/2', '5/3']);
});

test('weekends produce no window', () => {
  assert.strictEqual(buildTargetDates({ year: 2026, month: 3, day: 14 }), null); // Sat
  assert.strictEqual(buildTargetDates({ year: 2026, month: 3, day: 15 }), null); // Sun
});

// ============================================================
// End-to-end runs
// ============================================================

test('a normal weekday sends today-only, excluding the birthday people', async () => {
  const { result, sends } = await harness('2026-03-11T13:30:00Z');

  assert.strictEqual(result.status, 'sent');
  assert.deepStrictEqual(result.people, ['Ana', 'Ben']);

  // Roster has 6 sendable addresses; Ana and Ben are excluded, so 4 remain.
  assert.strictEqual(sends.length, 4);
  const to = sends.map(s => s.to);
  assert.ok(!to.includes(tb(1)) && !to.includes(tb(2)), 'birthday people must not receive');
  assert.deepStrictEqual(to.sort(), [tb(3), tb(4), tb(5), tb(8)].sort());
});

test('multiple same-day birthdays share one message with "them"', async () => {
  const { sends } = await harness('2026-03-11T13:30:00Z');
  const { subject, body } = sends[0];

  assert.strictEqual(subject, 'Happy Birthday / ¡Feliz Cumpleaños! - Ana & Ben');
  assert.ok(body.includes("It is Ana Reyes & Ben Carter's Birthday today!"));
  assert.ok(body.includes('¡Hoy es el cumpleaños de Ana Reyes & Ben Carter!'));
  assert.ok(body.includes('wishing them a HAPPY BIRTHDAY'));
  assert.ok(body.includes('para desearles un ¡FELIZ CUMPLEAÑOS!'));
});

test('a single birthday uses the first name and the singular Spanish verb', async () => {
  const solo = [ROSTER[0], ROSTER[4], ROSTER[5]];
  const { sends } = await harness('2026-03-11T13:30:00Z', solo);
  const { subject, body } = sends[0];

  assert.strictEqual(subject, 'Happy Birthday / ¡Feliz Cumpleaños! - Ana');
  assert.ok(body.includes("It is Ana Reyes's Birthday today!"));
  assert.ok(body.includes('wishing Ana a HAPPY BIRTHDAY'));
  assert.ok(body.includes('para desearle un ¡FELIZ CUMPLEAÑOS!'));
});

test('Thursday picks up a Saturday birthday as upcoming', async () => {
  // Roster trimmed to isolate the Saturday case — the full roster also has a
  // Sunday birthday, which Thursday's 3-day window would sweep in as well.
  const roster = [ROSTER[2], ROSTER[4], ROSTER[7]];
  const { result, sends } = await harness('2026-03-12T13:30:00Z', roster);

  assert.deepStrictEqual(result.people, ['Cara']);
  const { subject, body } = sends[0];
  assert.strictEqual(subject, 'Happy Birthday / ¡Feliz Cumpleaños! - Cara');
  assert.ok(body.includes('We also have Cara Lopez celebrating over the upcoming weekend!'));
  assert.ok(body.includes('¡También tenemos a Cara Lopez celebrando durante el próximo fin de semana!'));
  assert.ok(!body.includes('Birthday today'), 'nobody has a birthday on the Thursday itself');
  assert.ok(!sends.some(s => s.to === tb(3)), 'Cara must not receive her own message');
});

test("Thursday's window also reaches Sunday", async () => {
  const { result } = await harness('2026-03-12T13:30:00Z');
  assert.deepStrictEqual(result.people, ['Cara', 'Dan']); // Sat Mar 14 + Sun Mar 15
});

test('Friday covers both Saturday and Sunday birthdays', async () => {
  const { result, sends } = await harness('2026-03-13T13:30:00Z');

  assert.deepStrictEqual(result.people, ['Cara', 'Dan']);
  assert.ok(sends[0].body.includes(
    'We also have Cara Lopez & Dan Whitfield celebrating over the upcoming weekend!'
  ));
  const to = sends.map(s => s.to);
  assert.ok(!to.includes(tb(3)) && !to.includes(tb(4)));
});

test('today and upcoming birthdays combine into one message', async () => {
  const roster = [
    { name: 'Ana Reyes', birthday: '1990-03-13', text_bolt: tb(1), status: 'Active' },
    { name: 'Cara Lopez', birthday: '1992-03-14', text_bolt: tb(3), status: 'Active' },
    { name: 'Eve Nakamura', birthday: '1988-07-04', text_bolt: tb(5), status: 'Active' }
  ];
  const { sends } = await harness('2026-03-13T13:30:00Z', roster);

  assert.strictEqual(sends.length, 1);
  assert.ok(sends[0].body.includes("It is Ana Reyes's Birthday today!"));
  assert.ok(sends[0].body.includes('We also have Cara Lopez celebrating over the upcoming weekend!'));
  assert.strictEqual(sends[0].to, tb(5));
});

test('a birthday person who opted out is still named but receives nothing', async () => {
  const roster = [
    { name: 'Frank Osei', birthday: '1975-03-11', text_bolt: 'STOP', status: 'Active' },
    { name: 'Eve Nakamura', birthday: '1988-07-04', text_bolt: tb(5), status: 'Active' }
  ];
  const { result, sends } = await harness('2026-03-11T13:30:00Z', roster);

  assert.deepStrictEqual(result.people, ['Frank']);
  assert.ok(sends[0].body.includes("It is Frank Osei's Birthday today!"));
  assert.deepStrictEqual(sends.map(s => s.to), [tb(5)]);
});

test('opted-out and error addresses never receive', () => {
  const recipients = buildRecipients(ROSTER, []);
  assert.ok(!recipients.includes('STOP'));
  assert.ok(!recipients.some(r => r.includes('ERROR')));
  assert.strictEqual(recipients.length, 6); // tb(1..5) plus tb(8)
});

test('duplicate addresses are only messaged once', () => {
  const roster = [
    { name: 'A One', text_bolt: tb(1), status: 'Active' },
    { name: 'B Two', text_bolt: tb(1).toUpperCase(), status: 'Active' }
  ];
  assert.strictEqual(buildRecipients(roster, []).length, 1);
});

test('isSendableAddress rejects everything that is not a live address', () => {
  assert.ok(isSendableAddress(tb(1)));
  for (const v of ['', null, 'STOP', 'stop', '#ERROR!', 'no-at-sign']) {
    assert.strictEqual(isSendableAddress(v), false, `expected false for ${JSON.stringify(v)}`);
  }
});

test('weekend invocations exit without sending', async () => {
  for (const iso of ['2026-03-14T13:30:00Z', '2026-03-15T13:30:00Z']) {
    const { result, sends } = await harness(iso);
    assert.strictEqual(result.status, 'weekend');
    assert.strictEqual(sends.length, 0);
  }
});

test('a day with no birthdays exits silently', async () => {
  const { result, sends } = await harness('2026-03-11T13:30:00Z', [ROSTER[4]]);
  assert.strictEqual(result.status, 'no-birthdays');
  assert.strictEqual(sends.length, 0);
});

test('dry run composes the message but sends nothing', async () => {
  const { result, sends } = await harness('2026-03-11T13:30:00Z', ROSTER, { dryRun: true });
  assert.strictEqual(result.status, 'dry-run');
  assert.strictEqual(sends.length, 0);
  assert.strictEqual(result.recipients, 4);
  assert.ok(result.subject.startsWith('Happy Birthday / ¡Feliz Cumpleaños!'));
});

test('one bad address does not abort the run', async () => {
  const result = await runBirthdayNotifications({
    now: new Date('2026-03-11T13:30:00Z'),
    employees: ROSTER,
    log: () => {},
    send: async to => { if (to === tb(3)) throw new Error('550 bad recipient'); }
  });

  assert.strictEqual(result.sent, 3);
  assert.strictEqual(result.failed, 1);
});
