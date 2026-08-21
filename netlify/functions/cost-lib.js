// Cost aggregation by cost class, for the Manufacturing Costs and Overhead tabs.
//
// WHY THIS IS SERVER-SIDE, and why that is not an implementation detail:
//
// Neither tab may render an individual's compensation. There is no permissions
// system, so everything either tab shows is visible to every signed-in
// sequoiafp.com account. The way to make that true is to never send a per-person
// rate to the browser at all — if the client received rates and merely declined
// to render them, they would still sit in the payload, which is exactly the
// mistake Phase B closed for annual_salary.
//
// It is also forced. annual_salary is deliberately not in /api/data's projection,
// so the client CANNOT compute a salaried person's rate; and
// effectiveHourlyRate() lives in wage-sync.js, which the browser never loads.
// Porting either would duplicate the rule that decides who costs what, and a
// duplicated rule is the drift this project has already paid for twice.
//
// So: this module takes employees + daily hours and returns aggregates. Names
// appear in the output in exactly two places, neither of them compensation —
// the rate-gap list and the bullpen, both of which are data-quality findings
// that are useless without a name attached.

const { effectiveHourlyRate, isSalaried, SALARY_HOURS_PER_YEAR } = require('./wage-sync');

// The mill runs a Mon-Thu 4x10, so a standard week is 40 hours. Used only for
// salaried people; hourly people are costed on the hours they actually worked.
const STANDARD_WEEKLY_HOURS = 40;

const COST_CLASSES = ['Manufacturing', 'Mill Overhead', 'SG&A'];
const UNASSIGNED_DEPARTMENT = 'Unassigned';
const NO_POSITION_GROUP = 'No position group';

const textOf = (v) => String(v == null ? '' : v).trim();
const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Rounding to the cent, with the remainder landing on the primary bucket, so a
// split always sums exactly to the whole. A third of a penny disappearing daily
// becomes a visible variance over a year.
function splitToCents(total, weights, primaryIndex) {
  const cents = Math.round(num(total) * 100);
  const sum = weights.reduce((t, w) => t + num(w), 0);
  if (!weights.length) return [];
  if (sum <= 0) {
    // No usable weights: everything to the primary rather than silently vanishing.
    return weights.map((_, i) => (i === primaryIndex ? round2(cents / 100) : 0));
  }

  const raw = weights.map(w => (cents * num(w)) / sum);
  const floored = raw.map(Math.floor);
  let remainder = cents - floored.reduce((t, c) => t + c, 0);

  // Largest-remainder first, so the pennies go where the arithmetic says rather
  // than to whoever happens to be first in the list. Anything still over after
  // that lands on the primary.
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || (a.i === primaryIndex ? -1 : 1));

  const out = floored.slice();
  for (const { i } of order) {
    if (remainder <= 0) break;
    out[i] += 1;
    remainder -= 1;
  }
  if (remainder > 0) out[primaryIndex] += remainder;

  return out.map(c => round2(c / 100));
}

// Hours a person is costed on.
//
// Hourly: what they actually worked. Salaried: a standard week, because BBSI
// reports salaried people as all zeros — rate x actual hours would be zero and
// they would contribute nothing, which is the bug that left Eduardo Rivera out
// of manufacturing cost entirely.
function costedHours(employee, actualHours) {
  return isSalaried(employee) ? STANDARD_WEEKLY_HOURS : num(actualHours);
}

// One person's cost, or an explained gap. Never a substituted zero: a person
// with no usable rate is a data problem worth seeing, not somebody who is free.
function personCost(employee, actualHours) {
  const { rate, source } = effectiveHourlyRate(employee);
  const hours = costedHours(employee, actualHours);

  if (rate === null) {
    return {
      rate: null,
      source,
      hours,
      cost: null,
      gap: isSalaried(employee)
        ? 'salaried with no annual_salary on file — cost cannot be computed'
        : 'no pay rate in the daily file and none stored — cost cannot be computed'
    };
  }

  return { rate, source, hours, cost: round2(rate * hours), gap: null };
}

// Burdened cost, and cost per thousand board feet. Both are display-level
// derivations of the same number and are kept here so the two tabs cannot
// disagree about what burden means.
function burdened(cost, burden) {
  return cost === null ? null : round2(cost * (1 + num(burden)));
}

