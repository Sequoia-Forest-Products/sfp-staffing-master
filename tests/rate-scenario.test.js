// Rate Scenario — Manufacturing Costs → Rate Scenario.
//
// What is pinned here:
//
//   * ONE CALCULATION PATH. With no edits the scenario equals current exactly,
//     and "current" equals what /api/cost-report reports for the same inputs.
//   * One changed rate moves only that person, and moves the totals by exactly
//     the burdened amount — overtime days priced at 1.5x and 2.0x included.
//   * Reset restores current.
//   * NOTHING IS WRITTEN. Asserted directly: every write function in db.js and
//     payroll-db.js is replaced with a recorder, global fetch is a recorder
//     that refuses, and after a full scenario round trip all of them are empty.
//     The page's own requests are checked too: GET only, and no localStorage.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHmac } = require('crypto');

process.env.SESSION_SECRET = 'test-session-secret';
process.env.SUPABASE_URL = 'https://example.invalid';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';
process.env.PAYROLL_TIME_ZONE = 'America/Los_Angeles';

const db = require('../netlify/functions/db');
const payrollDb = require('../netlify/functions/payroll-db');
const { handler } = require('../netlify/functions/rate-scenario');
const { handler: costReportHandler } = require('../netlify/functions/cost-report');
const { buildRateScenario } = require('../netlify/functions/rate-scenario-lib');
const { weekStartFor, weekDates } = require('../netlify/functions/ot-report-lib');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'js');
const { __SCRIPT_MODULES } = require('../netlify/functions/session.js');

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const BURDEN = 0.44;
const MBF_PER_HOUR = 15;

const EMPLOYEES = [
  ...Array.from({ length: 4 }, (_, i) => ({
    id: `h${i}`, name: `Hourly ${i}`, employee_number: `010${i}`, status: 'Active',
    department: 'Production', cost_class: 'Manufacturing', pay_type: 'Hourly',
    position_group: 'Green Chain', position: 'Green Chain Puller', wage: '22.00'
  })),
  {
    id: 'm1', name: 'Mech One', employee_number: '0105', status: 'Active',
    department: 'Maintenance', cost_class: 'Manufacturing', pay_type: 'Hourly',
    position_group: 'Maintenance', position: 'Millwright', wage: '30.00'
  },
  {
    id: 'sal1', name: 'Eduardo Rivera', employee_number: '0200', status: 'Active',
    department: 'Production', cost_class: 'Manufacturing', pay_type: 'Salaried',
    position_group: 'Supervisors', position: 'Production Supervisor',
    wage: 'Salary', annual_salary: 104000
  },
  {
    id: 'sga1', name: 'Axeri Ramirez', employee_number: '0300', status: 'Active',
    department: 'Accounting', cost_class: 'SG&A', pay_type: 'Hourly',
    position_group: null, position: 'Payroll Clerk', wage: '30.00'
  }
];

// Production: 4 x 10-hour days, no OT. Mech One: Mon 12 (2 OT at 1.5x),
// Tue 13 (2 at 1.5x, 1 at 2.0x), Wed 10, Thu 10 — 40 regular, 5 OT, which
// prices as 40 + 4x1.5 + 1x2.0 = 48 straight-time-equivalent hours.
function dailyRowsFor(dates) {
  const rows = [];
  for (const d of dates.slice(0, 4)) {
    for (let i = 0; i < 4; i++) {
      rows.push({ work_date: d, employee_number: `010${i}`, total_hours: 10, regular_hours: 10, ot_hours: 0 });
    }
  }
  const mech = [[10, 2], [10, 3], [10, 0], [10, 0]];
  dates.slice(0, 4).forEach((d, i) => {
    const [reg, ot] = mech[i];
    rows.push({ work_date: d, employee_number: '0105', total_hours: reg + ot, regular_hours: reg, ot_hours: ot });
  });
  return rows;
}

const thisWeek = weekDates(weekStartFor(new Date().toISOString().slice(0, 10)));
const ROWS = dailyRowsFor(thisWeek);

function libInputs(extra = {}) {
  return {
    employees: EMPLOYEES, dailyRows: ROWS, burden: BURDEN, mbfPerHour: MBF_PER_HOUR,
    allocations: [], standardHours: 40, ...extra
  };
}

function sessionCookie() {
  const b64 = Buffer.from(JSON.stringify({ email: 'tester@sequoiafp.com', exp: Date.now() + 3600000 }))
    .toString('base64url');
  const sig = createHmac('sha256', 'test-session-secret').update(b64).digest('base64url');
  return `sfp_session=${b64}.${sig}`;
}

