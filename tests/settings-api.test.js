// Run with: npm test
//
// /api/settings had no session check on either method. GET returned any
// settings row by key and POST wrote to the settings table with the
// service-role key, so anyone on the internet could overwrite emailSettings —
// the manager email list and graceHoursPerEmployee, which is the pre-approved
// allowance the OT report measures net OT against.
//
// It is the same hole /api/data had, and it outlived that fix because the table
// allowlist added there only covers the four tables /api/data serves. Nothing
// pointed at this file.
//
// The key also went into the PostgREST query string raw, so a value could
// append parameters to the request instead of being looked up as a key.

const test = require('node:test');
const assert = require('node:assert');
const { createHmac } = require('node:crypto');

process.env.SESSION_SECRET = 'test-secret';
process.env.SUPABASE_URL = 'https://project.test';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

const settings = require('../netlify/functions/settings');

function cookie(email = 'someone@sequoiafp.com') {
  const b64 = Buffer.from(JSON.stringify({ email, exp: Date.now() + 3600000 })).toString('base64url');
  const sig = createHmac('sha256', process.env.SESSION_SECRET).update(b64).digest('base64url');
  return `sfp_session=${b64}.${sig}`;
}

// Raw URLs, NOT decoded: the whole point of the second fix is what the encoding
// does, so decoding here would hide it.
//
// `grants` answers the user_permissions lookup the write path now makes. It is
// SEPARATE from `rows` on purpose: a fake that returned the settings row to
// every query would have handed the tier resolver a list of settings rows and
// let a test pass for reasons that have nothing to do with permissions.
function stubFetch(rows = [], { grants = [], permsFail = false } = {}) {
  const urls = [];
  global.fetch = async (url, opts) => {
    const u = String(url);
    urls.push({ url: u, method: (opts && opts.method) || 'GET' });
    if (u.includes('user_permissions')) {
      if (permsFail) return { ok: false, status: 500, json: async () => ({}), text: async () => 'boom' };
      return { ok: true, status: 200, json: async () => grants, text: async () => JSON.stringify(grants) };
    }
    return { ok: true, status: 200, json: async () => rows, text: async () => JSON.stringify(rows) };
  };
  return urls;
}

const ADMIN = 'peter.stroble@sequoiafp.com';
const adminGrants = (email = ADMIN) => [{ email, tier: 'admin' }];

// Only the requests that reached the settings table. The tier lookup is a read
// of a different table and is not what these tests are counting.
const settingsCalls = (urls) => urls.filter(u => !u.url.includes('user_permissions'));
const writes = (urls) => urls.filter(u => u.method !== 'GET');

const call = (httpMethod, { query = null, body = null, headers = {} } = {}) =>
  settings.handler({ httpMethod, queryStringParameters: query, body, headers });

// ---------------------------------------------------------------------------
// The session check
// ---------------------------------------------------------------------------

test('GET without a session is refused', async () => {
  const urls = stubFetch([{ id: 1, key: 'emailSettings', value: '{}' }]);
  const res = await call('GET', { query: { key: 'emailSettings' } });

  assert.strictEqual(res.statusCode, 401);
  assert.deepStrictEqual(JSON.parse(res.body), { error: 'Unauthorized' });
  assert.deepStrictEqual(urls, [], 'an unauthenticated read must not reach Supabase at all');
});

test('POST without a session cannot write', async () => {
  // The live hole: this used to return 200 and update the row.
  const urls = stubFetch([{ id: 7, key: 'emailSettings' }]);
  const res = await call('POST', { body: JSON.stringify({ key: 'emailSettings', value: { managers: ['attacker@evil.test'] } }) });

  assert.strictEqual(res.statusCode, 401);
  assert.deepStrictEqual(urls, [], 'no write may be attempted without a session');
});

test('a forged session signature is refused', async () => {
  const b64 = Buffer.from(JSON.stringify({ email: 'x@sequoiafp.com', exp: Date.now() + 3600000 })).toString('base64url');
  const urls = stubFetch();
  const res = await call('GET', { query: { key: 'emailSettings' }, headers: { cookie: `sfp_session=${b64}.not-the-real-signature` } });

  assert.strictEqual(res.statusCode, 401);
  assert.deepStrictEqual(urls, []);
});

test('an expired session is refused', async () => {
  const b64 = Buffer.from(JSON.stringify({ email: 'x@sequoiafp.com', exp: Date.now() - 1000 })).toString('base64url');
  const sig = createHmac('sha256', process.env.SESSION_SECRET).update(b64).digest('base64url');
  const urls = stubFetch();
  const res = await call('GET', { query: { key: 'emailSettings' }, headers: { cookie: `sfp_session=${b64}.${sig}` } });

  assert.strictEqual(res.statusCode, 401);
  assert.deepStrictEqual(urls, []);
});

