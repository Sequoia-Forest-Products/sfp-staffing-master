// Run with: npm test
//
// Manual timeclock uploads (/api/timeclock-upload) and the pure decisions
// behind them (timeclock-upload-lib.js). The endpoint runs against an
// in-memory model of the tables it touches — daily_hours, daily_hours_held,
// hours_days, timeclock_weeks, timeclock_week_totals — with replace_hours()
// and replace_week_totals() modelled as the single replace they are.

const test = require('node:test');
const assert = require('node:assert');
const { createHmac } = require('node:crypto');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret';
delete process.env.TIMECLOCK_UPLOADERS;

const payrollDb = require('../netlify/functions/payroll-db');
const REAL_DB = { ...payrollDb };
const { handler } = require('../netlify/functions/timeclock-upload');
const lib = require('../netlify/functions/timeclock-upload-lib');
const { buildPayrollXlsx } = require('./helpers/make-xlsx');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Monday 2026-11-23, 12:00 PST.
const MONDAY_NOON = new Date('2026-11-23T20:00:00Z');
const WEEK = '2026-11-16';

const ROSTER = [
  { id: 'e1', name: 'Miguel Acosta Ruiz', employee_number: '0319', department: 'Production', wage: '24.00', pay_type: 'Hourly', status: 'Active' },
  { id: 'e2', name: 'Ana Smith', employee_number: '0063', department: 'Maintenance', wage: '30.00', pay_type: 'Hourly', status: 'Active' },
  { id: 'e3', name: 'Eduardo Rivera', employee_number: '0101', department: 'Production', annual_salary: '83200', pay_type: 'Salaried', status: 'Active' }
];

// emp, last, first, isSalary, rate, regular, ot, total, earnings
const r = (emp, last, first, reg, ot, salary = 'No') =>
  [emp, last, first, salary, 0, reg, ot, Math.round((reg + ot) * 100) / 100, 0];

// A day's file. `tag` changes the bytes so two days are two different files.
const dayFile = (rows, tag = '') => buildPayrollXlsx([...rows, ...(tag ? [r('0999', 'Tag' + tag, 'X', 0, 0, 'Yes')] : [])]).toString('base64');

const DAY = (reg319, reg063, tag) => dayFile([
  r('0319', 'Acosta Ruiz', 'Miguel', reg319, 0),
  r('0063', 'Smith', 'Ana', reg063, 0),
  r('0101', 'Rivera', 'Eduardo', 10, 0, 'Yes')
], tag);

// The weekly file: week totals, which put everybody above 24 hours.
const WEEKLY = (rows) => buildPayrollXlsx(rows).toString('base64');

function cookie(email = 'peter.stroble@sequoiafp.com') {
  const b64 = Buffer.from(JSON.stringify({ email, exp: Date.now() + 3600000 })).toString('base64url');
  const sig = createHmac('sha256', process.env.SESSION_SECRET).update(b64).digest('base64url');
  return `sfp_session=${b64}.${sig}`;
}

