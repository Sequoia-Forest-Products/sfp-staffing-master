// Run with: npm test
//
// The first tests over the src/js modules. They are classic scripts sharing one
// global scope (see core.js), so the way to exercise them is to evaluate them
// into a sandbox in that same order and call the render functions directly.
//
// Worth the setup for one reason above all others: the profile card MUST NOT
// show compensation. There is no permissions system, so every signed-in
// sequoiafp.com account can open every profile. annual_salary is not even in the
// API payload, and wage — which is in the payload and on the roster — must not be
// extended onto this new surface. That is a requirement about rendered output, so
// asserting it against rendered output is the only way to hold it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'src', 'js');

// The load order the session function uses. Only the modules the roster needs.
//
// preapproved.js and allocations.js are here because the profile card is where
// both are assigned (Phase C tasks 4 and 5), so the card calls into them —
// preApprovedFor, PREAPPROVED_TYPES, savePreApproved, profileAllocation. They are
// loaded AFTER employees.js, matching the manifest, so the TDZ ordering the real
// page has is the ordering these tests exercise.
const MODULES = ['core.js', 'employees.js', 'preapproved.js', 'allocations.js'];

// Enough of an element for the top-level DOM writes in core.js and for the
// handful of render paths that poke at one.
function fakeEl() {
  return {
    textContent: '', innerHTML: '', value: '', checked: false,
    style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {}, addEventListener() {},
    appendChild() {}, querySelector: () => fakeEl(), querySelectorAll: () => []
  };
}

function sandbox() {
  const ctx = {
    console,
    // The renderers touch these only on paths this file does not call; they exist
    // so evaluation does not throw at definition time.
    window: {},
    // core.js writes the signed-in user's name into the header at load time, so
    // getElementById has to hand back something writable rather than null.
    document: {
      getElementById: () => fakeEl(),
      querySelector: () => fakeEl(),
      querySelectorAll: () => []
    },
    setTimeout: () => 0,
    fetch: async () => ({ ok: true, json: async () => ({ data: [] }) })
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const m of MODULES) {
    vm.runInContext(fs.readFileSync(path.join(SRC, m), 'utf8'), ctx, { filename: m });
  }
  // `state` is declared with const, so it lives in the context's global LEXICAL
  // scope and is not a property of the global object — ctx.state is undefined
  // even though the modules all share it. Another script in the same context can
  // see it, so this hands out a reference. Function declarations (renderProfile,
  // employeeRow, rosterStats) are global properties already.
  vm.runInContext('globalThis.state = state;', ctx, { filename: 'expose-state.js' });
  return ctx;
}

// A person with every field populated, including the two that must never render.
function person(over = {}) {
  return Object.assign({
    id: 1,
    name: 'Rollin Tolle',
    empNum: '0319',
    status: 'Active',
    language: 'English',
    department: 'Production',
    costClass: 'Manufacturing',
    positionGroup: 'Sawmill Operators',
    position: 'Head Sawyer',
    payType: 'Hourly',
    wage: 31.5,
    annualSalary: 145000,          // must never reach the card
    phone: '5551234567',
    email: 'rollin.tolle@sequoiafp.com',
    smsOptedOut: false,
    birthday: 'Sat Aug 11 1979 00:00:00 GMT-0700 (Pacific Daylight Time)',
    addressStreet: '12 Mill Road',
    addressCity: 'Dinuba',
    addressState: 'CA',
    addressPostalCode: '93618',
    driveFolderId: 'FOLDER123',
    days: 'MON-THU',
    break1: '7:00 AM',
    break2: '12:45 PM'
  }, over);
}

function openCard(ctx, people, { editing = false } = {}) {
  ctx.state.employees = people;
  ctx.state.profile = { idx: 0 };
  ctx.state.editing = editing ? Object.assign({}, people[0], { _idx: 0, _isNew: false }) : null;
  return ctx.renderProfile();
}

// ---------------------------------------------------------------------------
// Compensation stays off the card
// ---------------------------------------------------------------------------

test('the read-only card shows no wage and no salary', () => {
  const ctx = sandbox();
  const html = openCard(ctx, [person()]);

  assert.ok(html.includes('Rollin Tolle'), 'sanity: the card rendered');
  assert.ok(!/31\.5|31,50|\$31/.test(html), 'the hourly wage must not appear');
  assert.ok(!/145000|145,000/.test(html), 'the salary must not appear');
  assert.ok(!/Wage|Salary/i.test(html.replace(/Salaries &amp; Wages/g, '')),
    'no compensation label either');
});

