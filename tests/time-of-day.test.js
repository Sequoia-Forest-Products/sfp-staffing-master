// break_1 / break_2 — parsing, display and the storage decision.
//
// The bug this starts from: the profile card rendered
// '1899-12-30T20:45:00.000Z' on screen where it should have read '8:45 PM'.
// That is a stored value shown without formatting, the same class of problem as
// the birthday column.
//
// The 1899-12-30 epoch is Excel/Sheets' zero date and the DATE PART IS
// MEANINGLESS — only the clock time matters. So these tests care most about two
// things: that the digits are read as written rather than cast through a Date
// (which would shift them by the viewer's UTC offset), and that a value the
// parser cannot read produces '' from timeInputValue so the caller is forced to
// deal with it rather than silently blanking somebody's data.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// core.js only — these helpers are pure and must not need the rest of the app.
function load() {
  const ctx = {
    console,
    window: {},
    document: {
      getElementById: () => ({ textContent: '', innerHTML: '', src: '', style: {},
        classList: { add() {}, remove() {} } }),
      querySelector: () => null, querySelectorAll: () => []
    },
    setTimeout: (fn) => { void fn; return 0; },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async () => ({ ok: true, json: async () => ({}) })
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'core.js'), 'utf8'),
    ctx, { filename: 'core.js' });
  return ctx;
}

const ctx = load();
const { parseTimeParts, fmtTime, timeInputValue, timeStorageValue } = ctx;

// ---------------------------------------------------------------------------
// the shape that caused the bug
// ---------------------------------------------------------------------------

test('the 1899 serialisation is EIGHT HOURS AHEAD of the time it means', () => {
  // Audited across all 74 rows. break_1 is '15:00' on 68 of them, break_2 is
  // '20:45' on 64, and the four TEXT rows in each column read '7:00 AM' and
  // '12:45 PM' — the mill's standard breaks. 15:00 - 8h is 07:00 and 20:45 - 8h
  // is 12:45: two independent values landing exactly on the known times under
  // one offset.
  //
  // Read as written instead, 68 people's morning break displays as 3:00 PM and
  // the ISO rows describe a different mill from the text rows beside them.
  assert.strictEqual(fmtTime('1899-12-30T15:00:00.000Z'), '7:00 AM');
  assert.strictEqual(fmtTime('1899-12-30T20:45:00.000Z'), '12:45 PM');
  assert.strictEqual(fmtTime('1899-12-30T21:30:00.000Z'), '1:30 PM');
  assert.strictEqual(fmtTime('1899-12-30T21:00:00.000Z'), '1:00 PM');
});

test('every ISO value actually in the column reads as a plausible break', () => {
  // The complete distribution, so a future change to the offset fails here
  // rather than on somebody's screen.
  const actual = [
    ['1899-12-30T15:00:00.000Z', '7:00 AM',  68],
    ['1899-12-31T00:30:00.000Z', '4:30 PM',   2],
    ['1899-12-30T20:45:00.000Z', '12:45 PM', 64],
    ['1899-12-30T21:30:00.000Z', '1:30 PM',   3],
    ['1899-12-31T04:45:00.000Z', '8:45 PM',   2],
    ['1899-12-30T21:00:00.000Z', '1:00 PM',   1]
  ];
  for (const [stored, expected] of actual) {
    assert.strictEqual(fmtTime(stored), expected, stored);
  }
});

test('a value past midnight UTC wraps back into the working day', () => {
  // The 1899-12-31 rows exist BECAUSE of the shift: a time-only value cannot
  // roll past its own epoch day on its own. 00:30 - 8h is 16:30 the previous
  // day, and the day is meaningless — only the clock survives.
  assert.strictEqual(fmtTime('1899-12-31T00:30:00.000Z'), '4:30 PM');
  assert.strictEqual(fmtTime('1899-12-31T04:45:00.000Z'), '8:45 PM');
  assert.strictEqual(fmtTime('1899-12-31T07:59:00.000Z'), '11:59 PM');
  assert.strictEqual(fmtTime('1899-12-31T08:00:00.000Z'), '12:00 AM');
});