async function call(body, { email, now = MONDAY_NOON } = {}) {
  const res = await handler({ httpMethod: 'POST', headers: { cookie: cookie(email) }, body: JSON.stringify(body) },
    {}, { now });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

// ---------------------------------------------------------------------------
// The in-memory database
// ---------------------------------------------------------------------------

function memoryDb(t, { daily = [], days = [], weeks = [] } = {}) {
  const s = {
    daily: daily.map(x => ({ ...x })), held: [], days: days.map(x => ({ ...x })),
    weeks: weeks.map(x => ({ ...x })), totals: [], imports: [], alerts: []
  };
  const calls = { replaceHours: [], replaceWeekTotals: [] };
  const inRange = (d, from, to) => { d = String(d).slice(0, 10); return d >= from && d <= to; };

  Object.assign(payrollDb, {
    fetchEmployees: async () => ROSTER,
    fetchExclusions: async () => [],
    fetchDailyHours: async (from, to) => s.daily.filter(x => inRange(x.work_date, from, to)),
    fetchDailyHoursAll: async (from, to) => s.daily.filter(x => inRange(x.work_date, from, to)),
    fetchDailyHoursForDate: async d => s.daily.filter(x => x.work_date === d),
    findRowsByFileHash: async h => s.daily.filter(x => h && x.file_hash === h),
    fetchHeldRows: async ({ reason, from, to } = {}) => s.held.filter(h =>
      (!reason || h.reason === reason) && (!from || h.work_date >= from) && (!to || h.work_date <= to)),
    fetchHoursDays: async (from, to) => s.days.filter(x => inRange(x.work_date, from, to)),
    replaceHours: async ({ importMeta, dates, rows, held }) => {
      calls.replaceHours.push({ importMeta, dates, rows, held });
      const before = s.daily.filter(x => dates.includes(x.work_date)).length;
      s.daily = s.daily.filter(x => !dates.includes(x.work_date));
      s.held = s.held.filter(x => !dates.includes(x.work_date));
      s.daily.push(...rows.map(x => ({ ...x, file_hash: importMeta.file_hash, source: importMeta.source })));
      s.held.push(...held);
      for (const d of dates) {
        s.days = s.days.filter(x => x.work_date !== d);
        s.days.push({ work_date: d, status: importMeta.source === 'weekly' ? 'reconciled' : 'provisional' });
      }
      return { import_id: 'imp-' + calls.replaceHours.length, counted: rows.length, held: held.length, replaced: before };
    },
    setDaysStatus: async (dates, status) => { s.days.forEach(x => { if (dates.includes(x.work_date)) x.status = status; }); return []; },
    fetchTimeclockWeek: async w => s.weeks.find(x => x.week_start === w) || null,
    fetchTimeclockWeeks: async ({ from } = {}) => s.weeks.filter(x => !from || x.week_start >= from),
    fetchWeekTotals: async w => s.totals.filter(x => x.week_start === w),
    findWeekByFileHash: async h => s.weeks.filter(x => h && x.file_hash === h),
    replaceWeekTotals: async ({ week, rows }) => {
      calls.replaceWeekTotals.push({ week, rows });
      s.weeks = s.weeks.filter(x => x.week_start !== week.week_start);
      s.weeks.push({ ...week, week_end: lib.addDays(week.week_start, 6), status: 'open', comparison: null });
      s.totals = s.totals.filter(x => x.week_start !== week.week_start);
      s.totals.push(...rows.map(x => ({ ...x, week_start: week.week_start })));
      return { week_start: week.week_start, rows: rows.length };
    },
    updateTimeclockWeek: async (w, patch) => { Object.assign(s.weeks.find(x => x.week_start === w), patch); return []; },
    // What the alert evaluation after a commit reads and writes.
    reattributeHeld: async () => 0, markHeldExternal: async () => [], updateHeldReason: async () => [],
    fetchDeliveriesForDates: async () => [],
    fetchAlerts: async () => s.alerts.filter(a => a.status !== 'resolved'),
    insertAlert: async a => { const row = { id: 'a' + s.alerts.length, ...a }; s.alerts.push(row); return row; },
    updateAlert: async (id, patch) => { Object.assign(s.alerts.find(a => a.id === id), patch); return []; }
  });
  t.after(() => Object.assign(payrollDb, REAL_DB));
  return { s, calls };
}

const commitDay = (workDate, fileBase64, extra = {}, opts) =>
  call({ action: 'commitDaily', fileName: `Work Summary Payroll.xlsx`, fileBase64, workDate, ...extra }, opts);

// ---------------------------------------------------------------------------
// Dates: suggestions only — the person always confirms
// ---------------------------------------------------------------------------

test('a date in the file name is read as a suggestion', () => {
  const today = '2026-11-24';
  assert.strictEqual(lib.dateFromFileName('Work Summary Payroll 11-9.xlsx', today), '2026-11-09');
  assert.strictEqual(lib.dateFromFileName('payroll_11.20.xlsx', today), '2026-11-20');
  assert.strictEqual(lib.dateFromFileName('daily 11-21-26.xlsx', today), '2026-11-21');
  assert.strictEqual(lib.dateFromFileName('2026-11-18 daily.xlsx', today), '2026-11-18');
  assert.strictEqual(lib.dateFromFileName('12-30.xlsx', '2027-01-02'), '2026-12-30', 'no year: the most recent one not after today');
  assert.strictEqual(lib.dateFromFileName('Work Summary Payroll.xlsx', today), null);
  assert.strictEqual(lib.dateFromFileName('Daily_Report_1.xlsx', today), null);
  assert.strictEqual(lib.dateFromFileName('report 13-45.xlsx', today), null, 'not a calendar date');
});

test('Monday: three files without dates default to Friday, Saturday and Sunday', () => {
  const s = lib.suggestDates(['a.xlsx', 'b.xlsx', 'c.xlsx'], '2026-11-23');
  assert.deepStrictEqual(s.map(x => x.workDate), ['2026-11-20', '2026-11-21', '2026-11-22']);
  assert.ok(s.every(x => x.source === 'default'));
});

test('a file-name date wins, and the Monday defaults fill the other days', () => {
  const s = lib.suggestDates(['payroll 11-21.xlsx', 'x.xlsx', 'y.xlsx'], '2026-11-23');
  assert.deepStrictEqual(s.map(x => x.workDate), ['2026-11-21', '2026-11-20', '2026-11-22']);
  assert.deepStrictEqual(s.map(x => x.source), ['filename', 'default', 'default']);
});

test('any other weekday defaults to yesterday', () => {
  assert.deepStrictEqual(lib.suggestDates(['a.xlsx'], '2026-11-25').map(x => x.workDate), ['2026-11-24']);
});

test('the endpoint suggests in Pacific time', async (t) => {
  memoryDb(t);
  const res = await call({ action: 'suggest', fileNames: ['a.xlsx', 'b.xlsx', 'c.xlsx'] });
  assert.strictEqual(res.status, 200, res.body.error);
  assert.deepStrictEqual(res.body.suggestions.map(x => x.workDate), ['2026-11-20', '2026-11-21', '2026-11-22']);
});

test('upload due dates: the next weekday; Friday to Sunday are due Monday; the weekly file Wednesday', () => {
  assert.strictEqual(lib.dailyDueDate('2026-11-16'), '2026-11-17');
  assert.strictEqual(lib.dailyDueDate('2026-11-19'), '2026-11-20');
  for (const d of ['2026-11-20', '2026-11-21', '2026-11-22']) assert.strictEqual(lib.dailyDueDate(d), '2026-11-23');
  assert.strictEqual(lib.weeklyDueDate('2026-11-16'), '2026-11-25');
  assert.strictEqual(lib.lastCompletedWeekStart('2026-11-24'), '2026-11-16');
  assert.strictEqual(lib.lastCompletedWeekStart('2026-11-23'), '2026-11-16');
});

// ---------------------------------------------------------------------------
// Daily upload
// ---------------------------------------------------------------------------

test('a daily upload replaces the day and never duplicates it', async (t) => {
  const { s, calls } = memoryDb(t);
  const first = await commitDay('2026-11-19', DAY(10, 10));
  assert.strictEqual(first.status, 200, first.body.error);

  // Same day again, corrected: refused until the replacement is confirmed...
  const refused = await commitDay('2026-11-19', DAY(10, 11.5));
  assert.strictEqual(refused.status, 400);
  assert.match(refused.body.error, /already has 2 row/);
  // ...then replaces, whole.
  const again = await commitDay('2026-11-19', DAY(10, 11.5), { confirmOverwrite: true });
  assert.strictEqual(again.status, 200, again.body.error);

  const day = s.daily.filter(x => x.work_date === '2026-11-19');
  assert.strictEqual(day.length, 2, 'two hourly people, once each');
  assert.strictEqual(day.find(x => x.employee_number === '0063').total_hours, 11.5);
  assert.deepStrictEqual(calls.replaceHours.map(c => c.dates), [['2026-11-19'], ['2026-11-19']],
    'each commit goes through the one replace path, for exactly its day');
  assert.ok(calls.replaceHours.every(c => c.importMeta.source === 'manual'));
  assert.strictEqual(s.days.find(x => x.work_date === '2026-11-19').status, 'provisional');
  // Salaried people are held, never counted.
  assert.ok(!day.some(x => x.employee_number === '0101'));
  assert.ok(s.held.some(x => x.employee_number === '0101' && x.reason === 'salaried'));
});

test('a weekly file uploaded as a daily is refused, and nothing is written', async (t) => {
  const { calls } = memoryDb(t);
  const weekly = WEEKLY([r('0319', 'Acosta Ruiz', 'Miguel', 40, 2.5), r('0063', 'Smith', 'Ana', 40, 0)]);

  const preview = await call({ action: 'previewDaily', files: [{ fileName: 'week.xlsx', fileBase64: weekly, workDate: '2026-11-22' }] });
  assert.strictEqual(preview.status, 200, preview.body.error);
  const p = preview.body.previews[0];
  assert.strictEqual(p.blocked, true);
  assert.match(p.errors.join(' '), /looks like a WEEKLY file/);
  assert.deepStrictEqual(p.looksWeekly.overPeople.map(x => x.employeeNumber), ['0319', '0063']);

  const commit = await commitDay('2026-11-22', weekly, { confirmOverwrite: true, confirmReconciled: true, confirmDuplicateFile: true });
  assert.strictEqual(commit.status, 400);
  assert.match(commit.body.error, /WEEKLY/);
  assert.strictEqual(calls.replaceHours.length, 0, 'no confirmation flag gets a weekly file onto a day');
});

test('a file whose total is far above any recent day is refused even with nobody over 24 hours', () => {
  const day = n => Array.from({ length: n }, (_, i) => ({ employee_number: String(i), total_hours: 20 }));
  const recent = [560, 548, 571];
  assert.strictEqual(lib.weeklyLook({ rows: day(6), trailingDayTotals: recent }).blocked, false,
    '120 hours is a light day against ~570');
  const heavy = lib.weeklyLook({ rows: day(50), trailingDayTotals: recent });
  assert.strictEqual(heavy.blocked, true, '1,000 hours is well above any day');
  assert.match(heavy.reasons[0], /totals 1000 hours/);
  assert.strictEqual(lib.weeklyLook({ rows: day(50), trailingDayTotals: [] }).blocked, false,
    'with no history, the fallback ceiling is 1,000 hours');
});

test('Monday: three files land on Friday, Saturday and Sunday', async (t) => {
  const { s } = memoryDb(t);
  const files = ['a.xlsx', 'b.xlsx', 'c.xlsx'];
  const sug = (await call({ action: 'suggest', fileNames: files })).body.suggestions;
  const bytes = [DAY(10, 0, 'fri'), DAY(0, 8, 'sat'), DAY(0, 6, 'sun')];

  const preview = await call({ action: 'previewDaily',
    files: files.map((fileName, i) => ({ fileName, fileBase64: bytes[i], workDate: sug[i].workDate })) });
  assert.strictEqual(preview.status, 200, preview.body.error);
  assert.deepStrictEqual(preview.body.previews.map(p => p.workDate), ['2026-11-20', '2026-11-21', '2026-11-22']);
  assert.ok(preview.body.previews.every(p => !p.blocked), JSON.stringify(preview.body.previews.map(p => p.errors)));

  for (let i = 0; i < 3; i++) {
    const res = await call({ action: 'commitDaily', fileName: files[i], fileBase64: bytes[i], workDate: sug[i].workDate });
    assert.strictEqual(res.status, 200, res.body.error);
  }
  const hoursOn = d => s.daily.filter(x => x.work_date === d).reduce((a, x) => a + x.total_hours, 0);
  assert.strictEqual(hoursOn('2026-11-20'), 10);
  assert.strictEqual(hoursOn('2026-11-21'), 8);
  assert.strictEqual(hoursOn('2026-11-22'), 6);
});

test('two files dated the same day, or one file twice, block the batch preview', async (t) => {
  memoryDb(t);
  const a = DAY(10, 10, 'a');
  const sameDate = await call({ action: 'previewDaily', files: [
    { fileName: 'a.xlsx', fileBase64: a, workDate: '2026-11-20' },
    { fileName: 'b.xlsx', fileBase64: DAY(9, 9, 'b'), workDate: '2026-11-20' }] });
  assert.ok(sameDate.body.previews.every(p => p.blocked && /dated 2026-11-20/.test(p.errors.join(' '))));
  const sameFile = await call({ action: 'previewDaily', files: [
    { fileName: 'a.xlsx', fileBase64: a, workDate: '2026-11-20' },
    { fileName: 'a copy.xlsx', fileBase64: a, workDate: '2026-11-21' }] });
  assert.ok(sameFile.body.previews.every(p => p.blocked && /same file/.test(p.errors.join(' '))));
});

test('the same file under two different dates is refused', async (t) => {
  memoryDb(t);
  const file = DAY(10, 10);
  assert.strictEqual((await commitDay('2026-11-19', file)).status, 200);
  const second = await commitDay('2026-11-18', file);
  assert.strictEqual(second.status, 400);
  assert.match(second.body.error, /already imported as 2026-11-19/);
});

test('a date that disagrees with the file name is a warning, not a refusal', async (t) => {
  memoryDb(t);
  const res = await call({ action: 'previewDaily', files: [{ fileName: 'payroll 11-18.xlsx', fileBase64: DAY(10, 10), workDate: '2026-11-19' }] });
  const p = res.body.previews[0];
  assert.strictEqual(p.blocked, false);
  assert.match(p.warnings.join(' '), /file name says 2026-11-18, but you chose 2026-11-19/);
});

test('the preview reports people counted, hours, overtime, and who is held', async (t) => {
  memoryDb(t, { daily: [{ work_date: '2026-11-19', employee_number: '0319', total_hours: 9, ot_hours: 0, source: 'manual' }] });
  const file = dayFile([r('0319', 'Acosta Ruiz', 'Miguel', 10, 1.5), r('0063', 'Smith', 'Ana', 10, 0),
    r('0101', 'Rivera', 'Eduardo', 10, 0, 'Yes'), r('3380', 'Gibb', 'Auzlo', 10, 0)]);
  const p = (await call({ action: 'previewDaily', files: [{ fileName: 'x.xlsx', fileBase64: file, workDate: '2026-11-19' }] })).body.previews[0];
  assert.strictEqual(p.counted, 2);
  assert.strictEqual(p.totalHours, 21.5);
  assert.strictEqual(p.otHours, 1.5);
  assert.deepStrictEqual([p.held.salaried, p.held.external, p.held.unknown], [1, 0, 1]);
  assert.deepStrictEqual(p.held.unknownPeople.map(u => u.employeeNumber), ['3380']);
  assert.deepStrictEqual(p.existing && [p.existing.rowCount, p.existing.totalHours], [1, 9], 'what will be replaced');
  assert.strictEqual(p.needs.confirmOverwrite, true);
});

test('a day already reconciled by a weekly file needs an explicit confirmation', async (t) => {
  const { calls } = memoryDb(t, { days: [{ work_date: '2026-11-12', status: 'reconciled' }] });
  const res = await commitDay('2026-11-12', DAY(10, 10));
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /reconciled by a weekly file/);
  assert.strictEqual(calls.replaceHours.length, 0);
  const ok = await commitDay('2026-11-12', DAY(10, 10), { confirmReconciled: true });
  assert.strictEqual(ok.status, 200, ok.body.error);
});