test('the editable card has no compensation input', () => {
  const ctx = sandbox();
  const html = openCard(ctx, [person()], { editing: true });

  assert.ok(!/31\.5|145000/.test(html), 'no compensation value in any input');
  assert.ok(!/state\.editing\.wage/.test(html), 'and nothing bound to the wage field');
  assert.ok(!/wageInput/.test(html), 'not even the roster modal wage input id');
});

test('a salaried person still shows no figure', () => {
  const ctx = sandbox();
  const html = openCard(ctx, [person({ payType: 'Salaried', wage: '', annualSalary: 210000 })]);

  assert.ok(!/210000|210,000/.test(html));
  assert.ok(html.includes('Salaried'), 'the pay TYPE is a classification and does show');
});

// ---------------------------------------------------------------------------
// The fields that should be there
// ---------------------------------------------------------------------------

test('the card groups every specified field', () => {
  const ctx = sandbox();
  const html = openCard(ctx, [person()]);

  for (const group of ['Identity', 'Classification', 'Contact', 'Personal', 'Address', 'Files']) {
    assert.ok(html.includes(group), `missing group: ${group}`);
  }
  for (const value of ['0319', 'Production', 'Manufacturing', 'Sawmill Operators',
                       'Head Sawyer', 'Hourly', '5551234567', '12 Mill Road',
                       'Dinuba', 'CA', '93618']) {
    assert.ok(html.includes(value), `missing value: ${value}`);
  }
});

test('clock in and clock out are gone from both modes', () => {
  const ctx = sandbox();
  for (const editing of [false, true]) {
    const html = openCard(ctx, [person()], { editing });
    assert.ok(!/Clock\s*(in|out)/i.test(html), `clock fields present (editing=${editing})`);
    assert.ok(!/clockIn|clockOut/.test(html), `clock bindings present (editing=${editing})`);
  }
});

// ---------------------------------------------------------------------------
// The Drive link
// ---------------------------------------------------------------------------

test('a populated drive_folder_id renders a working link', () => {
  const ctx = sandbox();
  const html = openCard(ctx, [person()]);
  assert.ok(html.includes('https://drive.google.com/drive/folders/FOLDER123'));
  assert.ok(html.includes('target="_blank"'));
  assert.ok(html.includes('rel="noopener noreferrer"'), 'a new tab needs noopener');
});

test('a missing drive folder says so plainly rather than showing a dash', () => {
  const ctx = sandbox();
  const html = openCard(ctx, [person({ driveFolderId: '' })]);
  assert.ok(!html.includes('drive.google.com/drive/folders'), 'no link to nowhere');
  assert.match(html, /No folder yet/, 'a new hire with no folder is a real state');
});

test('the stored folder id is authoritative — no lookup when it is set', () => {
  // loadDriveLink() asks /api/documents BY NAME and overwrites #driveLinkArea
  // with the answer. On somebody who already has an id that would replace a
  // correct link with a second opinion, including replacing it with
  // "No folder found" if the lookup disagreed.
  const ctx = sandbox();
  assert.strictEqual(ctx.needsDriveLookup(person()), false, 'a stored id needs no lookup');
  assert.strictEqual(ctx.needsDriveLookup(person({ driveFolderId: '' })), true,
    'no id is the only case where the lookup can help');
  assert.strictEqual(ctx.needsDriveLookup(undefined), true);
});

test('a folder id containing markup cannot break out of the href', () => {
  const ctx = sandbox();
  const html = openCard(ctx, [person({ driveFolderId: '"><script>alert(1)</script>' })]);
  assert.ok(!html.includes('<script>'), 'unescaped folder id in the href');
});

// ---------------------------------------------------------------------------
// Birthdays — the live system
// ---------------------------------------------------------------------------

test('the card shows month and day, matching what the notifier reads', () => {
  const ctx = sandbox();
  // Rollin Tolle on 2026-08-11 is the known-good case verified earlier.
  const html = openCard(ctx, [person()]);
  assert.ok(html.includes('August 11'), 'the stored JS date string reads as August 11');
});

test('a month/day value with no year still shows, because the notifier still announces it', () => {
  const ctx = sandbox();
  const html = openCard(ctx, [person({ birthday: '3/15' })]);
  assert.ok(html.includes('March 15'),
    'parseBirthday reads M/D fine, so the card must not report it as missing');
});

test('an unreadable birthday is called out, not shown as blank', () => {
  const ctx = sandbox();
  const html = openCard(ctx, [person({ birthday: 'sometime in June' })]);
  assert.match(html, /Unreadable/, 'silently blank would mean nobody notices they are not announced');
  assert.ok(html.includes('sometime in June'), 'and it shows the value that cannot be read');
});

test('the edit form gives a date picker for a value it can represent', () => {
  const ctx = sandbox();
  const html = openCard(ctx, [person()], { editing: true });
  assert.ok(html.includes('type="date"'), 'a picker, not free text');
  assert.ok(html.includes('value="1979-08-11"'), 'pre-filled from the old stored format');
});

