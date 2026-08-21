// Manufacturing Costs (renamed from Staffing Economics) and the Overhead tab.
//
// The thing worth testing on the client is not arithmetic — there is none here,
// every figure arrives already aggregated from /api/cost-report. What is worth
// testing is that this tab cannot render an individual's pay:
//
//   * Staffing Economics rendered every position's holder next to their hourly
//     rate and a max. There is no permissions system, so that page was readable
//     by every signed-in account. It is gone, and these tests fail if it or its
//     helpers come back.
//   * A suppressed bucket must still SHOW — headcount, hours, and a visible
//     marker — because a table whose rows do not sum to its total with nothing
//     saying why is worse than one that explains itself.
//   * The lazy load has to fire on tab open. Phase C task 3 already shipped one
//     bug of this shape: a load hook keyed on a tab name that stopped existing
//     renders a shell that never fills, which looks like an empty week.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'js');
const { __SCRIPT_MODULES } = require('../netlify/functions/session.js');

function fakeEl() {
  return {
    textContent: '', innerHTML: '', value: '', checked: false,
    style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {}, addEventListener() {},
    appendChild() {}, querySelector: () => fakeEl(), querySelectorAll: () => []
  };
}

// A cost report shaped exactly like buildCostReport's output, with one
// above-threshold bucket and one below it.
function reportFixture(overrides = {}) {
  return {
    costClass: 'Manufacturing',
    burden: 0.44,
    mbfPerHour: 15,
    standardWeeklyHours: 40,
    headcount: 7,
    byDepartment: [
      { key: 'Production', headcount: 7, hours: 280, cost: 6200, burdenedCost: 8928,
        costPerHour: 22.14, burdenedCostPerHour: 31.89, costPerThousand: 2.13,
        gaps: [], suppressed: false }
    ],
    byPositionGroup: [
      { key: 'Green Chain', headcount: 6, hours: 240, cost: 5280, burdenedCost: 7603.2,
        costPerHour: 22, burdenedCostPerHour: 31.68, costPerThousand: 2.11,
        gaps: [], suppressed: false },
      { key: 'Supervisors', headcount: 1, hours: 40, cost: null, burdenedCost: null,
        costPerHour: null, burdenedCostPerHour: null, costPerThousand: null,
        gaps: [], suppressed: true,
        suppressedReason: 'only 1 person in this grouping, so a cost figure here would be an individual rate' }
    ],
    bullpen: [],
    rateGaps: [],
    minBucketHeadcount: 3,
    hasSuppressedBuckets: true,
    totals: {
      hours: 280, cost: 8219.2, burdenedCost: 11835.65,
      costPerHour: 29.35, burdenedCostPerHour: 42.27, costPerThousand: 2.82,
      peopleWithoutRate: 0
    },
    ...overrides
  };
}

function sandbox({ costBody } = {}) {
  const calls = { fetches: [] };
  const ctx = {
    console,
    window: {},
    document: {
      getElementById: () => fakeEl(),
      querySelector: () => fakeEl(),
      querySelectorAll: () => []
    },
    setTimeout: (fn) => { void fn; return 0; },
    URLSearchParams,
    localStorage: {
      _v: {},
      getItem(k) { return Object.prototype.hasOwnProperty.call(this._v, k) ? this._v[k] : null; },
      setItem(k, v) { this._v[k] = String(v); },
      removeItem(k) { delete this._v[k]; }
    },
    fetch: async (url, opts) => {
      calls.fetches.push({ url: String(url), opts });
      if (String(url).startsWith('/api/cost-report')) {
        const body = costBody || {
          ok: true,
          report: reportFixture(),
          availableWeeks: [{ weekStart: '2026-08-17', weekEnd: '2026-08-23', days: 4, rows: 24, totalHours: 280, totalEarnings: 6200 }],
          week: { start: '2026-08-17', end: '2026-08-23', dates: [] },
          truncated: false,
          dataWindow: {},
          allocations: { available: false, count: 0, note: 'No allocations table yet — every person is costed 100% to their primary department.' }
        };
        return { ok: true, status: 200, json: async () => body };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, data: [], sent: 0, failed: 0 }) };
    }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const m of __SCRIPT_MODULES) {
    vm.runInContext(fs.readFileSync(path.join(SRC, m), 'utf8'), ctx, { filename: m });
  }
  // const declarations live in the context's global lexical scope, not on the
  // global object, so they are exposed explicitly. Function declarations already
  // are properties.
  vm.runInContext(
    'globalThis.state = state; globalThis.OVERHEAD_CLASSES = OVERHEAD_CLASSES;' +
    'globalThis.COST_CLASS_MANUFACTURING = COST_CLASS_MANUFACTURING;' +
    'globalThis.COST_CLASS_MILL_OVERHEAD = COST_CLASS_MILL_OVERHEAD;' +
    'globalThis.COST_CLASS_SGA = COST_CLASS_SGA;',
    ctx, { filename: 'expose-lexicals.js' });
  ctx.__calls = calls;
  return ctx;
}

