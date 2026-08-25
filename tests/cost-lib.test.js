// Run with: npm test
//
// Cost aggregation for the Manufacturing Costs and Overhead tabs.
//
// The two assertions that matter most, and why:
//
//   1. MEMBERSHIP IS cost_class AND NOTHING ELSE. Eduardo Rivera is salaried and
//      belongs in Manufacturing; Axeri Ramirez is hourly and does not. Every
//      previous version of this report filtered on pay type or department, which
//      is the bug the v2 model was built to remove. isSalaried() may decide
//      HOURS here; it may never decide membership.
//
//   2. NO OUTPUT CARRIES AN INDIVIDUAL'S RATE OR COST. There is no permissions
//      system, so everything these tabs show is visible to every signed-in
//      account. A person's name appears in exactly two places — the rate-gap
//      list and the bullpen — and neither is compensation.

const test = require('node:test');
const assert = require('node:assert');

const {
  buildCostReport, personCost, costedHours, splitToCents, burdened, costPerThousand,
  STANDARD_WEEKLY_HOURS
} = require('../netlify/functions/cost-lib');

// The real roster shape, with the real figures verified against the database.
const EDUARDO = {
  id: 'e-1', name: 'Eduardo Rivera', status: 'Active', cost_class: 'Manufacturing',
  pay_type: 'Salaried', department: 'Production', position_group: 'Supervisors',
  position: 'Plant Superintendent', employee_number: '0101',
  // RETIRED FROM THE LIVE COLUMN on 2026-08-22 by
  // SCHEMA_PHASE_D_PERMISSIONS.sql §5, which nulled it on all 11 salaried
  // people. Kept HERE on purpose: the fallback that tolerates it is still in
  // all three isSalaried() implementations, a restored backup would carry it,
  // and a fixture is where a tolerated input belongs once it stops being the
  // live shape. Nothing may read it as a number; effectiveHourlyRate decides
  // salaried first.
  wage: 'Salary', annual_salary: 105000
};
const AXERI = {
  id: 'a-1', name: 'Axeri Ramirez', status: 'Active', cost_class: 'SG&A',
  pay_type: 'Hourly', department: 'Accounting', position_group: null,
  position: 'Account Manager', employee_number: '0202', wage: 25, annual_salary: null
};
const hourly = (over = {}) => Object.assign({
  id: 'h-' + (over.name || 'x'), status: 'Active', cost_class: 'Manufacturing',
  pay_type: 'Hourly', department: 'Production', position_group: 'Sawmill Operators',
  position: 'Edgerman', wage: 30, annual_salary: null
}, over);

const day = (employee_number, total_hours) => ({ employee_number, total_hours });

// ---------------------------------------------------------------------------
// Membership: cost_class, never pay type, never department
// ---------------------------------------------------------------------------

test('a salaried Manufacturing person is included', () => {
  const r = buildCostReport({ employees: [EDUARDO], costClass: 'Manufacturing' });
  assert.strictEqual(r.headcount, 1, 'Eduardo is salaried and belongs in Manufacturing');
});

test('an hourly SG&A person is excluded from Manufacturing', () => {
  const r = buildCostReport({ employees: [AXERI], costClass: 'Manufacturing' });
  assert.strictEqual(r.headcount, 0, 'Axeri is hourly and does NOT belong in Manufacturing');
});

test('membership ignores department entirely', () => {
  // Somebody in an office department but classed Manufacturing is still in.
  const odd = hourly({ name: 'Odd One', department: 'Accounting', employee_number: '0303' });
  const r = buildCostReport({ employees: [odd], costClass: 'Manufacturing' });
  assert.strictEqual(r.headcount, 1);
});

test('inactive people are excluded whatever their cost class', () => {
  const gone = hourly({ name: 'Gone', status: 'Inactive', employee_number: '0404' });
  const r = buildCostReport({ employees: [gone], costClass: 'Manufacturing' });
  assert.strictEqual(r.headcount, 0);
});