test('the edit form does NOT blank a birthday the picker cannot show', () => {
  // The dangerous case: <input type="date"> renders empty for an unparseable
  // value, and saving would write that emptiness over a real birthday.
  const ctx = sandbox();
  const html = openCard(ctx, [person({ birthday: '3/15' })], { editing: true });

  assert.ok(!html.includes('type="date"'), 'must fall back to text rather than an empty picker');
  assert.ok(html.includes('value="3/15"'), 'the stored value is preserved in the field');
  assert.match(html, /left as text rather than blanked/);
});

// ---------------------------------------------------------------------------
// Position
// ---------------------------------------------------------------------------

test('position suggestions come from the roster, grouped first by position group', () => {
  const ctx = sandbox();
  const people = [
    person(),
    person({ id: 2, name: 'B', positionGroup: 'Sawmill Operators', position: 'Edgerman' }),
    person({ id: 3, name: 'C', positionGroup: 'Green Chain', position: 'Stacker' }),
    person({ id: 4, name: 'D', positionGroup: '', position: 'Chief Executive Officer' })
  ];
  const html = openCard(ctx, people, { editing: true });

  for (const p of ['Head Sawyer', 'Edgerman', 'Stacker', 'Chief Executive Officer']) {
    assert.ok(html.includes(p), `suggestion missing: ${p}`);
  }
  // Same-group titles first, so the common case is at the top of the list.
  assert.ok(html.indexOf('Edgerman') < html.indexOf('Stacker'),
    'titles in the selected position group should be offered before the rest');
});

test('position is free text, so a new title can be typed', () => {
  const ctx = sandbox();
  const html = openCard(ctx, [person()], { editing: true });
  assert.ok(/list="positionSuggestions"/.test(html), 'a datalist, not a closed select');
  assert.ok(/<input[^>]+list="positionSuggestions"/.test(html), 'and it is an input');
});

test('a non-mill person has a position and no position group', () => {
  const ctx = sandbox();
  const html = openCard(ctx, [person({ positionGroup: '', position: 'Chief Financial Officer' })]);
  assert.ok(html.includes('Chief Financial Officer'), 'position applies to everyone');
  assert.match(html, /none — not mill floor staff/, 'and a blank group is explained, not blamed');
});

// ---------------------------------------------------------------------------
// Escaping — employee names are user-controlled
// ---------------------------------------------------------------------------

test('a name containing markup is escaped on the card', () => {
  const ctx = sandbox();
  const html = openCard(ctx, [person({ name: '<img src=x onerror=alert(1)>' })]);
  assert.ok(!html.includes('<img src=x'), 'raw markup reached the page');
  assert.ok(html.includes('&lt;img src=x'), 'and it should be escaped instead');
});

test('the roster row escapes every user-controlled field', () => {
  const ctx = sandbox();
  const evil = '"><script>alert(1)</script>';
  ctx.state.employees = [person({ name: evil, days: evil, phone: evil, status: evil })];
  ctx.state.profile = null;
  ctx.state.editing = null;

  const row = ctx.employeeRow(ctx.state.employees[0]);
  assert.ok(!row.includes('<script>'), 'unescaped script tag in the roster row');
  assert.ok(row.includes('&lt;script&gt;'), 'expected escaped output');
});

test('both roster renderers use the same row builder and the same wage format', () => {
  // renderEmployeeList used to print e.wage raw where renderEmployees used
  // fmtWage(e), so the same person's wage read differently once you typed in the
  // search box.
  const src = fs.readFileSync(path.join(SRC, 'employees.js'), 'utf8');
  assert.ok(!/\$\{e\.wage\|\|'—'\}/.test(src), 'the raw wage render is back');
  assert.strictEqual((src.match(/function employeeRow\(/g) || []).length, 1);
  // Both call sites go through it.
  assert.ok((src.match(/\.map\(employeeRow\)/g) || []).length >= 2,
    'both renderers should map the shared row builder');
});

test('the four stat cards are computed in one place', () => {
  const ctx = sandbox();
  ctx.state.employees = [
    person({ status: 'Active', language: 'English' }),
    person({ id: 2, status: 'Active', language: 'Spanish' }),
    person({ id: 3, status: 'Active', language: '' }),        // neither
    person({ id: 4, status: 'Terminated' })                   // neither Active nor Inactive
  ];
  const st = ctx.rosterStats();

  assert.strictEqual(st.active, 3);
  assert.strictEqual(st.english, 1, 'someone with no language recorded is not an English speaker');
  assert.strictEqual(st.spanish, 1);
  assert.strictEqual(st.inactive, 1, 'inactive is everyone who is not Active, whatever the label');
});
