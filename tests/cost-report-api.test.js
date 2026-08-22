// /api/cost-report — the HTTP surface over cost-lib.js.
//
// cost-lib's own arithmetic is tested in cost-lib.test.js with no network in
// sight. What is tested here is everything the endpoint adds: the session gate,
// parameter validation, week selection, the missing-allocations-table case, and
// the one guarantee that matters most — no individual's pay reaches the wire.

const test = require('node:test');
const assert = require('node:assert');
const { createHmac } = require('crypto');

process.env.SESSION_SECRET = 'test-session-secret';
process.env.SUPABASE_URL = 'https://example.invalid';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';
process.env.PAYROLL_TIME_ZONE = 'America/Los_Angeles';

const payrollDb = require('../netlify/functions/payroll-db');
const { handler } = require('../netlify/functions/cost-report');
const { weekStartFor, weekDates } = require('../netlify/functions/ot-report-lib');

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function sessionCookie() {
  const b64 = Buffer.from(JSON.stringify({ email: 'peter.stroble@sequoiafp.com', exp: Date.now() + 3600000 }))
    .toString('base64url');
  const sig = createHmac('sha256', 'test-session-secret').update(b64).digest('base64url');
  return `sfp_session=${b64}.${sig}`;
}

function event(params = {}, { method = 'GET', cookie = sessionCookie() } = {}) {
  return { httpMethod: method, headers: cookie ? { cookie } : {}, queryStringParameters: params };
}

// Six hourly Green Chain people plus a salaried supervisor. Six is above the
// suppression threshold so the department reports money; the supervisor sits in
// a group of one, which does not.
const EMPLOYEES = [
  ...Array.from({ length: 6 }, (_, i) => ({
    id: `h${i}`, name: `Hourly ${i}`, employee_number: `010${i}`, status: 'Active',
    department: 'Production', cost_class: 'Manufacturing', pay_type: 'Hourly',
    position_group: 'Green Chain', position: 'Green Chain Puller', wage: '22.00'
  })),
  {
    id: 'sal1', name: 'Eduardo Rivera', employee_number: '0200', status: 'Active',
    department: 'Production', cost_class: 'Manufacturing', pay_type: 'Salaried',
    position_group: 'Supervisors', position: 'Production Supervisor',
    wage: 'Salary', annual_salary: 105000
  },
  {
    id: 'sga1', name: 'Axeri Ramirez', employee_number: '0300', status: 'Active',
    department: 'Accounting', cost_class: 'SG&A', pay_type: 'Hourly',
    position_group: null, position: 'Payroll Clerk', wage: '30.00'
  }
];

function dailyRowsFor(dates) {
  const rows = [];
  for (const d of dates.slice(0, 4)) {
    for (let i = 0; i < 6; i++) {
      rows.push({ work_date: d, employee_number: `010${i}`, total_hours: 10, total_earnings: 220 });
    }
  }
  return rows;
}

// Stubs payroll-db so nothing reaches the network. `overrides` replaces any of
// the four reads; the week index answers from the same rows the detail fetch
// returns, so the completeness cross-check sees a consistent database.
function stub(t, overrides = {}) {
  const real = {
    fetchDailyHours: payrollDb.fetchDailyHours,
    fetchDailyHoursIndex: payrollDb.fetchDailyHoursIndex,
    fetchEmployees: payrollDb.fetchEmployees,
    fetchAllocations: payrollDb.fetchAllocations
  };
  t.after(() => Object.assign(payrollDb, real));

  const calls = { daily: [], index: [], allocations: 0 };

  // Today's week, so the fixture is always inside the 400-day window.
  const thisWeek = weekDates(weekStartFor(new Date().toISOString().slice(0, 10)));
  const rows = dailyRowsFor(thisWeek);

  payrollDb.fetchDailyHours = async (from, to) => {
    calls.daily.push([from, to]);
    return rows.filter(r => r.work_date >= from && r.work_date <= to);
  };
  payrollDb.fetchDailyHoursIndex = async (from, to, { offset = 0, limit = 5000 } = {}) => {
    calls.index.push([from, to, offset, limit]);
    const inRange = rows.filter(r => r.work_date >= from && r.work_date <= to);
    return { rows: inRange.slice(offset, offset + limit), total: inRange.length };
  };
  payrollDb.fetchEmployees = async () => EMPLOYEES;
  payrollDb.fetchAllocations = async () => { calls.allocations += 1; return []; };

  Object.assign(payrollDb, overrides);
  return { calls, rows, thisWeek };
}