test('the offset is FIXED, not the viewer\'s and not DST-aware', () => {
  // new Date(...) then getHours() applies whatever offset the machine happens to
  // have: a different break time in California, Berlin and on a UTC build
  // server, none of them the stored one. The correction has to be arithmetic on
  // the digits, and the same everywhere.
  assert.strictEqual(parseTimeParts('1899-12-30T20:45:00.000Z').hour, 12);
  assert.strictEqual(parseTimeParts('1899-12-30T20:45:00.000Z').minute, 45);

  // No DST either: 15:00 - 8 matching the text rows exactly means the export used
  // a flat -8, and 1899 predates US daylight saving anyway. Every date gets the
  // same treatment.
  for (const d of ['1899-12-30', '1899-12-31', '1900-07-04', '2026-07-04']) {
    assert.strictEqual(fmtTime(d + 'T15:00:00.000Z'), '7:00 AM', d);
  }

  // The zone marker in the string is ignored rather than honoured — the exporter
  // wrote it as boilerplate, and reading meaning into punctuation would make the
  // answer depend on which tool produced the row.
  for (const suffix of ['.000Z', '', '+00:00', '+05:00', '-03:00']) {
    assert.strictEqual(fmtTime('1899-12-30T15:00:00' + suffix), '7:00 AM', suffix);
  }
});

test('the date part is ignored whatever it is', () => {
  // 1899-12-30 is the epoch we expect, but 1900-01-01 and 1970-01-01 turn up in
  // data exported by different tools. None of them is a real date here.
  for (const d of ['1899-12-30', '1899-12-31', '1900-01-01', '1970-01-01', '2026-08-21']) {
    assert.strictEqual(fmtTime(d + 'T20:45:00.000Z'), '12:45 PM', d);
  }
});

// ---------------------------------------------------------------------------
// the other shapes actually in the column
// ---------------------------------------------------------------------------

test('12-hour text with a meridiem is NOT shifted', () => {
  // These four rows per column are the reference the offset was derived FROM.
  // Shifting them too would move already-correct values a second time — 7:00 AM
  // would become 11:00 PM the day before.
  assert.strictEqual(fmtTime('7:00 AM'), '7:00 AM');
  assert.strictEqual(fmtTime('12:45 PM'), '12:45 PM');
  assert.strictEqual(fmtTime('8:45 pm'), '8:45 PM');
  assert.strictEqual(fmtTime('8:45 p.m.'), '8:45 PM');
  assert.strictEqual(fmtTime('  8:45   PM  '), '8:45 PM');
});

test('midnight and noon are the cases a naive conversion gets wrong', () => {
  // 12 AM is hour 0 and 12 PM is hour 12. (h % 12) + (pm ? 12 : 0) gets both
  // backwards, and the error is a full twelve hours.
  assert.strictEqual(parseTimeParts('12:00 AM').hour, 0);
  assert.strictEqual(parseTimeParts('12:30 AM').hour, 0);
  assert.strictEqual(parseTimeParts('12:00 PM').hour, 12);
  assert.strictEqual(parseTimeParts('12:30 PM').hour, 12);
  assert.strictEqual(fmtTime('00:00'), '12:00 AM');
  assert.strictEqual(fmtTime('12:00'), '12:00 PM');
  assert.strictEqual(fmtTime('23:59'), '11:59 PM');
});

test('24-hour HH:MM is NOT shifted either — it is what we write from now on', () => {
  assert.strictEqual(fmtTime('20:45'), '8:45 PM');
  assert.strictEqual(fmtTime('07:00'), '7:00 AM');
  assert.strictEqual(fmtTime('7:00'), '7:00 AM');
  assert.strictEqual(fmtTime('20:45:00'), '8:45 PM');
});

test('a migrated value and its original render identically', () => {
  // The migration rewrites each ISO value as its local HH:MM. If these two ever
  // disagreed, running the migration would silently change everybody's break
  // times — which is the one thing it must not do.
  for (const iso of ['1899-12-30T15:00:00.000Z', '1899-12-31T00:30:00.000Z',
                     '1899-12-30T20:45:00.000Z', '1899-12-30T21:30:00.000Z',
                     '1899-12-31T04:45:00.000Z', '1899-12-30T21:00:00.000Z']) {
    const migrated = timeStorageValue(iso);
    assert.strictEqual(fmtTime(migrated), fmtTime(iso), iso);
    // And migrating twice is a no-op, so a re-run cannot shift anything again.
    assert.strictEqual(timeStorageValue(migrated), migrated, iso);
  }
});

test('a spreadsheet day fraction reads as a time', () => {
  assert.strictEqual(fmtTime('0.53125'), '12:45 PM');   // 12.75/24
  assert.strictEqual(fmtTime('.53125'), '12:45 PM');
  assert.strictEqual(fmtTime('0'), '12:00 AM');
});

test('a full date serial is NOT read as a time', () => {
  // 45000 is a date in 2023, not a break at 45000 o'clock. Treating it as a
  // fraction would silently produce a plausible-looking time from a column
  // mix-up; better that it reads as unreadable and gets looked at.
  for (const v of ['45000', '1', '1.5', '2.25', '100']) {
    assert.strictEqual(fmtTime(v), null, v);
  }
});

