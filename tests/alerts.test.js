// Run with: npm test
//
// The Alerts tab: every alert type opens on its condition, never duplicates,
// and resolves itself when the condition clears (Weekly variance: when
// acknowledged). Thresholds come from timeclock-config.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHmac } = require('node:crypto');

const { evaluateConditions, planAlertChanges, varianceAlert, addDays } = require('../netlify/functions/alerts-lib');
const { runAlertEvaluation } = require('../netlify/functions/alerts-engine');

// Thursday 2026-11-05. PST is UTC-8.
const AT = (hhmm, date = '2026-11-05') => new Date(`${date}T${String(Number(hhmm.slice(0, 2)) + 8).padStart(2, '0')}:${hhmm.slice(3)}:00Z`);
const HOURLY = (n, extra = {}) => ({ id: 'e' + n, name: 'Person ' + n, employee_number: n, pay_type: 'Hourly',
  status: 'Active', wage: '20.00', department: 'Production', ...extra });
const row = (date, emp, hours) => ({ work_date: date, employee_number: emp, total_hours: hours,
  regular_hours: hours, ot_hours: 0, first_name: 'F', last_name: emp });

// A steady month: 10 hourly people every day for the last ~10 weeks.
function steady(people = 10, { except = {} } = {}) {
  const rows = [];
  const days = [];
  for (let d = '2026-08-20'; d <= '2026-11-04'; d = addDays(d, 1)) {
    days.push({ work_date: d, status: 'provisional' });
    const n = except[d] !== undefined ? except[d] : people;
    for (let i = 0; i < n; i++) rows.push(row(d, String(1000 + i), 10));
  }
  const employees = Array.from({ length: people }, (_, i) => HOURLY(String(1000 + i)));
  return { rows, days, employees };
}
const types = (conds) => conds.map(c => c.type);
const ofType = (conds, t) => conds.filter(c => c.type === t);

// ---------------------------------------------------------------------------
// New employee
// ---------------------------------------------------------------------------

test('New employee: an unknown number with held hours opens one alert per number', () => {
  const s = steady();
  const conds = evaluateConditions({ now: AT('10:00'), employees: s.employees, dailyRows: s.rows, hoursDays: s.days,
    heldUnknown: [
      { work_date: '2026-11-03', employee_number: '3380', first_name: 'Auzlo', last_name: 'Gibb', total_hours: 10 },
      { work_date: '2026-11-04', employee_number: '3380', first_name: 'Auzlo', last_name: 'Gibb', total_hours: 11.62 }
    ] });
  const ne = ofType(conds, 'new_employee');
  assert.strictEqual(ne.length, 1);
  assert.strictEqual(ne[0].alert_key, '3380');
  assert.strictEqual(ne[0].details.hours, 21.62);
  assert.strictEqual(ne[0].details.days, 2);
});

test('an open condition is not inserted twice, and a cleared one resolves', () => {
  const live = [{ id: 'a1', type: 'new_employee', alert_key: '3380', status: 'open', title: 't', details: {} },
                { id: 'a2', type: 'new_employee', alert_key: '9999', status: 'acknowledged', title: 't', details: {} }];
  const plan = planAlertChanges({
    conditions: [{ type: 'new_employee', alert_key: '3380', title: 't', details: {}, severity: 'warning' }],
    liveAlerts: live, now: AT('10:00')
  });
  assert.strictEqual(plan.insert.length, 0, 'no duplicate for a condition already open');
  assert.deepStrictEqual(plan.resolve.map(r => r.id), ['a2'], 'cleared — acknowledged or not, it resolves');
});

test('the engine re-attributes a number added to the roster, and its alert resolves', async () => {
  const db = memoryDb({
    employees: [...steady().employees, HOURLY('3380', { name: 'Auzlo Gibb', department: 'Maintenance' })],
    held: [{ work_date: '2026-11-04', employee_number: '3380', reason: 'unknown', total_hours: 11.62 }],
    alerts: [{ id: 'a1', type: 'new_employee', alert_key: '3380', status: 'open', title: 'x', details: {} }]
  });
  const result = await runAlertEvaluation({ now: AT('10:00'), db });
  assert.deepStrictEqual(db.calls.reattribute, [['3380', 'Maintenance']]);
  assert.strictEqual(db.state.alerts.find(a => a.id === 'a1').status, 'resolved');
  assert.strictEqual(result.reattributed[0].to, 'counted');
});

