// /api/permissions — the grant surface.
//
// The thing worth testing here is not that an admin can grant. It is that
// somebody who is NOT an admin cannot, and that the refusal happens on the
// server rather than by the page declining to draw a button. Every write test
// below asserts that nothing reached the database, not merely that the status
// code was 403.
//
// The read path has a deliberate asymmetry: anyone may ask what THEY hold —
// they could find out by trying — but the grant list is a list of who can see
// salaries, so reading other people's requires admin.

const test = require('node:test');
const assert = require('node:assert');
const { createHmac } = require('node:crypto');

process.env.SESSION_SECRET = 'test-session-secret';
process.env.SUPABASE_URL = 'https://example.invalid';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const perms = require('../netlify/functions/permissions-lib');
const api = require('../netlify/functions/permissions');

const ADMIN = 'peter.stroble@sequoiafp.com';
const SALARIED_ONLY = 'jeffrey.cook@sequoiafp.com';
const NOBODY = 'ana.reyes@sequoiafp.com';

const GRANTS = [
  { id: 'g1', email: ADMIN, tier: 'admin', granted_by: 'migration', granted_at: 't', note: null },
  { id: 'g2', email: ADMIN, tier: 'salaries', granted_by: 'migration', granted_at: 't', note: null },
  { id: 'g3', email: SALARIED_ONLY, tier: 'salaries', granted_by: 'migration', granted_at: 't', note: null }
];

function cookie(email) {
  const b64 = Buffer.from(JSON.stringify({ email, exp: Date.now() + 3600000 })).toString('base64url');
  return `sfp_session=${b64}.${createHmac('sha256', process.env.SESSION_SECRET).update(b64).digest('base64url')}`;
}

// Answers user_permissions queries out of GRANTS, honouring the email= and
// tier= filters so a "does this row already exist" probe behaves like the real
// table. Records every call, and every WRITE separately — the write list is
// what most of these tests assert on.
function stub({ grants = GRANTS, missingTable = false, deleteError = null } = {}) {
  const calls = [];
  const writes = [];
  global.fetch = async (url, opts = {}) => {
    const u = decodeURIComponent(String(url));
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: u, method, body });
    if (method !== 'GET') writes.push({ url: u, method, body });

    if (!u.includes('user_permissions')) {
      return { ok: true, status: 200, json: async () => [], text: async () => '[]' };
    }
    if (missingTable) {
      return { ok: false, status: 404,
               text: async () => 'PGRST205 could not find the table', json: async () => ({}) };
    }
    if (method === 'DELETE') {
      if (deleteError) {
        return { ok: false, status: 400, text: async () => deleteError, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => [], text: async () => '[]' };
    }
    if (method === 'POST') {
      return { ok: true, status: 200, json: async () => [body], text: async () => JSON.stringify([body]) };
    }
    // GET, with PostgREST-style eq filters applied.
    const wantEmail = (/email=eq\.([^&]+)/.exec(u) || [])[1];
    const wantTier  = (/tier=eq\.([^&]+)/.exec(u) || [])[1];
    const rows = grants.filter(g =>
      (!wantEmail || g.email === wantEmail) && (!wantTier || g.tier === wantTier));
    return { ok: true, status: 200, json: async () => rows, text: async () => JSON.stringify(rows) };
  };
  return { calls, writes };
}

const call = (email, method, opts = {}) => api.handler({
  httpMethod: method,
  headers: { cookie: cookie(email) },
  queryStringParameters: opts.params || {},
  body: opts.body ? JSON.stringify(opts.body) : undefined
});

const json = (res) => JSON.parse(res.body);

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

test('an unauthenticated caller gets 401 and reaches no table', async () => {
  const { calls } = stub();
  const res = await api.handler({ httpMethod: 'GET', headers: {}, queryStringParameters: {} });
  assert.strictEqual(res.statusCode, 401);
  assert.deepStrictEqual(calls, []);
});

test('anyone may ask what they themselves hold', async () => {
  stub();
  const res = await call(NOBODY, 'GET');
  const b = json(res);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(b.tiers, [perms.TIER_HOURLY_WAGES]);
  assert.strictEqual(b.isAdmin, false);
});

test('a non-admin is not shown the grant list at all', async () => {
  stub();
  const b = json(await call(SALARIED_ONLY, 'GET'));
  assert.deepStrictEqual(b.tiers.sort(), ['hourly_wages', 'salaries']);
  assert.strictEqual(b.isAdmin, false);
  // null, not [] — "you may not see this" and "there are none" are different
  // answers and the page draws them differently.
  assert.strictEqual(b.grants, null);
  // And nobody else's address is anywhere in the response.
  assert.ok(!res_includes(b, ADMIN.split('@')[0]), 'no other user leaks into the payload');
});

function res_includes(body, needle) {
  return JSON.stringify(body).includes(needle);
}

test('an admin sees every grant', async () => {
  stub();
  const b = json(await call(ADMIN, 'GET'));
  assert.strictEqual(b.isAdmin, true);
  assert.strictEqual(b.grants.length, 3);
  assert.deepStrictEqual(b.grants.map(g => g.tier).sort(), ['admin', 'salaries', 'salaries']);
});

test('a missing table leaves an admin with an empty list rather than an error', async () => {
  stub({ missingTable: true });
  const res = await call(ADMIN, 'GET');
  assert.strictEqual(res.statusCode, 200);
  const b = json(res);
  // Fails closed: no table means no grants means nobody is an admin.
  assert.strictEqual(b.isAdmin, false);
  assert.deepStrictEqual(b.tiers, [perms.TIER_HOURLY_WAGES]);
});

// ---------------------------------------------------------------------------
// writing — the half that matters
// ---------------------------------------------------------------------------

