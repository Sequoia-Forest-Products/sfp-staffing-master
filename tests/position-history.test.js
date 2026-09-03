// Run with: npm test
//
// What a person's classification USED to be.
//
// wage_history has recorded every rate change since the v2 model. Nothing has
// ever recorded a change to department, position, position_group or cost_class —
// the four fields that decide which cost centre a person's hours land in, which
// line of the Manufacturing Costs report they appear on, and whether they show
// in the Bullpen. Each change overwrote the row in place and left nothing.
//
// This file covers the recording. Two halves:
//
//   the planner   pure, decides WHAT is a change worth recording
//   the endpoint  /api/data writes the history BEFORE it updates the employee
//
// That ordering is the same one wage_history uses and it is not stylistic: a
// record with no change is a puzzle, a change with no record is unrecoverable.
// Only one of those can be repaired afterwards.
//
// Negative controls, actually run while writing this — each applied alone and
// reverted:
//
//   normalize() stops folding '' to null            -> 2 fail
//   absent fields treated as a change to null       -> 9 fail
//   one row per save instead of one per field       -> 1 fail
//   history written AFTER the employee update       -> 1 fail
//
// Restored, 14 pass.

const test = require('node:test');
const assert = require('node:assert');
const { createHmac } = require('node:crypto');

process.env.SESSION_SECRET = 'test-session-secret';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

const { planPositionHistory, touchesTrackedField, normalize, TRACKED_FIELDS } =
  require('../netlify/functions/position-history-lib');
const data = require('../netlify/functions/data');

const EMP = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const BEFORE = {
  id: EMP, name: 'Ana Reyes', employee_number: '0101',
  department: 'Production', position: 'Puller',
  position_group: 'Green Chain', cost_class: 'Manufacturing',
  wage: '22.00', pay_type: 'Hourly'
};

// ---------------------------------------------------------------------------
// the planner
// ---------------------------------------------------------------------------

test('all four fields are tracked, and nothing else is', () => {
  assert.deepStrictEqual(TRACKED_FIELDS,
    ['department', 'position', 'position_group', 'cost_class']);
});

test('a change produces one row per field, not one per save', () => {
  // A transfer that moves department and cost_class together is two facts.
  // Answering "when did he leave Production" should not mean unpacking a blob.
  const rows = planPositionHistory({
    before: BEFORE,
    body: { department: 'Maintenance', cost_class: 'Mill Overhead' },
    editorEmail: 'peter.stroble@sequoiafp.com'
  });

  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(rows.map(r => r.field).sort(), ['cost_class', 'department']);

  const dept = rows.find(r => r.field === 'department');
  assert.strictEqual(dept.previous_value, 'Production');
  assert.strictEqual(dept.new_value, 'Maintenance');
  assert.strictEqual(dept.employee_id, EMP);
  assert.strictEqual(dept.changed_by, 'peter.stroble@sequoiafp.com');
  // Denormalised so the row still says who it was about when read next to a
  // roster that has moved on.
  assert.strictEqual(dept.employee_name, 'Ana Reyes');
  assert.strictEqual(dept.employee_number, '0101');
});

test('a field absent from the body is not a change to null', () => {
  // A PATCH carrying only { phone } says nothing about anybody's department.
  // Treating absence as a clear would fabricate a transfer on every save of an
  // unrelated field.
  assert.deepStrictEqual(
    planPositionHistory({ before: BEFORE, body: { phone: '555-0100' } }), []);
  assert.strictEqual(touchesTrackedField({ phone: '555-0100' }), false);
  assert.strictEqual(touchesTrackedField({ cost_class: 'SG&A' }), true);
});

test("'' and null and whitespace are the same absence, and produce no row", () => {
  // A <select> with no selection posts ''; the database holds null. Comparing
  // them raw makes every save of an unclassified person look like a change from
  // null to '' — a history full of rows recording nothing, which is how a
  // history stops being read.
  assert.strictEqual(normalize(''), null);
  assert.strictEqual(normalize('   '), null);
  assert.strictEqual(normalize(null), null);
  assert.strictEqual(normalize(undefined), null);

  const unclassified = { ...BEFORE, position_group: null };
  assert.deepStrictEqual(
    planPositionHistory({ before: unclassified, body: { position_group: '' } }), []);
});

test('setting a value on an empty field IS a change, and reads as one', () => {
  const rows = planPositionHistory({
    before: { ...BEFORE, position_group: null },
    body: { position_group: 'Sawmill Operators' }
  });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].previous_value, null, 'null, not "" — it is preserved as an absence');
  assert.strictEqual(rows[0].new_value, 'Sawmill Operators');
});

test('clearing a value IS a change', () => {
  const rows = planPositionHistory({ before: BEFORE, body: { position_group: '' } });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].previous_value, 'Green Chain');
  assert.strictEqual(rows[0].new_value, null);
});