test('only the uploaders can commit; everyone else can still look', async (t) => {
  const { calls } = memoryDb(t);
  const other = { email: 'tony.griffith@sequoiafp.com' };
  const res = await commitDay('2026-11-19', DAY(10, 10), {}, other);
  assert.strictEqual(res.status, 403);
  assert.strictEqual(calls.replaceHours.length, 0);
  const weekly = await call({ action: 'commitWeekly', fileName: 'w.xlsx', weekStart: WEEK,
    fileBase64: WEEKLY([r('0319', 'Acosta Ruiz', 'Miguel', 40, 0)]) }, other);
  assert.strictEqual(weekly.status, 403);
  assert.strictEqual((await call({ action: 'acceptWeek', weekStart: WEEK, note: 'fine' }, other)).status, 403);

  const view = await call({ action: 'overview' }, other);
  assert.strictEqual(view.status, 200);
  assert.strictEqual(view.body.canUpload, false);
  assert.strictEqual((await call({ action: 'overview' }, { email: 'axeri.ramirez@sequoiafp.com' })).body.canUpload, true);
  assert.strictEqual((await call({ action: 'overview' })).body.canUpload, true);
});

// ---------------------------------------------------------------------------
// Weekly reconciliation
// ---------------------------------------------------------------------------

// Mon–Thu 10 hours each for both, except one open punch: Ana's Wednesday is 0.
function weekOfDailyRows() {
  const out = [];
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = lib.addDays(WEEK, i);
    days.push({ work_date: d, status: 'provisional' });
    if (i > 3) continue;
    out.push({ work_date: d, employee_number: '0319', first_name: 'Miguel', last_name: 'Acosta Ruiz', regular_hours: 10, ot_hours: 0, total_hours: 10 });
    out.push({ work_date: d, employee_number: '0063', first_name: 'Ana', last_name: 'Smith', regular_hours: i === 2 ? 0 : 10, ot_hours: 0, total_hours: i === 2 ? 0 : 10 });
  }
  return { daily: out, days };
}
const WEEK_FILE = WEEKLY([r('0319', 'Acosta Ruiz', 'Miguel', 40, 0), r('0063', 'Smith', 'Ana', 40, 0),
  r('0101', 'Rivera', 'Eduardo', 40, 0, 'Yes')]);