async function run(t, params = {}, overrides = {}, opts = {}) {
  const ctx = stub(t, overrides);
  const res = await handler(event(params, opts));
  return { res, body: JSON.parse(res.body), ...ctx };
}

// ---------------------------------------------------------------------------
// the gate
// ---------------------------------------------------------------------------

test('no session is 401, and nothing is read', async (t) => {
  const ctx = stub(t);
  const res = await handler(event({}, { cookie: null }));
  assert.strictEqual(res.statusCode, 401);
  assert.deepStrictEqual(ctx.calls.index, [], 'the database must not be touched before the gate');
});

test('an expired session is 401', async (t) => {
  stub(t);
  const b64 = Buffer.from(JSON.stringify({ email: 'x@y.com', exp: Date.now() - 1000 })).toString('base64url');
  const sig = createHmac('sha256', 'test-session-secret').update(b64).digest('base64url');
  const res = await handler(event({}, { cookie: `sfp_session=${b64}.${sig}` }));
  assert.strictEqual(res.statusCode, 401);
});

test('anything but GET is 405', async (t) => {
  stub(t);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    assert.strictEqual((await handler(event({}, { method }))).statusCode, 405, method);
  }
});

test('the response is never cached', async (t) => {
  const { res } = await run(t);
  assert.strictEqual(res.headers['Cache-Control'], 'no-store');
});

// ---------------------------------------------------------------------------
// parameters
// ---------------------------------------------------------------------------

test('an unknown cost class is 400 and names the valid ones', async (t) => {
  const ctx = stub(t);
  const res = await handler(event({ class: 'Overhead' }));
  assert.strictEqual(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /Manufacturing.*Mill Overhead.*SG&A/);
  assert.deepStrictEqual(ctx.calls.index, [], 'validation happens before the database');
});

test('all three real cost classes are accepted', async (t) => {
  for (const cls of ['Manufacturing', 'Mill Overhead', 'SG&A']) {
    const { res, body } = await run(t, { class: cls });
    assert.strictEqual(res.statusCode, 200, cls);
    assert.strictEqual(body.report.costClass, cls);
  }
});

test('cost class defaults to Manufacturing', async (t) => {
  const { body } = await run(t);
  assert.strictEqual(body.report.costClass, 'Manufacturing');
});

test('a non-numeric burden is 400 rather than a page of nulls', async (t) => {
  for (const bad of ['abc', '-1', '99', 'NaN', 'Infinity']) {
    const res = await handler(event({ burden: bad }));
    assert.strictEqual(res.statusCode, 400, `burden=${bad}`);
  }
});

test('burden and mbfPerHour reach the arithmetic', async (t) => {
  const { body } = await run(t, { burden: '0.44', mbfPerHour: '15' });
  assert.strictEqual(body.report.burden, 0.44);
  assert.strictEqual(body.report.mbfPerHour, 15);
  const dept = body.report.byDepartment.find(d => d.key === 'Production');
  assert.ok(dept.cost > 0);
  assert.strictEqual(dept.burdenedCost, Math.round(dept.cost * 1.44 * 100) / 100);
  assert.ok(dept.costPerThousand > 0, 'cost per MBF is computed once mbfPerHour is set');
});

test('an omitted burden is zero, not a guess', async (t) => {
  const { body } = await run(t);
  assert.strictEqual(body.report.burden, 0);
  const dept = body.report.byDepartment.find(d => d.key === 'Production');
  assert.strictEqual(dept.burdenedCost, dept.cost);
  assert.strictEqual(dept.costPerThousand, null, 'no MBF rate means no cost per MBF, not a zero');
});

test('an invalid week is 400 before the database is touched', async (t) => {
  const ctx = stub(t);
  const res = await handler(event({ week: 'last-tuesday' }));
  assert.strictEqual(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /expected YYYY-MM-DD/);
  assert.deepStrictEqual(ctx.calls.index, []);
});

test('a mid-week date is snapped to its Monday', async (t) => {
  const { body, thisWeek } = await run(t, { week: thisWeekWednesday() });
  assert.strictEqual(body.week.start, weekStartFor(thisWeekWednesday()));
  assert.strictEqual(body.week.start, thisWeek[0]);
  assert.strictEqual(body.week.dates.length, 7);
});

