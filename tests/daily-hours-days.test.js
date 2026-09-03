// Run with: npm test
//
// Every day gets a row, and the reason a day is empty is a fact rather than an
// assumption.
//
// THE BUG THIS FILE IS ABOUT. A payroll file that reports no hours builds no
// daily_hours rows. That is correct — there are no hours to record — but it
// meant an empty day and a missing day were the same absence, and everything
// downstream guessed. The Daily Hours tab derived gaps by subtracting what came
// back from the date range, so a day nobody worked appeared in a red banner as a
// "probable missed delivery"; payroll-missed-check did the same arithmetic and
// emailed about it. Both were wrong in the same direction, every quiet day.
//
// processed_emails already knew. It carries work_date, status and rows_imported
// for every message the ingest handled, so "a file arrived for this date" was
// recorded the whole time and nothing read it. These tests pin that it is read
// now, and that each of the five states a date can be in is distinguishable.
//
// Negative controls, actually run while writing this — each sabotage applied on
// its own and reverted:
//
//   dayState returns 'no-file' whenever rowCount is 0   -> 4 fail
//   eachDate returns only the dates that have rows      -> 6 fail
//   NAMED_LIMIT raised so nothing is ever omitted       -> 1 fail
//   roster lookup reads e.employee_number again         -> 1 fail
//   the overflow menu is absolutely positioned again    -> 1 fail
//   "Delete day" put back on the row                    -> 1 fail
//   a stale snapshot counted as unassigned again        -> 1 fail
//
// Restored, 25 pass.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHmac } = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'js');
const TZ = 'America/Los_Angeles';

process.env.SESSION_SECRET = 'test-session-secret';
process.env.PAYROLL_TIME_ZONE = TZ;
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

const payrollDb = require('../netlify/functions/payroll-db');
const REAL_DB = { ...payrollDb };
const { handler } = require('../netlify/functions/payroll-import');
const { workDateInfo } = require('../netlify/functions/payroll-lib');

const TODAY = workDateInfo(null, TZ).date;
const shiftDay = (dateStr, days) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * 86400000).toISOString().slice(0, 10);
};

function sessionCookie() {
  const b64 = Buffer.from(JSON.stringify({
    email: 'peter.stroble@sequoiafp.com', exp: Date.now() + 3600000
  })).toString('base64url');
  const sig = createHmac('sha256', process.env.SESSION_SECRET).update(b64).digest('base64url');
  return `sfp_session=${b64}.${sig}`;
}

const invoke = async body => {
  const res = await handler({
    httpMethod: 'POST', headers: { cookie: sessionCookie() }, body: JSON.stringify(body)
  });
  return { statusCode: res.statusCode, body: JSON.parse(res.body) };
};

function stub(t, { rows = [], deliveries = [], deliveriesThrow = null } = {}) {
  Object.assign(payrollDb, {
    fetchDaySummaries: async () => rows,
    fetchDeliveriesForDates: async () => {
      if (deliveriesThrow) throw new Error(deliveriesThrow);
      return deliveries;
    }
  });
  t.after(() => { Object.assign(payrollDb, REAL_DB); });
}

const hoursRow = (workDate, empNumber, over = {}) => Object.assign({
  work_date: workDate,
  employee_number: empNumber,
  first_name: 'Ana', last_name: 'Smith',
  total_hours: 10, ot_hours: 0,
  department: 'Production',
  flags: [],
  source: 'email', date_source: 'email_received',
  upload_batch_id: 'batch-1', created_at: '2026-08-18T09:00:00.000Z',
  email_received_at: '2026-08-18T13:04:00.000Z'
}, over);

const byDate = days => Object.fromEntries(days.map(d => [d.workDate, d]));

// ---------------------------------------------------------------------------
// Every date in the range gets a row
// ---------------------------------------------------------------------------

test('a date with no rows still comes back, in date order with the rest', async (t) => {
  const from = shiftDay(TODAY, -4), to = shiftDay(TODAY, -1);
  stub(t, { rows: [hoursRow(shiftDay(TODAY, -2), '0101')] });

  const { statusCode, body } = await invoke({ action: 'days', from, to });
  assert.strictEqual(statusCode, 200);
  assert.deepStrictEqual(body.days.map(d => d.workDate),
    [shiftDay(TODAY, -1), shiftDay(TODAY, -2), shiftDay(TODAY, -3), shiftDay(TODAY, -4)],
    'four days in the range, newest first, whether or not they have rows');
});

