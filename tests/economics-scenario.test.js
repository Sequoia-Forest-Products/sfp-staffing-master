// Staffing Economics → Rate scenario mode.
//
// A toggle on the Staffing Economics page that adds a Scenario Rate and a
// Scenario $/M column to every seat, and a headline comparing the crew's fully
// burdened $/M now against the scenario. Pinned here:
//
//   * ONE CALCULATION. The scenario is econCrew() — the function the page's own
//     "Burdened" card is drawn from — called with an overrides map. With no
//     edits the two are equal exactly.
//   * One edit moves only that person's seat(s), by (Δrate × (1 + burden)) / MBF/hr.
//   * Bad rates are flagged and not applied; changes over 25% warn and apply.
//   * NOTHING IS SAVED OR SENT: no fetch and no localStorage write while the
//     scenario is used, and the roster's rates are untouched.
//   * The period-based build (PR #68) stays gone.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'js');
const { __SCRIPT_MODULES } = require('../netlify/functions/session.js');

// Plan order on purpose not alphabetical: the page must keep it.
const SEATS = [
  { id: 'e1', num: 1, section: 'Sawmill', seat: 'Head Sawyer',  employeeId: 'h2', name: 'Zed Young', unlinked: false, max_wage: 40 },
  { id: 'e2', num: 2, section: 'Sawmill', seat: 'Edgerman',     employeeId: 'h1', name: 'Ana Reyes', unlinked: false, max_wage: 30 },
  { id: 'e3', num: 3, section: 'Yard',    seat: 'Loader',       employeeId: null, name: null,        unlinked: false, max_wage: 24 },
  { id: 'e4', num: 4, section: 'Yard',    seat: 'Utility',      employeeId: 'h1', name: 'Ana Reyes', unlinked: false, max_wage: 24 },
  { id: 'e5', num: 5, section: 'Yard',    seat: 'Lead',         employeeId: 's1', name: 'Sal Aried', unlinked: false, max_wage: 50 }
];
const ROSTER = [
  { id: 'h1', name: 'Ana Reyes', status: 'Active', payType: 'Hourly', wage: 25.00 },
  { id: 'h2', name: 'Zed Young', status: 'Active', payType: 'Hourly', wage: 32.00 },
  { id: 's1', name: 'Sal Aried', status: 'Active', payType: 'Salaried', annualSalary: 104000, wage: 'Salary' }
];

function fakeEl(id) {
  return {
    id, textContent: '', innerHTML: '', value: '', checked: false, hidden: false, style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {}, addEventListener() {}, focus() {}, setSelectionRange() {},
    appendChild() {}, querySelector: () => fakeEl(), querySelectorAll: () => []
  };
}

function sandbox() {
  const calls = [];
  const stored = [];
  const els = new Map();
  const getEl = (id) => { if (!els.has(id)) els.set(id, fakeEl(id)); return els.get(id); };
  const ctx = {
    console, window: {}, URLSearchParams,
    document: { getElementById: getEl, querySelector: () => fakeEl(), querySelectorAll: () => [] },
    setTimeout: () => 0,
    localStorage: { getItem: () => null, setItem: (k) => stored.push(k), removeItem() {} },
    fetch: async (url, opts = {}) => {
      calls.push({ url: String(url), method: opts.method || 'GET' });
      if (String(url).startsWith('/api/economics')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, seats: SEATS.map(s => ({ ...s })), assignable: true }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, data: [] }) };
    }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const m of __SCRIPT_MODULES) {
    if (m === 'bootstrap.js') continue;
    vm.runInContext(fs.readFileSync(path.join(SRC, m), 'utf8'), ctx, { filename: m });
  }
  vm.runInContext('globalThis.state = state; toast = () => {};', ctx);
  Object.assign(ctx.state, { employees: ROSTER.map(e => ({ ...e })), loading: false,
    tab: 'costs', costsView: 'staffing', burden: 0.44, mhr: 15 });
  ctx.__calls = calls;
  ctx.__stored = stored;
  ctx.__html = () => getEl('tabContent').innerHTML;
  return ctx;
}