// ---------------------------------------------------------------------------
// Staffing Economics is gone, and cannot come back by accident
// ---------------------------------------------------------------------------

test('the Staffing Economics module and its per-person wage helpers no longer exist', () => {
  const ctx = sandbox();
  for (const gone of ['renderEcon', 'econAssign', 'econUnassign', 'saveEconomics',
                      'getEmpWage', 'calcDollarPerM']) {
    assert.strictEqual(typeof ctx[gone], 'undefined',
      `${gone} is back — it rendered an individual's hourly rate on a costing page`);
  }
  assert.ok(!__SCRIPT_MODULES.includes('economics.js'), 'economics.js is still in the manifest');
  assert.ok(__SCRIPT_MODULES.includes('costs.js'), 'costs.js must be in the manifest');
});

test('the app no longer reads the economics table', () => {
  // The table itself is untouched in the database, deliberately. What must not
  // happen is the app fetching a table nothing renders.
  const src = fs.readFileSync(path.join(SRC, 'data.js'), 'utf8');
  assert.ok(!/fetch\('\/api\/data\?table=economics'\)/.test(src));
  assert.ok(!/state\.economics\s*=/.test(src));
});

test('app.html offers Manufacturing Costs and Overhead, and not Staffing Economics', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'app.html'), 'utf8');
  assert.ok(!html.includes('Staffing Economics'));
  assert.ok(!html.includes("data-tab=\"economics\""));
  assert.match(html, /data-tab="costs"[^>]*>Manufacturing Costs</);
  assert.match(html, /data-tab="overhead"[^>]*>Overhead</);
});

// ---------------------------------------------------------------------------
// The lazy load
// ---------------------------------------------------------------------------

test('opening Manufacturing Costs loads the Manufacturing cost class, once', async () => {
  const ctx = sandbox();
  ctx.switchTab('costs', null);
  await new Promise(r => setImmediate(r));

  const costCalls = ctx.__calls.fetches.filter(f => f.url.startsWith('/api/cost-report'));
  assert.strictEqual(costCalls.length, 1);
  assert.match(costCalls[0].url, /class=Manufacturing/);

  // Re-opening the tab does not re-fetch; Refresh is how a reader asks again.
  ctx.switchTab('costs', null);
  await new Promise(r => setImmediate(r));
  assert.strictEqual(ctx.__calls.fetches.filter(f => f.url.startsWith('/api/cost-report')).length, 1);
});

test('opening Overhead loads both of its cost classes', async () => {
  const ctx = sandbox();
  ctx.switchTab('overhead', null);
  await new Promise(r => setImmediate(r));

  const asked = ctx.__calls.fetches
    .filter(f => f.url.startsWith('/api/cost-report'))
    .map(f => new URLSearchParams(f.url.split('?')[1]).get('class'))
    .sort();
  assert.deepStrictEqual(Array.from(asked), ['Mill Overhead', 'SG&A']);
});

test('burden and MBF/hr go to the server, because the browser cannot apply them', async () => {
  const ctx = sandbox();
  ctx.state.burden = 0.44;
  ctx.state.mhr = 15;
  ctx.switchTab('costs', null);
  await new Promise(r => setImmediate(r));

  const url = ctx.__calls.fetches.find(f => f.url.startsWith('/api/cost-report')).url;
  const qs = new URLSearchParams(url.split('?')[1]);
  assert.strictEqual(qs.get('burden'), '0.44');
  assert.strictEqual(qs.get('mbfPerHour'), '15');
});

test('changing burden re-asks the server rather than recomputing locally', async () => {
  const ctx = sandbox();
  ctx.switchTab('costs', null);
  await new Promise(r => setImmediate(r));
  const before = ctx.__calls.fetches.filter(f => f.url.startsWith('/api/cost-report')).length;

  ctx.costSetBurden(['Manufacturing'], '60');
  await new Promise(r => setImmediate(r));

  const after = ctx.__calls.fetches.filter(f => f.url.startsWith('/api/cost-report'));
  assert.strictEqual(after.length, before + 1);
  assert.strictEqual(new URLSearchParams(after.at(-1).url.split('?')[1]).get('burden'), '0.6');
});