test('a future date inside the range is not a gap', async (t) => {
  stub(t, { rows: [] });
  const { body } = await invoke({ action: 'days', from: TODAY, to: shiftDay(TODAY, 2) });
  const days = byDate(body.days);
  assert.strictEqual(days[shiftDay(TODAY, 1)].state, 'future');
  assert.strictEqual(days[shiftDay(TODAY, 2)].state, 'future');
});

// ---------------------------------------------------------------------------
// The five states
// ---------------------------------------------------------------------------

test('a day whose file arrived and reported no hours is no-hours, not no-file', async (t) => {
  // THE BUG. Before this, both of these dates were indistinguishable, and both
  // were reported as probable missed deliveries.
  const worked = shiftDay(TODAY, -1);
  const quiet = shiftDay(TODAY, -2);
  const gone = shiftDay(TODAY, -3);

  stub(t, {
    rows: [hoursRow(worked, '0101')],
    deliveries: [
      { work_date: worked, status: 'imported', rows_imported: 1, message_id: 'm1' },
      { work_date: quiet, status: 'imported', rows_imported: 0, message_id: 'm2',
        received_at: '2026-08-20T13:04:00.000Z' }
      // nothing at all for `gone`
    ]
  });

  const { body } = await invoke({ action: 'days', from: gone, to: worked });
  const days = byDate(body.days);

  assert.strictEqual(days[worked].state, 'data');
  assert.strictEqual(days[quiet].state, 'no-hours',
    'a file arrived and reported nothing — that is a fact about the day, not a failure');
  assert.strictEqual(days[gone].state, 'no-file');

  // And the quiet day still carries its evidence, so the tab can say when it came.
  assert.strictEqual(days[quiet].delivery.status, 'imported');
  assert.strictEqual(days[quiet].delivery.rowsImported, 0);
  assert.strictEqual(days[quiet].emailReceivedAt, '2026-08-20T13:04:00.000Z');
});

test('a delivery that did not import reads as not-imported', async (t) => {
  const date = shiftDay(TODAY, -1);
  for (const status of ['pending_review', 'error', 'duplicate_file', 'rejected']) {
    stub(t, { rows: [], deliveries: [{ work_date: date, status, message_id: 'm1' }] });
    const { body } = await invoke({ action: 'days', from: date, to: date });
    assert.strictEqual(body.days[0].state, 'not-imported',
      `${status} is neither a quiet day nor a missing file`);
  }
});

test('an imported re-send supersedes an earlier failure on the same date', async (t) => {
  const date = shiftDay(TODAY, -1);
  stub(t, {
    rows: [],
    deliveries: [
      { work_date: date, status: 'error', message_id: 'm1' },
      { work_date: date, status: 'imported', rows_imported: 0, message_id: 'm2' }
    ]
  });
  const { body } = await invoke({ action: 'days', from: date, to: date });
  assert.strictEqual(body.days[0].state, 'no-hours');
  assert.strictEqual(body.days[0].delivery.messageId, 'm2');
});

test('an unreadable ledger says so and still returns the days', async (t) => {
  // Falling back to "every empty day is missing" is the safe direction, but the
  // tab has to be able to say the distinction could not be made — otherwise a
  // quiet day looks like a failed delivery again and nobody knows why.
  const date = shiftDay(TODAY, -1);
  stub(t, { rows: [], deliveriesThrow: 'processed_emails 503' });

  const { statusCode, body } = await invoke({ action: 'days', from: date, to: date });
  assert.strictEqual(statusCode, 200, 'a ledger failure must not take the day list down');
  assert.strictEqual(body.deliveryUnavailable, true);
  assert.strictEqual(body.days[0].state, 'no-file');
});

// ---------------------------------------------------------------------------
// Data quality names people
// ---------------------------------------------------------------------------