function costPerThousand(burdenedCost, hours, mbfPerHour) {
  const mbf = num(mbfPerHour) * num(hours);
  if (burdenedCost === null || mbf <= 0) return null;
  return round2(burdenedCost / mbf);
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function emptyBucket(key) {
  return {
    key,
    headcount: 0,
    hours: 0,
    cost: 0,
    burdenedCost: 0,
    // People whose cost could not be computed. Counted separately so a bucket's
    // total is never quietly short by an unknown amount.
    gaps: []
  };
}

function addTo(bucket, person, amount, burdenPct) {
  bucket.headcount += 1;
  bucket.hours = round2(bucket.hours + num(person.hours));
  if (person.cost === null) {
    bucket.gaps.push({ name: person.name, reason: person.gap });
    return;
  }
  bucket.cost = round2(bucket.cost + num(amount));
  bucket.burdenedCost = round2(bucket.burdenedCost + num(burdened(amount, burdenPct)));
}

// SMALL-BUCKET SUPPRESSION, and it is not optional politeness.
//
// "Aggregate by department and position group" protects nobody when a bucket has
// one member: that bucket's cost-per-hour IS that person's rate. Eduardo Rivera
// is the only salaried person in Manufacturing and the only member of some
// groupings, so his 105,000 / 2080 = 50.48 would have been printed on a tab
// every signed-in account can open. A two-member bucket is barely better —
// anyone who knows one figure derives the other.
//
// So a bucket below the threshold still SHOWS — headcount, hours, and that it is
// suppressed — and withholds every money figure. Hiding the bucket entirely
// would be worse: the totals would stop adding up with nothing explaining why,
// which is the class of silent shortfall this project keeps rooting out.
//
// The threshold is a parameter rather than a constant because it is a judgement
// about disclosure, not a fact. DEFAULT_MIN_BUCKET is the safe default; the
// caller can lower it deliberately.
const DEFAULT_MIN_BUCKET = 3;

function finishBucket(bucket, mbfPerHour, minBucket) {
  const suppressed = bucket.headcount > 0 && bucket.headcount < minBucket;

  const base = {
    key: bucket.key,
    headcount: bucket.headcount,
    hours: bucket.hours,
    gaps: bucket.gaps,
    suppressed
  };

  if (suppressed) {
    return {
      ...base,
      cost: null,
      burdenedCost: null,
      costPerHour: null,
      burdenedCostPerHour: null,
      costPerThousand: null,
      suppressedReason:
        `only ${bucket.headcount} ${bucket.headcount === 1 ? 'person' : 'people'} in this ` +
        `grouping, so a cost figure here would be an individual rate`
    };
  }

  return {
    ...base,
    cost: bucket.cost,
    burdenedCost: bucket.burdenedCost,
    costPerHour: bucket.hours > 0 ? round2(bucket.cost / bucket.hours) : null,
    burdenedCostPerHour: bucket.hours > 0 ? round2(bucket.burdenedCost / bucket.hours) : null,
    costPerThousand: costPerThousand(bucket.burdenedCost, bucket.hours, mbfPerHour)
  };
}

// buildCostReport({employees, dailyRows, costClass, burden, mbfPerHour, allocations})
//
//   employees   roster rows, straight from the database — cost_class, pay_type,
//               department, position_group, position, wage, annual_salary
//   dailyRows   daily_hours rows for the period, used for HOURS only. Cost is
//               recomputed from the rate rather than read from total_earnings,
//               so a salaried person's zeros in the file cannot become their cost.
//   costClass   'Manufacturing' | 'Mill Overhead' | 'SG&A'
//   allocations optional [{employee_id, department, percent}] — cost splits
//               across departments. Hours stay whole at the person level; only
//               cost splits, so a department's hours are the hours of the people
//               whose PRIMARY department it is.
//
// THE FILTER IS cost_class AND NOTHING ELSE. Not pay type, not department. That
// is the whole point of the v2 model: Eduardo Rivera is salaried and belongs in
// Manufacturing; Axeri Ramirez is hourly and does not. Any filter keyed on
// isSalaried() reproduces the bug the model was built to remove — so isSalaried
// appears in this file only to choose HOURS, never to choose membership.
function buildCostReport({
  employees = [],
  dailyRows = [],
  costClass = 'Manufacturing',
  burden = 0,
  mbfPerHour = 0,
  allocations = [],
  minBucketHeadcount = DEFAULT_MIN_BUCKET
} = {}) {
  const hoursByEmployeeNumber = new Map();
  for (const row of dailyRows) {
    const key = textOf(row && (row.employee_number != null ? row.employee_number : row.employeeNumber));
    if (!key) continue;
    hoursByEmployeeNumber.set(key, round2((hoursByEmployeeNumber.get(key) || 0) + num(row.total_hours)));
  }

  const allocByEmployee = new Map();
  for (const a of allocations || []) {
    const id = textOf(a && a.employee_id);
    if (!id) continue;
    if (!allocByEmployee.has(id)) allocByEmployee.set(id, []);
    allocByEmployee.get(id).push({ department: textOf(a.department), percent: num(a.percent) });
  }

  const members = (employees || []).filter(e =>
    textOf(e && e.status) === 'Active' &&
    textOf(e && (e.cost_class != null ? e.cost_class : e.costClass)) === costClass
  );

  const byDepartment = new Map();
  const byPositionGroup = new Map();
  const bullpen = [];
  const rateGaps = [];
  let totalHours = 0;
  let totalCost = 0;
  let totalBurdened = 0;

  for (const emp of members) {
    const name = textOf(emp.name);
    const empNum = textOf(emp.employee_number != null ? emp.employee_number : emp.empNum);
    const priced = personCost(emp, hoursByEmployeeNumber.get(empNum) || 0);
    const person = { ...priced, name };

    const primaryDept = textOf(emp.department) || UNASSIGNED_DEPARTMENT;
    const group = textOf(emp.position_group != null ? emp.position_group : emp.positionGroup);

    if (priced.gap) rateGaps.push({ name, reason: priced.gap, department: primaryDept });

    // A Manufacturing person with no position group needs somewhere visible to
    // sit. Empty today, but new hires arrive unclassified through the BBSI
    // auto-create path, so the bucket has to exist before they do.
    if (!group) {
      bullpen.push({
        name,
        department: primaryDept,
        position: textOf(emp.position),
        employeeNumber: empNum
      });
    }

    // ---- department, with allocations applied to COST only ----
    const alloc = allocByEmployee.get(textOf(emp.id)) || [];
    const targets = alloc.length ? alloc : [{ department: primaryDept, percent: 100 }];
    const primaryIndex = Math.max(0, targets.findIndex(t => t.department === primaryDept));
    const shares = priced.cost === null
      ? targets.map(() => null)
      : splitToCents(priced.cost, targets.map(t => t.percent), primaryIndex);

    targets.forEach((t, i) => {
      const dept = t.department || UNASSIGNED_DEPARTMENT;
      if (!byDepartment.has(dept)) byDepartment.set(dept, emptyBucket(dept));
      // Hours belong to the primary department only. Axeri works whole hours in
      // one place; it is her COST that splits three ways.
      const hoursForThisBucket = (i === primaryIndex) ? person.hours : 0;
      addTo(byDepartment.get(dept), { ...person, hours: hoursForThisBucket },
        shares[i] === null ? null : shares[i], burden);
    });

    // ---- position group ----
    const groupKey = group || NO_POSITION_GROUP;
    if (!byPositionGroup.has(groupKey)) byPositionGroup.set(groupKey, emptyBucket(groupKey));
    addTo(byPositionGroup.get(groupKey), person, priced.cost, burden);

    totalHours = round2(totalHours + person.hours);
    if (priced.cost !== null) {
      totalCost = round2(totalCost + priced.cost);
      totalBurdened = round2(totalBurdened + num(burdened(priced.cost, burden)));
    }
  }

  const finish = (map) => [...map.values()]
    .map(b => finishBucket(b, mbfPerHour, minBucketHeadcount))
    // Suppressed buckets sort last and among themselves by name: they have no
    // cost to rank by, and leaving them interleaved by a null would put them in
    // an arbitrary position that looks meaningful.
    .sort((a, b) =>
      (a.suppressed === b.suppressed)
        ? ((b.cost || 0) - (a.cost || 0) || a.key.localeCompare(b.key))
        : (a.suppressed ? 1 : -1));

  const departments = finish(byDepartment);
  const positionGroups = finish(byPositionGroup);

  return {
    costClass,
    burden: num(burden),
    mbfPerHour: num(mbfPerHour),
    standardWeeklyHours: STANDARD_WEEKLY_HOURS,
    headcount: members.length,
    byDepartment: departments,
    byPositionGroup: positionGroups,
    bullpen: bullpen.sort((a, b) => a.name.localeCompare(b.name)),
    // Named on purpose: "somebody has no rate" is unactionable without the name,
    // and this is the one place a name is required. It is not compensation.
    rateGaps: rateGaps.sort((a, b) => a.name.localeCompare(b.name)),
    minBucketHeadcount,
    // True when at least one bucket withheld its money, so a reader can tell
    // why the visible buckets do not sum to the total.
    hasSuppressedBuckets: departments.concat(positionGroups).some(b => b.suppressed),
    totals: {
      hours: totalHours,
      cost: totalCost,
      burdenedCost: totalBurdened,
      costPerHour: totalHours > 0 ? round2(totalCost / totalHours) : null,
      burdenedCostPerHour: totalHours > 0 ? round2(totalBurdened / totalHours) : null,
      costPerThousand: costPerThousand(totalBurdened, totalHours, mbfPerHour),
      peopleWithoutRate: rateGaps.length
    }
  };
}

module.exports = {
  buildCostReport,
  DEFAULT_MIN_BUCKET,
  personCost,
  costedHours,
  splitToCents,
  burdened,
  costPerThousand,
  STANDARD_WEEKLY_HOURS,
  SALARY_HOURS_PER_YEAR,
  COST_CLASSES,
  UNASSIGNED_DEPARTMENT,
  NO_POSITION_GROUP
};