test('a number marked as BBSI staff moves to external and raises nothing', async () => {
  const db = memoryDb({
    employees: steady().employees,
    exclusions: [{ employee_number: '9001' }],
    held: [{ work_date: '2026-11-04', employee_number: '9001', reason: 'unknown', total_hours: 8 }]
  });
  await runAlertEvaluation({ now: AT('10:00'), db });
  assert.deepStrictEqual(db.calls.external, ['9001']);
  assert.strictEqual(db.state.alerts.filter(a => a.type === 'new_employee').length, 0);
});

// ---------------------------------------------------------------------------
// Missing files
// ---------------------------------------------------------------------------

test('Daily file missing: not before 9:00 AM Pacific, yes after, and not once delivered', () => {
  const s = steady();
  const days = s.days.filter(d => d.work_date !== '2026-11-04');
  const before = evaluateConditions({ now: AT('08:59'), employees: s.employees, dailyRows: s.rows, hoursDays: days });
  assert.ok(!types(before).includes('daily_file_missing'));
  const after = evaluateConditions({ now: AT('09:00'), employees: s.employees, dailyRows: s.rows, hoursDays: days });
  assert.deepStrictEqual(ofType(after, 'daily_file_missing').map(c => c.alert_key), ['2026-11-04']);
  const delivered = evaluateConditions({ now: AT('09:00'), employees: s.employees, dailyRows: s.rows, hoursDays: days,
    deliveredDates: ['2026-11-04'] });
  assert.ok(!types(delivered).includes('daily_file_missing'), 'a "nobody had time" day is delivered too');
});

test('Weekly file missing: Monday 11:00 AM Pacific, for last week, until a weekly import exists', () => {
  const s = steady();
  const mon = d => AT(d, '2026-11-09');
  const base = { employees: s.employees, dailyRows: s.rows, hoursDays: s.days };
  assert.ok(!types(evaluateConditions({ ...base, now: mon('10:59') })).includes('weekly_file_missing'));
  const missing = ofType(evaluateConditions({ ...base, now: mon('11:00') }), 'weekly_file_missing');
  assert.deepStrictEqual(missing.map(c => c.alert_key), ['2026-11-02']);
  const arrived = evaluateConditions({ ...base, now: mon('11:30'),
    weeklyImports: [{ created_at: '2026-11-09T18:05:00Z', work_date_from: '2026-11-02', work_date_to: '2026-11-08' }] });
  assert.ok(!types(arrived).includes('weekly_file_missing'));
});

// ---------------------------------------------------------------------------
// Thin day and zero-hour rows
// ---------------------------------------------------------------------------

test('Thin day: below 60% of the trailing 4-week weekday median', () => {
  const s = steady(10, { except: { '2026-10-08': 5 } });  // 5 < 6
  const conds = evaluateConditions({ now: AT('10:00'), employees: s.employees, dailyRows: s.rows, hoursDays: s.days });
  assert.deepStrictEqual(ofType(conds, 'thin_day').map(c => c.alert_key), ['2026-10-08']);
  const ok = steady(10, { except: { '2026-10-08': 6 } });  // exactly 60% is not below it
  assert.strictEqual(ofType(evaluateConditions({ now: AT('10:00'), employees: ok.employees,
    dailyRows: ok.rows, hoursDays: ok.days }), 'thin_day').length, 0);
});

test('Thin day resolves only when the day is reconciled AND back above the threshold', () => {
  const live = [{ id: 't', type: 'thin_day', alert_key: '2026-10-08', status: 'open', details: {}, title: '' }];
  const refilled = steady();   // 10 rows now
  const provisional = evaluateConditions({ now: AT('10:00'), employees: refilled.employees,
    dailyRows: refilled.rows, hoursDays: refilled.days, liveAlerts: live });
  assert.strictEqual(ofType(provisional, 'thin_day').length, 1, 'filled but still provisional: stays');
  const reconciled = refilled.days.map(d => d.work_date === '2026-10-08' ? { ...d, status: 'reconciled' } : d);
  const after = evaluateConditions({ now: AT('10:00'), employees: refilled.employees,
    dailyRows: refilled.rows, hoursDays: reconciled, liveAlerts: live });
  assert.strictEqual(ofType(after, 'thin_day').length, 0);
});