// ---------------------------------------------------------------------------
// what "unreadable" must do
// ---------------------------------------------------------------------------

test('an unreadable value returns null, not a dash and not the raw string', () => {
  // Returning the raw value is how '1899-12-30T20:45:00.000Z' got on screen in
  // the first place. Returning '—' would make the caller unable to tell
  // "nothing stored" from "something stored that I cannot read".
  for (const v of ['', '   ', null, undefined, 'lunch', 'after the whistle',
                   '25:00', '12:60', '99:99', '13:00 PM', '0:00 AM', 'PM',
                   {}, [], NaN]) {
    assert.strictEqual(fmtTime(v), null, JSON.stringify(v));
  }
});

test('13:00 PM is rejected rather than coerced', () => {
  // A meridiem with an out-of-range hour is a typo, and guessing which half the
  // author meant would store a fabricated time.
  assert.strictEqual(parseTimeParts('13:00 PM'), null);
  assert.strictEqual(parseTimeParts('0:30 PM'), null);
});

// ---------------------------------------------------------------------------
// timeInputValue — the blanking trap
// ---------------------------------------------------------------------------

test('timeInputValue gives LOCAL HH:MM for every readable shape', () => {
  // The picker must open on the time the card displays. Handing it the unshifted
  // 20:45 would show a 12:45 PM lunch as 8:45 PM, and saving would then store
  // 8:45 PM as fact.
  assert.strictEqual(timeInputValue('1899-12-30T20:45:00.000Z'), '12:45');
  assert.strictEqual(timeInputValue('1899-12-30T15:00:00.000Z'), '07:00');
  assert.strictEqual(timeInputValue('8:45 PM'), '20:45');
  assert.strictEqual(timeInputValue('20:45'), '20:45');
  assert.strictEqual(timeInputValue('7:00 AM'), '07:00');
  assert.strictEqual(timeInputValue('12:00 AM'), '00:00');
  assert.strictEqual(timeInputValue('0.53125'), '12:45');
});

test('timeInputValue gives EMPTY for an unreadable value, and that is load-bearing', () => {
  // A time input given '' renders blank, and the next save writes that blank
  // back as though somebody had deliberately cleared it. The caller MUST check
  // for this and show a text field instead — see profileEditBody. The empty
  // string here is a signal, not a fallback.
  for (const v of ['lunch', '25:00', '45000', 'after the whistle']) {
    assert.strictEqual(timeInputValue(v), '', v);
    assert.notStrictEqual(String(v).trim(), '', 'the value is NOT itself blank');
  }
  // Genuinely absent is also '' — indistinguishable here, which is why the
  // caller compares against the raw value rather than trusting this alone.
  assert.strictEqual(timeInputValue(''), '');
  assert.strictEqual(timeInputValue(null), '');
});

// ---------------------------------------------------------------------------
// the storage decision
// ---------------------------------------------------------------------------

test('everything is stored as 24-hour LOCAL HH:MM going forward', () => {
  // Chosen because <input type="time"> emits exactly this, it sorts correctly as
  // text, it needs no meridiem to be unambiguous, and it carries neither a fake
  // 1899 date nor a hidden eight-hour offset for something later to get wrong.
  assert.strictEqual(timeStorageValue('1899-12-30T20:45:00.000Z'), '12:45');
  assert.strictEqual(timeStorageValue('1899-12-30T15:00:00.000Z'), '07:00');
  assert.strictEqual(timeStorageValue('8:45 PM'), '20:45');
  assert.strictEqual(timeStorageValue('20:45'), '20:45');
  assert.strictEqual(timeStorageValue('7:00 AM'), '07:00');
});

test('an unstorable value is NULL, never a default and never an empty string', () => {
  // The bug this forecloses: `break_1: e.break1 || '7:00 AM'` in two writers,
  // one of which re-writes every row on the roster. A person with no break time
  // on file was being given one.
  for (const v of ['', null, undefined, 'lunch', '25:00']) {
    assert.strictEqual(timeStorageValue(v), null, JSON.stringify(v));
  }
});

test('storing then reading is stable, and stays stable on a second pass', () => {
  // A value that changed shape on every save would make the column impossible
  // to audit.
  for (const v of ['1899-12-30T20:45:00.000Z', '1899-12-31T00:30:00.000Z',
                   '8:45 PM', '20:45', '0.53125', '12:00 AM']) {
    const once = timeStorageValue(v);
    assert.strictEqual(timeStorageValue(once), once, v);
    assert.strictEqual(fmtTime(once), fmtTime(v), v);
  }
});