test('the three cost classes partition the roster', () => {
  const roster = [EDUARDO, AXERI,
    hourly({ name: 'Floor', employee_number: '0505' }),
    { id: 'm-1', name: 'Tony Griffith', status: 'Active', cost_class: 'Mill Overhead',
      pay_type: 'Salaried', department: 'Mill Overhead', wage: 'Salary', annual_salary: 160000 }];

  const counts = ['Manufacturing', 'Mill Overhead', 'SG&A']
    .map(cc => buildCostReport({ employees: roster, costClass: cc }).headcount);
  assert.deepStrictEqual(counts, [2, 1, 1]);
  assert.strictEqual(counts.reduce((a, b) => a + b, 0), roster.length, 'nobody is counted twice or lost');
});

// ---------------------------------------------------------------------------
// The rate, and the hours it is multiplied by
// ---------------------------------------------------------------------------

test("a salaried person's rate is annual_salary / 2080", () => {
  const p = personCost(EDUARDO, 0);
  assert.strictEqual(p.rate, 50.48, '105000 / 2080 = 50.4808, rounded to the cent');
  assert.strictEqual(p.source, 'salary/2080');
});

test('a salaried person is costed on a standard week, not on their zero hours', () => {
  // This is the bug being fixed. BBSI reports salaried people as all zeros, so
  // rate x actual hours is zero and Eduardo contributed nothing to manufacturing
  // cost at all.
  assert.strictEqual(costedHours(EDUARDO, 0), STANDARD_WEEKLY_HOURS);
  const p = personCost(EDUARDO, 0);
  assert.strictEqual(p.hours, 40);
  assert.strictEqual(p.cost, 2019.2, '50.48 x 40');
});

test('the salary sentinel in wage is never read as a number', () => {
  // employees.wage no longer holds the marker — Phase D cleared it — but
  // parseFloat of it is NaN, so this pins that a rate can never come from it if
  // one ever reappears through a restore or a hand-edit.
  const p = personCost({ ...EDUARDO, annual_salary: 105000 }, 0);
  assert.strictEqual(p.rate, 50.48);
  assert.ok(!Number.isNaN(p.cost));
});

test('an hourly person is costed on the hours they actually worked', () => {
  const p = personCost(hourly({ name: 'A', wage: 30 }), 42.5);
  assert.strictEqual(p.hours, 42.5);
  assert.strictEqual(p.cost, 1275, '30 x 42.5');
});

// ---------------------------------------------------------------------------
// Gaps are shown, never zeroed and never dropped
// ---------------------------------------------------------------------------

test('a salaried person with no annual_salary is a named gap, not a free employee', () => {
  const noSalary = { ...EDUARDO, name: 'No Salary', annual_salary: null };
  const r = buildCostReport({ employees: [noSalary], costClass: 'Manufacturing' });

  assert.strictEqual(r.headcount, 1, 'still counted in headcount');
  assert.strictEqual(r.totals.peopleWithoutRate, 1);
  assert.strictEqual(r.rateGaps[0].name, 'No Salary');
  assert.match(r.rateGaps[0].reason, /no annual_salary/);

  // A one-person cost class suppresses its own total, so the cost here reads
  // null rather than 0. What matters for THIS test is the gap, not the total:
  // asserted below at a headcount where the total is published.
  assert.strictEqual(r.totals.cost, null);
  const wide = buildCostReport({
    employees: [noSalary,
      hourly({ name: 'A', wage: 20, employee_number: '7001' }),
      hourly({ name: 'B', wage: 20, employee_number: '7002' })],
    dailyRows: [day('7001', 10), day('7002', 10)],
    costClass: 'Manufacturing'
  });
  assert.strictEqual(wide.totals.cost, 400,
    'the person with no salary contributes no cost — not a zero rate, no cost at all');
  assert.strictEqual(wide.totals.peopleWithoutRate, 1);
});

test('an hourly person with no rate anywhere is a named gap', () => {
  const noRate = hourly({ name: 'No Rate', wage: null, employee_number: '0606' });
  const r = buildCostReport({ employees: [noRate], costClass: 'Manufacturing' });
  assert.strictEqual(r.totals.peopleWithoutRate, 1);
  assert.match(r.rateGaps[0].reason, /no hourly rate on file/);
  assert.match(r.rateGaps[0].reason, /Salaries & Wages/,
    'the gap says where to fix it — there is nowhere else the rate can come from now');
});

