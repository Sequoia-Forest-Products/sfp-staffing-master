// /api/permissions — the access list.
//
// ONE LIST, NO ROLES, since 2026-09-15. Anyone signed in may read it and edit
// it, because being signed in IS being on it — auth.js checks the list against
// Google's answer and nothing else can produce a session.
//
// So the thing worth testing here is no longer "can a non-admin write". There
// are no admins. It is the one refusal that survives — the last entry cannot be
// removed — plus the two things that would silently produce access that does
// not work: an address that never matches because of its case, and a removal
// that leaves a second row behind from the old tier model.

const test = require('node:test');
const assert = require('node:assert');
const { createHmac } = require('node:crypto');

process.env.SESSION_SECRET = 'test-session-secret';
process.env.SUPABASE_URL = 'https://example.invalid';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const perms = require('../netlify/functions/permissions-lib');
const api = require('../netlify/functions/permissions');

const PETER = 'peter.stroble@sequoiafp.com';
const RYLEY = 'ryley.stanley@sequoiafp.com';
const JEFF  = 'jeffrey.cook@sequoiafp.com';
const NOBODY = 'ana.reyes@sequoiafp.com';

// The live shape on the day of the migration: two rows for one person, left
// over from the tier model. The list must report them as ONE entry and a
// removal must take BOTH.
const ROWS = [
  { id: 'g1', email: PETER, tier: 'admin' },
  { id: 'g2', email: PETER, tier: 'salaries' },
  { id: 'g3', email: RYLEY, tier: 'access' },
  { id: 'g4', email: JEFF,  tier: 'access' }
];

function cookie(email) {
  const b64 = Buffer.from(JSON.stringify({ email, exp: Date.now() + 3600000 })).toString('base64url');
  return `sfp_session=${b64}.${createHmac('sha256', process.env.SESSION_SECRET).update(b64).digest('base64url')}`;
}

function stub({ rows = ROWS, missingTable = false, readError = null, writeError = null } = {}) {
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
    if (readError && method === 'GET') {
      return { ok: false, status: 500, text: async () => readError, json: async () => ({}) };
    }
    if (writeError && method !== 'GET') {
      return { ok: false, status: 500, text: async () => writeError, json: async () => ({}) };
    }
    if (method === 'GET') {
      // Honour an email= filter so the id lookup before a delete behaves like
      // the real table.
      const m = /email=eq\.([^&]+)/.exec(u);
      const out = m ? rows.filter(r => r.email === m[1]) : rows;
      return { ok: true, status: 200, json: async () => out, text: async () => JSON.stringify(out) };
    }
    return { ok: true, status: 200, json: async () => [{}], text: async () => '[{}]' };
  };
  return { calls, writes };
}

const call = (method, email, opts = {}) => api.handler({
  httpMethod: method,
  headers: { cookie: cookie(email) },
  queryStringParameters: opts.params || {},
  body: opts.body ? JSON.stringify(opts.body) : null
});

const json = (res) => JSON.parse(res.body);

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

test('an unauthenticated caller is refused before anything is read', async () => {
  const { calls } = stub();
  const res = await api.handler({ httpMethod: 'GET', headers: {}, queryStringParameters: {} });
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(calls.length, 0, 'a refused request must reach no table');
});

test('GET returns the whole list, one entry per person', async () => {
  // Peter holds two rows from the tier model. One person, one entry.
  stub();
  const d = json(await call('GET', RYLEY));
  assert.strictEqual(d.ok, true);
  assert.deepStrictEqual(d.list, [JEFF, PETER, RYLEY], 'sorted, deduplicated');
  assert.strictEqual(d.hasAccess, true);
});

test('GET says whether the caller is on the list', async () => {
  stub();
  assert.strictEqual(json(await call('GET', PETER)).hasAccess, true);
  // A session for somebody not on the list should be unreachable — auth.js
  // would not have issued it — but the answer is still honest if one appears.
  assert.strictEqual(json(await call('GET', NOBODY)).hasAccess, false);
});

