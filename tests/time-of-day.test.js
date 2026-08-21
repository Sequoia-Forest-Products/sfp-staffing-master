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

test('the 1899 spreadsheet serialisation reads as its clock time', () => {
  assert.strictEqual(fmtTime('1899-12-30T20:45:00.000Z'), '8:45 PM');
  assert.strictEqual(fmtTime('1899-12-30T07:00:00.000Z'), '7:00 AM');
  assert.strictEqual(fmtTime('1899-12-30T12:45:00.000Z'), '12:45 PM');
  assert.strictEqual(fmtTime('1899-12-30T00:15:00.000Z'), '12:15 AM');
});

test('the digits are read as written, NOT cast through a Date', () => {
  // This is the whole reason parseTimeParts uses a regex. new Date(...) then
  // getHours() would shift 20:45Z to 12:45 in California and 21:45 in Berlin —
  // three different break times for one stored value, none of them stored.
  const viaDate = new Date('1899-12-30T20:45:00.000Z').getHours();
  assert.strictEqual(parseTimeParts('1899-12-30T20:45:00.000Z').hour, 20);
  if (viaDate !== 20) {
    assert.notStrictEqual(viaDate, 20,
      'this machine is not UTC, which is exactly the case the regex protects against');
  }
  // And the zone marker is ignored rather than applied.
  assert.deepStrictEqual(parseTimeParts('1899-12-30T20:45:00.000Z'),
                         parseTimeParts('1899-12-30T20:45:00'));
  assert.deepStrictEqual(parseTimeParts('1899-12-30T20:45:00+05:00'),
                         parseTimeParts('1899-12-30T20:45:00'));
});

test('the date part is ignored whatever it is', () => {
  // 1899-12-30 is the epoch we expect, but 1900-01-01 and 1970-01-01 turn up in
  // data exported by different tools. None of them is a real date here.
  for (const d of ['1899-12-30', '1899-12-31', '1900-01-01', '1970-01-01', '2026-08-21']) {
    assert.strictEqual(fmtTime(d + 'T20:45:00.000Z'), '8:45 PM', d);
  }
});

// ---------------------------------------------------------------------------
// the other shapes actually in the column
// ---------------------------------------------------------------------------

test('12-hour text with a meridiem reads back unchanged', () => {
  // What the roster's Add form writes: openAdd() defaults break1 to '7:00 AM'.
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

test('24-hour HH:MM reads back, with or without seconds', () => {
  assert.strictEqual(fmtTime('20:45'), '8:45 PM');
  assert.strictEqual(fmtTime('07:00'), '7:00 AM');
  assert.strictEqual(fmtTime('7:00'), '7:00 AM');
  assert.strictEqual(fmtTime('20:45:00'), '8:45 PM');
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

test('timeInputValue gives HH:MM for every readable shape', () => {
  assert.strictEqual(timeInputValue('1899-12-30T20:45:00.000Z'), '20:45');
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

test('everything is stored as 24-hour HH:MM going forward', () => {
  // Chosen because <input type="time"> emits exactly this, it sorts correctly as
  // text, it needs no meridiem to be unambiguous, and it carries no fake 1899
  // date for something later to misread as an instant.
  assert.strictEqual(timeStorageValue('1899-12-30T20:45:00.000Z'), '20:45');
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
  for (const v of ['1899-12-30T20:45:00.000Z', '8:45 PM', '20:45', '0.53125', '12:00 AM']) {
    const once = timeStorageValue(v);
    assert.strictEqual(timeStorageValue(once), once, v);
    assert.strictEqual(fmtTime(once), fmtTime(v), v);
  }
});