test('a gap still contributes its HOURS, so hours and cost disagree visibly', () => {
  // Silently excluding the person would make cost-per-hour look right while
  // being wrong. Counting the hours makes the shortfall show up.
  const noRate = hourly({ name: 'No Rate', wage: null, employee_number: '0707' });
  const r = buildCostReport({
    employees: [noRate], dailyRows: [day('0707', 40)], costClass: 'Manufacturing',
    minBucketHeadcount: 1
  });
  assert.strictEqual(r.totals.hours, 40);
  assert.strictEqual(r.totals.cost, 0);
  assert.strictEqual(r.byDepartment[0].gaps.length, 1);
});

// ---------------------------------------------------------------------------
// No individual compensation in the output
// ---------------------------------------------------------------------------

test('no per-person rate or cost appears anywhere in the report', () => {
  // This failed the first time it was written, and the failure was real rather
  // than a bad assertion: with two people in two different position groups,
  // each group had ONE member, so each group's costPerHour WAS that person's
  // rate. Eduardo's 105,000/2080 = 50.48 was printed on a tab every signed-in
  // account can open. "Aggregate by group" is not a protection when the group
  // has one member.
  const r = buildCostReport({
    employees: [EDUARDO, hourly({ name: 'Floor Hand', wage: 31.5, employee_number: '0808' })],
    dailyRows: [day('0808', 40)],
    costClass: 'Manufacturing', burden: 0.44, mbfPerHour: 15
  });

  const json = JSON.stringify(r);
  for (const forbidden of ['50.48', '2019.2', '31.5', '1260']) {
    assert.ok(!json.includes(forbidden),
      `an individual figure (${forbidden}) leaked into the report`);
  }
});

test('a bucket below the threshold withholds money but still shows itself', () => {
  // Hiding the bucket would be worse than suppressing it: the totals would stop
  // adding up with nothing on screen explaining why.
  const r = buildCostReport({
    employees: [EDUARDO], costClass: 'Manufacturing', burden: 0.44, mbfPerHour: 15
  });

  const group = r.byPositionGroup[0];
  assert.strictEqual(group.key, 'Supervisors');
  assert.strictEqual(group.suppressed, true);
  assert.strictEqual(group.headcount, 1, 'headcount still shows');
  assert.strictEqual(group.hours, 40, 'and hours still show');
  assert.strictEqual(group.cost, null);
  assert.strictEqual(group.costPerHour, null);
  assert.strictEqual(group.burdenedCostPerHour, null);
  assert.strictEqual(group.costPerThousand, null);
  assert.match(group.suppressedReason, /individual rate/);
  assert.strictEqual(r.hasSuppressedBuckets, true, 'the report says so at the top level');
});

test('a bucket at the threshold reports its cost', () => {
  const three = [
    hourly({ name: 'A', wage: 20, employee_number: '4001' }),
    hourly({ name: 'B', wage: 20, employee_number: '4002' }),
    hourly({ name: 'C', wage: 20, employee_number: '4003' })
  ];
  const r = buildCostReport({
    employees: three,
    dailyRows: [day('4001', 10), day('4002', 10), day('4003', 10)],
    costClass: 'Manufacturing'
  });
  assert.strictEqual(r.byPositionGroup[0].suppressed, false);
  assert.strictEqual(r.byPositionGroup[0].cost, 600);
  assert.strictEqual(r.hasSuppressedBuckets, false);
});

test('the threshold is a parameter, so it can be lowered deliberately', () => {
  // It is a judgement about disclosure, not a fact about the data.
  const r = buildCostReport({
    employees: [EDUARDO], costClass: 'Manufacturing', minBucketHeadcount: 1
  });
  assert.strictEqual(r.byPositionGroup[0].suppressed, false);
  assert.strictEqual(r.byPositionGroup[0].cost, 2019.2);
});