test('Zero-hour rows: a provisional day with rostered people at 0.00; gone once reconciled', () => {
  const s = steady();
  s.rows.find(r => r.work_date === '2026-11-03' && r.employee_number === '1001').total_hours = 0;
  const conds = evaluateConditions({ now: AT('10:00'), employees: s.employees, dailyRows: s.rows, hoursDays: s.days });
  const z = ofType(conds, 'zero_hour_rows');
  assert.deepStrictEqual(z.map(c => c.alert_key), ['2026-11-03']);
  assert.strictEqual(z[0].details.employees[0].employeeNumber, '1001');
  const reconciled = s.days.map(d => d.work_date === '2026-11-03' ? { ...d, status: 'reconciled' } : d);
  assert.strictEqual(ofType(evaluateConditions({ now: AT('10:00'), employees: s.employees,
    dailyRows: s.rows, hoursDays: reconciled }), 'zero_hour_rows').length, 0);
});

// ---------------------------------------------------------------------------
// Active, no hours
// ---------------------------------------------------------------------------

test('Active, no hours: active hourly only; inactive and salaried never; feed down suppresses it', () => {
  const s = steady();
  const employees = [...s.employees,
    HOURLY('5159', { name: 'Miguel Cervantes' }),
    HOURLY('5467', { name: 'Off Roll', status: 'Inactive' }),
    { id: 'sal', name: 'Salaried', employee_number: '0303', pay_type: 'Salaried', status: 'Active' }];
  const conds = evaluateConditions({ now: AT('10:00'), employees, dailyRows: s.rows, hoursDays: s.days });
  assert.deepStrictEqual(ofType(conds, 'active_no_hours').map(c => c.alert_key), ['5159']);

  const down = evaluateConditions({ now: AT('10:00'), employees, hoursDays: s.days,
    dailyRows: s.rows.filter(r => r.work_date < '2026-10-28') });
  assert.strictEqual(ofType(down, 'active_no_hours').length, 0, 'that is a missing-file problem, not sixty people');
});

// ---------------------------------------------------------------------------
// Weekly variance
// ---------------------------------------------------------------------------

test('Weekly variance: over 2% or $1,000 raises; under both does not', () => {
  const v = (before, after) => ({ from: '2026-11-02', to: '2026-11-08', changedDays: [], fixedPunches: [],
    totals: { dollarsBefore: before, dollarsAfter: after, dollarsChange: after - before, hoursChange: 0 } });
  assert.ok(varianceAlert(v(100000, 101500)), '$1,500 is over $1,000');
  assert.ok(varianceAlert(v(10000, 10300)), '3% is over 2%');
  assert.strictEqual(varianceAlert(v(100000, 100900)), null, '$900 and 0.9% is under both');
});

test('Weekly variance is never auto-resolved by the evaluator', () => {
  const plan = planAlertChanges({ conditions: [], liveAlerts: [
    { id: 'v', type: 'weekly_variance', alert_key: 'w', status: 'open', details: {}, title: '' }] });
  assert.strictEqual(plan.resolve.length, 0);
});

// ---------------------------------------------------------------------------
// API: acknowledge, count
// ---------------------------------------------------------------------------

function sessionCookie() {
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
  const b64 = Buffer.from(JSON.stringify({ email: 'peter.stroble@sequoiafp.com', exp: Date.now() + 3600000 })).toString('base64url');
  const sig = createHmac('sha256', process.env.SESSION_SECRET).update(b64).digest('base64url');
  return `sfp_session=${b64}.${sig}`;
}