test('a per-class view cannot be filled from another class\'s response', async () => {
  const ctx = sandbox();
  ctx.switchTab('overhead', null);
  await new Promise(r => setImmediate(r));
  assert.ok(ctx.state.cost['Mill Overhead']);
  assert.ok(ctx.state.cost['SG&A']);
  assert.strictEqual(ctx.state.cost.Manufacturing, undefined,
    'Overhead must not populate the Manufacturing view');
});

// ---------------------------------------------------------------------------
// What renders
// ---------------------------------------------------------------------------

async function renderedCosts(ctx) {
  ctx.switchTab('costs', null);
  await new Promise(r => setImmediate(r));
  return ctx.renderCosts();
}

test('a suppressed bucket shows its headcount and hours and withholds its money', async () => {
  const html = await renderedCosts(sandbox());
  assert.match(html, /Supervisors/);
  assert.match(html, /withheld/);
  // The suppression explanation is on the page, not only in a tooltip.
  assert.match(html, /would be an individual/i);
  assert.match(html, /deliberately do not add up/);
});

test('the total is rendered even though a bucket is suppressed', async () => {
  const html = await renderedCosts(sandbox());
  assert.match(html, /Total/);
  assert.ok(html.includes('11,835.65'), 'the burdened total must be shown');
});

test('rate gaps are named and the understatement is stated', async () => {
  const ctx = sandbox({
    costBody: {
      ok: true,
      report: reportFixture({
        rateGaps: [{ name: 'New Hire', reason: 'salaried with no annual_salary on file — cost cannot be computed', department: 'Production' }],
        totals: { ...reportFixture().totals, peopleWithoutRate: 1 }
      }),
      availableWeeks: [], week: { start: '2026-08-17', end: '2026-08-23' },
      truncated: false, dataWindow: {}, allocations: { available: true, count: 0, note: null }
    }
  });
  const html = await renderedCosts(ctx);
  assert.match(html, /New Hire/);
  assert.match(html, /no usable pay rate/);
  assert.match(html, /understated/);
  assert.match(html, /nobody works for free/);
});

test('the bullpen renders when somebody has no position group', async () => {
  const ctx = sandbox({
    costBody: {
      ok: true,
      report: reportFixture({
        bullpen: [{ name: 'Unclassified Person', department: 'Production', position: 'Utility', employeeNumber: '0999' }]
      }),
      availableWeeks: [], week: { start: '2026-08-17', end: '2026-08-23' },
      truncated: false, dataWindow: {}, allocations: { available: true, count: 0, note: null }
    }
  });
  const html = await renderedCosts(ctx);
  assert.match(html, /Bullpen/);
  assert.match(html, /Unclassified Person/);
  assert.match(html, /Utility/);
});

test('a truncated read says so rather than presenting a short answer as whole', async () => {
  const ctx = sandbox({
    costBody: {
      ok: true, report: reportFixture(), availableWeeks: [],
      week: { start: '2026-08-17', end: '2026-08-23' },
      truncated: true,
      dataWindow: { weekDetailTruncated: true, weekRowsFetched: 3, weekRowsExpected: 24 },
      allocations: { available: true, count: 0, note: null }
    }
  });
  const html = await renderedCosts(ctx);
  assert.match(html, /may be incomplete/);
  assert.match(html, /3 of 24 rows/);
});

test('a missing allocations table is stated on the page', async () => {
  const html = await renderedCosts(sandbox());
  assert.match(html, /100% to their primary department/);
});

test('the membership rule is stated on the page, because it is the surprising part', async () => {
  const html = await renderedCosts(sandbox());
  // A salaried supervisor belongs here and an hourly clerk does not. Somebody
  // reading a headcount of 57 needs to know why it is not 56.
  assert.match(html, /cost class alone/);
  assert.match(html, /not pay type/);
});

test('Overhead renders both sections and no cost per MBF', async () => {
  const ctx = sandbox();
  ctx.switchTab('overhead', null);
  await new Promise(r => setImmediate(r));
  const html = ctx.renderOverhead();
  assert.match(html, /Mill Overhead/);
  assert.match(html, /SG&A/);
  assert.ok(!/MBF\/hr/.test(html), 'the MBF control does not belong on an overhead page');
  assert.match(html, /not production cost/);
});

