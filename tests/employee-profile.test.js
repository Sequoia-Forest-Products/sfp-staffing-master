// Run with: npm test
//
// The first tests over the src/js modules. They are classic scripts sharing one
// global scope (see core.js), so the way to exercise them is to evaluate them
// into a sandbox in that same order and call the render functions directly.
//
// Worth the setup for one reason above all others: the profile card MUST NOT
// show compensation. Every signed-in sequoiafp.com account can open every
// profile, and Phase D did not change that — what it added is a tier deciding
// whether annual_salary is in their payload at all. The card shows neither that
// nor wage in either case, because compensation lives on Salaries & Wages: one
// page to look at, one place to change. That is a requirement about rendered
// output, so asserting it against rendered output is the only way to hold it.

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
// The REAL manifest, not a hand-picked subset.
//
// This used to be a four-file list, and it went stale the moment the profile
// card started asking canSeeSalaries() — a function that lives in
// permissions.js, which the list did not include. Every test in this file threw
// ReferenceError at once, which was the lucky outcome: a subset that happens to
// omit a module the code only touches on one branch fails nothing and proves
// the wrong thing. session.js's SCRIPT_MODULES is what the browser actually
// loads, so the sandbox loads that.
const { __SCRIPT_MODULES: MODULES } = require('../netlify/functions/session.js');

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
    // bootstrap.js runs at load and reads stored settings. It is in the manifest,
    // so loading the real module list brings it — and without this the rejection
    // surfaces as "asynchronous activity after the test ended" in whichever test
    // happens to be last, which is a confusing way to find out a browser global
    // is missing.
    localStorage: {
      _v: {},
      getItem(k) { return Object.prototype.hasOwnProperty.call(this._v, k) ? this._v[k] : null; },
      setItem(k, v) { this._v[k] = String(v); },
      removeItem(k) { delete this._v[k]; }
    },
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
// Compensation ON the card, with the salary behind its tier
// ---------------------------------------------------------------------------
//
// These three tests asserted the OPPOSITE until 2026-09-03: no wage, no salary,
// no compensation input anywhere on the card. That was Phase B's decision and it
// was right at the time — the card is opened by everybody and there were no
// permission tiers yet. Phase D built the tiers and the Salaries & Wages page
// proved them; compensation moves here and that page is retired.
//
// They are rewritten rather than deleted because the rule they guard has not
// gone away, it has become conditional, and a conditional gate has TWO failure
// directions. A gate that refuses everybody passes every "must not appear"
// assertion ever written. So each of these has a partner below asserting the
// figure IS there for somebody who may see it.

// The salaries tier, as permissions.js resolves it. Set on state rather than
// faked through a stubbed canSeeSalaries(), so the test exercises the real
// predicate the card calls.
function withSalariesTier(ctx) {
  ctx.state.perms = { tiers: ['hourly_wages', 'salaries'], isAdmin: false,
                      loading: false, error: '', email: 'peter.stroble@sequoiafp.com' };
  return ctx;
}

test('the hourly rate is on the card for anybody with app access', () => {
  // Base tier: no grants at all. Hourly rates are base-tier readable AND
  // writable in permissions-lib.js, and have been since the daily feed stopped
  // overwriting them.
  const ctx = sandbox();
  const html = openCard(ctx, [person({ payType: 'Hourly', wage: '31.50', annualSalary: null })]);

  assert.ok(html.includes('Rollin Tolle'), 'sanity: the card rendered');
  assert.match(html, /Compensation/);
  assert.match(html, /31\.50/, 'the hourly rate is not a secret from anybody');
});

test('a person with no rate is flagged, not shown as a dash', () => {
  // Every hour they work is costed at $0 in every report until somebody sets
  // one, silently. A blank cell does not say that.
  const ctx = sandbox();
  const html = openCard(ctx, [person({ payType: 'Hourly', wage: '', annualSalary: null })]);

  assert.match(html, /No rate on file/);
  assert.match(html, /cost \$0 in every report/);
});

test('the hourly rate is editable, with the change shown before saving', () => {
  const ctx = sandbox();
  const html = openCard(ctx, [person({ payType: 'Hourly', wage: '31.50' })], { editing: true });

  assert.match(html, /id="profileRateInput"/);
  assert.match(html, /setProfileRate\(this\.value\)/);
  assert.match(html, /id="profileRateNote"/, 'the live percentage needs a node to write into');
});