test('flagged and unassigned rows are named, not just counted', async (t) => {
  const date = shiftDay(TODAY, -1);
  stub(t, {
    rows: [
      hoursRow(date, '0101', { first_name: 'Shawn', last_name: 'Owsley', department: null }),
      hoursRow(date, '0102', { first_name: 'Ana', last_name: 'Smith',
        flags: ['unknown_employee'] }),
      hoursRow(date, '0103')
    ]
  });

  const { body } = await invoke({ action: 'days', from: date, to: date });
  const day = body.days[0];

  assert.strictEqual(day.unassignedCount, 1);
  assert.deepStrictEqual(day.unassigned.map(p => p.name), ['Shawn Owsley'],
    '"1 unassigned" with no name sent you to a roster of 71 people');
  assert.strictEqual(day.unassigned[0].employeeNumber, '0101');

  assert.strictEqual(day.flagCount, 1);
  assert.deepStrictEqual(day.flagged.map(p => p.name), ['Ana Smith']);
  assert.deepStrictEqual(day.flagged[0].flags, ['unknown_employee']);
});

test('one person with no department is one problem, not two', async (t) => {
  // Every Mon-Thu row on the tab read "1 flagged / 1 unassigned". That was one
  // person counted twice: buildImport puts missing_department in flags on
  // exactly the rows that have no department, so the two headings were the same
  // fact. Over a week it looked like eight problems and was one.
  const date = shiftDay(TODAY, -1);
  stub(t, {
    rows: [hoursRow(date, '0101', {
      first_name: 'Shawn', last_name: 'Owsley',
      department: null, flags: ['missing_department']
    })]
  });

  const { body } = await invoke({ action: 'days', from: date, to: date });
  assert.strictEqual(body.days[0].unassignedCount, 1);
  assert.strictEqual(body.days[0].flagCount, 0, 'the unassigned line already says this');
  assert.deepStrictEqual(body.days[0].unassigned.map(p => p.name), ['Shawn Owsley']);
});

test('a row with a real flag AND no department still reports both', async (t) => {
  // The de-duplication is specific to missing_department. Anything else is a
  // separate fact and must not be swallowed with it.
  const date = shiftDay(TODAY, -1);
  stub(t, {
    rows: [hoursRow(date, '0101', {
      department: null, flags: ['missing_department', 'unknown_employee']
    })]
  });
  const { body } = await invoke({ action: 'days', from: date, to: date });
  assert.strictEqual(body.days[0].flagCount, 1);
  assert.strictEqual(body.days[0].unassignedCount, 1);
  assert.deepStrictEqual(body.days[0].flagged[0].flags,
    ['missing_department', 'unknown_employee'], 'and the full flag list survives');
});

test('more than three are capped and the rest counted', async (t) => {
  const date = shiftDay(TODAY, -1);
  stub(t, {
    rows: [1, 2, 3, 4, 5].map(n =>
      hoursRow(date, `010${n}`, { first_name: `P${n}`, last_name: 'X', department: null }))
  });
  const { body } = await invoke({ action: 'days', from: date, to: date });
  assert.strictEqual(body.days[0].unassignedCount, 5);
  assert.strictEqual(body.days[0].unassigned.length, 3);
  assert.strictEqual(body.days[0].unassignedOmitted, 2);
});

test('a person with no name at all is identified by number rather than blank', async (t) => {
  const date = shiftDay(TODAY, -1);
  stub(t, {
    rows: [hoursRow(date, '0777', { first_name: null, last_name: null, department: null })]
  });
  const { body } = await invoke({ action: 'days', from: date, to: date });
  assert.strictEqual(body.days[0].unassigned[0].name, null);
  assert.strictEqual(body.days[0].unassigned[0].employeeNumber, '0777');
});

// ---------------------------------------------------------------------------
// The tab
// ---------------------------------------------------------------------------

function sandbox() {
  const { __SCRIPT_MODULES } = require('../netlify/functions/session.js');
  const el = () => ({
    textContent: '', innerHTML: '', value: '', checked: false, style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {}, addEventListener() {},
    appendChild() {}, querySelector: () => el(), querySelectorAll: () => []
  });
  const ctx = {
    console, window: {},
    document: { getElementById: () => el(), querySelector: () => el(), querySelectorAll: () => [] },
    setTimeout: (fn) => { void fn; return 0; },
    localStorage: {
      _v: {},
      getItem(k) { return Object.prototype.hasOwnProperty.call(this._v, k) ? this._v[k] : null; },
      setItem(k, v) { this._v[k] = String(v); },
      removeItem(k) { delete this._v[k]; }
    },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const m of __SCRIPT_MODULES) {
    vm.runInContext(fs.readFileSync(path.join(SRC, m), 'utf8'), ctx, { filename: m });
  }
  vm.runInContext('globalThis.state = state;', ctx, { filename: 'expose-lexicals.js' });
  return ctx;
}