test('the weekly upload never writes day rows, and lists per-person variances against the daily data', async (t) => {
  const { s, calls } = memoryDb(t, weekOfDailyRows());
  const dailyBefore = JSON.stringify(s.daily);

  const res = await call({ action: 'commitWeekly', fileName: 'weekly.xlsx', fileBase64: WEEK_FILE, weekStart: WEEK });
  assert.strictEqual(res.status, 200, res.body.error);
  assert.strictEqual(calls.replaceHours.length, 0, 'replace_hours is never called for a weekly file');
  assert.strictEqual(JSON.stringify(s.daily), dailyBefore, 'not one day row changed');
  assert.strictEqual(s.totals.length, 3, 'stored as week totals per person, salaried included');

  const c = res.body.comparison;
  assert.strictEqual(res.body.week.status, 'open');
  assert.deepStrictEqual(c.variances.map(v => v.employeeNumber), ['0063'], 'Miguel matches; salaried Eduardo is not compared');
  const ana = c.variances[0];
  assert.deepStrictEqual([ana.daily.total, ana.weekly.total, ana.diff.total], [30, 40, 10]);
  assert.strictEqual(ana.dollarsDiff, 300, '10 regular hours at the roster rate of $30');
  assert.deepStrictEqual(ana.zeroDays.filter(z => z.state === 'zero').map(z => z.date), ['2026-11-18'],
    'her 0.00 Wednesday is the place to look');

  // An open alert names her.
  const alert = s.alerts.find(a => a.type === 'weekly_unreconciled' && a.status === 'open');
  assert.ok(alert, 'Week not reconciled is raised');
  assert.match(alert.title, /Ana Smith \+10 h/);
});