async function scenarioOn() {
  const ctx = sandbox();
  await ctx.loadEconomics();
  ctx.econToggleScenario();
  ctx.__calls.length = 0;
  return ctx;
}

const r2 = (n) => Math.round(n * 100) / 100;
const dpm = (wage) => wage * 1.44 / 15;

test('off by default: the page is exactly as it was', async () => {
  const ctx = sandbox();
  await ctx.loadEconomics();
  const html = ctx.renderEconomics();
  assert.ok(!/>Scenario Rate<|Crew burdened \$\/M/.test(html));
  assert.match(html, />Rate scenario</, 'the toggle is offered');
});

test('the toggle adds the scenario columns and the headline, in plan order', async () => {
  const ctx = await scenarioOn();
  const html = ctx.__html();
  assert.match(html, /Scenario Rate/);
  assert.match(html, /Scenario \$\/M/);
  assert.match(html, /Scenario only — actual rates are not changed\./);
  assert.match(html, /Crew burdened \$\/M — current/);
  const order = ['Head Sawyer', 'Edgerman', 'Loader', 'Utility', 'Lead'].map(s => html.indexOf(`>${s}<`));
  assert.ok(order.every(i => i > 0), 'every seat is drawn');
  assert.deepStrictEqual([...order].sort((a, b) => a - b), order, 'seats stay in plan order');
  assert.ok(html.indexOf('>Sawmill<') < html.indexOf('>Yard<'), 'sections stay grouped in plan order');
});

test('with no edits, the scenario equals the Staffing Economics $/M exactly', async () => {
  const ctx = await scenarioOn();
  const current = ctx.econCrew();
  assert.deepStrictEqual({ ...ctx.econCrew(ctx.econScenOverrides()) }, { ...current });
  assert.deepStrictEqual({ ...ctx.econScenOverrides() }, {});
  // Ana in two seats, Zed, and Sal's imputed 50.00 — the page's own sum.
  assert.strictEqual(r2(current.totalDpm), r2(dpm(25) * 2 + dpm(32) + dpm(50)));
  const html = ctx.__html();
  const cur = /Crew burdened \$\/M — current<\/div><div class="stat-value">([^<]+)</.exec(html)[1];
  const scn = /Crew burdened \$\/M — scenario<\/div><div class="stat-value">([^<]+)</.exec(html)[1];
  assert.strictEqual(scn, cur);
  assert.match(html, new RegExp(`Burdened</div><div class="stat-value">${cur.replace('$', '\\$')}`),
    'the headline current figure is the Burdened card');
});

test('one edit moves only that person, by Δrate × (1 + burden) ÷ MBF/hr', async () => {
  const ctx = await scenarioOn();
  const before = ctx.econCrew();
  ctx.econScenSet('h2', 'econ-scn-e1', '35');
  const ov = ctx.econScenOverrides();
  assert.deepStrictEqual({ ...ov }, { h2: 35 });
  const after = ctx.econCrew(ov);
  assert.strictEqual(r2(after.totalDpm - before.totalDpm), r2(3 * 1.44 / 15));
  assert.strictEqual(r2(after.totalWage - before.totalWage), 3);
  assert.strictEqual(ctx.econWageFor('h1', ov), 25, 'Ana is untouched');
  assert.strictEqual(ctx.econWageFor('s1', ov), 50);
  const html = ctx.__html();
  assert.match(html, /class="econ-row[^"]*econ-scn-edited/);
  assert.match(html, /edited<\/span>/);
  assert.match(html, />\+\$0\.29<span/, 'the change, in $/M');
  assert.match(html, /class="stat-value econ-scn-up"/, 'a rise is coloured as a cost increase');
});

test('a person in two seats moves in both', async () => {
  const ctx = await scenarioOn();
  const before = ctx.econCrew();
  ctx.econScenSet('h1', 'econ-scn-e2', '26');
  const after = ctx.econCrew(ctx.econScenOverrides());
  assert.strictEqual(r2(after.totalWage - before.totalWage), 2);
});