test('Overhead is totals only — no department or position-group breakdown', async () => {
  // SG&A is seven people across five departments, so a breakdown would withhold
  // nearly every row it drew. A table of dashes is worse than no table; the
  // breakdown returns in Phase D behind permissions.
  const ctx = sandbox();
  ctx.switchTab('overhead', null);
  await new Promise(r => setImmediate(r));
  const html = ctx.renderOverhead();
  assert.ok(!html.includes('By department'), 'Overhead must not draw a department table');
  assert.ok(!html.includes('By position group'), 'Overhead must not draw a position-group table');
  assert.ok(!html.includes('Bullpen'), 'a null position group is normal for non-mill staff');
  // The totals still render, and the omission is stated rather than silent.
  assert.match(html, /totals only/);
  assert.match(html, /returns in Phase D/);
});

test('Manufacturing keeps both breakdowns and the bullpen', async () => {
  // The same section renderer serves both tabs, so this is the guard that
  // totalsOnly did not leak across.
  const ctx = sandbox({
    costBody: {
      ok: true,
      report: reportFixture({
        bullpen: [{ name: 'Unclassified', department: 'Production', position: 'Utility', employeeNumber: '0999' }]
      }),
      availableWeeks: [], week: { start: '2026-08-17', end: '2026-08-23' },
      truncated: false, dataWindow: {}, allocations: { available: true, count: 0, note: null }
    }
  });
  const html = await renderedCosts(ctx);
  assert.match(html, /By department/);
  assert.match(html, /By position group/);
  assert.match(html, /Bullpen/);
});

test('a cost class too small for a total says so instead of showing dashes', async () => {
  const ctx = sandbox({
    costBody: {
      ok: true,
      report: reportFixture({
        headcount: 2,
        byDepartment: [], byPositionGroup: [], bullpen: [], rateGaps: [],
        totalsSuppressed: true,
        hasSuppressedBuckets: true,
        totals: {
          hours: 80, cost: null, burdenedCost: null, costPerHour: null,
          burdenedCostPerHour: null, costPerThousand: null, peopleWithoutRate: 0,
          suppressed: true,
          suppressedReason: 'only 2 people in this cost class, so a total here would be an individual figure'
        }
      }),
      availableWeeks: [], week: { start: '2026-08-17', end: '2026-08-23' },
      truncated: false, dataWindow: {}, allocations: { available: true, count: 0, note: null }
    }
  });
  const html = await renderedCosts(ctx);
  assert.match(html, /No cost figures for this class/);
  assert.match(html, /only 2 people in this cost class/);
  // Headcount and hours survive, so the page can say how much is withheld.
  assert.match(html, /80\.00/);
});


test('SG&A survives being put in an HTML attribute', async () => {
  const ctx = sandbox();
  ctx.switchTab('overhead', null);
  await new Promise(r => setImmediate(r));
  const html = ctx.renderOverhead();
  // The ampersand has to be an entity inside onchange="...", or the browser is
  // left deciding whether &A begins one. This project has been bitten by an
  // unescaped ampersand in a dropdown value already.
  assert.match(html, /costRefresh\(\[&quot;Mill Overhead&quot;,&quot;SG&amp;A&quot;\]\)/);
});

// ---------------------------------------------------------------------------
// Nothing the tab renders is an individual's pay
// ---------------------------------------------------------------------------

test('no per-person cost figure appears in the rendered page', async () => {
  const ctx = sandbox({
    costBody: {
      ok: true,
      report: reportFixture({
        // The real shape of the leak that was found: one salaried supervisor in a
        // group of his own, whose group cost per hour IS his rate.
        byPositionGroup: [
          { key: 'Supervisors', headcount: 1, hours: 40, cost: null, burdenedCost: null,
            costPerHour: null, burdenedCostPerHour: null, costPerThousand: null,
            gaps: [], suppressed: true, suppressedReason: 'only 1 person in this grouping, so a cost figure here would be an individual rate' }
        ]
      }),
      availableWeeks: [], week: { start: '2026-08-17', end: '2026-08-23' },
      truncated: false, dataWindow: {}, allocations: { available: true, count: 0, note: null }
    }
  });
  const html = await renderedCosts(ctx);
  for (const forbidden of ['50.48', '105,000', '105000', '2,019.20']) {
    assert.ok(!html.includes(forbidden), `the page renders ${forbidden}`);
  }
});