function thisWeekWednesday() {
  return weekDates(weekStartFor(new Date().toISOString().slice(0, 10)))[2];
}

// ---------------------------------------------------------------------------
// suppression cannot be turned off from the query string
// ---------------------------------------------------------------------------

test('minBucket can be raised but never lowered below the default', async (t) => {
  const { body: low } = await run(t, { minBucket: '1' });
  assert.strictEqual(low.report.minBucketHeadcount, 3,
    'asking for minBucket=1 must not publish a one-person bucket');

  const { body: high } = await run(t, { minBucket: '8' });
  assert.strictEqual(high.report.minBucketHeadcount, 8);
  const dept = high.report.byDepartment.find(d => d.key === 'Production');
  assert.strictEqual(dept.suppressed, true, 'seven people is below a threshold of eight');
  assert.strictEqual(dept.cost, null);
});

test('a garbage minBucket falls back to the default rather than 400ing the page', async (t) => {
  const { res, body } = await run(t, { minBucket: 'all' });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(body.report.minBucketHeadcount, 3);
});

// ---------------------------------------------------------------------------
// THE guarantee
// ---------------------------------------------------------------------------

test('no individual pay figure appears anywhere in the response', async (t) => {
  const { res } = await run(t, { burden: '0.44', mbfPerHour: '15' });
  const wire = res.body;

  // The salaried rate, the hourly rate, and the annual salary. Any of these in
  // the payload is readable by every signed-in account.
  for (const forbidden of ['105000', '50.48', '50.4807', '22.00', '"wage"', 'annual_salary']) {
    assert.ok(!wire.includes(forbidden), `the wire carries ${forbidden}: it must not`);
  }

  // And the group of one that would otherwise average out to exactly his rate.
  const supervisors = JSON.parse(wire).report.byPositionGroup.find(g => g.key === 'Supervisors');
  assert.strictEqual(supervisors.headcount, 1);
  assert.strictEqual(supervisors.suppressed, true);
  assert.strictEqual(supervisors.costPerHour, null);
  assert.ok(supervisors.suppressedReason.includes('individual rate'));
});

test('membership is cost class alone — the salaried supervisor is in, the hourly clerk is out', async (t) => {
  const { body } = await run(t);
  assert.strictEqual(body.report.headcount, 7, 'six hourly plus the salaried supervisor');
  const groups = body.report.byPositionGroup.map(g => g.key);
  assert.ok(groups.includes('Supervisors'), 'a salaried person belongs in Manufacturing');

  const { body: sga } = await run(t, { class: 'SG&A' });
  assert.strictEqual(sga.report.headcount, 1, 'the hourly clerk is SG&A, not Manufacturing');
  assert.ok(sga.report.bullpen.some(p => p.name === 'Axeri Ramirez'),
    'no position group puts her in the bullpen, with her position named');
});

// ---------------------------------------------------------------------------
// allocations, before and after the table exists
// ---------------------------------------------------------------------------

test('a missing allocations table means nobody has an allocation, and says so', async (t) => {
  const { res, body } = await run(t, {}, {
    fetchAllocations: async () => { throw new Error('{"code":"PGRST205","message":"Could not find the table \'public.employee_allocations\'"}'); }
  });
  assert.strictEqual(res.statusCode, 200, 'the report still renders before Task 5 lands');
  assert.strictEqual(body.allocations.available, false);
  assert.match(body.allocations.note, /100% to their primary department/);
});

test('an unreachable database is a 500, not a silent flattening of every split', async (t) => {
  // The failure mode this guards: allocations that quietly become "primary
  // department gets everything" produce numbers that look completely normal.
  const { res, body } = await run(t, {}, {
    fetchAllocations: async () => { throw new Error('JWT expired'); }
  });
  assert.strictEqual(res.statusCode, 500);
  assert.match(body.error, /JWT expired/);
});