test('the same value retyped produces nothing', () => {
  assert.deepStrictEqual(planPositionHistory({
    before: BEFORE,
    body: { department: 'Production', position: 'Puller', cost_class: 'Manufacturing' }
  }), []);
});

test('no row and no body are answered, not thrown', () => {
  assert.deepStrictEqual(planPositionHistory({ before: null, body: { department: 'X' } }), []);
  assert.deepStrictEqual(planPositionHistory({ before: BEFORE, body: null }), []);
  assert.deepStrictEqual(planPositionHistory({}), []);
});

// ---------------------------------------------------------------------------
// the write path
// ---------------------------------------------------------------------------

function cookie(email = 'peter.stroble@sequoiafp.com') {
  const b64 = Buffer.from(JSON.stringify({ email, exp: Date.now() + 3600000 })).toString('base64url');
  const sig = createHmac('sha256', process.env.SESSION_SECRET).update(b64).digest('base64url');
  return `sfp_session=${b64}.${sig}`;
}

// Records the ORDER of every write, which is the point: history first.
function stubFetch(current = BEFORE) {
  const calls = [];
  global.fetch = async (url, opts) => {
    const u = decodeURIComponent(String(url));
    const method = (opts && opts.method) || 'GET';
    if (u.includes('user_permissions')) {
      return { ok: true, status: 200, json: async () => [], text: async () => '[]' };
    }
    calls.push({ url: u, method, body: opts && opts.body ? JSON.parse(opts.body) : null });
    if (method === 'GET' && u.includes('employees')) {
      return { ok: true, status: 200, json: async () => [current], text: async () => JSON.stringify([current]) };
    }
    return { ok: true, status: 200, json: async () => [{ id: EMP }], text: async () => '[]' };
  };
  return calls;
}

const patch = body => data.handler({
  httpMethod: 'PATCH',
  headers: { cookie: cookie() },
  queryStringParameters: { table: 'employees', id: EMP },
  body: JSON.stringify(body)
});

test('a classification change is recorded, with who made it', async () => {
  const calls = stubFetch();
  const res = await patch({ department: 'Maintenance' });
  assert.strictEqual(res.statusCode, 200);

  const history = calls.filter(c => c.url.includes('position_history'));
  assert.strictEqual(history.length, 1);
  assert.strictEqual(history[0].body.field, 'department');
  assert.strictEqual(history[0].body.previous_value, 'Production');
  assert.strictEqual(history[0].body.new_value, 'Maintenance');
  assert.strictEqual(history[0].body.changed_by, 'peter.stroble@sequoiafp.com',
    'the session email, not anything the browser sent');
});

test('the history is written BEFORE the employee row', async () => {
  // The ordering wage_history uses, for the same reason. If the history write
  // throws, data.js turns it into a 500 and the employee update never runs: a
  // record with no change is a puzzle, a change with no record cannot be
  // reconstructed.
  const calls = stubFetch();
  await patch({ department: 'Maintenance' });

  const writes = calls.filter(c => c.method !== 'GET');
  const historyAt = writes.findIndex(c => c.url.includes('position_history'));
  const employeeAt = writes.findIndex(c => c.url.includes('employees'));

  assert.ok(historyAt !== -1 && employeeAt !== -1, 'both writes happened');
  assert.ok(historyAt < employeeAt,
    'the employee row was updated before the change was recorded');
});

test('the previous value comes from the DATABASE, not from the browser', async () => {
  // A page open since this morning holds values somebody else may have changed
  // since. A history row whose previous value was never the current value is
  // worse than no history at all.
  const calls = stubFetch({ ...BEFORE, department: 'Log Yard' });
  await patch({ department: 'Maintenance' });

  const [history] = calls.filter(c => c.url.includes('position_history'));
  assert.strictEqual(history.body.previous_value, 'Log Yard');
});

test('a save that changes nothing tracked writes no history', async () => {
  const calls = stubFetch();
  await patch({ phone: '555-0199' });
  assert.strictEqual(calls.filter(c => c.url.includes('position_history')).length, 0);
});

test('a save that retypes the same department writes no history', async () => {
  const calls = stubFetch();
  await patch({ department: 'Production' });
  assert.strictEqual(calls.filter(c => c.url.includes('position_history')).length, 0);
});

test('both histories are written from one save, from one read of the row', async () => {
  // The rate and the department are two records with the same rule about
  // previous values. They share the read so they cannot see different versions
  // of the row.
  const calls = stubFetch();
  await patch({ department: 'Maintenance', wage: '25.00' });

  assert.strictEqual(calls.filter(c => c.url.includes('position_history')).length, 1);
  assert.strictEqual(calls.filter(c => c.url.includes('wage_history')).length, 1);

  const reads = calls.filter(c => c.method === 'GET' && c.url.includes('employees'));
  assert.strictEqual(reads.length, 1, 'the row was read twice — the two could disagree');
});