test('re-uploading a corrected day re-runs the comparison; the week turns reconciled when variances clear', async (t) => {
  const { s } = memoryDb(t, weekOfDailyRows());
  await call({ action: 'commitWeekly', fileName: 'weekly.xlsx', fileBase64: WEEK_FILE, weekStart: WEEK });
  assert.strictEqual(s.weeks[0].status, 'open');

  // Wednesday from TimeNet, with Ana's punch fixed.
  const fixed = dayFile([r('0319', 'Acosta Ruiz', 'Miguel', 10, 0), r('0063', 'Smith', 'Ana', 10, 0)]);
  const res = await commitDay('2026-11-18', fixed, { confirmOverwrite: true }, { now: new Date('2026-11-25T21:00:00Z') });
  assert.strictEqual(res.status, 200, res.body.error);
  assert.strictEqual(res.body.week.status, 'reconciled');
  assert.strictEqual(res.body.week.varianceCount, 0);
  assert.strictEqual(s.weeks[0].status, 'reconciled');
  // The week's uploaded days are now reconciled; the rows themselves came from the daily files.
  assert.ok(s.days.filter(d => d.work_date >= WEEK && d.work_date <= '2026-11-22').every(d => d.status === 'reconciled'));
  assert.ok(!s.alerts.some(a => a.type === 'weekly_unreconciled' && a.status === 'open'), 'the alert resolved');
});