test('allocations split cost across departments and leave hours with the primary', async (t) => {
  const { body } = await run(t, { class: 'SG&A' }, {
    fetchAllocations: async () => ([
      { employee_id: 'sga1', department: 'Accounting', percent: 34 },
      { employee_id: 'sga1', department: 'HR', percent: 33 },
      { employee_id: 'sga1', department: 'Corporate', percent: 33 }
    ])
  });
  assert.strictEqual(body.allocations.available, true);
  assert.strictEqual(body.allocations.count, 3);
  const depts = body.report.byDepartment.map(d => d.key).sort();
  assert.deepStrictEqual(depts, ['Accounting', 'Corporate', 'HR']);
  // One person, so every bucket is suppressed — which is exactly right, and is
  // why this asserts on the shape rather than on the dollars.
  assert.ok(body.report.byDepartment.every(d => d.suppressed));
  assert.ok(body.report.hasSuppressedBuckets);
});

// ---------------------------------------------------------------------------
// the week list and the completeness cross-check
// ---------------------------------------------------------------------------

test('availableWeeks comes back and the default week is the newest with data', async (t) => {
  const { body, thisWeek } = await run(t);
  assert.ok(body.availableWeeks.length >= 1);
  assert.strictEqual(body.availableWeeks[0].weekStart, thisWeek[0]);
  assert.strictEqual(body.week.start, thisWeek[0]);
  assert.strictEqual(body.truncated, false);
});

test('a detail fetch shorter than the index says is reported, not hidden', async (t) => {
  const { body } = await run(t, {}, {
    // The index counts 24 rows; the detail fetch returns three of them.
    fetchDailyHours: async (from, to) => {
      const week = weekDates(weekStartFor(new Date().toISOString().slice(0, 10)));
      return dailyRowsFor(week).slice(0, 3);
    }
  });
  assert.strictEqual(body.dataWindow.weekDetailTruncated, true);
  assert.strictEqual(body.truncated, true);
  assert.ok(body.dataWindow.weekRowsFetched < body.dataWindow.weekRowsExpected);
});

test('the same week window as /api/payroll-report, so the two pickers agree', async (t) => {
  const { calls, thisWeek } = await run(t);
  const [from, to] = calls.index[0];
  assert.strictEqual(to, weekDates(new Date().toISOString().slice(0, 10))[6]);
  assert.strictEqual(from, weekStartFor(from), 'the window starts on a Monday');
  assert.deepStrictEqual(calls.daily[0], [thisWeek[0], thisWeek[6]]);
});

test('a week with no data reports honestly rather than erroring', async (t) => {
  const { res, body } = await run(t, { week: '2020-01-06' });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(body.week.start, '2020-01-06');
  assert.strictEqual(body.report.headcount, 7, 'membership is the roster, not the week');

  // The six hourly people contribute nothing: no daily_hours rows, no hours, no
  // cost. The salaried supervisor contributes a standard 40-hour week and his
  // full cost, because that is what "salary / 2080 x standard hours" means and it
  // does not consult the file.
  //
  // PINNED, NOT ENDORSED: it means picking any week — one before he was hired, or
  // next week — shows his cost. Whether a salaried person should be costed into a
  // week the roster says they were not there for is a question about the roster
  // having no start date, not about this arithmetic. Flagged rather than guessed.
  assert.strictEqual(body.report.totals.hours, 40);
  assert.strictEqual(body.report.totals.cost, 2019.2);   // 105000 / 2080 * 40
  const production = body.report.byDepartment.find(d => d.key === 'Production');
  assert.strictEqual(production.headcount, 7);
  assert.strictEqual(production.hours, 40);
});

test('a rate gap is named and counted', async (t) => {
  const { body } = await run(t, {}, {
    fetchEmployees: async () => ([
      ...EMPLOYEES,
      {
        id: 'gap1', name: 'New Hire', employee_number: '0999', status: 'Active',
        department: 'Production', cost_class: 'Manufacturing', pay_type: 'Salaried',
        position_group: 'Supervisors', position: 'Shift Supervisor',
        wage: 'Salary', annual_salary: null
      }
    ])
  });
  assert.strictEqual(body.report.totals.peopleWithoutRate, 1);
  const gap = body.report.rateGaps[0];
  assert.strictEqual(gap.name, 'New Hire');
  assert.match(gap.reason, /no annual_salary/);
});

// ---------------------------------------------------------------------------
// Phase D — the suppression floor comes from the caller's tiers
// ---------------------------------------------------------------------------
//
// The 'Supervisors' position group is one person: Eduardo Rivera, salaried at
// 105,000, so that bucket's cost-per-hour IS 105000/2080 = 50.48. At the base
// tier the endpoint must withhold it. For a caller holding the salaries tier it
// must not — the same reader can open Salaries & Wages and read the figure by
// name, so a dash there protects nothing and costs the page its use.
//
// These assert against the RESPONSE BODY, not against what a page would draw.
// The gate is that the money is null in the payload.