function event(params = {}, { method = 'GET', cookie = sessionCookie() } = {}) {
  return { httpMethod: method, headers: cookie ? { cookie } : {}, queryStringParameters: params };
}

// The reads answer from the fixture. EVERY OTHER exported function of db.js
// and payroll-db.js — every write — is replaced with a recorder, and global
// fetch refuses, so a write by any route is caught rather than attempted.
const READS = new Set(['fetchDailyHours', 'fetchDailyHoursIndex', 'fetchEmployees',
  'fetchAllocations', 'fetchHoursDays']);

function stub(t) {
  const realDb = { ...db };
  const realPdb = { ...payrollDb };
  const realFetch = global.fetch;
  t.after(() => { Object.assign(db, realDb); Object.assign(payrollDb, realPdb); global.fetch = realFetch; });

  const writes = [];
  const network = [];
  for (const [mod, name] of [[db, 'db'], [payrollDb, 'payrollDb']]) {
    for (const k of Object.keys(mod)) {
      if (typeof mod[k] !== 'function') continue;
      if (mod === payrollDb && READS.has(k)) continue;
      mod[k] = async (...args) => { writes.push(`${name}.${k}`); void args; return []; };
    }
  }
  global.fetch = async (url, opts) => {
    network.push({ url: String(url), method: (opts && opts.method) || 'GET' });
    throw new Error('no network in tests');
  };

  payrollDb.fetchDailyHours = async (from, to) => ROWS.filter(r => r.work_date >= from && r.work_date <= to);
  payrollDb.fetchDailyHoursIndex = async (from, to, { offset = 0, limit = 5000 } = {}) => {
    const inRange = ROWS.filter(r => r.work_date >= from && r.work_date <= to);
    return { rows: inRange.slice(offset, offset + limit), total: inRange.length };
  };
  payrollDb.fetchEmployees = async () => EMPLOYEES;
  payrollDb.fetchAllocations = async () => [];
  payrollDb.fetchHoursDays = async () => [];
  return { writes, network };
}

async function call(t, params) {
  const rec = stub(t);
  const res = await handler(event({ burden: String(BURDEN), mbfPerHour: String(MBF_PER_HOUR), ...params }));
  return { res, body: JSON.parse(res.body), ...rec };
}

// ---------------------------------------------------------------------------
// the calculation
// ---------------------------------------------------------------------------

test('with no edits, every scenario figure equals current exactly', () => {
  const r = buildRateScenario(libInputs());
  assert.deepStrictEqual(r.scenario, r.current);
  assert.strictEqual(r.change.burdenedCost, 0);
  assert.strictEqual(r.change.costPerThousand, 0);
  assert.strictEqual(r.change.annualized, 0);
  assert.strictEqual(r.changedCount, 0);
  for (const p of r.people) {
    assert.strictEqual(p.scenarioRate, p.currentRate, p.name);
    assert.strictEqual(p.scenarioBurdened, p.currentBurdened, p.name);
    assert.strictEqual(p.burdenedDelta, 0, p.name);
    assert.strictEqual(p.changed, false, p.name);
  }
});

test('the table is the hourly Manufacturing roster only, grouped in plant order', () => {
  const r = buildRateScenario(libInputs());
  assert.deepStrictEqual(r.people.map(p => p.employeeNumber), ['0100', '0101', '0102', '0103', '0105']);
  assert.deepStrictEqual(r.departments.map(d => d.department), ['Production', 'Maintenance']);
  const mech = r.people.find(p => p.employeeNumber === '0105');
  assert.strictEqual(mech.regularHours, 40);
  assert.strictEqual(mech.otHours, 5);
});