test('a week turns accepted only with a note, and re-opens if the variances change afterwards', async (t) => {
  const { s } = memoryDb(t, weekOfDailyRows());
  await call({ action: 'commitWeekly', fileName: 'weekly.xlsx', fileBase64: WEEK_FILE, weekStart: WEEK });

  const noNote = await call({ action: 'acceptWeek', weekStart: WEEK, note: '' });
  assert.strictEqual(noNote.status, 400);
  assert.strictEqual(s.weeks[0].status, 'open');

  const ok = await call({ action: 'acceptWeek', weekStart: WEEK, note: 'Ana was paid via a manual check' },
    { email: 'axeri.ramirez@sequoiafp.com' });
  assert.strictEqual(ok.status, 200, ok.body.error);
  assert.strictEqual(ok.body.week.status, 'accepted');
  assert.strictEqual(ok.body.week.acceptedBy, 'axeri.ramirez@sequoiafp.com');
  assert.strictEqual(ok.body.week.acceptNote, 'Ana was paid via a manual check');

  // Looking at it again does not disturb an acceptance that still describes the week.
  assert.strictEqual((await call({ action: 'week', weekStart: WEEK })).body.week.status, 'accepted');

  // A different variance — Miguel's Tuesday re-uploaded short — re-opens it.
  const short = dayFile([r('0319', 'Acosta Ruiz', 'Miguel', 8, 0), r('0063', 'Smith', 'Ana', 10, 0)]);
  const res = await commitDay('2026-11-17', short, { confirmOverwrite: true, confirmReconciled: true },
    { now: new Date('2026-11-25T21:00:00Z') });
  assert.strictEqual(res.status, 200, res.body.error);
  assert.strictEqual(res.body.week.status, 'open');
  assert.strictEqual(s.weeks[0].accept_note, null);
});

test('the weekly upload refuses an unfinished week, a non-Monday, and a daily file already stored', async (t) => {
  const { calls } = memoryDb(t);
  const day = DAY(10, 10);
  assert.strictEqual((await commitDay('2026-11-19', day)).status, 200);

  const notMonday = await call({ action: 'previewWeekly', fileName: 'w.xlsx', fileBase64: WEEK_FILE, weekStart: '2026-11-17' });
  assert.strictEqual(notMonday.status, 400);
  assert.match(notMonday.body.error, /not a Monday/);

  const unfinished = await call({ action: 'commitWeekly', fileName: 'w.xlsx', fileBase64: WEEK_FILE, weekStart: '2026-11-23' });
  assert.strictEqual(unfinished.status, 400);
  assert.match(unfinished.body.error, /has not finished/);

  const dailyAsWeekly = await call({ action: 'commitWeekly', fileName: 'w.xlsx', fileBase64: day, weekStart: WEEK });
  assert.strictEqual(dailyAsWeekly.status, 400);
  assert.match(dailyAsWeekly.body.error, /DAILY file for 2026-11-19/);
  assert.strictEqual(calls.replaceWeekTotals.length, 0);
});

