// Manufacturing Costs (renamed from Staffing Economics) and the Overhead tab.
//
// The thing worth testing on the client is not arithmetic — there is none here,
// every figure arrives already aggregated from /api/cost-report. What is worth
// testing is that this tab cannot render an individual's pay:
//
//   * Staffing Economics rendered every seat's holder next to their hourly rate
//     and a ceiling, which was unpublishable while every signed-in account had
//     the same access. Phase D brought it back behind the salaries tier and
//     READ-ONLY; these tests fail if its WRITE path comes back with it, because
//     that path replaced the whole table.
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

function sandbox({ costBody, tiers = ['hourly_wages'] } = {}) {
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
      if (String(url).startsWith('/api/permissions')) {
        return { ok: true, status: 200, json: async () => ({
          ok: true, email: 'me@sequoiafp.com', tiers,
          isAdmin: tiers.includes('admin'), grants: null }) };
      }
      if (String(url).startsWith('/api/cost-report')) {
        const body = costBody || {
          ok: true,
          report: reportFixture(),
          availableWeeks: [{ weekStart: '2026-08-17', weekEnd: '2026-08-23', days: 4, rows: 24, totalHours: 280, totalEarnings: 6200 }],
          week: { start: '2026-08-17', end: '2026-08-23', dates: [] },
          truncated: false,
          dataWindow: {},
          allocations: { available: false, count: 0, note: 'No allocations table yet — every person is costed 100% to their primary department.' },
          // Mirrors what the endpoint reports: the floor it actually applied.
          // The money in `report` is nulled or not by the SERVER; this only
          // says which happened.
          disclosure: { minBucketHeadcount: tiers.includes('salaries') ? 1 : 3,
                        suppressionLifted: tiers.includes('salaries'), tiers }
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

test('the Staffing Economics REPLACE-ALL stays gone, though assignment is back', () => {
  // Phase C deleted the whole module. Phase D restored the page, and then the
  // assignment dropdown — but not the thing that made the old one unsafe.
  //
  // The distinction is exact: econAssign is back and PATCHes one row through
  // /api/economics; saveEconomics is the one that wrote the whole table with
  // PUT, over the only record of a per-seat rate ceiling, and it must not
  // return. /api/data does not know the table exists any more.
  const ctx = sandbox();
  assert.strictEqual(typeof ctx.saveEconomics, 'undefined',
    'saveEconomics is back — it saved by replacing the whole table');
  assert.strictEqual(typeof ctx.econAssign, 'function', 'per-seat assignment is the replacement');
  assert.ok(__SCRIPT_MODULES.includes('economics.js'), 'the page is back in the manifest');
  assert.ok(__SCRIPT_MODULES.includes('costs.js'), 'costs.js must be in the manifest');

  // No source file reaches the table through the generic endpoint, in either
  // direction, and none uses PUT against the dedicated one.
  for (const f of fs.readdirSync(SRC)) {
    const src = fs.readFileSync(path.join(SRC, f), 'utf8');
    assert.ok(!/table=economics/.test(src), `${f} reaches economics through /api/data`);
    assert.ok(!/method:\s*'PUT'[^}]*economics|economics[^}]*method:\s*'PUT'/.test(src),
      `${f} PUTs economics`);
  }
});

test('the roster load does not fetch the staffing plan — that would 403 for most people', () => {
  // /api/economics is refused without the salaries tier, so fetching it in
  // loadData would fail on every boot for almost everybody. It is loaded on
  // first open of its own tab instead, the way the cost reports are.
  const src = fs.readFileSync(path.join(SRC, 'data.js'), 'utf8');
  assert.ok(!/api\/economics/.test(src), 'data.js must not touch the staffing plan');
  const econ = fs.readFileSync(path.join(SRC, 'economics.js'), 'utf8');
  assert.match(econ, /'\/api\/economics'/, 'its own module does the fetch');
});

test('the two gated tabs ship HIDDEN, and the ungated ones do not', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'app.html'), 'utf8');
  assert.match(html, /data-tab="costs"[^>]*>Manufacturing Costs</);
  assert.match(html, /data-tab="overhead"[^>]*>Overhead</);

  // Hidden in the markup and revealed by applyTabVisibility(), rather than the
  // other way round. A tab that appears and then vanishes has already told
  // everybody that a salaries page exists and that they are not allowed in it.
  for (const tab of ['salaries', 'economics']) {
    const m = new RegExp(`<button[^>]*data-tab="${tab}"[^>]*>`).exec(html);
    assert.ok(m, `no ${tab} tab in app.html`);
    assert.match(m[0], /\bhidden\b/, `the ${tab} tab must ship hidden`);
  }
  for (const tab of ['employees', 'costs', 'overhead', 'reports', 'settings']) {
    const m = new RegExp(`<button[^>]*data-tab="${tab}"[^>]*>`).exec(html);
    assert.ok(m && !/\bhidden\b/.test(m[0]), `${tab} is not gated and must not ship hidden`);
  }
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