function withPermissionRows(t, rows) {
  const real = global.fetch;
  t.after(() => { global.fetch = real; });
  global.fetch = async (url) => {
    const u = decodeURIComponent(String(url));
    if (!u.includes('user_permissions')) throw new Error('unexpected fetch: ' + u);
    const wantEmail = (/email=eq\.([^&]+)/.exec(u) || [])[1];
    const out = rows.filter(r => !wantEmail || r.email === wantEmail);
    return { ok: true, status: 200, json: async () => out, text: async () => JSON.stringify(out) };
  };
}

const supervisors = (body) =>
  body.report.byPositionGroup.find(b => b.key === 'Supervisors');

test('without the salaries tier a one-person bucket withholds its money', async (t) => {
  withPermissionRows(t, []);
  const { body } = await run(t);

  assert.strictEqual(body.disclosure.minBucketHeadcount, 3);
  assert.strictEqual(body.disclosure.suppressionLifted, false);

  const sup = supervisors(body);
  assert.ok(sup, 'the bucket is still listed — hiding it would break the reconciliation');
  assert.strictEqual(sup.suppressed, true);
  assert.strictEqual(sup.cost, null);
  assert.strictEqual(sup.costPerHour, null);
  // The figure itself is nowhere in the response, not merely null on one field.
  assert.ok(!res_body_has(body, 50.48), '50.48 must not appear anywhere');
  assert.ok(!JSON.stringify(body).includes('105000'), 'nor the salary it came from');
  // Headcount and hours survive — a page that shows neither cannot say how much
  // is being withheld.
  assert.strictEqual(sup.headcount, 1);
});

test('WITH the salaries tier the same bucket reports its real figures', async (t) => {
  withPermissionRows(t, [{ email: 'peter.stroble@sequoiafp.com', tier: 'salaries' }]);
  const { body } = await run(t);

  assert.strictEqual(body.disclosure.minBucketHeadcount, 1);
  assert.strictEqual(body.disclosure.suppressionLifted, true);

  const sup = supervisors(body);
  assert.strictEqual(sup.suppressed, false);
  assert.strictEqual(sup.costPerHour, 50.48, '105000 / 2080, the same divisor the page shows');
  assert.ok(sup.cost > 0);
});

test('the admin tier alone does not lift suppression', async (t) => {
  // Admin grants access; it does not itself read pay. Same rule as the column
  // registry and the Salaries page.
  withPermissionRows(t, [{ email: 'peter.stroble@sequoiafp.com', tier: 'admin' }]);
  const { body } = await run(t);
  assert.strictEqual(body.disclosure.suppressionLifted, false);
  assert.strictEqual(supervisors(body).cost, null);
});

test('minBucket in the query string cannot talk the floor below the tier', async (t) => {
  withPermissionRows(t, []);
  const { body } = await run(t, { minBucket: '1' });
  assert.strictEqual(body.disclosure.minBucketHeadcount, 3, 'the floor is the caller, not the URL');
  assert.strictEqual(supervisors(body).cost, null);
});

test('minBucket can still raise the threshold, for either tier', async (t) => {
  withPermissionRows(t, [{ email: 'peter.stroble@sequoiafp.com', tier: 'salaries' }]);
  const { body } = await run(t, { minBucket: '8' });
  assert.strictEqual(body.disclosure.minBucketHeadcount, 8);
  // Now even the six-person Production department is below it.
  assert.strictEqual(body.report.byDepartment.find(b => b.key === 'Production').suppressed, true);
});

test('a permissions read that fails suppresses rather than publishes', async (t) => {
  const real = global.fetch;
  t.after(() => { global.fetch = real; });
  global.fetch = async () => { throw new Error('network down'); };

  const { res, body } = await run(t);
  assert.strictEqual(res.statusCode, 200, 'the report still renders');
  assert.strictEqual(body.disclosure.suppressionLifted, false,
    'failing closed here means MORE withheld, never less');
  assert.strictEqual(supervisors(body).cost, null);
});

function res_body_has(body, n) {
  return JSON.stringify(body).includes(String(n));
}