test('acknowledging keeps a standing alert acknowledged, and resolves a weekly variance', async (t) => {
  const payrollDb = require('../netlify/functions/payroll-db');
  const REAL = { ...payrollDb };
  t.after(() => Object.assign(payrollDb, REAL));
  const store = {
    a: { id: 'a', type: 'thin_day', status: 'open' },
    v: { id: 'v', type: 'weekly_variance', status: 'open' }
  };
  Object.assign(payrollDb, {
    fetchAlert: async id => store[id],
    updateAlert: async (id, patch) => { Object.assign(store[id], patch); return [store[id]]; },
    fetchAlerts: async () => Object.values(store)
  });
  const { handler } = require('../netlify/functions/alerts');
  const post = body => handler({ httpMethod: 'POST', headers: { cookie: sessionCookie() }, body: JSON.stringify(body) });

  assert.strictEqual((await post({ action: 'acknowledge', id: 'a' })).statusCode, 200);
  assert.strictEqual(store.a.status, 'acknowledged');
  assert.strictEqual(store.a.acknowledged_by, 'peter.stroble@sequoiafp.com');
  await post({ action: 'acknowledge', id: 'v' });
  assert.strictEqual(store.v.status, 'resolved');

  store.b = { id: 'b', type: 'new_employee', status: 'open' };
  const res = await handler({ httpMethod: 'GET', headers: { cookie: sessionCookie() }, queryStringParameters: { count: '1' } });
  assert.strictEqual(JSON.parse(res.body).openCount, 1, 'only OPEN alerts count toward the badge');
});

test('the alerts endpoint refuses an unsigned caller', async () => {
  const { handler } = require('../netlify/functions/alerts');
  const res = await handler({ httpMethod: 'GET', headers: {} });
  assert.strictEqual(res.statusCode, 401);
});

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

test('the nav badge shows the open count and is hidden at zero', () => {
  const badge = { textContent: '', style: {} };
  const ctx = { document: { getElementById: id => (id === 'alertBadge' ? badge : null) }, state: {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'alerts.js'), 'utf8'), ctx);
  ctx.setAlertBadge(3);
  assert.strictEqual(badge.textContent, '3');
  assert.strictEqual(badge.style.display, 'inline-block');
  ctx.setAlertBadge(0);
  assert.strictEqual(badge.style.display, 'none');
  ctx.setAlertBadge(250);
  assert.strictEqual(badge.textContent, '99+');
});

test('the Alerts tab is in the nav, in the manifest, and dispatched', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');
  assert.match(app, /data-tab="alerts"[^>]*>Alerts<span class="al-badge" id="alertBadge"/);
  const { __SCRIPT_MODULES } = require('../netlify/functions/session.js');
  assert.ok(__SCRIPT_MODULES.indexOf('alerts.js') < __SCRIPT_MODULES.indexOf('bootstrap.js'));
  const core = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'core.js'), 'utf8');
  assert.match(core, /state\.tab==='alerts'\)el\.innerHTML=renderAlertsTab\(\)/);
  const toml = fs.readFileSync(path.join(__dirname, '..', 'netlify.toml'), 'utf8');
  assert.match(toml, /\[functions\."alerts-evaluate"\]\s*\n\s*schedule = "20 \* \* \* \*"/);
});

// ---------------------------------------------------------------------------
// In-memory db for the engine
// ---------------------------------------------------------------------------

function memoryDb({ employees = [], exclusions = [], held = [], alerts = [], rows, days } = {}) {
  const s = steady();
  const state = { held: [...held], alerts: alerts.map(a => ({ ...a })), rows: rows || s.rows, days: days || s.days };
  const calls = { reattribute: [], external: [] };
  return {
    state, calls,
    fetchEmployees: async () => employees,
    fetchExclusions: async () => exclusions,
    fetchHeldRows: async ({ reason }) => state.held.filter(h => !reason || h.reason === reason),
    markHeldExternal: async n => { calls.external.push(n); state.held.forEach(h => { if (h.employee_number === n) h.reason = 'external'; }); return []; },
    updateHeldReason: async (n, from, to) => { state.held.forEach(h => { if (h.employee_number === n && h.reason === from) h.reason = to; }); return []; },
    reattributeHeld: async (n, dept) => { calls.reattribute.push([n, dept]); const before = state.held.length;
      state.held = state.held.filter(h => !(h.employee_number === n && h.reason === 'unknown')); return before - state.held.length; },
    fetchDailyHoursAll: async () => state.rows,
    fetchHoursDays: async () => state.days,
    fetchDeliveriesForDates: async () => [],
    fetchImports: async () => [],
    fetchAlerts: async () => state.alerts.filter(a => a.status !== 'resolved'),
    insertAlert: async r => { const a = { id: 'n' + state.alerts.length, ...r }; state.alerts.push(a); return a; },
    updateAlert: async (id, patch) => { const a = state.alerts.find(x => x.id === id); Object.assign(a, patch); return [a]; }
  };
}