test('the total survives suppressed buckets inside a class big enough to have one', () => {
  // This is the load-bearing case. Suppression is per bucket, so a class with
  // enough people publishes its total even when every bucket inside it is
  // withheld — the total is what tells a reader the withheld buckets are missing
  // from a known whole. Withholding it too would leave nothing to reconcile.
  const employees = [
    EDUARDO,
    hourly({ name: 'A', wage: 30, position_group: 'Green Chain', department: 'Production', employee_number: '5001' }),
    hourly({ name: 'B', wage: 30, position_group: 'Log Yard', department: 'Log Yard', employee_number: '5002' })
  ];
  const r = buildCostReport({
    employees,
    dailyRows: [day('5001', 10), day('5002', 10)],
    costClass: 'Manufacturing'
  });
  assert.strictEqual(r.headcount, 3);
  assert.strictEqual(r.totalsSuppressed, false);
  assert.strictEqual(r.totals.cost, round2(2019.2 + 300 + 300));
  assert.ok(r.byDepartment.every(b => b.suppressed), 'every bucket suppressed here');
  assert.strictEqual(r.hasSuppressedBuckets, true,
    'so the reader can tell why the buckets do not sum to the total');
});

test('a cost class too small to have a bucket is too small to have a total', () => {
  // The hole this closes: suppression was per bucket, and a total is not a
  // bucket, so a two-person cost class published a two-person average as a
  // "total" and passed every check. Mill Overhead is three people — deactivate
  // one and this is live. It got sharper when the Overhead tab became
  // totals-only, because then the total is the whole page.
  const r = buildCostReport({
    employees: [EDUARDO, hourly({ name: 'Solo', wage: 30, employee_number: '5001' })],
    dailyRows: [day('5001', 10)],
    costClass: 'Manufacturing'
  });
  assert.strictEqual(r.headcount, 2);
  assert.strictEqual(r.totalsSuppressed, true);
  assert.strictEqual(r.totals.suppressed, true);
  assert.match(r.totals.suppressedReason, /only 2 people in this cost class/);

  // Every money figure withheld...
  for (const key of ['cost', 'burdenedCost', 'costPerHour', 'burdenedCostPerHour', 'costPerThousand']) {
    assert.strictEqual(r.totals[key], null, `totals.${key} must be withheld`);
  }
  // ...and everything that is not compensation kept, so the page can still say
  // how much is being withheld and from how many people.
  assert.strictEqual(r.totals.hours, 50);
  assert.strictEqual(r.totals.peopleWithoutRate, 0);

  // The individual figures must not be reachable by arithmetic either.
  const wire = JSON.stringify(r);
  for (const forbidden of ['2019.2', '50.48', '300']) {
    assert.ok(!wire.includes(forbidden), `a two-person class leaked ${forbidden}`);
  }
});

test('a large class total is published, and that is the whole point of the threshold', () => {
  const employees = Array.from({ length: 8 }, (_, i) =>
    hourly({ name: `P${i}`, wage: 25, position_group: 'Green Chain',
             department: 'Production', employee_number: `52${i}0` }));
  const r = buildCostReport({
    employees,
    dailyRows: employees.map((_, i) => day(`52${i}0`, 10)),
    costClass: 'Manufacturing'
  });
  assert.strictEqual(r.totalsSuppressed, false);
  assert.strictEqual(r.totals.cost, 2000);
  assert.strictEqual(r.hasSuppressedBuckets, false);
});

test('suppressed buckets sort last rather than at an arbitrary null position', () => {
  const employees = [
    hourly({ name: 'A', wage: 20, position_group: 'Green Chain', employee_number: '6001' }),
    hourly({ name: 'B', wage: 20, position_group: 'Green Chain', employee_number: '6002' }),
    hourly({ name: 'C', wage: 20, position_group: 'Green Chain', employee_number: '6003' }),
    hourly({ name: 'D', wage: 20, position_group: 'Saw Filing', employee_number: '6004' })
  ];
  const r = buildCostReport({
    employees,
    dailyRows: employees.map((e, i) => day(String(6001 + i), 10)),
    costClass: 'Manufacturing'
  });
  assert.strictEqual(r.byPositionGroup[0].key, 'Green Chain');
  assert.strictEqual(r.byPositionGroup[0].suppressed, false);
  assert.strictEqual(r.byPositionGroup[1].suppressed, true);
});