test('a missing table reads as an empty list and says to run the migration', async () => {
  stub({ missingTable: true });
  const d = json(await call('GET', PETER));
  assert.strictEqual(d.ok, true);
  assert.deepStrictEqual(d.list, []);
  assert.strictEqual(d.unavailable, true);
  assert.match(d.detail, /SCHEMA_ACCESS_LIST\.sql/);
});

test('a missing table refuses a WRITE rather than pretending it worked', async () => {
  const { writes } = stub({ missingTable: true });
  const res = await call('POST', PETER, { body: { email: NOBODY } });
  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(writes.length, 0);
});

test('a read failure is a 500, not an empty list', async () => {
  // An empty list and an unreachable table mean opposite things. Answering []
  // for a broken read would make the page show "nobody has access" for a
  // database hiccup.
  stub({ readError: 'connection reset' });
  const res = await call('GET', PETER);
  assert.strictEqual(res.statusCode, 500);
  assert.match(json(res).error, /could not be read/i);
});

// ---------------------------------------------------------------------------
// adding
// ---------------------------------------------------------------------------

test('anybody signed in may add anybody — there are no roles', async () => {
  const { writes } = stub();
  const res = await call('POST', JEFF, { body: { email: NOBODY } });
  assert.strictEqual(res.statusCode, 200, res.body);
  assert.strictEqual(json(res).added, true);
  assert.strictEqual(writes.length, 1);
  assert.strictEqual(writes[0].body.email, NOBODY);
  assert.strictEqual(writes[0].body.granted_by, JEFF, 'who did it is recorded');
});

test('the address is canonicalised, so case cannot create access that never matches', async () => {
  // Google hands back a canonical address; a person typing one does not. An
  // entry that fails to match because of a capital letter is access that looks
  // granted and is not, and nothing would ever report it.
  const { writes } = stub();
  const res = await call('POST', PETER, { body: { email: '  Ana.Reyes@SequoiaFP.com  ' } });
  assert.strictEqual(res.statusCode, 200, res.body);
  assert.strictEqual(writes[0].body.email, NOBODY);
});

test('a non-address is refused before it reaches the table', async () => {
  const { writes } = stub();
  for (const email of ['', '   ', 'not-an-email', 'missing@domain']) {
    const res = await call('POST', PETER, { body: { email } });
    assert.strictEqual(res.statusCode, 400, JSON.stringify(email));
  }
  assert.strictEqual(writes.length, 0);
});

test('adding somebody who is already on the list is a success, not a conflict', async () => {
  // The caller asked for a state the system is already in, and it is in it.
  // A 409 would make the Settings tab report a failure for a list that says
  // exactly what they wanted.
  const { writes } = stub();
  const res = await call('POST', PETER, { body: { email: RYLEY } });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(json(res).added, false);
  assert.strictEqual(writes.length, 0, 'and writes nothing');
});

// ---------------------------------------------------------------------------
// removing — and the one refusal
// ---------------------------------------------------------------------------

test('a removal takes EVERY row for the address', async () => {
  // Peter has two rows left over from the tier model. Removing one id would
  // leave the other, and he would still be on the list — access that looks
  // revoked and is not.
  const { writes } = stub();
  const res = await call('DELETE', RYLEY, { params: { email: PETER } });
  assert.strictEqual(res.statusCode, 200, res.body);
  assert.strictEqual(json(res).removed, true);
  const deletes = writes.filter(w => w.method === 'DELETE');
  assert.strictEqual(deletes.length, 2, 'both of his rows');
  assert.ok(deletes.some(d => d.url.includes('g1')) && deletes.some(d => d.url.includes('g2')));
});