const uiDay = (workDate, over = {}) => Object.assign({
  workDate, dayName: 'Monday', isScheduledDay: true, state: 'data',
  rowCount: 3, employees: 3, totalHours: 30, otHours: 0,
  source: 'email', dateSource: 'email_received', uploadBatchId: 'b1',
  createdAt: null, emailReceivedAt: null,
  flagCount: 0, unassignedCount: 0,
  flagged: [], flaggedOmitted: 0, unassigned: [], unassignedOmitted: 0,
  staleCount: 0, stale: [], staleOmitted: 0,
  delivery: null
}, over);

// The roster, built by the PRODUCTION mapping rather than by hand.
//
// This exists because the hand-built version shipped a bug. loadData() renames
// the column when it maps a roster row — `empNum:r.employee_number||''` — and
// the tab's lookup read `e.employee_number`, which is undefined on every person.
// Every named person came back "(not on the roster)", including people who are
// on it and fully classified. The test passed anyway, because its fixture had an
// employee_number field: a fixture that agreed with the bug.
//
// So the fixture is now whatever loadData() actually produces from an API row.
// If the mapping is renamed again, this goes red instead of the screen going
// wrong.
async function loadRoster(ctx, apiRows) {
  ctx.fetch = async (url) => ({
    ok: true, status: 200,
    json: async () => ({ ok: true, data: String(url).includes('table=employees') ? apiRows : [] })
  });
  await ctx.loadData();
  return ctx.state.employees;
}

function renderTab(ctx, days, extra = {}) {
  Object.assign(ctx.state, {
    dailyDays: days, dailyLoaded: true, dailyLoading: false,
    dailyFrom: '2026-08-24', dailyTo: '2026-08-30',
    dailyPending: [], employees: []
  }, extra);
  return ctx.renderDailyHours();
}

test('the Classification column is gone from the tab', () => {
  // "Scheduled Mon–Thu / Non-scheduled Fri–Sun" is a wrong label, not a wrong
  // split: maintenance crews are scheduled Fri–Sun, they just are not
  // production. The field stays (the OT report splits on it); the column goes.
  const ctx = sandbox();
  const html = renderTab(ctx, [uiDay('2026-08-24')]);
  assert.doesNotMatch(html, /Classification/);
  assert.doesNotMatch(html, /Non-scheduled Fri/);
  assert.doesNotMatch(html, /Scheduled Mon/);
});

test('the import banner is gone and the date picker keeps a plain label', () => {
  const ctx = sandbox();
  const html = renderTab(ctx, []);
  assert.doesNotMatch(html, /contains no date/);
  assert.doesNotMatch(html, /Nothing is hunting for one/);
  assert.doesNotMatch(html, /both are normal work days/);
  assert.match(html, /Work date this file covers/);
  assert.match(html, /Import hours file/);
  assert.match(html, /Hours file \(\.xlsx\)/);
});

test('an empty day is a row in the table, and says which kind of empty', () => {
  const ctx = sandbox();
  const html = renderTab(ctx, [
    uiDay('2026-08-26'),
    uiDay('2026-08-25', { state: 'no-hours', rowCount: 0, employees: 0, totalHours: 0 }),
    uiDay('2026-08-24', { state: 'no-file', rowCount: 0, employees: 0, totalHours: 0 })
  ]);

  assert.match(html, /No hours reported/);
  assert.match(html, /No file received/);
  // and the old banner-of-chips is gone
  assert.doesNotMatch(html, /have no data at all/);
  assert.doesNotMatch(html, /probable missed delivery/);
});

test('a quiet day and a missing day do not read the same', () => {
  const ctx = sandbox();
  const quiet = renderTab(sandbox(), [uiDay('2026-08-25', { state: 'no-hours', rowCount: 0 })]);
  const gone = renderTab(ctx, [uiDay('2026-08-25', { state: 'no-file', rowCount: 0 })]);
  assert.notStrictEqual(quiet, gone);
  assert.match(quiet, /Nobody logged time/);
  assert.match(gone, /did not arrive/);
});

