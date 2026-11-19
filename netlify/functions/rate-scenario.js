// GET /api/rate-scenario — Manufacturing's fully burdened cost per MBF, as it is
// and as it would be with some hourly people at a different rate.
//
//   ?week= / ?from=&to=   the period, exactly as /api/cost-report takes it
//   ?burden=0.44          burden, as a decimal — same parameter, same bounds
//   ?mbfPerHour=15        MBF per labour hour — same parameter, same bounds
//   ?overrides={"0101":24.5,...}   employee number -> scenario hourly rate
//
// A WHAT-IF. THIS ENDPOINT WRITES NOTHING. It is GET-only, it imports no write
// function, and the scenario rates exist only in the request that carries them:
// they are not stored here, not stored by the page, and never reach the roster,
// wage history, /api/cost-report or any export. Reload the page and they are
// gone. tests/rate-scenario.test.js asserts the no-write property directly.
//
// Same inputs as /api/cost-report (cost-inputs-lib.loadCostInputs) and the
// same calculation (cost-lib.buildCostReport, called twice) — see
// rate-scenario-lib.js.

const { verifySession, getCookies } = require('./session-lib');
const { parseCostParams, loadCostInputs } = require('./cost-inputs-lib');
const { buildRateScenario, scenarioEligible } = require('./rate-scenario-lib');
const { buildCostReport } = require('./cost-lib');

// A scenario rate above this is refused as a typo — the same guard, for the
// same reason, as MAX_CEILING on a seat's position rate: an annual figure in an
// hourly field.
const MAX_RATE = 1000;
const MAX_OVERRIDES = 500;

// { error } or { overrides } — numbers only, positive, keyed by employee number.
function parseOverrides(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { overrides: {} };
  let obj;
  try { obj = JSON.parse(String(raw)); }
  catch { return { error: 'overrides is not valid JSON — expected {"employee number": rate}' }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { error: 'overrides must be an object of {"employee number": rate}' };
  }
  const keys = Object.keys(obj);
  if (keys.length > MAX_OVERRIDES) return { error: `Too many overrides (${keys.length})` };
  const overrides = {};
  for (const k of keys) {
    const key = String(k).trim();
    const v = obj[k];
    const n = typeof v === 'number' ? v : Number(String(v == null ? '' : v).replace(/[$,\s]/g, ''));
    if (!key) return { error: 'An override has no employee number' };
    if (!Number.isFinite(n) || n <= 0) {
      return { error: `Scenario rate for #${key} must be a positive number` };
    }
    if (n > MAX_RATE) {
      return { error: `Scenario rate for #${key} (${n}) is too high to be an hourly rate` };
    }
    overrides[key] = Math.round(n * 100) / 100;
  }
  return { overrides };
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const fail = (statusCode, error, extra = {}) =>
    ({ statusCode, headers, body: JSON.stringify({ ok: false, error, ...extra }) });

  const session = verifySession(getCookies(event).sfp_session || '');
  if (!session) return fail(401, 'Unauthorized');
  // GET only. There is nothing a scenario could legitimately write.
  if (event.httpMethod !== 'GET') return fail(405, 'Method not allowed — the rate scenario is read-only');

  const params = event.queryStringParameters || {};
  const parsed = parseCostParams(params);
  if (parsed.error) return fail(400, parsed.error);
  const ov = parseOverrides(params.overrides);
  if (ov.error) return fail(400, ov.error);

  try {
    const inputs = await loadCostInputs({ range: parsed.range, snappedWeek: parsed.snappedWeek });

    // Every override must name an active hourly Manufacturing person. A rate
    // for anybody else would be silently ignored by cost-lib, and a scenario
    // that quietly dropped an edit would report a figure the reader did not ask
    // for.
    const eligible = scenarioEligible(buildCostReport({
      employees: inputs.employees, dailyRows: [], costClass: 'Manufacturing',
      standardHours: inputs.standardHours, includePeople: true
    }));
    const unknown = Object.keys(ov.overrides).filter(k => !eligible.has(k));
    if (unknown.length) {
      return fail(400, 'Not an active hourly Manufacturing employee: #' + unknown.join(', #'), { unknown });
    }

    const scenario = buildRateScenario({
      employees: inputs.employees,
      dailyRows: inputs.dailyRows,
      burden: parsed.burden,
      mbfPerHour: parsed.mbfPerHour,
      allocations: inputs.allocations.rows,
      standardHours: inputs.standardHours,
      overrides: ov.overrides
    });

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        ok: true,
        scenario,
        availableWeeks: inputs.availableWeeks,
        week: { start: inputs.periodFrom, end: inputs.periodTo, dates: inputs.dates },
        period: {
          from: inputs.periodFrom, to: inputs.periodTo,
          isRange: !!parsed.range.from,
          days: parsed.range.days || inputs.dates.length,
          standardHours: inputs.standardHours
        },
        truncated: !!inputs.weekIndex.truncated
      })
    };
  } catch (err) {
    console.error('rate-scenario error:', err.message);
    return fail(500, err.message);
  }
};

exports.parseOverrides = parseOverrides;
