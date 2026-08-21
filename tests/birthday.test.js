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
  normalizePhone,
  textBoltAddress,
  isOptedOut,
  buildRecipients,
  runBirthdayNotifications
} = require('../netlify/functions/birthday-lib');

// ph(n) is what sits in the phone column; tb(n) is the address derived from it.
const ph = n => `(509) 555-${String(n).padStart(4, '0')}`;
const tb = n => `+1509555${String(n).padStart(4, '0')}@sendemailtotext.com`;

// The live birthday column stores full JS date strings — midnight Pacific with
// the numeric offset embedded. Note the label is decorative and occasionally
// wrong in the real data (see Cara: PDT written against a -0800 offset).
const jsDate = (str) => str;

// Mar 11 2026 = Wed, Mar 12 = Thu, Mar 13 = Fri, Mar 14 = Sat, Mar 15 = Sun.
const ROSTER = [
  { name: 'Ana Reyes',     birthday: jsDate('Sun Mar 11 1990 00:00:00 GMT-0800 (Pacific Standard Time)'), phone: ph(1), status: 'Active' },
  { name: 'Ben Carter',    birthday: jsDate('Mon Mar 11 1985 00:00:00 GMT-0800 (Pacific Standard Time)'), phone: ph(2), status: 'Active' },
  { name: 'Cara Lopez',    birthday: jsDate('Sat Mar 14 1992 00:00:00 GMT-0800 (Pacific Daylight Time)'), phone: ph(3), status: 'Active' },
  { name: 'Dan Whitfield', birthday: jsDate('Fri Mar 15 1991 00:00:00 GMT-0800 (Pacific Standard Time)'), phone: ph(4), status: 'Active' },
  { name: 'Eve Nakamura',  birthday: jsDate('Mon Jul 04 1988 00:00:00 GMT-0700 (Pacific Daylight Time)'), phone: ph(5), status: 'Active' },
  { name: 'Frank Osei',    birthday: jsDate('Mon Jan 20 1975 00:00:00 GMT-0800 (Pacific Standard Time)'), phone: ph(6), sms_opted_out: true, status: 'Active' },
  { name: 'Gina Alvarez',  birthday: jsDate('Sat Feb 02 1991 00:00:00 GMT-0800 (Pacific Standard Time)'), phone: 'ext. 4412', status: 'Active' },
  { name: 'Hank Moore',    birthday: '',                                                                 phone: ph(8), status: 'Active' }
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

test('full JS date strings — the live column format — parse as month/day', () => {
  assert.deepStrictEqual(
    parseBirthday('Mon Nov 12 1990 00:00:00 GMT-0800 (Pacific Standard Time)'),
    { month: 11, day: 12 }
  );
  assert.deepStrictEqual(
    parseBirthday('Mon Jul 04 1988 00:00:00 GMT-0700 (Pacific Daylight Time)'),
    { month: 7, day: 4 }
  );
});

test('a mismatched timezone label does not shift the day', () => {
  // The data contains "(Pacific Daylight Time)" against a -0800 offset. Date.parse
  // reads the numeric offset and ignores the label, so the day must hold.
  assert.deepStrictEqual(
    parseBirthday('Sun Aug 09 1992 00:00:00 GMT-0800 (Pacific Daylight Time)'),
    { month: 8, day: 9 }
  );
  assert.deepStrictEqual(
    parseBirthday('Wed Jun 15 1994 00:00:00 GMT-0700 (Pacific Standard Time)'),
    { month: 6, day: 15 }
  );
});

test('year-boundary JS date strings do not roll into an adjacent day', () => {
  // Midnight PT is 08:00 UTC the same day, so Jan 1 and Dec 31 must stay put.
  assert.deepStrictEqual(
    parseBirthday('Mon Jan 01 1990 00:00:00 GMT-0800 (Pacific Standard Time)'),
    { month: 1, day: 1 }
  );
  assert.deepStrictEqual(
    parseBirthday('Thu Dec 31 1987 00:00:00 GMT-0800 (Pacific Standard Time)'),
    { month: 12, day: 31 }
  );
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

test('Thursday looks ahead 3 days, covering Fri/Sat/Sun', () => {
  const w = buildTargetDates({ year: 2026, month: 3, day: 12 });
  assert.strictEqual(w.daysToLookAhead, 3);
  assert.deepStrictEqual(w.targets.map(t => `${t.month}/${t.date}`), ['3/12', '3/13', '3/14', '3/15']);
});

test('the look-ahead rolls across a month boundary', () => {
  // Thu Apr 30 2026 → May 1, 2, 3.
  const w = buildTargetDates({ year: 2026, month: 4, day: 30 });
  assert.deepStrictEqual(w.targets.map(t => `${t.month}/${t.date}`), ['4/30', '5/1', '5/2', '5/3']);
});

test('Friday and the weekend produce no window', () => {
  // Friday is deliberately excluded — Thursday already covered these people.
  assert.strictEqual(buildTargetDates({ year: 2026, month: 3, day: 13 }), null); // Fri
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
  // One upcoming person — singular "a birthday" / "un cumpleaños".
  assert.ok(body.includes('We also have Cara Lopez celebrating a birthday over the upcoming weekend!'));
  assert.ok(body.includes('¡También tenemos a Cara Lopez celebrando un cumpleaños durante el próximo fin de semana!'));
  assert.ok(!body.includes('Birthday today'), 'nobody has a birthday on the Thursday itself');
  assert.ok(!sends.some(s => s.to === tb(3)), 'Cara must not receive her own message');
});

test('multiple upcoming people use the plural birthday wording', async () => {
  const { result, sends } = await harness('2026-03-12T13:30:00Z');

  assert.deepStrictEqual(result.people, ['Cara', 'Dan']); // Sat Mar 14 + Sun Mar 15
  const { body } = sends[0];
  assert.ok(body.includes(
    'We also have Cara Lopez & Dan Whitfield celebrating birthdays over the upcoming weekend!'
  ));
  assert.ok(body.includes(
    '¡También tenemos a Cara Lopez & Dan Whitfield celebrando cumpleaños durante el próximo fin de semana!'
  ));
  const to = sends.map(s => s.to);
  assert.ok(!to.includes(tb(3)) && !to.includes(tb(4)));
});

test('a Friday birthday is announced by the Thursday run', async () => {
  const roster = [
    { name: 'Cara Lopez', birthday: '1992-03-13', phone: ph(3), status: 'Active' },
    { name: 'Eve Nakamura', birthday: '1988-07-04', phone: ph(5), status: 'Active' }
  ];
  const { result, sends } = await harness('2026-03-12T13:30:00Z', roster);

  assert.deepStrictEqual(result.people, ['Cara']);
  assert.ok(sends[0].body.includes('We also have Cara Lopez celebrating a birthday over the upcoming weekend!'));
  assert.strictEqual(sends[0].to, tb(5));
});

test('today and upcoming birthdays combine into one message', async () => {
  const roster = [
    { name: 'Ana Reyes', birthday: '1990-03-12', phone: ph(1), status: 'Active' },
    { name: 'Cara Lopez', birthday: '1992-03-14', phone: ph(3), status: 'Active' },
    { name: 'Eve Nakamura', birthday: '1988-07-04', phone: ph(5), status: 'Active' }
  ];
  const { sends } = await harness('2026-03-12T13:30:00Z', roster);

  assert.strictEqual(sends.length, 1);
  assert.ok(sends[0].body.includes("It is Ana Reyes's Birthday today!"));
  assert.ok(sends[0].body.includes('We also have Cara Lopez celebrating a birthday over the upcoming weekend!'));
  assert.strictEqual(sends[0].to, tb(5));
});

test('a birthday person with no address is still named but receives nothing', async () => {
  const roster = [
    { name: 'Tony Griffith', birthday: 'Wed Mar 11 1970 00:00:00 GMT-0800 (Pacific Standard Time)', phone: '', status: 'Active' },
    { name: 'Eve Nakamura',  birthday: 'Mon Jul 04 1988 00:00:00 GMT-0700 (Pacific Daylight Time)', phone: ph(5), status: 'Active' }
  ];
  const { result, sends } = await harness('2026-03-11T13:30:00Z', roster);

  assert.deepStrictEqual(result.people, ['Tony']);
  assert.ok(sends[0].body.includes("It is Tony Griffith's Birthday today!"));
  assert.deepStrictEqual(sends.map(s => s.to), [tb(5)]);
});

test('an empty address never sneaks into the recipient list', () => {
  const roster = [
    { name: 'Tony Griffith', phone: '', status: 'Active' },
    { name: 'Eve Nakamura',  phone: ph(5), status: 'Active' }
  ];
  const birthdayPeople = [{ full: 'Tony Griffith', first: 'Tony', address: '' }];
  assert.deepStrictEqual(buildRecipients(roster, birthdayPeople), [tb(5)]);
});

test('a birthday person who opted out is still named but receives nothing', async () => {
  const roster = [
    { name: 'Frank Osei', birthday: '1975-03-11', phone: ph(6), sms_opted_out: true, status: 'Active' },
    { name: 'Eve Nakamura', birthday: '1988-07-04', phone: ph(5), status: 'Active' }
  ];
  const { result, sends } = await harness('2026-03-11T13:30:00Z', roster);

  assert.deepStrictEqual(result.people, ['Frank']);
  assert.ok(sends[0].body.includes("It is Frank Osei's Birthday today!"));
  assert.deepStrictEqual(sends.map(s => s.to), [tb(5)]);
});

test('opted-out and unusable-phone employees never receive', () => {
  const recipients = buildRecipients(ROSTER, [], () => {});
  // Frank has a perfectly good phone, ph(6), but has opted out.
  assert.ok(!recipients.includes(tb(6)), 'opted-out employee must not receive');
  // Gina's phone ("ext. 4412") does not normalise.
  assert.strictEqual(recipients.length, 6); // ph(1..5) plus ph(8)
});

test('opting out leaves the phone number untouched and reversible', () => {
  // The point of sms_opted_out: nothing about the number changes, so opting
  // back in resumes texting with nothing to re-enter.
  const frank = ROSTER.find(e => e.name === 'Frank Osei');
  assert.strictEqual(frank.phone, ph(6));
  assert.ok(isOptedOut(frank));
  assert.strictEqual(textBoltAddress(frank.phone), tb(6));

  const optedBackIn = { ...frank, sms_opted_out: false };
  assert.deepStrictEqual(buildRecipients([optedBackIn], []), [tb(6)]);
});

test('isOptedOut reads the boolean and still honours legacy STOP rows', () => {
  assert.strictEqual(isOptedOut({ sms_opted_out: true, phone: ph(1) }), true);
  assert.strictEqual(isOptedOut({ sms_opted_out: false, phone: ph(1) }), false);
  assert.strictEqual(isOptedOut({ phone: ph(1) }), false);
  // Pre-migration rows must not start receiving texts again.
  assert.strictEqual(isOptedOut({ text_bolt: 'STOP' }), true);
  assert.strictEqual(isOptedOut({ text_bolt: ' stop ' }), true);
});

test('an unmigrated STOP row is still excluded from recipients', () => {
  const roster = [
    { name: 'Legacy Larry', text_bolt: 'STOP', status: 'Active' },
    { name: 'Eve Nakamura', phone: ph(5), status: 'Active' }
  ];
  assert.deepStrictEqual(buildRecipients(roster, []), [tb(5)]);
});

test('duplicate addresses are only messaged once', () => {
  const roster = [
    { name: 'A One', phone: ph(1), status: 'Active' },
    { name: 'B Two', phone: '509-555-0001', status: 'Active' }
  ];
  assert.strictEqual(buildRecipients(roster, []).length, 1);
});

test('normalizePhone strips whatever format the free-text column holds', () => {
  for (const v of ['(509) 555-0123', '509-555-0123', '509.555.0123', '5095550123',
                   ' 509 555 0123 ', '+1 (509) 555-0123', '1-509-555-0123']) {
    assert.strictEqual(normalizePhone(v), '5095550123', `failed for ${JSON.stringify(v)}`);
  }
});

test('normalizePhone rejects anything that is not 10 digits', () => {
  for (const v of ['', null, undefined, '555-0123', '12345', 'ext. 4412',
                   'n/a', '509-555-01234', '2-509-555-0123']) {
    assert.strictEqual(normalizePhone(v), null, `expected null for ${JSON.stringify(v)}`);
  }
});

test('textBoltAddress derives the address from the phone number', () => {
  assert.strictEqual(textBoltAddress('(509) 555-0123'), '+15095550123@sendemailtotext.com');
  assert.strictEqual(textBoltAddress('1-509-555-0123'), '+15095550123@sendemailtotext.com');
  assert.strictEqual(textBoltAddress('ext. 4412'), null);
  assert.strictEqual(textBoltAddress(''), null);
});

test('an unusable phone number is warned about and skipped', async () => {
  const roster = [
    { name: 'Ana Reyes',    birthday: '1990-03-11', phone: ph(1), status: 'Active' },
    { name: 'Gina Alvarez', birthday: '1991-02-02', phone: 'ext. 4412', status: 'Active' },
    { name: 'Hank Moore',   birthday: '', phone: '', status: 'Active' }
  ];
  const { sends, logs } = await harness('2026-03-11T13:30:00Z', roster);

  // Ana is the birthday person; Gina is unreachable; Hank has no phone at all.
  assert.strictEqual(sends.length, 0);

  const warnings = logs.filter(l => l.startsWith('WARNING:') && l.includes('phone'));
  assert.strictEqual(warnings.length, 1, 'exactly one phone warning expected');
  assert.ok(warnings[0].includes('Gina Alvarez'));
  assert.ok(warnings[0].includes('ext. 4412'));

  // A blank phone is ordinary data, not an error — it must not warn.
  assert.ok(!warnings.some(l => l.includes('Hank Moore')));
});

test('the Nolan case: opted out, valid phone, named but not texted', async () => {
  const roster = [
    { name: "Nolan O'Kelly", birthday: '1980-03-11', phone: ph(7), sms_opted_out: true, status: 'Active' },
    { name: 'Eve Nakamura',  birthday: '1988-07-04', phone: ph(5), status: 'Active' }
  ];
  const { result, sends } = await harness('2026-03-11T13:30:00Z', roster);

  // Named on his birthday...
  assert.deepStrictEqual(result.people, ['Nolan']);
  assert.ok(sends[0].body.includes("It is Nolan O'Kelly's Birthday today!"));
  // ...but never texted, even though his phone derives a perfectly good address.
  assert.strictEqual(textBoltAddress(ph(7)), tb(7));
  assert.deepStrictEqual(sends.map(s => s.to), [tb(5)]);
});

test('an unparseable birthday is warned about, not silently dropped', async () => {
  const roster = [
    { name: 'Ana Reyes',   birthday: 'sometime in March', phone: ph(1), status: 'Active' },
    { name: 'Ben Carter',  birthday: 'Mon Mar 11 1985 00:00:00 GMT-0800 (Pacific Standard Time)', phone: ph(2), status: 'Active' },
    { name: 'Hank Moore',  birthday: '', phone: ph(8), status: 'Active' }
  ];
  const { result, logs } = await harness('2026-03-11T13:30:00Z', roster);

  assert.deepStrictEqual(result.people, ['Ben']);

  const warnings = logs.filter(l => l.startsWith('WARNING:'));
  assert.strictEqual(warnings.length, 1, 'exactly one warning expected');
  assert.ok(warnings[0].includes('Ana Reyes'));
  assert.ok(warnings[0].includes('sometime in March'));

  // A blank birthday is normal data, not a parse failure — it must not warn.
  assert.ok(!warnings.some(l => l.includes('Hank Moore')));
});

test('Friday and weekend invocations exit without sending', async () => {
  // Includes Friday: a manual trigger or mocked Friday date must not re-announce
  // the people Thursday already covered.
  for (const iso of ['2026-03-13T13:30:00Z', '2026-03-14T13:30:00Z', '2026-03-15T13:30:00Z']) {
    const { result, sends } = await harness(iso);
    assert.strictEqual(result.status, 'no-run-day', `expected no send for ${iso}`);
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

// ---------------------------------------------------------------------------
// Migration equivalence — the acceptance criterion, as code
// ---------------------------------------------------------------------------
//
// SCHEMA_PHASE_B_BIRTHDAY.sql rewrites the stored JS date strings to YYYY-MM-DD.
// The notifier reads MONTH AND DAY ONLY, so the migration is safe exactly when
// the month and day survive it. This asserts that for both formats of the same
// birthday, over cases chosen to break it:
//
//   * a PST date and a PDT date, since the offset differs by an hour
//   * a date whose Pacific midnight is the previous day in UTC-11, which is what
//     a timestamptz cast would get wrong
//   * the first and last day of a month, where an off-by-one hour shows up as an
//     off-by-one MONTH
//   * Feb 29, which only exists in a leap year
test('the migrated ISO value parses to the same month and day as the JS date string', () => {
  const pairs = [
    ['Mon Nov 12 1990 00:00:00 GMT-0800 (Pacific Standard Time)', '1990-11-12'],
    ['Sat Aug 11 1979 00:00:00 GMT-0700 (Pacific Daylight Time)', '1979-08-11'],
    ['Tue Jan 01 1985 00:00:00 GMT-0800 (Pacific Standard Time)', '1985-01-01'],
    ['Thu Jan 31 1974 00:00:00 GMT-0800 (Pacific Standard Time)', '1974-01-31'],
    ['Wed Dec 31 1969 00:00:00 GMT-0800 (Pacific Standard Time)', '1969-12-31'],
    ['Sat Mar 01 1980 00:00:00 GMT-0800 (Pacific Standard Time)', '1980-03-01'],
    ['Sun Feb 29 1976 00:00:00 GMT-0800 (Pacific Standard Time)', '1976-02-29']
  ];

  for (const [oldValue, newValue] of pairs) {
    const before = parseBirthday(oldValue);
    const after  = parseBirthday(newValue);
    assert.ok(before, `the stored format must parse: ${oldValue}`);
    assert.ok(after, `the migrated format must parse: ${newValue}`);
    assert.deepStrictEqual(after, before,
      `migrating ${JSON.stringify(oldValue)} to ${newValue} changed the month/day`);
  }
});

test('a value with no year still parses, so the migration can leave it alone', () => {
  // SCHEMA_PHASE_B_BIRTHDAY.sql section 1c deliberately does not touch these:
  // there is no year to build a date from and inventing one would write a false
  // fact into an HR record. They must keep working untouched.
  assert.deepStrictEqual(parseBirthday('3/15'), { month: 3, day: 15 });
  assert.deepStrictEqual(parseBirthday('12/25'), { month: 12, day: 25 });
  assert.deepStrictEqual(parseBirthday('12/25/90'), { month: 12, day: 25 });
});

test('the parser accepts both formats at once, which is what makes a mid-deploy state safe', () => {
  // The function may run against a half-migrated table while the deploy rolls.
  const migrated   = parseBirthday('1990-11-12');
  const unmigrated = parseBirthday('Mon Nov 12 1990 00:00:00 GMT-0800 (Pacific Standard Time)');
  assert.deepStrictEqual(migrated, unmigrated);
  assert.deepStrictEqual(migrated, { month: 11, day: 12 });
});