test('the row carries no destructive action — both are behind the overflow', () => {
  const ctx = sandbox();
  const closed = renderTab(ctx, [uiDay('2026-08-24')]);

  assert.doesNotMatch(closed, /Correct date/, 'not on the row');
  assert.doesNotMatch(closed, /Delete day/,
    'deleting a day of hours must not be one stray click on every row');
  assert.doesNotMatch(closed, /deleteDailyDay\(/);
  assert.match(closed, /toggleDayMenu\('2026-08-24'\)/, 'but both are still reachable');

  const open = renderTab(ctx, [uiDay('2026-08-24')], { dailyMenu: '2026-08-24' });
  assert.match(open, /Correct date/);
  assert.match(open, /correctDailyDate\(/, 'the capability is intact, not deleted');
  assert.match(open, /Delete day/);
  assert.match(open, /deleteDailyDay\(/);
});

test('the overflow menu is in normal flow, not absolutely positioned', () => {
  // THE BUG THIS PINS. The first version positioned the menu absolutely inside
  // the cell. app.html's .table-wrap sets overflow:hidden, which clipped it away
  // completely — the markup was in the DOM, the test asserting the markup
  // passed, and clicking the button did visibly nothing. A string test cannot
  // see CSS clipping, so what is asserted instead is that nothing in this menu
  // relies on escaping the wrapper.
  const ctx = sandbox();
  const open = renderTab(ctx, [uiDay('2026-08-24')], { dailyMenu: '2026-08-24' });

  const cell = open.slice(open.indexOf('toggleDayMenu'));
  const menu = cell.slice(0, cell.indexOf('</td>'));
  assert.doesNotMatch(menu, /position:\s*absolute/,
    '.table-wrap has overflow:hidden — an absolutely positioned menu is invisible');
  assert.doesNotMatch(menu, /position:\s*fixed/);
  assert.match(menu, /class="dh-menu"/);

  // And the wrapper really does clip, which is why the rule above exists.
  const appHtml = fs.readFileSync(path.join(ROOT, 'public', 'app.html'), 'utf8');
  assert.match(appHtml, /\.table-wrap\{[^}]*overflow:hidden/,
    'if this ever stops being true the comment above is stale, not the code');
});

test('Delete names what is being destroyed, not just a row count', () => {
  const ctx = sandbox();
  const open = renderTab(ctx, [uiDay('2026-08-24', {
    rowCount: 37, employees: 37, totalHours: 312.5
  })], { dailyMenu: '2026-08-24' });

  // hours and headcount reach the handler, so the confirm can weigh the loss
  assert.match(open, /deleteDailyDay\('2026-08-24',37,312\.5,37\)/);

  const src = fs.readFileSync(path.join(SRC, 'daily-hours.js'), 'utf8');
  assert.match(src, /async function deleteDailyDay\(workDate,rowCount,totalHours,people\)/);
  assert.match(src, /if\(!confirm\(/, 'the confirmation stays on top of the move');
  assert.match(src, /manager email/, 'and says what else the day disappears from');
});

test('Data quality names the person and links to their card', async () => {
  const ctx = sandbox();
  const roster = await loadRoster(ctx, [
    { id: 'emp-1', name: 'Shawn Owsley', employee_number: '0101', department: 'Production' }
  ]);
  assert.strictEqual(roster.length, 1, 'the roster has to actually load, or this proves nothing');

  const html = renderTab(ctx, [uiDay('2026-08-24', {
    unassignedCount: 1,
    unassigned: [{ employeeNumber: '0101', name: 'Shawn Owsley' }]
  })], { employees: roster });

  assert.match(html, /1 unassigned — /);
  assert.match(html, /Shawn Owsley/);
  assert.match(html, /goToEmployeeProfile\('emp-1'\)/,
    'the button used to open a roster of 71 people with no indication which one');
});

test('somebody the roster has never heard of is named without a dead link', async () => {
  const ctx = sandbox();
  const roster = await loadRoster(ctx, [
    { id: 'emp-1', name: 'Somebody Else', employee_number: '0101' }
  ]);

  const html = renderTab(ctx, [uiDay('2026-08-24', {
    flagCount: 1,
    flagged: [{ employeeNumber: '9999', name: 'Ghost Person', flags: ['unknown_employee'] }]
  })], { employees: roster });

  assert.match(html, /Ghost Person/);
  assert.match(html, /not on the roster/);
  assert.doesNotMatch(html, /goToEmployeeProfile\('9999'\)/);
});

test('an empty roster does not accuse anybody of not being on it', () => {
  // loadData() runs at bootstrap but this tab can render first. "Not on the
  // roster" is a serious claim about a person and must not be made because the
  // page was early.
  const ctx = sandbox();
  const html = renderTab(ctx, [uiDay('2026-08-24', {
    unassignedCount: 1,
    unassigned: [{ employeeNumber: '0101', name: 'Shawn Owsley' }]
  })], { employees: [] });

  assert.match(html, /Shawn Owsley/);
  assert.doesNotMatch(html, /not on the roster/);
});

test('a stale department snapshot is not reported as an unclassified person', async (t) => {
  // Shawn Owsley, on the screen: "1 unassigned ... no payroll department on the
  // roster" for somebody who IS on the roster and fully classified.
  // daily_hours.department is a snapshot taken at import — deliberately, so a
  // transfer never rewrites history — so anybody classified after their hours
  // landed still carries null on those rows. Sending that person's manager to
  // the profile to set a department that is already set is worse than silence.
  const date = shiftDay(TODAY, -1);
  Object.assign(payrollDb, { fetchEmployees: async () => [
    { id: 'emp-1', employee_number: '0101', name: 'Shawn Owsley', department: 'Production' },
    { id: 'emp-2', employee_number: '0102', name: 'Nobody Classified', department: null }
  ] });
  stub(t, {
    rows: [
      hoursRow(date, '0101', { first_name: 'Shawn', last_name: 'Owsley', department: null }),
      hoursRow(date, '0102', { first_name: 'Nobody', last_name: 'Classified', department: null })
    ]
  });

  const { body } = await invoke({ action: 'days', from: date, to: date });
  const day = body.days[0];

  assert.strictEqual(day.staleCount, 1);
  assert.deepStrictEqual(day.stale.map(p => p.name), ['Shawn Owsley']);
  assert.strictEqual(day.stale[0].rosterDepartment, 'Production',
    'and it says what the roster does know, so the remedy is obvious');

  assert.strictEqual(day.unassignedCount, 1);
  assert.deepStrictEqual(day.unassigned.map(p => p.name), ['Nobody Classified'],
    'a genuinely unclassified person still reports as unassigned');
});

test('an unreadable roster reports every empty department as unassigned', async (t) => {
  // No evidence means no verdict. Claiming a stale snapshot without the roster
  // to prove it would tell somebody to re-stamp a day that needs a profile edit.
  const date = shiftDay(TODAY, -1);
  Object.assign(payrollDb, { fetchEmployees: async () => { throw new Error('roster 503'); } });
  stub(t, { rows: [hoursRow(date, '0101', { department: null })] });

  const { statusCode, body } = await invoke({ action: 'days', from: date, to: date });
  assert.strictEqual(statusCode, 200, 'and it must not take the day list down');
  assert.strictEqual(body.rosterUnavailable, true);
  assert.strictEqual(body.days[0].unassignedCount, 1);
  assert.strictEqual(body.days[0].staleCount, 0);
});

test('the tab points a stale department at Re-stamp, not at the profile', () => {
  const ctx = sandbox();
  const html = renderTab(ctx, [uiDay('2026-08-24', {
    staleCount: 1,
    stale: [{ employeeNumber: '0101', name: 'Shawn Owsley', rosterDepartment: 'Production' }]
  })]);

  assert.match(html, /Shawn Owsley/);
  assert.match(html, /Classified on the roster \(Production\)/);
  assert.match(html, /Re-stamp departments/);
  assert.doesNotMatch(html, /no payroll department on the roster/,
    'that message is for somebody the roster genuinely has not classified');
});

test('the summary counts each kind of day', () => {
  const ctx = sandbox();
  const html = renderTab(ctx, [
    uiDay('2026-08-26'),
    uiDay('2026-08-25', { state: 'no-hours' }),
    uiDay('2026-08-24', { state: 'no-file' })
  ]);
  assert.match(html, /1 day with hours/);
  assert.match(html, /1 with none reported/);
  assert.match(html, /1 with no file at all/);
});
