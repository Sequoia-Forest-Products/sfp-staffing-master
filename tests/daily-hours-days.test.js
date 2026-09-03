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
//   dayState returns 'no-file' whenever rowCount is 0   -> 4 fail (2,3,4,5)
//   eachDate returns only the dates that have rows      -> 6 fail (1-6)
//   NAMED_LIMIT raised so nothing is ever omitted       -> 1 fail (8)
//   "Correct date" put back on the row                  -> 1 fail (14)
//
// Restored, 17 pass.

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
  delivery: null
}, over);

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

test('Correct date is off the row and behind the overflow', () => {
  const ctx = sandbox();
  const closed = renderTab(ctx, [uiDay('2026-08-24')]);
  assert.doesNotMatch(closed, /Correct date/, 'not on the row any more');
  assert.match(closed, /toggleDayMenu\('2026-08-24'\)/, 'but still reachable');

  const open = renderTab(ctx, [uiDay('2026-08-24')], { dailyMenu: '2026-08-24' });
  assert.match(open, /Correct date/);
  assert.match(open, /correctDailyDate\(/, 'and the capability is intact, not deleted');
});

test('Data quality names the person and links to their card', () => {
  const ctx = sandbox();
  const html = renderTab(ctx, [uiDay('2026-08-24', {
    unassignedCount: 1,
    unassigned: [{ employeeNumber: '0101', name: 'Shawn Owsley' }]
  })], { employees: [{ id: 'emp-1', employee_number: '0101', name: 'Shawn Owsley' }] });

  assert.match(html, /1 unassigned — /);
  assert.match(html, /Shawn Owsley/);
  assert.match(html, /goToEmployeeProfile\('emp-1'\)/,
    'the button used to open a roster of 71 people with no indication which one');
});

test('somebody the roster has never heard of is named without a dead link', () => {
  const ctx = sandbox();
  const html = renderTab(ctx, [uiDay('2026-08-24', {
    flagCount: 1,
    flagged: [{ employeeNumber: '9999', name: 'Ghost Person', flags: ['unknown_employee'] }]
  })], { employees: [] });

  assert.match(html, /Ghost Person/);
  assert.match(html, /not on the roster/);
  assert.doesNotMatch(html, /goToEmployeeProfile\('9999'\)/);
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