test('anybody may remove themselves, and is told what that means', async () => {
  const { writes } = stub();
  const res = await call('DELETE', JEFF, { params: { email: JEFF } });
  assert.strictEqual(res.statusCode, 200, res.body);
  assert.strictEqual(json(res).self, true, 'the page needs to say so');
  assert.ok(writes.some(w => w.method === 'DELETE'));
});

test('THE LAST ENTRY CANNOT BE REMOVED, and nothing reaches the table', async () => {
  // Not a role sneaking back in — it applies to everybody equally. An empty
  // list locks every account out and nothing inside the app could put one back.
  const { writes } = stub({ rows: [{ id: 'only', email: PETER, tier: 'access' }] });
  const res = await call('DELETE', PETER, { params: { email: PETER } });
  assert.strictEqual(res.statusCode, 409);
  assert.match(json(res).error, /last person cannot be removed/i);
  assert.match(json(res).detail, /add the replacement first/i);
  assert.strictEqual(writes.length, 0);
});

test('the last-entry count is taken from the table, not from the caller', async () => {
  // Two people racing to remove the last two entries must not both be told they
  // were the second-to-last. The count is re-read inside the request.
  const { writes } = stub({ rows: [{ id: 'a', email: PETER, tier: 'access' }] });
  await call('DELETE', RYLEY, { params: { email: PETER } });
  assert.strictEqual(writes.length, 0, 'a stale client view cannot empty the list');
});

test('removing somebody who is not on the list is a success, and writes nothing', async () => {
  const { writes } = stub();
  const res = await call('DELETE', PETER, { params: { email: NOBODY } });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(json(res).removed, false);
  assert.strictEqual(writes.length, 0);
});

test('a removal that fails at the database is reported, not swallowed', async () => {
  stub({ writeError: 'permission denied for table user_permissions' });
  const res = await call('DELETE', PETER, { params: { email: JEFF } });
  assert.strictEqual(res.statusCode, 500);
  assert.match(json(res).error, /could not be revoked/i);
});

test('an unsupported method is refused', async () => {
  stub();
  const res = await call('PUT', PETER, {});
  assert.strictEqual(res.statusCode, 405);
});

// ---------------------------------------------------------------------------
// the list IS the email recipient list
// ---------------------------------------------------------------------------

test('send-ot-email reads the access list, not a second list beside it', async () => {
  // There were two lists both meaning "the managers", and they drifted: the
  // live data had jeffrey.cook@ holding a permission and jefrey.cook@ — one f —
  // on the recipient list, with nothing in the app able to notice they were not
  // the same person.
  const send = require('../netlify/functions/send-ot-email');
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'netlify', 'functions', 'send-ot-email.js'), 'utf8');

  assert.match(src, /perms\.fetchAccessList/, 'the recipients must come from the access list');
  // The old reader survives as a FALLBACK only — sending the week's per-person
  // dollars to nobody is worse than sending them to yesterday's correct list.
  assert.match(src, /loadLegacyManagers/);
  assert.strictEqual(typeof send.managersFromSettingsRow, 'function');
});

test('an address on the access list passes the recipient check', async () => {
  const { resolveRecipients } = require('../netlify/functions/send-ot-email');
  const list = ['peter.stroble@sequoiafp.com', 'tony.griffith@sequoiafp.com'];

  // No proposal means "whoever is on the list", which is what the Monday
  // scheduled send does.
  const all = resolveRecipients(null, list);
  assert.strictEqual(all.ok, true);
  assert.deepStrictEqual(all.recipients, list);

  // And a proposal is checked against it.
  assert.strictEqual(resolveRecipients(['peter.stroble@sequoiafp.com'], list).ok, true);
  assert.strictEqual(resolveRecipients(['stranger@gmail.com'], list).ok, false);
});

test('an empty access list refuses to send rather than sending to nobody', async () => {
  const { resolveRecipients } = require('../netlify/functions/send-ot-email');
  const out = resolveRecipients(null, []);
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /No manager recipients are configured/);
});
