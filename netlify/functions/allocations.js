// /api/allocations — cost allocation: the departments a person's COST splits across.
//
//   GET                  every allocation, grouped by employee
//   PUT {employeeId, rows:[{department, percent}]}
//                        replace that ONE employee's whole split, atomically.
//                        An empty rows array removes the allocation, which puts
//                        them back to 100% of their primary department.
//
// WHY PUT REPLACES THE WHOLE SET FOR ONE EMPLOYEE, when /api/preapproved-ot
// deliberately does the opposite:
//
// The 100% rule is a property of the SET, not of any row in it. Editing a 50/50
// split into a 60/40 one is not two independent row edits — there is no order in
// which they are individually valid. So the unit of change is one employee's
// whole allocation, and it goes through a single Postgres function
// (set_employee_allocations) so it is one transaction with one deferred check at
// commit. PostgREST gives each HTTP request its own transaction, so assembling
// the delete and the insert here would be two transactions with a window in
// between where the split is wrong.
//
// The scope is still ONE employee. Nothing here can touch anybody else's rows,
// which is the property that mattered about not having a replace-all.

const payrollDb = require('./payroll-db');
const { verifySession, getCookies } = require('./session-lib');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Percentages are compared as integer hundredths. 33.34 + 33.33 + 33.33 in
// floating point is 100.00000000000001, and a strict !== 100 would reject the
// exact split the database stores. Integers have no such opinion.
const HUNDREDTHS = 100;
const TOTAL_HUNDREDTHS = 100 * HUNDREDTHS;
const MAX_ROWS = 12;   // the department vocabulary is twelve values

function isMissingTableError(err) {
  return /\b404\b|PGRST205|could not find the table|could not find the function|does not exist/i.test(
    String((err && err.message) || ''));
}

const MIGRATION_HINT =
  'The employee_allocations table does not exist yet — run SCHEMA_PHASE_C_ALLOCATIONS.sql. ' +
  'Until then everybody is costed 100% to their primary department, which is the correct ' +
  'answer for all but two people.';

// Validates a whole set. Returns {error} or {rows} ready for the RPC.
//
// The API checks this as well as the database because the database's message is
// a Postgres exception — accurate, and not something to put in front of somebody
// who mistyped a percentage.
function validateSet(body) {
  const employeeId = String((body && body.employeeId) || '').trim();
  if (!UUID_RE.test(employeeId)) {
    return { error: 'employeeId must be an employee UUID — an allocation belongs to a person, not a name.' };
  }

  const input = (body && body.rows);
  if (!Array.isArray(input)) return { error: 'rows must be an array' };

  // An empty set is how an allocation is REMOVED. A real operation, not an edge
  // case: it puts the person back to 100% of their primary department.
  if (input.length === 0) return { employeeId, rows: [] };

  if (input.length > MAX_ROWS) {
    return { error: `An allocation cannot name more than ${MAX_ROWS} departments.` };
  }

  const rows = [];
  const seen = new Set();
  let totalHundredths = 0;

  for (const raw of input) {
    const department = String((raw && raw.department) || '').trim();
    if (!department) return { error: 'Every allocation row needs a department.' };
    const key = department.toLowerCase();
    if (seen.has(key)) {
      return { error: `${department} appears twice. Each department can only take one share.` };
    }
    seen.add(key);

    const p = raw && raw.percent;
    if (typeof p !== 'number' && typeof p !== 'string') {
      return { error: `${department} needs a percentage.` };
    }
    const trimmed = typeof p === 'string' ? p.trim() : p;
    if (trimmed === '') return { error: `${department} needs a percentage.` };
    const percent = Number(trimmed);
    if (!Number.isFinite(percent)) return { error: `${department}'s percentage is not a number.` };
    // Zero is not a share. A department getting nothing is a department that
    // should not be in the list, and storing it would make the list lie about
    // who the cost reaches.
    if (percent <= 0) return { error: `${department} must be more than 0% — remove the row instead.` };
    if (percent > 100) return { error: `${department} cannot be more than 100%.` };

    const hundredths = Math.round(percent * HUNDREDTHS);
    totalHundredths += hundredths;
    rows.push({ department, percent: hundredths / HUNDREDTHS });
  }

  if (totalHundredths !== TOTAL_HUNDREDTHS) {
    const total = totalHundredths / HUNDREDTHS;
    const short = Math.abs(100 - total);
    return {
      error: `The shares add up to ${total}%, not 100%. ` +
        (total < 100
          ? `${short}% of this person's cost would land nowhere and every department total would be quietly short.`
          : `${short}% of this person's cost would be counted twice.`) +
        ' To remove the allocation entirely, save it with no departments.'
    };
  }

  return { employeeId, rows };
}