test('Overhead is totals only WITHOUT the salaries tier', async () => {
  // SG&A is seven people across five departments, so at the base tier's
  // suppression floor a breakdown withholds nearly every row it draws. A table
  // of dashes is worse than no table.
  const ctx = sandbox();
  ctx.switchTab('overhead', null);
  await new Promise(r => setImmediate(r));
  const html = ctx.renderOverhead();
  assert.ok(!html.includes('By department'), 'Overhead must not draw a department table');
  assert.ok(!html.includes('By position group'), 'Overhead must not draw a position-group table');
  assert.ok(!html.includes('Bullpen'), 'a null position group is normal for non-mill staff');
  // The totals still render, and the omission is stated rather than silent.
  assert.match(html, /totals only/);
  assert.match(html, /worse than no table/);
});

test('Overhead shows the breakdown WITH the salaries tier', async () => {
  // The gate is the server's: it set the suppression floor to 1 from the
  // caller's own tiers, so the figures in this payload are real. The page is
  // only declining to draw a table it would otherwise fill with dashes.
  const ctx = sandbox({ tiers: ['hourly_wages', 'salaries'] });
  ctx.switchTab('overhead', null);
  await new Promise(r => setImmediate(r));
  const html = ctx.renderOverhead();
  assert.match(html, /By department/);
  assert.match(html, /By position group/);
  // And it says why it is visible, so nobody assumes everyone sees this.
  assert.match(html, /because you hold the salaries tier/);
});

test('the breakdown follows the SERVER, not the browser', async () => {
  // A client that thinks it holds the tier while the server disagrees must get
  // the base-tier page. The disclosure posture in the payload is what decides,
  // and it is the server's answer — this is the assertion that stops the gate
  // quietly becoming a client-side one.
  const ctx = sandbox({ tiers: ['hourly_wages', 'salaries'] });
  ctx.switchTab('overhead', null);
  await new Promise(r => setImmediate(r));
  // Same tiers in state, but the server said it suppressed.
  for (const c of ctx.OVERHEAD_CLASSES) {
    ctx.state.cost[c].disclosure = { minBucketHeadcount: 3, suppressionLifted: false, tiers: [] };
  }
  const html = ctx.renderOverhead();
  assert.ok(!html.includes('By department'),
    'the payload said suppressed, so no breakdown — whatever the browser believes');
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

// NO CLIENT-SIDE BULLPEN TEST, DELIBERATELY.
//
// One was written here and deleted before it shipped. It set
// report.bullpen = [] on an Overhead view with suppression lifted and asserted
// that nothing rendered — which asserts that an empty array renders nothing.
// It passed with the server-side guard REMOVED, which is the definition of a
// test that cannot fail for the reason it claims to check.
//
// The client is not the gate here and should not pretend to be: costBullpenBlock
// renders whatever report.bullpen contains, correctly. The rule — position group
// is mill-floor only, so its absence is a finding for Manufacturing and the right
// answer everywhere else — lives in cost-lib, and the tests that bite are
// 'office staff with no position group are NOT in the bullpen' (cost-lib) and
// 'membership is cost class alone' (cost-report-api).
//
// What made the bug visible on this side was the totals-only early return in
// costSection: it hid the bullpen on Overhead by accident, until the salaries
// tier lifted suppression and it stopped firing. That is covered by
// 'Manufacturing keeps both breakdowns and the bullpen' above.

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

// ---------------------------------------------------------------------------
// allocations on the tab
// ---------------------------------------------------------------------------

test('the People column shows allocated-in cost separately from headcount', async () => {
  const ctx = sandbox({
    costBody: {
      ok: true,
      report: reportFixture({
        byDepartment: [
          { key: 'Accounting', headcount: 3, allocatedFrom: 0, hours: 120, cost: 2400,
            burdenedCost: 3456, costPerHour: 20, burdenedCostPerHour: 28.8, costPerThousand: null,
            gaps: [], suppressed: false },
          // HR has no employees at all — a third of one person's cost lands here.
          { key: 'HR', headcount: 0, allocatedFrom: 1, hours: 0, cost: null,
            burdenedCost: null, costPerHour: null, burdenedCostPerHour: null, costPerThousand: null,
            gaps: [], suppressed: true,
            suppressedReason: 'only 1 person contributes cost to this grouping, so a figure here would be an individual rate' }
        ],
        hasSuppressedBuckets: true
      }),
      availableWeeks: [], week: { start: '2026-08-17', end: '2026-08-23' },
      truncated: false, dataWindow: {},
      allocations: { available: true, count: 3, note: null }
    }
  });
  const html = await renderedCosts(ctx);

  assert.match(html, /\+1</, 'allocated-in cost must be shown as a separate +n');
  assert.match(html, /everyone whose money is in the row/);
  assert.match(html, /and none of their time/);
  // HR shows, withheld, rather than being hidden — hiding it loses the money.
  assert.match(html, /HR/);
  assert.match(html, /withheld/);
});

test('the suppression banner no longer claims the total is never suppressed', async () => {
  // It said exactly that in the commit that ADDED totals suppression. A UI
  // sentence that contradicts the code is worse than no sentence.
  const html = await renderedCosts(sandbox());
  assert.ok(!html.includes('never suppressed'));
  const src = fs.readFileSync(path.join(SRC, 'costs.js'), 'utf8');
  assert.ok(!src.includes('never suppressed'));
});