test('a valid session still gets its settings', async () => {
  // The fix must not break the Settings tab, which is the only caller.
  const urls = stubFetch([{ id: 1, key: 'emailSettings', value: '{"managers":[]}' }]);
  const res = await call('GET', { query: { key: 'emailSettings' }, headers: { cookie: cookie() } });

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(JSON.parse(res.body).data.key, 'emailSettings');
  assert.strictEqual(urls.length, 1);
});

test('an admin can still save', async () => {
  const urls = stubFetch([{ id: 1, key: 'emailSettings' }], { grants: adminGrants() });
  const res = await call('POST', {
    body: JSON.stringify({ key: 'emailSettings', value: { graceHoursPerEmployee: 0.5 } }),
    headers: { cookie: cookie(ADMIN) }
  });

  assert.strictEqual(res.statusCode, 200);
  assert.ok(writes(urls).length >= 1, 'the settings row was written');
});

// ---------------------------------------------------------------------------
// Writes are admin-only
// ---------------------------------------------------------------------------
//
// The session check above closed the anonymous hole. It left every signed-in
// user able to change the manager recipient list — the addresses that receive a
// report carrying what each hourly employee was paid — and the grace allowance,
// which moves the headline Net OT figure on every report. That is the Phase D
// gate routed around through a different endpoint, which is exactly how this
// file survived the /api/data fix in the first place.

// ---------------------------------------------------------------------------
// THE ADMIN GATE IS GONE, 2026-09-15
// ---------------------------------------------------------------------------
//
// It refused a POST from anybody without the admin tier, above any parsing or
// database access, because sign-in was the whole sequoiafp.com domain and these
// settings change what the weekly report says and who receives it.
//
// Access is an explicit list now and everyone on it holds the same rights, so
// the gate would be a role and the model has none. What that opens is real and
// was accepted knowingly: anyone on the list can move the timeclock grace
// allowance and the OT budget. The list is short and everyone on it is a
// manager.
//
// The recipient list is no longer among the things this endpoint can change at
// all — it IS the access list, edited through /api/permissions.

test('anybody signed in may save a setting', async () => {
  const urls = stubFetch([{ id: 7, key: 'emailSettings' }], { grants: [] });
  const res = await call('POST', {
    body: JSON.stringify({ key: 'emailSettings', value: { otBudgetPercent: 12 } }),
    headers: { cookie: cookie('nobody@sequoiafp.com') }
  });

  assert.strictEqual(res.statusCode, 200, res.body);
  assert.ok(settingsCalls(urls).length > 0, 'the save must reach the settings table');
});

test('an UNAUTHENTICATED POST is still refused, and reaches nothing', async () => {
  // The session check survived the tier it used to sit above. It is the only
  // gate left on this endpoint, and it is the one that matters: these settings
  // change what managers are told is over budget.
  const urls = stubFetch([{ id: 7, key: 'emailSettings' }], { grants: [] });
  const res = await call('POST', {
    body: JSON.stringify({ key: 'emailSettings', value: { otBudgetPercent: 99 } }),
    headers: {}
  });

  assert.strictEqual(res.statusCode, 401);
  assert.deepStrictEqual(settingsCalls(urls), [],
    'a refused save still touched the settings table');
});

test('saving no longer costs a permissions read', async () => {
  // It resolved the caller's tiers before parsing the body. A permissions table
  // that is down cannot stop somebody changing a setting now.
  const urls = stubFetch([{ id: 7, key: 'emailSettings' }], { permsFail: true });
  const res = await call('POST', {
    body: JSON.stringify({ key: 'emailSettings', value: { otBudgetPercent: 12 } }),
    headers: { cookie: cookie(ADMIN) }
  });

  assert.strictEqual(res.statusCode, 200, res.body);
  assert.strictEqual(urls.filter(c => c.url.includes('user_permissions')).length, 0);
});

test('reads stay open to everybody — the figures are on every report anyway', async () => {
  const urls = stubFetch([{ id: 1, key: 'emailSettings', value: '{"managers":["a@sequoiafp.com"]}' }],
    { grants: [] });
  const res = await call('GET', { query: { key: 'emailSettings' }, headers: { cookie: cookie('nobody@sequoiafp.com') } });

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(JSON.parse(res.body).data.key, 'emailSettings');
  // And a read does not cost a permissions round-trip.
  assert.deepStrictEqual(urls.filter(u => u.url.includes('user_permissions')), [],
    'the read path resolved tiers it does not need');
});

// ---------------------------------------------------------------------------
// The query interpolation
// ---------------------------------------------------------------------------