test('bad rates are flagged and not applied; over 25% warns and applies', async () => {
  const ctx = await scenarioOn();
  for (const [raw, msg] of [['0', 'Must be more than zero'], ['-4', 'Must be more than zero'],
                            ['abc', 'Not a number'], ['5000', 'Too high']]) {
    ctx.econScenSet('h2', 'econ-scn-e1', raw);
    assert.deepStrictEqual({ ...ctx.econScenOverrides() }, {}, raw);
    assert.match(ctx.__html(), new RegExp(msg + '[^<]* — not applied'), raw);
  }
  ctx.econScenSet('h2', 'econ-scn-e1', '45');      // 32 -> 45 is +41%
  assert.deepStrictEqual({ ...ctx.econScenOverrides() }, { h2: 45 });
  assert.match(ctx.__html(), /over 25%/);
  ctx.econScenSet('h2', 'econ-scn-e1', '32.00');   // back to the rate on file: not an edit
  assert.deepStrictEqual({ ...ctx.econScenOverrides() }, {});
});

test('Reset clears every scenario rate', async () => {
  const ctx = await scenarioOn();
  ctx.econScenSet('h2', 'econ-scn-e1', '35');
  ctx.econScenSet('h1', 'econ-scn-e2', '30');
  ctx.econScenReset();
  assert.deepStrictEqual({ ...ctx.econScenOverrides() }, {});
  assert.deepStrictEqual({ ...ctx.econCrew(ctx.econScenOverrides()) }, { ...ctx.econCrew() });
  assert.ok(!/class="econ-row[^"]*econ-scn-edited/.test(ctx.__html()));
});

test('nothing is sent or stored, and real rates are untouched', async () => {
  const ctx = await scenarioOn();
  ctx.econScenSet('h2', 'econ-scn-e1', '35');
  ctx.econScenSet('h1', 'econ-scn-e2', '-1');
  ctx.econScenReset();
  ctx.econToggleScenario();
  assert.deepStrictEqual(ctx.__calls, [], 'the scenario made no request at all: ' + JSON.stringify(ctx.__calls));
  assert.deepStrictEqual(ctx.__stored, [], 'nothing went to localStorage');
  assert.strictEqual(ctx.state.employees.find(e => e.id === 'h2').wage, 32);
  // The scenario code path contains no fetch.
  const src = fs.readFileSync(path.join(SRC, 'economics.js'), 'utf8');
  const block = src.slice(src.indexOf('// RATE SCENARIO'), src.indexOf('async function loadEconomics'))
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  assert.ok(block.length > 200, 'the scenario block was found');
  assert.ok(!/fetch\(|localStorage/.test(block), 'the scenario block neither fetches nor stores');
});

test('no MBF/hr means $/M is unavailable, not a division by zero', async () => {
  const ctx = await scenarioOn();
  ctx.state.mhr = 0;
  ctx.econScenSet('h2', 'econ-scn-e1', '35');
  assert.match(ctx.__html(), /unavailable/);
  assert.ok(!/NaN|Infinity/.test(ctx.__html()));
});

test('the period-based Rate Scenario build stays gone', () => {
  for (const f of ['rate-scenario.js', 'rate-scenario-lib.js', 'cost-inputs-lib.js']) {
    assert.ok(!fs.existsSync(path.join(ROOT, 'netlify', 'functions', f)), f);
  }
  assert.ok(!fs.existsSync(path.join(SRC, 'rate-scenario.js')));
  assert.ok(!__SCRIPT_MODULES.includes('rate-scenario.js'));
  const costs = fs.readFileSync(path.join(SRC, 'costs.js'), 'utf8');
  assert.ok(!/key: 'scenario'/.test(costs), 'no separate Rate Scenario tab');
  const lib = fs.readFileSync(path.join(ROOT, 'netlify', 'functions', 'cost-lib.js'), 'utf8');
  assert.ok(!/rateOverrides|includePeople/.test(lib));
});
