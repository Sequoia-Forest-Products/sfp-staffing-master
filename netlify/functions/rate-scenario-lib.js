// Rate Scenario — what Manufacturing's fully burdened cost per MBF would be if
// some hourly people were paid a different rate. A what-if, not an editor.
//
// ONE CALCULATION PATH. Both sides of the comparison are buildCostReport from
// cost-lib.js — the function the Manufacturing Costs tab's Department & Group
// view is built from — called twice over the same inputs: once as it is, once
// with `rateOverrides`. Burden, the 1.5x/2.0x overtime pricing (pay-rules-lib's
// dayPay), salaried imputation and the MBF divisor are therefore exactly the
// ones that view uses, and "current" here is the figure that view shows.
//
// PURE. No database, no network. The endpoint reads the inputs and calls this.

const { buildCostReport, SALARY_HOURS_PER_YEAR } = require('./cost-lib');

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const round4 = (n) => Math.round((n + Number.EPSILON) * 10000) / 10000;

// The order the page groups by. Anything else (Unassigned, a department added
// later) follows alphabetically, rather than being dropped.
const DEPARTMENT_ORDER = ['Production', 'Maintenance', 'Saw Filing', 'Shipping', 'Log Yard', 'Clean-up'];

const COST_CLASS = 'Manufacturing';

function departmentRank(d) {
  const i = DEPARTMENT_ORDER.indexOf(d);
  return i < 0 ? DEPARTMENT_ORDER.length : i;
}

// Everyone whose rate the scenario may change: active, Manufacturing, hourly.
// Taken from the report's own people list so membership is cost-lib's rule.
function scenarioEligible(report) {
  return new Set((report.people || []).filter(p => !p.salaried).map(p => p.employeeNumber));
}

// The total MBF the cost-per-MBF figure divides by — the same product
// cost-lib.costPerThousand computes: MBF per labour hour x labour hours. Null
// when there is no volume, so nothing downstream divides by zero.
function volumeMbf(report) {
  const mbf = Number(report.mbfPerHour) * Number(report.totals.hours);
  return Number.isFinite(mbf) && mbf > 0 ? round4(mbf) : null;
}

function side(report) {
  const t = report.totals;
  return {
    hours: t.hours,
    cost: t.cost,
    burdenedCost: t.burdenedCost,
    otPremium: t.otPremium,
    costPerThousand: volumeMbf(report) === null ? null : t.costPerThousand
  };
}

// buildRateScenario({ employees, dailyRows, burden, mbfPerHour, allocations,
//                     standardHours, overrides })
//
// `overrides` is { employee_number: rate }. The caller validates it; this
// function still only applies a rate to an hourly Manufacturing member, because
// cost-lib's personCost ignores an override on anybody else.
function buildRateScenario({
  employees = [], dailyRows = [], burden = 0, mbfPerHour = 0, allocations = [],
  standardHours, overrides = {}
} = {}) {
  const common = {
    employees, dailyRows, costClass: COST_CLASS, burden, mbfPerHour, allocations,
    // No suppression: this view is a per-person table by design, and the floor
    // is already 1 for everybody on /api/cost-report.
    minBucketHeadcount: 1,
    standardHours,
    includePeople: true
  };
  const current = buildCostReport(common);
  const scenario = buildCostReport({ ...common, rateOverrides: overrides || {} });

  const mbf = volumeMbf(current);
  const scenByNum = new Map((scenario.people || []).map(p => [p.employeeNumber, p]));

  const people = (current.people || [])
    .filter(p => !p.salaried)
    .map(cur => {
      const scen = scenByNum.get(cur.employeeNumber) || cur;
      const changed = scen.rate !== cur.rate;
      const burdenedDelta = (cur.burdenedCost === null || scen.burdenedCost === null)
        ? null : round2(scen.burdenedCost - cur.burdenedCost);
      return {
        employeeNumber: cur.employeeNumber,
        name: cur.name,
        department: cur.department,
        hours: cur.hours,
        regularHours: cur.regularHours,
        otHours: cur.otHours,
        currentRate: cur.rate,
        scenarioRate: scen.rate,
        changed,
        rateChange: (changed && cur.rate !== null && scen.rate !== null) ? round2(scen.rate - cur.rate) : 0,
        rateChangePct: (changed && cur.rate) ? round4((scen.rate - cur.rate) / cur.rate) : (changed ? null : 0),
        currentBurdened: cur.burdenedCost,
        scenarioBurdened: scen.burdenedCost,
        burdenedDelta,
        perMbfImpact: (mbf === null || burdenedDelta === null) ? null : round4(burdenedDelta / mbf),
        gap: cur.gap
      };
    })
    .sort((a, b) => departmentRank(a.department) - departmentRank(b.department)
      || a.department.localeCompare(b.department) || a.name.localeCompare(b.name));

  // Department subtotals over the rows the page shows (hourly people).
  const deptMap = new Map();
  for (const p of people) {
    if (!deptMap.has(p.department)) {
      deptMap.set(p.department, { department: p.department, headcount: 0, changed: 0,
        hours: 0, currentBurdened: 0, scenarioBurdened: 0, burdenedDelta: 0 });
    }
    const d = deptMap.get(p.department);
    d.headcount += 1;
    if (p.changed) d.changed += 1;
    d.hours = round2(d.hours + (Number(p.hours) || 0));
    d.currentBurdened = round2(d.currentBurdened + (Number(p.currentBurdened) || 0));
    d.scenarioBurdened = round2(d.scenarioBurdened + (Number(p.scenarioBurdened) || 0));
    d.burdenedDelta = round2(d.scenarioBurdened - d.currentBurdened);
  }
  const departments = [...deptMap.values()].map(d => ({
    ...d, perMbfImpact: mbf === null ? null : round4(d.burdenedDelta / mbf)
  }));

  const cur = side(current);
  const scen = side(scenario);
  const dollars = (cur.burdenedCost === null || scen.burdenedCost === null)
    ? null : round2(scen.burdenedCost - cur.burdenedCost);
  const perMbf = (cur.costPerThousand === null || scen.costPerThousand === null)
    ? null : round2(scen.costPerThousand - cur.costPerThousand);
  const pct = (perMbf === null || !cur.costPerThousand) ? null : round4(perMbf / cur.costPerThousand);

  // Annualised by the period's share of a standard year: 2,080 hours, the same
  // divisor that imputes a salaried rate. One standard week (40 hours) x 52.
  const sh = Number(standardHours);
  const annualFactor = Number.isFinite(sh) && sh > 0 ? SALARY_HOURS_PER_YEAR / sh : null;

  return {
    costClass: COST_CLASS,
    burden: current.burden,
    mbfPerHour: current.mbfPerHour,
    standardHours: current.standardHours,
    volumeMbf: mbf,
    headcount: current.headcount,
    current: cur,
    scenario: scen,
    change: {
      burdenedCost: dollars,
      costPerThousand: perMbf,
      costPerThousandPct: pct,
      annualFactor: annualFactor === null ? null : round4(annualFactor),
      annualized: (dollars === null || annualFactor === null) ? null : round2(dollars * annualFactor)
    },
    people,
    departments,
    changedCount: people.filter(p => p.changed).length,
    rateGaps: current.rateGaps,
    noHours: current.noHours
  };
}

module.exports = { buildRateScenario, scenarioEligible, DEPARTMENT_ORDER };