test('re-uploading the weekly file for a week needs confirmation, then replaces it', async (t) => {
  const { s } = memoryDb(t, weekOfDailyRows());
  assert.strictEqual((await call({ action: 'commitWeekly', fileName: 'w.xlsx', fileBase64: WEEK_FILE, weekStart: WEEK })).status, 200);
  const again = await call({ action: 'commitWeekly', fileName: 'w2.xlsx', fileBase64: WEEK_FILE, weekStart: WEEK });
  assert.strictEqual(again.status, 400);
  assert.match(again.body.error, /already has a weekly file/);
  const ok = await call({ action: 'commitWeekly', fileName: 'w2.xlsx', fileBase64: WEEK_FILE, weekStart: WEEK, confirmReplace: true });
  assert.strictEqual(ok.status, 200, ok.body.error);
  assert.strictEqual(s.weeks.length, 1);
  assert.strictEqual(s.totals.length, 3, 'replaced, not appended');
});

test('the overview defaults to the most recent completed week and shows what is overdue', async (t) => {
  memoryDb(t, { days: [{ work_date: '2026-11-19', status: 'provisional' }] });
  const res = await call({ action: 'overview' }, { now: new Date('2026-11-25T21:00:00Z') });   // Wed 1 PM PST
  assert.strictEqual(res.status, 200, res.body.error);
  assert.strictEqual(res.body.defaultWeekStart, WEEK);
  const day = d => res.body.days.find(x => x.workDate === d);
  assert.strictEqual(day('2026-11-19').uploaded, true);
  assert.strictEqual(day('2026-11-20').overdue, true);
  assert.strictEqual(day('2026-11-24').overdue, true, 'Tuesday was due Wednesday noon');
  assert.strictEqual(day('2026-11-13').owed, false, 'before uploads began');
  assert.strictEqual(res.body.weeks[0].weekStart, WEEK);
  assert.strictEqual(res.body.weeks[0].overdue, true);
});

// ---------------------------------------------------------------------------
// The Timeclock tab (src/js/timeclock.js), rendered in a sandbox
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function uiSandbox() {
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
    setTimeout: () => 0,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const m of __SCRIPT_MODULES) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'js', m), 'utf8'), ctx, { filename: m });
  }
  vm.runInContext('globalThis.state = state;', ctx);
  return ctx;
}

const OVERVIEW = (canUpload) => ({ canUpload, today: '2026-11-24', defaultWeekStart: WEEK,
  days: [{ workDate: '2026-11-23', dow: 1, dueDate: '2026-11-24', uploaded: false, owed: true, overdue: false, people: 0, totalHours: 0, otHours: 0 },
         { workDate: '2026-11-22', dow: 7, dueDate: '2026-11-23', uploaded: false, owed: true, overdue: true, people: 0, totalHours: 0, otHours: 0 }],
  weeks: [{ weekStart: WEEK, weekEnd: '2026-11-22', uploaded: false, owed: true, overdue: false, dueDate: '2026-11-25', status: null }] });

test('the tab is view-only for anyone who is not an uploader', () => {
  const ctx = uiSandbox();
  Object.assign(ctx.state, { tcOverview: OVERVIEW(false), tcMode: 'daily' });
  const html = ctx.renderTimeclock();
  assert.match(html, /data-tc-view-only/);
  assert.doesNotMatch(html, /type="file"/);
  assert.match(html, /Missing — was due/);
  ctx.state.tcMode = 'weekly';
  assert.doesNotMatch(ctx.renderTimeclock(), /type="file"/);
});