test('changing one rate moves only that person, by the burdened amount including overtime', () => {
  const before = buildRateScenario(libInputs());
  const after = buildRateScenario(libInputs({ overrides: { '0105': 35 } }));

  // 48 straight-time-equivalent hours (40 + 4 x 1.5 + 1 x 2.0) x $5 x 1.44.
  const expected = Math.round(48 * 5 * (1 + BURDEN) * 100) / 100;
  assert.strictEqual(expected, 345.6);

  const mech = after.people.find(p => p.employeeNumber === '0105');
  assert.strictEqual(mech.currentRate, 30);
  assert.strictEqual(mech.scenarioRate, 35);
  assert.strictEqual(mech.currentBurdened, 2073.6, '1,440 wages (incl. OT premium) x 1.44');
  assert.strictEqual(mech.scenarioBurdened, 2419.2);
  assert.strictEqual(mech.burdenedDelta, expected);
  assert.strictEqual(mech.changed, true);
  assert.strictEqual(mech.rateChange, 5);
  assert.strictEqual(mech.rateChangePct, 0.1667);

  for (const p of after.people.filter(x => x.employeeNumber !== '0105')) {
    const b = before.people.find(x => x.employeeNumber === p.employeeNumber);
    assert.strictEqual(p.scenarioBurdened, b.currentBurdened, `${p.name} must not move`);
    assert.strictEqual(p.burdenedDelta, 0);
  }

  // The current side is untouched by the override.
  assert.deepStrictEqual(after.current, before.current);
  assert.strictEqual(Math.round((after.scenario.burdenedCost - after.current.burdenedCost) * 100) / 100, expected);
  assert.strictEqual(after.change.burdenedCost, expected);

  // $/MBF divides by MBF/hr x labour hours, the same divisor as Department & Group.
  const mbf = MBF_PER_HOUR * after.current.hours;
  assert.strictEqual(after.volumeMbf, mbf);
  assert.strictEqual(after.scenario.costPerThousand,
    Math.round((after.scenario.burdenedCost / mbf) * 100) / 100);
  assert.ok(after.change.costPerThousand > 0 && after.change.costPerThousandPct > 0);
  assert.strictEqual(after.change.annualized, Math.round(expected * 52 * 100) / 100,
    'one standard week x 52');

  const dept = after.departments.find(d => d.department === 'Maintenance');
  assert.strictEqual(dept.burdenedDelta, expected);
  assert.strictEqual(dept.changed, 1);
});

test('a salaried person cannot be given a scenario rate in the library either', () => {
  const r = buildRateScenario(libInputs({ overrides: { '0200': 99 } }));
  assert.deepStrictEqual(r.scenario, r.current);
});

test('no production volume shows $/MBF as unavailable rather than dividing by zero', () => {
  const r = buildRateScenario(libInputs({ mbfPerHour: 0, overrides: { '0105': 35 } }));
  assert.strictEqual(r.volumeMbf, null);
  assert.strictEqual(r.current.costPerThousand, null);
  assert.strictEqual(r.scenario.costPerThousand, null);
  assert.strictEqual(r.change.costPerThousand, null);
  assert.strictEqual(r.change.costPerThousandPct, null);
  for (const p of r.people) assert.strictEqual(p.perMbfImpact, null);
  // Dollars are still real.
  assert.strictEqual(r.change.burdenedCost, 345.6);
});

// ---------------------------------------------------------------------------
// the endpoint
// ---------------------------------------------------------------------------

test('current figures are exactly what Manufacturing Costs reports for the same period', async (t) => {
  const { body } = await call(t, {});
  stub(t);
  const cr = JSON.parse((await costReportHandler(event({
    burden: String(BURDEN), mbfPerHour: String(MBF_PER_HOUR)
  }))).body);
  assert.strictEqual(body.ok, true);
  assert.strictEqual(cr.ok, true);
  assert.strictEqual(body.scenario.current.burdenedCost, cr.report.totals.burdenedCost);
  assert.strictEqual(body.scenario.current.costPerThousand, cr.report.totals.costPerThousand);
  assert.strictEqual(body.scenario.current.hours, cr.report.totals.hours);
  assert.deepStrictEqual(body.week, cr.week);
});

test('nothing is written to the database — asserted directly', async (t) => {
  const { res, body, writes, network } = await call(t, { overrides: JSON.stringify({ '0105': 35, '0100': 40 }) });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(body.scenario.changedCount, 2);
  assert.deepStrictEqual(writes, [], 'no write function in db.js or payroll-db.js was called');
  assert.deepStrictEqual(network, [], 'nothing reached the network at all');
  // And the roster the scenario read is unchanged.
  assert.strictEqual(EMPLOYEES.find(e => e.employee_number === '0105').wage, '30.00');
});