test('a key cannot append parameters to the PostgREST request', async () => {
  // `?key=eq.${key}` unencoded turned this into two parameters: key=eq.x and
  // limit=1, which PostgREST honoured. Encoded, the ampersand is part of the
  // value and the request carries exactly one parameter.
  const urls = stubFetch([]);
  await call('GET', { query: { key: 'x&limit=1' }, headers: { cookie: cookie() } });

  const q = urls[0].url.slice(urls[0].url.indexOf('?'));
  assert.ok(!/[?&]limit=/.test(q), `injected limit reached PostgREST: ${q}`);
  assert.ok(q.includes('%26'), `the ampersand should be encoded, got: ${q}`);
  assert.strictEqual(q.split('&').length, 1, `expected one query parameter, got: ${q}`);
});

test('a key cannot inject a select or an or-filter', async () => {
  for (const evil of ['x&select=*', 'x&or=(id.gte.0)', 'x#frag', 'x?y']) {
    const urls = stubFetch([]);
    await call('GET', { query: { key: evil }, headers: { cookie: cookie() } });
    const q = urls[0].url.slice(urls[0].url.indexOf('?'));
    assert.ok(!/[?&](select|or)=/.test(q), `injection survived for ${evil}: ${q}`);
    assert.strictEqual(q.split('&').length, 1, `extra parameter for ${evil}: ${q}`);
  }
});

test('the POST lookup encodes its key the same way', async () => {
  // The write path had the same interpolation and is the one that mutates rows.
  // Admin, so the request gets far enough to build the filter at all.
  const urls = stubFetch([], { grants: adminGrants() });
  await call('POST', {
    body: JSON.stringify({ key: 'x&limit=1', value: {} }),
    headers: { cookie: cookie(ADMIN) }
  });

  const first = settingsCalls(urls)[0];
  const q = first.url.slice(first.url.indexOf('?'));
  assert.ok(!/[?&]limit=/.test(q), `injected limit reached PostgREST on POST: ${q}`);
});

test('a non-string key is refused rather than stringified into the filter', async () => {
  // As an ADMIN: the 400 is about the key, and running it as a non-admin would
  // test the 403 instead and pass for the wrong reason.
  for (const bad of [{ nested: true }, 42, ['a'], null, '']) {
    const urls = stubFetch([], { grants: adminGrants() });
    const res = await call('POST', { body: JSON.stringify({ key: bad, value: {} }), headers: { cookie: cookie(ADMIN) } });
    assert.strictEqual(res.statusCode, 400, `key ${JSON.stringify(bad)} should be a 400`);
    assert.deepStrictEqual(settingsCalls(urls), [], 'a rejected key must not hit the database');
  }
});

test('an unsupported method is refused, with a session and without', async () => {
  // db.replaceAll is what made PUT dangerous on /api/data. Nothing here maps to
  // it, and this pins that a new method cannot arrive unauthenticated.
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    const anon = await call(method, {});
    assert.strictEqual(anon.statusCode, 401, `${method} without a session`);

    const authed = await call(method, { headers: { cookie: cookie() } });
    assert.strictEqual(authed.statusCode, 405, `${method} with a session`);
  }
});

// ---------------------------------------------------------------------------
// A READ THAT FAILED IS NOT AN EMPTY TABLE (2026-09-15)
// ---------------------------------------------------------------------------
//
// public.settings was never created. This handler caught the missing-table
// error and answered {data: null} with a 200 — a comment reading "Table might
// not exist yet - return empty" — so the Settings tab rendered its defaults and
// looked healthy while nothing could be saved and the Monday manager OT email
// refused to send for want of a recipient list. For months. The distinction
// below is the whole fix: the page can now tell "no row yet" from "the read
// failed", and say which.

test('an unreadable settings table answers with unavailable, not silence', async () => {
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('user_permissions')) return { ok: true, status: 200, json: async () => [], text: async () => '[]' };
    return {
      ok: false, status: 404,
      json: async () => ({}),
      text: async () => JSON.stringify({ code: 'PGRST205',
        message: "Could not find the table 'public.settings' in the schema cache" })
    };
  };

  const res = await call('GET', { query: { key: 'emailSettings' }, headers: { cookie: cookie() } });
  const body = JSON.parse(res.body);

  // Still a 200 with data: null — a settings read that fails must not take the
  // page down, and a caller that only reads .data behaves exactly as before.
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(body.data, null);
  // What is new, and what the page needs.
  assert.strictEqual(body.unavailable, true);
  assert.match(body.reason, /public\.settings/,
    'the reason has to name the table, because that is what identifies the fix');
});

test('a table that simply has no row is NOT reported as unavailable', async () => {
  // The healthy first-run state. Raising the alarm here would teach everybody
  // to ignore the banner.
  stubFetch([]);
  const res = await call('GET', { query: { key: 'nothing-here' }, headers: { cookie: cookie() } });
  const body = JSON.parse(res.body);

  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(body.data, null);
  assert.strictEqual(body.unavailable, undefined, 'an absent row is not a broken read');
});
