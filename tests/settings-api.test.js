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
function stubFetch(rows = []) {
  const urls = [];
  global.fetch = async (url, opts) => {
    urls.push({ url: String(url), method: (opts && opts.method) || 'GET' });
    return { ok: true, status: 200, json: async () => rows, text: async () => JSON.stringify(rows) };
  };
  return urls;
}

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

test('a valid session can still save', async () => {
  const urls = stubFetch([{ id: 1, key: 'emailSettings' }]);
  const res = await call('POST', {
    body: JSON.stringify({ key: 'emailSettings', value: { graceHoursPerEmployee: 0.5 } }),
    headers: { cookie: cookie() }
  });

  assert.strictEqual(res.statusCode, 200);
  assert.ok(urls.length >= 1);
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
  const urls = stubFetch([]);
  await call('POST', {
    body: JSON.stringify({ key: 'x&limit=1', value: {} }),
    headers: { cookie: cookie() }
  });

  const q = urls[0].url.slice(urls[0].url.indexOf('?'));
  assert.ok(!/[?&]limit=/.test(q), `injected limit reached PostgREST on POST: ${q}`);
});

test('a non-string key is refused rather than stringified into the filter', async () => {
  for (const bad of [{ nested: true }, 42, ['a'], null, '']) {
    const urls = stubFetch([]);
    const res = await call('POST', { body: JSON.stringify({ key: bad, value: {} }), headers: { cookie: cookie() } });
    assert.strictEqual(res.statusCode, 400, `key ${JSON.stringify(bad)} should be a 400`);
    assert.deepStrictEqual(urls, [], 'a rejected key must not hit the database');
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