// Grouped by employee, with the name attached. No wage, no salary: this endpoint
// says how somebody's cost is DIVIDED, never how large it is.
async function listAllocations() {
  const [rows, employees] = await Promise.all([
    payrollDb.fetchAllocations(),
    payrollDb.fetchEmployees()
  ]);
  const byId = new Map((employees || []).map(e => [String(e.id), e]));

  const grouped = new Map();
  for (const r of (rows || [])) {
    const id = String(r.employee_id);
    const emp = byId.get(id) || null;
    const g = grouped.get(id) || {
      employeeId: id,
      name: emp ? (emp.name || '') : null,
      onRoster: !!emp,
      status: emp ? (emp.status || 'Active') : null,
      primaryDepartment: emp ? (emp.department || null) : null,
      costClass: emp ? (emp.cost_class || null) : null,
      rows: [],
      total: 0
    };
    g.rows.push({ department: r.department, percent: Number(r.percent) || 0 });
    g.total = Math.round((g.total + (Number(r.percent) || 0)) * HUNDREDTHS) / HUNDREDTHS;
    grouped.set(id, g);
  }

  for (const g of grouped.values()) {
    g.rows.sort((a, b) => b.percent - a.percent || a.department.localeCompare(b.department));
    // Surfaced rather than assumed. The trigger makes it impossible at rest, so
    // a true here means the trigger is missing — which is worth seeing on the
    // page, because every Overhead figure depends on it.
    g.sumsTo100 = Math.round(g.total * HUNDREDTHS) === TOTAL_HUNDREDTHS;
    // Whether the primary department is in the split. It does NOT have to be —
    // but it is where the rounding remainder lands, so a split that omits it is
    // worth showing plainly.
    g.includesPrimary = !!g.primaryDepartment
      && g.rows.some(r => r.department === g.primaryDepartment);
  }

  return [...grouped.values()].sort((a, b) =>
    String(a.name || '￿').localeCompare(String(b.name || '￿')));
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const fail = (statusCode, error, extra = {}) =>
    ({ statusCode, headers, body: JSON.stringify({ ok: false, error, ...extra }) });

  const session = verifySession(getCookies(event).sfp_session || '');
  if (!session) return fail(401, 'Unauthorized');

  const method = event.httpMethod;

  try {
    if (method === 'GET') {
      try {
        return {
          statusCode: 200, headers,
          body: JSON.stringify({ ok: true, allocations: await listAllocations() })
        };
      } catch (err) {
        if (!isMissingTableError(err)) throw err;
        return {
          statusCode: 200, headers,
          body: JSON.stringify({ ok: true, allocations: [], tableMissing: true, note: MIGRATION_HINT })
        };
      }
    }

    if (method === 'PUT' || method === 'POST') {
      let body;
      try { body = JSON.parse(event.body || '{}'); }
      catch { return fail(400, 'Body must be JSON'); }

      const { error, employeeId, rows } = validateSet(body);
      if (error) return fail(400, error);

      try {
        // One call, one transaction, one deferred check at commit.
        const saved = await payrollDb.request('POST', 'rpc/set_employee_allocations', {
          body: { p_employee_id: employeeId, p_rows: rows }
        });
        return {
          statusCode: 200, headers,
          body: JSON.stringify({ ok: true, employeeId, rows: saved.rows || [], removed: rows.length === 0 })
        };
      } catch (err) {
        const message = String(err.message || '');
        if (isMissingTableError(err)) return fail(409, MIGRATION_HINT);
        if (/foreign key|23503|No employee with id/i.test(message)) {
          return fail(400, 'That employee is not on the roster.');
        }
        // The trigger fired. It should be unreachable — validateSet checks the
        // same rule first — so reaching it means the two disagree, and that is
        // worth saying rather than dressing up as a generic failure.
        if (/not 100|check_violation|23514/i.test(message)) {
          return fail(409,
            'The database rejected this allocation for not summing to 100%. ' +
            'The API validated it as correct, so those two rules disagree — do not retry.',
            { databaseMessage: message });
        }
        throw err;
      }
    }

    return fail(405, 'Method not allowed');

  } catch (err) {
    console.error('allocations error:', err.message);
    return fail(500, err.message);
  }
};

exports.__test = { validateSet, MAX_ROWS };