test('names appear only in the rate-gap list and the bullpen', () => {
  const r = buildCostReport({
    employees: [
      hourly({ name: 'Priced Person', wage: 30, employee_number: '0909' }),
      hourly({ name: 'Gap Person', wage: null, employee_number: '1010' }),
      hourly({ name: 'Bullpen Person', position_group: null, employee_number: '1111' })
    ],
    costClass: 'Manufacturing'
  });

  assert.ok(!JSON.stringify(r.byDepartment).includes('Priced Person'),
    'a fully priced person must not be named');
  assert.ok(r.rateGaps.some(g => g.name === 'Gap Person'));
  assert.ok(r.bullpen.some(b => b.name === 'Bullpen Person'));
});

// ---------------------------------------------------------------------------
// The bullpen
// ---------------------------------------------------------------------------

test('Manufacturing with no position group lands in the bullpen', () => {
  const r = buildCostReport({
    employees: [hourly({ name: 'New Hire', position_group: null, employee_number: '1212' })],
    costClass: 'Manufacturing'
  });
  assert.strictEqual(r.bullpen.length, 1);
  assert.strictEqual(r.bullpen[0].name, 'New Hire');
  // And their cost still counts — the bullpen is a visibility bucket, not an
  // exclusion.
  assert.strictEqual(r.byPositionGroup[0].key, 'No position group');
});

test('the bullpen is empty but present when everyone is classified', () => {
  const r = buildCostReport({ employees: [EDUARDO], costClass: 'Manufacturing' });
  assert.deepStrictEqual(r.bullpen, []);
});

// ---------------------------------------------------------------------------
// Allocations: cost splits, hours do not
// ---------------------------------------------------------------------------

test('an allocated person splits cost across departments and keeps hours whole', () => {
  // Axeri: 1/3 HR, 1/3 Corporate, 1/3 Accounting. Primary is Accounting.
  const r = buildCostReport({
    employees: [AXERI],
    dailyRows: [day('0202', 30)],
    costClass: 'SG&A', minBucketHeadcount: 1,
    allocations: [
      { employee_id: 'a-1', department: 'HR', percent: 33.34 },
      { employee_id: 'a-1', department: 'Corporate', percent: 33.33 },
      { employee_id: 'a-1', department: 'Accounting', percent: 33.33 }
    ]
  });

  const cost = 25 * 30;                       // 750
  const total = r.byDepartment.reduce((t, d) => t + d.cost, 0);
  assert.strictEqual(round2(total), cost, 'department costs must sum exactly to the person cost');

  const hours = r.byDepartment.reduce((t, d) => t + d.hours, 0);
  assert.strictEqual(hours, 30, 'hours stay whole — they do not split');
  const accounting = r.byDepartment.find(d => d.key === 'Accounting');
  assert.strictEqual(accounting.hours, 30, 'and they sit with the primary department');
});

test('a person with no allocation is 100% to their primary department', () => {
  const r = buildCostReport({
    employees: [hourly({ name: 'Plain', wage: 20, employee_number: '1313' })],
    dailyRows: [day('1313', 10)],
    costClass: 'Manufacturing', minBucketHeadcount: 1
  });
  assert.strictEqual(r.byDepartment.length, 1);
  assert.strictEqual(r.byDepartment[0].key, 'Production');
  assert.strictEqual(r.byDepartment[0].cost, 200);
});

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// ---------------------------------------------------------------------------
// splitToCents — the rounding rule
// ---------------------------------------------------------------------------

test('a three-way split sums exactly, with the remainder on the primary', () => {
  // 100.00 in thirds is 33.333... — the classic case where a third of a penny
  // goes missing and becomes a visible variance over a year.
  const parts = splitToCents(100, [1, 1, 1], 0);
  assert.strictEqual(parts.reduce((a, b) => a + b, 0), 100);
  assert.strictEqual(parts.length, 3);
});

test('the remainder lands on the primary, not on whoever is first', () => {
  const parts = splitToCents(10, [1, 1, 1], 2);
  assert.strictEqual(round2(parts.reduce((a, b) => a + b, 0)), 10);
  assert.ok(parts[2] >= parts[0], 'the primary should not be shortchanged');
});

