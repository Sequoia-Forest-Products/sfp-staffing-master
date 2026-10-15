// /api/daily-hours-edit — correcting one person's hours on one day by hand.
//
// The case it exists for: a missed clock-out arrives as 24 hours, 10 regular +
// 14 OT. What matters is that it touches exactly one existing row, keeps total
// equal to regular + OT, refuses nonsense, and leaves an audit trail.

const test = require('node:test');
const assert = require('node:assert');
const { createHmac } = require('crypto');

process.env.SESSION_SECRET = 'test-session-secret';
process.env.SUPABASE_URL = 'https://example.invalid';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const payrollDb = require('../netlify/functions/payroll-db');
const { handler, __test } = require('../netlify/functions/daily-hours-edit');
const { validateEdit } = __test;

function cookie() {
  const b64 = Buffer.from(JSON.stringify({ email: 'peter.stroble@sequoiafp.com', exp: Date.now() + 3600000 }))
    .toString('base64url');
  return `sfp_session=${b64}.${createHmac('sha256', 'test-session-secret').update(b64).digest('base64url')}`;
}

const event = (method, body, { noCookie } = {}) => ({
  httpMethod: method,
  headers: noCookie ? {} : { cookie: cookie() },
  queryStringParameters: {},
  body: body === undefined ? null : JSON.stringify(body)
});

const ROW = {
  id: 'row-1', first_name: 'Everardo', last_name: 'Gonzalez',
  regular_hours: '10.00', ot_hours: '14.00', total_hours: '24.00', flags: ['long_day']
};

function stub(t, { existing = [ROW], auditFails = false } = {}) {
  const real = payrollDb.request;
  t.after(() => { payrollDb.request = real; });
  const calls = [];
  payrollDb.request = async (method, path, opts) => {
    calls.push({ method, path, opts });
    if (method === 'GET') return { rows: existing };
    if (method === 'PATCH') return { rows: existing.length ? [{ ...existing[0], ...opts.body }] : [] };
    if (method === 'POST') {
      if (auditFails) throw new Error('POST daily_hours_edits 404: relation does not exist');
      return { rows: [] };
    }
    throw new Error('unexpected ' + method);
  };
  return calls;
}

const GOOD = { workDate: '2026-10-06', employeeNumber: '0895', regularHours: 10, otHours: 0, note: 'missed clock-out' };
const parse = res => JSON.parse(res.body);

test('no session is 401, and anything but POST is 405', async (t) => {
  const calls = stub(t);
  assert.strictEqual((await handler(event('POST', GOOD, { noCookie: true }))).statusCode, 401);
  assert.strictEqual((await handler(event('GET'))).statusCode, 405);
  assert.strictEqual(calls.length, 0);
});

test('a 24-hour day is corrected: one row patched, total = regular + OT, flagged, audited', async (t) => {
  const calls = stub(t);
  const res = await handler(event('POST', GOOD));
  assert.strictEqual(res.statusCode, 200);
  const json = parse(res);
  assert.deepStrictEqual(json.row, { workDate: '2026-10-06', employeeNumber: '0895', regularHours: 10, otHours: 0, totalHours: 10 });
  assert.deepStrictEqual(json.previous, { regularHours: 10, otHours: 14, totalHours: 24 });

  const get = calls.find(c => c.method === 'GET');
  assert.match(get.path, /work_date=eq\.2026-10-06&employee_number=eq\.0895/);

  const patch = calls.find(c => c.method === 'PATCH');
  assert.strictEqual(patch.path, 'daily_hours?id=eq.row-1', 'patched by id, so it can only touch the one row');
  assert.deepStrictEqual(patch.opts.body, { regular_hours: 10, ot_hours: 0, total_hours: 10, flags: ['long_day', 'manual_edit'] });

  const audit = calls.find(c => c.method === 'POST');
  assert.strictEqual(audit.path, 'daily_hours_edits');
  const a = audit.opts.body[0];
  assert.strictEqual(a.previous_total_hours, '24.00');
  assert.strictEqual(a.new_total_hours, 10);
  assert.strictEqual(a.edited_by, 'peter.stroble@sequoiafp.com');
  assert.strictEqual(a.note, 'missed clock-out');
  assert.strictEqual(a.employee_name, 'Everardo Gonzalez');
});

test('editing an already-edited row does not stack the flag', async (t) => {
  const calls = stub(t, { existing: [{ ...ROW, flags: ['long_day', 'manual_edit'] }] });
  await handler(event('POST', GOOD));
  assert.deepStrictEqual(calls.find(c => c.method === 'PATCH').opts.body.flags, ['long_day', 'manual_edit']);
});

test('a day the file never sent is 404, and nothing is written', async (t) => {
  const calls = stub(t, { existing: [] });
  const res = await handler(event('POST', GOOD));
  assert.strictEqual(res.statusCode, 404);
  assert.deepStrictEqual(calls.map(c => c.method), ['GET']);
});

test('a failed audit write still reports the saved hours, and says the audit failed', async (t) => {
  stub(t, { auditFails: true });
  const res = await handler(event('POST', GOOD));
  assert.strictEqual(res.statusCode, 200);
  assert.match(parse(res).auditError, /daily_hours_edits/);
});

test('validation refuses bad input before anything is read', async (t) => {
  const calls = stub(t);
  const bad = [
    [{ ...GOOD, workDate: '10/06/2026' }, /YYYY-MM-DD/],
    [{ ...GOOD, employeeNumber: '' }, /employeeNumber/],
    [{ ...GOOD, regularHours: '' }, /Regular hours is required/],
    [{ ...GOOD, otHours: 'lots' }, /OT hours must be a number/],
    [{ ...GOOD, otHours: -1 }, /cannot be negative/],
    [{ ...GOOD, regularHours: 25 }, /more than 24/],
    [{ ...GOOD, regularHours: 12, otHours: 13 }, /more than a day holds/]
  ];
  for (const [body, re] of bad) {
    const res = await handler(event('POST', body));
    assert.strictEqual(res.statusCode, 400, JSON.stringify(body));
    assert.match(parse(res).error, re);
  }
  assert.strictEqual(calls.length, 0);
});

test('hours round to the cent and the note is trimmed and capped', () => {
  const { edit } = validateEdit({ ...GOOD, regularHours: '9.999', otHours: '0.004', note: '  ' + 'x'.repeat(600) });
  assert.strictEqual(edit.regularHours, 10);
  assert.strictEqual(edit.otHours, 0);
  assert.strictEqual(edit.totalHours, 10);
  assert.strictEqual(edit.note.length, 500);
  assert.strictEqual(validateEdit({ ...GOOD, note: '   ' }).edit.note, null);
});