test('a non-admin cannot grant, and nothing reaches the database', async () => {
  const { writes } = stub();
  const res = await call(SALARIED_ONLY, 'POST', { body: { email: NOBODY, tier: 'salaries' } });
  assert.strictEqual(res.statusCode, 403);
  assert.deepStrictEqual(writes, [], 'no write of any kind');
});

test('a non-admin cannot grant THEMSELVES admin', async () => {
  const { writes } = stub();
  const res = await call(NOBODY, 'POST', { body: { email: NOBODY, tier: 'admin' } });
  assert.strictEqual(res.statusCode, 403);
  assert.deepStrictEqual(writes, []);
});

test('a non-admin cannot revoke', async () => {
  const { writes } = stub();
  const res = await call(SALARIED_ONLY, 'DELETE', { params: { email: ADMIN, tier: 'admin' } });
  assert.strictEqual(res.statusCode, 403);
  assert.deepStrictEqual(writes, []);
});

test('an admin can grant, and the row carries who granted it', async () => {
  const { writes } = stub();
  const res = await call(ADMIN, 'POST', { body: { email: NOBODY, tier: 'salaries' } });
  assert.strictEqual(res.statusCode, 200);
  const inserts = writes.filter(w => w.method === 'POST');
  assert.strictEqual(inserts.length, 1);
  assert.strictEqual(inserts[0].body.email, NOBODY);
  assert.strictEqual(inserts[0].body.tier, 'salaries');
  assert.strictEqual(inserts[0].body.granted_by, ADMIN, 'an unattributed grant is not auditable');
});

test('the address is canonicalised before it is stored', async () => {
  const { writes } = stub();
  await call(ADMIN, 'POST', { body: { email: '  ANA.Reyes@SequoiaFP.com ', tier: 'salaries' } });
  const [insert] = writes.filter(w => w.method === 'POST');
  assert.strictEqual(insert.body.email, 'ana.reyes@sequoiafp.com',
    'a non-canonical row would violate the CHECK and would sort as a different person');
});

test('granting a tier somebody already holds is a no-op, not a duplicate', async () => {
  const { writes } = stub();
  const res = await call(ADMIN, 'POST', { body: { email: SALARIED_ONLY, tier: 'salaries' } });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(json(res).alreadyHeld, true);
  assert.deepStrictEqual(writes.filter(w => w.method === 'POST'), [], 'no second row');
});

test('the base tier cannot be granted, and the refusal says why', async () => {
  const { writes } = stub();
  const res = await call(ADMIN, 'POST', { body: { email: NOBODY, tier: 'hourly_wages' } });
  assert.strictEqual(res.statusCode, 400);
  assert.match(json(res).detail, /base tier/i);
  assert.deepStrictEqual(writes, []);
});

test('an unknown tier is refused rather than stored', async () => {
  const { writes } = stub();
  const res = await call(ADMIN, 'POST', { body: { email: NOBODY, tier: 'superuser' } });
  assert.strictEqual(res.statusCode, 400);
  assert.deepStrictEqual(writes, []);
});

test('a malformed address is refused before it reaches the CHECK constraint', async () => {
  const { writes } = stub();
  const res = await call(ADMIN, 'POST', { body: { email: 'nodomain', tier: 'salaries' } });
  assert.strictEqual(res.statusCode, 400);
  assert.match(json(res).error, /not an email address/);
  assert.deepStrictEqual(writes, []);
});

test('an admin can revoke, by email and tier rather than by row id', async () => {
  const { writes } = stub();
  const res = await call(ADMIN, 'DELETE', { params: { email: SALARIED_ONLY, tier: 'salaries' } });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(json(res).revoked, true);
  const [del] = writes.filter(w => w.method === 'DELETE');
  assert.ok(del, 'a delete was issued');
  assert.match(del.url, /id=eq\.g3/, 'resolved to the right row');
});

test('revoking something nobody holds is a no-op, not a 404', async () => {
  const { writes } = stub();
  const res = await call(ADMIN, 'DELETE', { params: { email: NOBODY, tier: 'admin' } });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(json(res).notHeld, true);
  assert.deepStrictEqual(writes.filter(w => w.method === 'DELETE'), []);
});

test("the last admin's refusal is passed through, not flattened into 'conflict'", async () => {
  // The database raises this, and its message says what to do about it.
  stub({ deleteError: JSON.stringify({
    code: 'P0001',
    message: 'Refusing to remove the last administrator.\n\nWith no admin row nobody can grant or ' +
             'revoke through the app. If this is deliberate, see SCHEMA_PHASE_D_PERMISSIONS.sql ' +
             'section 7 — grant somebody else admin first, then remove this one.' }) });
  const res = await call(ADMIN, 'DELETE', { params: { email: ADMIN, tier: 'admin' } });
  assert.strictEqual(res.statusCode, 409);
  const b = json(res);
  assert.match(b.error, /last administrator/);
  assert.match(b.error, /grant somebody else admin first/,
    'the actionable half of the message survives the trip');
  assert.ok(!b.error.includes('P0001'), 'and the postgres envelope does not');
});

test('a missing table on a write says which migration to run', async () => {
  stub({ missingTable: true });
  // No table means no grants means the caller is not an admin, so this is 403
  // before it is 503 — deny-by-default winning over a helpful message, which is
  // the correct order.
  const res = await call(ADMIN, 'POST', { body: { email: NOBODY, tier: 'salaries' } });
  assert.strictEqual(res.statusCode, 403);
});

test('PUT and PATCH are not methods on this endpoint', async () => {
  const { writes } = stub();
  for (const method of ['PUT', 'PATCH']) {
    const res = await call(ADMIN, method, { body: { email: NOBODY, tier: 'admin' } });
    assert.strictEqual(res.statusCode, 405, method);
  }
  assert.deepStrictEqual(writes, []);
});