test('the scenario modules contain no write path', () => {
  for (const f of ['rate-scenario.js', 'rate-scenario-lib.js', 'cost-inputs-lib.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'netlify', 'functions', f), 'utf8')
      .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
    assert.ok(!/require\(['"]\.\/db['"]\)/.test(src), `${f} imports db.js`);
    assert.ok(!/\b(insert|update|upsert|remove|replaceAll|delete\w*|create\w*|apply\w*)\s*\(/.test(src),
      `${f} calls a write function`);
  }
});

test('anything but GET is 405, and no session is 401', async (t) => {
  const { writes } = stub(t);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.strictEqual((await handler(event({}, { method }))).statusCode, 405, method);
  }
  assert.strictEqual((await handler(event({}, { cookie: null }))).statusCode, 401);
  assert.deepStrictEqual(writes, []);
});

test('scenario rates must be positive numbers', async (t) => {
  for (const bad of [{ '0105': -1 }, { '0105': 0 }, { '0105': 'abc' }, { '0105': 5000 }, [1], 'nope']) {
    const raw = typeof bad === 'string' ? bad : JSON.stringify(bad);
    const { res, body } = await call(t, { overrides: raw });
    assert.strictEqual(res.statusCode, 400, raw);
    assert.strictEqual(body.ok, false);
  }
  const ok = await call(t, { overrides: JSON.stringify({ '0105': '$35.00' }) });
  assert.strictEqual(ok.res.statusCode, 200);
});

test('an override for anybody outside the hourly Manufacturing roster is refused, not ignored', async (t) => {
  for (const num of ['0200', '0300', '9999']) {
    const { res, body } = await call(t, { overrides: JSON.stringify({ [num]: 30 }) });
    assert.strictEqual(res.statusCode, 400, num);
    assert.deepStrictEqual(body.unknown, [num]);
  }
});

test('the cost report endpoint takes no overrides', async (t) => {
  stub(t);
  const plain = JSON.parse((await costReportHandler(event({ burden: '0.44', mbfPerHour: '15' }))).body);
  const withOv = JSON.parse((await costReportHandler(event({
    burden: '0.44', mbfPerHour: '15', overrides: JSON.stringify({ '0105': 99 })
  }))).body);
  assert.deepStrictEqual(withOv.report.totals, plain.report.totals);
  assert.strictEqual(plain.report.people, undefined, 'the cost report stays aggregates');
});

// ---------------------------------------------------------------------------
// the page
// ---------------------------------------------------------------------------

function fakeEl() {
  return {
    textContent: '', innerHTML: '', value: '', checked: false, style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {}, addEventListener() {},
    appendChild() {}, querySelector: () => fakeEl(), querySelectorAll: () => []
  };
}

// The page, wired to the REAL endpoint: /api/rate-scenario requests go through
// handler() over the stubbed database, so the round trip is the real one.
function pageSandbox(t) {
  const rec = stub(t);
  const calls = { fetches: [], storage: [] };
  const timers = [];
  const tab = fakeEl();
  const ctx = {
    console, window: {}, URLSearchParams, URL,
    document: {
      getElementById: (id) => (id === 'tabContent' ? tab : fakeEl()),
      querySelector: () => fakeEl(), querySelectorAll: () => []
    },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: (id) => { if (id) timers[id - 1] = null; },
    localStorage: {
      getItem: () => null,
      setItem: (k) => calls.storage.push(k),
      removeItem: () => {}
    },
    location: { href: '' },
    fetch: async (url, opts) => {
      const u = String(url);
      calls.fetches.push({ url: u, method: (opts && opts.method) || 'GET' });
      if (u.startsWith('/api/rate-scenario')) {
        const q = Object.fromEntries(new URL(u, 'http://x').searchParams);
        const res = await handler(event(q, { method: (opts && opts.method) || 'GET' }));
        return { ok: res.statusCode < 400, status: res.statusCode, json: async () => JSON.parse(res.body) };
      }
      if (u.startsWith('/api/permissions')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, caller: 'me@sequoiafp.com', list: ['me@sequoiafp.com'], hasAccess: true }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, data: [] }) };
    }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const m of __SCRIPT_MODULES) {
    vm.runInContext(fs.readFileSync(path.join(SRC, m), 'utf8'), ctx, { filename: m });
  }
  vm.runInContext('globalThis.state = state;', ctx);
  ctx.__calls = calls;
  ctx.__tab = tab;
  ctx.__writes = rec.writes;
  ctx.__flush = async () => {
    while (timers.some(Boolean)) {
      const fns = timers.splice(0).filter(Boolean);
      for (const fn of fns) fn();
      await settle();
    }
  };
  return ctx;
}

const settle = () => new Promise(r => setImmediate(r));

async function openScenario(ctx) {
  await settle(); await settle();          // let bootstrap's loadData() land first
  ctx.state.tab = 'costs';
  ctx.state.burden = BURDEN; ctx.state.mhr = MBF_PER_HOUR;
  ctx.switchCostsView('scenario');
  for (let i = 0; i < 5; i++) await settle();
  return ctx.state.rs;
}

test('the page: Rate Scenario is a view beside Staffing Economics, and loads on open', async (t) => {
  const ctx = pageSandbox(t);
  const rs = await openScenario(ctx);
  assert.ok(rs.data && rs.data.ok, rs.error);
  const html = ctx.__tab.innerHTML;
  assert.match(html, />Rate Scenario</);
  assert.match(html, /Scenario only — actual rates are not changed\./);
  assert.match(html, /Current fully burdened \$\/MBF/);
  assert.match(html, /Scenario fully burdened \$\/MBF/);
  for (const name of ['Hourly 0', 'Mech One']) assert.ok(html.includes(name), name);
  assert.ok(!html.includes('Eduardo Rivera'), 'salaried people are not in the hourly table');
  assert.ok(!html.includes('Axeri Ramirez'), 'SG&A is not Manufacturing');
});

test('the page: editing a rate recalculates, Reset restores, and nothing is stored', async (t) => {
  const ctx = pageSandbox(t);
  const rs = await openScenario(ctx);
  const current = JSON.parse(JSON.stringify(rs.data.scenario.current));
  assert.deepStrictEqual(rs.data.scenario.scenario, current);

  ctx.rsSetRate('0105', '35');
  assert.deepStrictEqual({ ...rs.overrides }, { '0105': 35 });
  assert.match(ctx.__tab.innerHTML, /edited/, 'the row is marked before the server answers');
  await ctx.__flush();
  assert.strictEqual(rs.data.scenario.change.burdenedCost, 345.6);
  assert.deepStrictEqual(rs.data.scenario.current, current, 'current never moves');
  assert.match(ctx.__tab.innerHTML, /rs-changed/);

  // Only-changed filter.
  ctx.rsToggleOnlyChanged();
  assert.ok(ctx.__tab.innerHTML.includes('Mech One'));
  assert.ok(!ctx.__tab.innerHTML.includes('Hourly 0'));
  ctx.rsToggleOnlyChanged();

  ctx.rsReset();
  await ctx.__flush();
  for (let i = 0; i < 3; i++) await settle();
  assert.deepStrictEqual({ ...rs.overrides }, {});
  assert.deepStrictEqual(rs.data.scenario.scenario, current, 'Reset restores current');
  assert.strictEqual(rs.data.scenario.changedCount, 0);

  // Every request the page made was a GET, the scenario never went near
  // localStorage, and the database saw no write.
  assert.ok(ctx.__calls.fetches.every(f => f.method === 'GET'),
    JSON.stringify(ctx.__calls.fetches.filter(f => f.method !== 'GET')));
  assert.deepStrictEqual(ctx.__calls.storage.filter(k => /rs|scenario|rate/i.test(k)), []);
  assert.deepStrictEqual(ctx.__writes, []);
});

test('the page: an invalid rate is not applied; a change over 25% warns but applies', async (t) => {
  const ctx = pageSandbox(t);
  const rs = await openScenario(ctx);
  const before = ctx.__calls.fetches.length;

  ctx.rsSetRate('0100', '-3');
  assert.deepStrictEqual({ ...rs.overrides }, {});
  assert.match(ctx.__tab.innerHTML, /Must be a positive number — not applied/);
  ctx.rsSetRate('0100', 'abc');
  assert.match(ctx.__tab.innerHTML, /Not a number — not applied/);
  await ctx.__flush();
  assert.strictEqual(ctx.__calls.fetches.length, before, 'an invalid box sends nothing');

  ctx.rsSetRate('0100', '30');                 // 22 -> 30 is +36%
  assert.deepStrictEqual({ ...rs.overrides }, { '0100': 30 });
  assert.match(ctx.__tab.innerHTML, /over 25% change/);
  await ctx.__flush();
  assert.strictEqual(rs.data.scenario.changedCount, 1);

  ctx.rsSetRate('0100', '22.00');              // typed back to current: not an edit
  assert.deepStrictEqual({ ...rs.overrides }, {});
});

test('the page: the scenario never reaches any other view', async (t) => {
  const ctx = pageSandbox(t);
  const rs = await openScenario(ctx);
  ctx.rsSetRate('0105', '35');
  await ctx.__flush();
  assert.ok(rs.data.scenario.changedCount === 1);

  ctx.switchCostsView('deptgroup');
  for (let i = 0; i < 5; i++) await settle();
  const costReq = ctx.__calls.fetches.filter(f => f.url.startsWith('/api/cost-report'));
  assert.ok(costReq.length >= 1);
  for (const f of costReq) assert.ok(!/overrides/.test(f.url), 'the cost report request carries no scenario');

  // No other module reads the scenario state.
  for (const f of fs.readdirSync(SRC).filter(f => f !== 'rate-scenario.js')) {
    const src = fs.readFileSync(path.join(SRC, f), 'utf8');
    assert.ok(!/state\.rs\b|rsState\(|\.overrides\b/.test(src), `${f} reads the scenario`);
  }
});