test('a daily file commits only after its date is confirmed, and a blocked file never does', () => {
  const ctx = uiSandbox();
  const preview = (over) => Object.assign({ workDate: '2026-11-20', dayName: 'Friday', counted: 19, totalHours: 118.16, otHours: 4,
    held: { salaried: 7, external: 0, unknown: 0, unknownPeople: [] }, errors: [], warnings: [], blocked: false,
    needs: { confirmOverwrite: false, confirmReconciled: false, confirmDuplicateFile: false } }, over);
  Object.assign(ctx.state, { tcOverview: OVERVIEW(true), tcMode: 'daily', tcFiles: [
    { fileName: 'fri.xlsx', workDate: '2026-11-20', dateSource: 'default', confirm: {}, dateConfirmed: false, preview: preview({}) },
    { fileName: 'week.xlsx', workDate: '2026-11-21', dateSource: 'default', confirm: {}, dateConfirmed: true,
      preview: preview({ workDate: '2026-11-21', blocked: true, errors: ['This looks like a WEEKLY file, not a day: 50 people have more than 24 hours.'] }) }
  ] });
  let html = ctx.renderTimeclock();
  assert.match(html, /Commit 0 days/);
  assert.match(html, /This file is the timeclock for <span[^>]*>Friday, Nov 20, 2026/);
  assert.match(html, /looks like a WEEKLY file/);
  assert.match(html, /Hourly counted<\/span><b>19/);
  ctx.tcConfirmDate(0, true);
  html = ctx.renderTimeclock();
  assert.match(html, /Commit 1 day</, 'the confirmed file is ready; the weekly-looking one is not');

  // A day with rows needs the replacement confirmed too, and says what it replaces.
  ctx.state.tcFiles[0].preview = preview({ existing: { rowCount: 18, totalHours: 110, otHours: 2, source: 'manual' },
    needs: { confirmOverwrite: true } });
  html = ctx.renderTimeclock();
  assert.match(html, /Replace what is already on Nov 20, 2026: 18 people, 110\.00 hours/);
  assert.match(html, /Commit 0 days/);
  ctx.tcConfirm(0, 'overwrite', true);
  assert.match(ctx.renderTimeclock(), /Commit 1 day</);
});

test('changing a date throws away the preview and the confirmation', () => {
  const ctx = uiSandbox();
  ctx.state.tcFiles = [{ fileName: 'a.xlsx', workDate: '2026-11-20', confirm: { overwrite: true }, dateConfirmed: true, preview: { blocked: false } }];
  ctx.tcSetDate(0, '2026-11-21');
  const f = ctx.state.tcFiles[0];
  assert.strictEqual(f.preview, null);
  assert.strictEqual(f.dateConfirmed, false);
  assert.deepStrictEqual(Object.keys(f.confirm), []);
});

test('the weekly view lists each person off, with their zero-hour days to look at', () => {
  const ctx = uiSandbox();
  Object.assign(ctx.state, { tcOverview: OVERVIEW(true), tcMode: 'weekly', tcWeekStart: WEEK, tcWeek: { weekStart: WEEK,
    week: { weekStart: WEEK, weekEnd: '2026-11-22', status: 'open', fileName: 'weekly.xlsx' },
    comparison: { daysNotUploaded: ['2026-11-22'], totals: { people: 2, weeklyHours: 80, dailyHours: 70, absHoursOff: 10, dollarsDiff: 300 },
      variances: [{ employeeNumber: '0063', name: 'Ana Smith', onRoster: true, inWeeklyFile: true,
        daily: { regular: 30, ot: 0, total: 30 }, weekly: { regular: 40, ot: 0, total: 40 }, diff: { regular: 10, ot: 0, total: 10 },
        dollarsDiff: 300, zeroDays: [{ date: '2026-11-18', state: 'zero' }, { date: '2026-11-22', state: 'not_uploaded' }, { date: '2026-11-21', state: 'none' }] }] } } });
  const html = ctx.renderTimeclock();
  assert.match(html, /data-tc-person="0063"/);
  assert.match(html, /Ana Smith/);
  assert.match(html, /\+10\.00/);
  assert.match(html, /\+\$300\.00/);
  assert.match(html, /tc-chip zero[^>]*>Wed Nov 18 0\.00/);
  assert.match(html, /tc-chip not_uploaded[^>]*>Sun Nov 22 not uploaded/);
  assert.doesNotMatch(html, /Sat Nov 21/, 'a weekend day with no row is not a place to look');
  assert.match(html, /Accept remaining variances/);
  assert.match(html, /No daily upload yet for Sun Nov 22/);
});

test('the Timeclock tab is in the main navigation and an alert can open a week', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');
  assert.match(app, /data-tab="timeclock"/);
  const ctx = uiSandbox();
  ctx.loadTimeclock = () => {};
  ctx.openTimeclockWeek('2026-11-16');
  assert.strictEqual(ctx.state.tab, 'timeclock');
  assert.strictEqual(ctx.state.tcMode, 'weekly');
  assert.strictEqual(ctx.state.tcWeekStart, '2026-11-16');
});