test('the rate note never re-renders the page, so typing cannot lose a keystroke', () => {
  // render() does `el.innerHTML = renderEmployees()`, which destroys the input
  // the cursor is in and takes the caret and any half-typed value with it.
  // Nothing in src/js preserves focus, so the live percentage has to write
  // straight into its own node — the same thing salaries.js did.
  //
  // ASSERTED BEHAVIOURALLY, not by slicing the source. Two earlier attempts to
  // read the function text failed on correct code: the first ran past
  // setProfileSalary into loadEmployeeHistory, and the second still did because
  // that one is an `async function` and the delimiter was `\nfunction `. A test
  // that depends on file order and declaration style breaks when somebody
  // reorders a file. Calling the thing and watching what it does cannot.
  const ctx = sandbox();
  openCard(ctx, [person({ payType: 'Hourly', wage: '31.50' })], { editing: true });

  const notes = {};
  ctx.document.getElementById = (id) => {
    notes[id] = notes[id] || { innerHTML: '' };
    return notes[id];
  };
  let renders = 0;
  ctx.render = () => { renders += 1; };

  ctx.setProfileRate('40.00');
  assert.strictEqual(renders, 0, 'setProfileRate re-rendered the page mid-type');
  assert.strictEqual(ctx.state.editing.wage, '40.00', 'and it must still record the keystroke');
  assert.match(notes.profileRateNote.innerHTML, /%/, 'and update the live note in place');

  ctx.setProfileSalary('150000');
  assert.strictEqual(renders, 0, 'setProfileSalary re-rendered the page mid-type');
  assert.strictEqual(ctx.state.editing.annualSalary, '150000');
  assert.match(notes.profileSalaryNote.innerHTML, /Hourly equivalent/);
});

test('a rate cannot be set for somebody with no employee number', () => {
  // wage_history.employee_number is NOT NULL, so the server refuses it. Saying
  // so beats offering a box that fails on Save.
  const ctx = sandbox();
  const html = openCard(ctx, [person({ payType: 'Hourly', wage: '31.50', empNum: '' })], { editing: true });

  assert.ok(!/id="profileRateInput"/.test(html));
  assert.match(html, /employee number before setting a rate/);
});

// ---- the salary, and both directions of its gate ----------------------

test('WITHOUT the salaries tier the card shows no figure, only the word Salaried', () => {
  const ctx = sandbox();
  // annualSalary null is what the API actually delivers to this user: the
  // projection in data.js is built from their tiers and never NAMES the column,
  // so nothing is being hidden here — there is nothing to hide.
  const html = openCard(ctx, [person({ payType: 'Salaried', wage: 'Salary', annualSalary: null })]);

  assert.match(html, /Salaried/);
  assert.match(html, /not visible to this account/);
  assert.ok(!/145000|145,000|210000/.test(html));
});

test('WITH the salaries tier the figure is there — the half a broken gate would pass', () => {
  // THE POINT OF THIS TEST. A gate that refuses everybody satisfies every "must
  // not appear" assertion in this file. Without this one, inverting the
  // condition in profileCompensation would be invisible.
  const ctx = withSalariesTier(sandbox());
  const html = openCard(ctx, [person({ payType: 'Salaried', wage: 'Salary', annualSalary: 145000 })]);

  assert.match(html, /Annual salary/);
  assert.match(html, /145,000/);
  assert.match(html, /Hourly equivalent/, 'and what the costing reports will divide it into');
  assert.ok(!/not visible to this account/.test(html));
});

test('the salary input exists only for the tier that may write it', () => {
  const withTier = openCard(withSalariesTier(sandbox()),
    [person({ payType: 'Salaried', wage: 'Salary', annualSalary: 145000 })], { editing: true });
  assert.match(withTier, /id="profileSalaryInput"/);

  const without = openCard(sandbox(),
    [person({ payType: 'Salaried', wage: 'Salary', annualSalary: null })], { editing: true });
  assert.ok(!/id="profileSalaryInput"/.test(without),
    'and hiding the input is the cosmetic half — data.js returns 403 regardless');
});

test('a salaried person shows no HOURLY rate, tier or not', () => {
  // Their cost is annual_salary / 2080. An hourly rate alongside it would be a
  // second, disagreeing figure — which is why wage-edit-lib refuses to record
  // one for a salaried person at all.
  for (const ctx of [sandbox(), withSalariesTier(sandbox())]) {
    const html = openCard(ctx, [person({ payType: 'Salaried', wage: '', annualSalary: 210000 })]);
    assert.ok(!/id="profileRateInput"/.test(html));
    assert.ok(!/Hourly rate/.test(html));
    assert.ok(html.includes('Salaried'), 'the pay TYPE is a classification and does show');
  }
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