test('a 50/50 split of an odd number of cents still sums exactly', () => {
  const parts = splitToCents(0.01, [50, 50], 0);
  assert.strictEqual(round2(parts[0] + parts[1]), 0.01);
});

test('weights that do not sum to 100 still preserve the total', () => {
  // The UI enforces 100%, but the aggregator must not lose money if a bad row
  // ever reaches it — losing 10% of a person's cost silently is the failure.
  const parts = splitToCents(90, [30, 30, 30], 0);
  assert.strictEqual(round2(parts.reduce((a, b) => a + b, 0)), 90);
});

test('zero weights put everything on the primary rather than vanishing', () => {
  const parts = splitToCents(75, [0, 0], 1);
  assert.strictEqual(round2(parts.reduce((a, b) => a + b, 0)), 75);
  assert.strictEqual(parts[1], 75);
});

// ---------------------------------------------------------------------------
// Burden and cost per thousand
// ---------------------------------------------------------------------------

test('burden is applied on top of raw cost', () => {
  assert.strictEqual(burdened(100, 0.44), 144);
  assert.strictEqual(burdened(null, 0.44), null, 'a gap stays a gap');
});

test('cost per thousand divides burdened cost by board feet produced', () => {
  // 15 MBF/hr x 40 hours = 600 MBF; 1440 burdened / 600 = 2.40
  assert.strictEqual(costPerThousand(1440, 40, 15), 2.4);
});

test('cost per thousand is null rather than infinite when nothing was produced', () => {
  assert.strictEqual(costPerThousand(1000, 0, 15), null);
  assert.strictEqual(costPerThousand(1000, 40, 0), null);
});

// ---------------------------------------------------------------------------
// The real shape, end to end
// ---------------------------------------------------------------------------

test('a mixed Manufacturing roster aggregates by department and position group', () => {
  const employees = [
    EDUARDO,
    hourly({ name: 'Saw A', wage: 30, department: 'Production', position_group: 'Sawmill Operators', employee_number: '2001' }),
    hourly({ name: 'Saw B', wage: 28, department: 'Production', position_group: 'Sawmill Operators', employee_number: '2002' }),
    hourly({ name: 'Chain A', wage: 22, department: 'Clean-up', position_group: 'Green Chain', employee_number: '2003' })
  ];
  const dailyRows = [day('2001', 40), day('2002', 40), day('2003', 20)];

  // minBucketHeadcount: 1 deliberately — this test is about the ARITHMETIC
  // summing correctly through the buckets. Suppression is asserted separately;
  // leaving it on here would compare nulls and prove nothing about the maths.
  const r = buildCostReport({
    employees, dailyRows, costClass: 'Manufacturing',
    burden: 0.44, mbfPerHour: 15, minBucketHeadcount: 1
  });

  assert.strictEqual(r.headcount, 4);
  // 40 (Eduardo, standard) + 40 + 40 + 20
  assert.strictEqual(r.totals.hours, 140);
  // 2019.20 + 1200 + 1120 + 440
  assert.strictEqual(r.totals.cost, 4779.2);
  assert.strictEqual(r.totals.burdenedCost, round2(4779.2 * 1.44));

  const depts = r.byDepartment.map(d => d.key).sort();
  assert.deepStrictEqual(depts, ['Clean-up', 'Production']);
  const groups = r.byPositionGroup.map(g => g.key).sort();
  assert.deepStrictEqual(groups, ['Green Chain', 'Sawmill Operators', 'Supervisors']);

  // Department costs must sum to the total — no leakage through the buckets.
  assert.strictEqual(round2(r.byDepartment.reduce((t, d) => t + d.cost, 0)), r.totals.cost);
  assert.strictEqual(round2(r.byPositionGroup.reduce((t, g) => t + g.cost, 0)), r.totals.cost);
});

test('hours with no matching employee_number are ignored rather than guessed at', () => {
  const r = buildCostReport({
    employees: [hourly({ name: 'A', wage: 10, employee_number: '3001' })],
    dailyRows: [day('3001', 10), day('9999', 40)],
    costClass: 'Manufacturing', minBucketHeadcount: 1
  });
  assert.strictEqual(r.totals.hours, 10, "a stranger's hours must not join this cost class");
});
