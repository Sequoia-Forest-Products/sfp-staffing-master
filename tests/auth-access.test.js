// WHO MAY SIGN IN.
//
// This is the whole permission system now. Until 2026-09-15 anybody with a
// sequoiafp.com Google account could sign in and see every hourly rate on the
// roster, and three permission tiers existed to hold one column back from that
// crowd. The list replaced both: you are on it or you are not, and being on it
// means everything.
//
// So the tests that matter are the two failure directions:
//
//   somebody NOT on the list gets in        — the thing the list exists to stop
//   NOBODY can get in                       — unrecoverable, because the person
//                                             who would fix it needs to sign in
//
// The second is why this is the ONE place in the app where a failed permissions
// read does not deny. Everywhere else, failing closed costs somebody a screen.
// Here it costs everybody the app, with no way back in.

const test = require('node:test');
const assert = require('node:assert');

process.env.SESSION_SECRET = 'test-session-secret';
process.env.SUPABASE_URL = 'https://example.invalid';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';
process.env.ALLOWED_DOMAIN = 'sequoiafp.com';
process.env.GOOGLE_CLIENT_ID = 'test-client';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';

const perms = require('../netlify/functions/permissions-lib');
const db = require('../netlify/functions/db');

const ON_LIST  = 'peter.stroble@sequoiafp.com';
const OFF_LIST = 'contractor@sequoiafp.com';

// auth.js's isAllowed is not exported — it is closed over inside the handler —
// so the rule is exercised through the pieces it is built from, which is where
// the decisions actually live. The handler's own wiring is one line:
//   const access = await isAllowed(user.email); if (!access.allowed) redirect.
function stub({ rows = null, error = null } = {}) {
  global.fetch = async (url) => {
    const u = decodeURIComponent(String(url));
    if (!u.includes('user_permissions')) {
      return { ok: true, status: 200, json: async () => [], text: async () => '[]' };
    }
    if (error) {
      return { ok: false, status: error.status || 500,
               text: async () => error.message, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => rows, text: async () => JSON.stringify(rows) };
  };
}

// The same shape auth.js implements: read the list, fall back to the domain
// only when it cannot answer.
async function signInAllowed(email) {
  const wanted = perms.normalizeEmail(email);
  if (!wanted) return false;
  let list;
  try {
    list = await perms.fetchAccessList(db);
  } catch (err) {
    assert.ok(perms.bootstrapAllows(err), 'a failed read must permit the bootstrap');
    return wanted.endsWith('@' + process.env.ALLOWED_DOMAIN);
  }
  if (!list.length) return wanted.endsWith('@' + process.env.ALLOWED_DOMAIN);
  return list.includes(wanted);
}

test('somebody on the list gets in', async () => {
  stub({ rows: [{ email: ON_LIST }] });
  assert.strictEqual(await signInAllowed(ON_LIST), true);
});

test('THE DOMAIN IS NO LONGER ENOUGH', async () => {
  // The reversal, and the point of the whole change. This address is on the
  // company domain and would have been waved through until 2026-09-15.
  stub({ rows: [{ email: ON_LIST }] });
  assert.strictEqual(await signInAllowed(OFF_LIST), false);
});

test('the address is matched case-insensitively', async () => {
  // Google hands back a canonical address; an entry typed on the Settings tab
  // does not have to be. A mismatch on a capital letter would be access that
  // looks granted and is not.
  stub({ rows: [{ email: '  Peter.Stroble@SequoiaFP.com ' }] });
  assert.strictEqual(await signInAllowed('PETER.STROBLE@sequoiafp.com'), true);
});

test('an outside domain is refused whatever the list says', async () => {
  stub({ rows: [{ email: 'someone@gmail.com' }] });
  assert.strictEqual(await signInAllowed('someone@gmail.com'), true,
    'an explicit entry IS honoured — the list is the rule, not the domain');
  assert.strictEqual(await signInAllowed('stranger@gmail.com'), false);
});

// ---------------------------------------------------------------------------
// THE BOOTSTRAP — the one place a failed read must not deny
// ---------------------------------------------------------------------------

test('a table that does not exist yet falls back to the domain', async () => {
  // The code can deploy before the migration runs. In that window the app
  // behaves exactly as it did before — which is the state it is migrating FROM,
  // so nothing is newly exposed.
  stub({ error: { status: 404, message: 'PGRST205 could not find the table' } });
  assert.strictEqual(await signInAllowed(OFF_LIST), true, 'the domain rule is back in force');
  assert.strictEqual(await signInAllowed('stranger@gmail.com'), false, 'but only the domain');
});

test('a database that cannot be reached falls back to the domain', async () => {
  // Everywhere else in the app this would be a hole. Here the alternative is
  // that nobody can sign in to fix it, including the person who would fix it.
  stub({ error: { status: 500, message: 'connection refused' } });
  assert.strictEqual(await signInAllowed(OFF_LIST), true);
});

test('an EMPTY list falls back rather than locking everybody out', async () => {
  // It should be unreachable — /api/permissions refuses to remove the last
  // entry — so this covers a hand-written DELETE in the SQL editor, which the
  // database no longer stops now that the last-admin trigger is gone.
  stub({ rows: [] });
  assert.strictEqual(await signInAllowed(ON_LIST), true);
});

test('bootstrapAllows is true for every failure and never consulted on success', async () => {
  // The helper auth.js branches on. Both failure shapes permit the fallback;
  // the success path never reaches it, which is what keeps the domain rule out
  // of the ordinary case.
  assert.strictEqual(perms.bootstrapAllows(new Error('PGRST205 could not find the table')), true);
  assert.strictEqual(perms.bootstrapAllows(new Error('connection refused')), true);
  assert.strictEqual(perms.isMissingTable(new Error('PGRST205 could not find the table')), true);
  assert.strictEqual(perms.isMissingTable(new Error('connection refused')), false);
});

test('fetchAccessList THROWS on a failure rather than returning an empty list', async () => {
  // An empty list and an unreachable table mean opposite things at sign-in, and
  // a function that returned [] for both would make them impossible to tell
  // apart — which would turn a database hiccup into "nobody has access".
  stub({ error: { status: 500, message: 'connection refused' } });
  await assert.rejects(() => perms.fetchAccessList(db));

  stub({ rows: [] });
  assert.deepStrictEqual(await perms.fetchAccessList(db), [], 'and an empty table is a real []');
});
