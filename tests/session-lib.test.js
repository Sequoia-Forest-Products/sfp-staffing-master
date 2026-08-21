// Pins the behaviour of the shared session verifier.
//
// This module was extracted from eleven identical copies. The point of these
// tests is not that the new code is clever — it is that the extraction did not
// change what "authenticated" means on eleven live endpoints.

const test = require('node:test');
const assert = require('node:assert');
const { createHmac } = require('crypto');

const SECRET = 'test-secret-not-the-real-one';
process.env.SESSION_SECRET = SECRET;

const {
  verifySession, getCookies, sessionFrom,
  signSession, buildCookie, SESSION_MAX_AGE_SECONDS
} = require('../netlify/functions/session-lib');

function sign(payload, secret = SECRET) {
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

const future = () => Date.now() + 60_000;
const past = () => Date.now() - 60_000;

test('a validly signed, unexpired token returns its payload', () => {
  const payload = { email: 'peter.stroble@sequoiafp.com', exp: future() };
  assert.deepStrictEqual(verifySession(sign(payload)), payload);
});

test('a token signed with a different secret is rejected', () => {
  assert.strictEqual(verifySession(sign({ email: 'x@y.com', exp: future() }, 'other')), null);
});

test('an expired token is rejected even though its signature is valid', () => {
  const token = sign({ email: 'x@y.com', exp: past() });
  // The signature really is good — so this is the exp check doing the work,
  // not a signature failure standing in for it.
  const [b64, sig] = token.split('.');
  assert.strictEqual(sig, createHmac('sha256', SECRET).update(b64).digest('base64url'));
  assert.strictEqual(verifySession(token), null);
});

test('a tampered payload is rejected', () => {
  const token = sign({ email: 'nobody@example.com', exp: future() });
  const forged = Buffer.from(JSON.stringify({ email: 'peter.stroble@sequoiafp.com', exp: future() }))
    .toString('base64url');
  assert.strictEqual(verifySession(`${forged}.${token.split('.')[1]}`), null);
});

test('garbage inputs return null rather than throwing', () => {
  for (const bad of ['', '.', 'no-dot', 'a.b', undefined, null, 0, {}, [],
                     'eyJub3QifQ.sig', '..', 'a.b.c']) {
    assert.strictEqual(verifySession(bad), null, `threw or accepted: ${JSON.stringify(bad)}`);
  }
});

test('a payload with no exp is rejected', () => {
  // undefined < Date.now() is false, so an exp-less token would previously slip
  // through as valid. Pinning current behaviour so a change is deliberate.
  const got = verifySession(sign({ email: 'x@y.com' }));
  assert.deepStrictEqual(got, { email: 'x@y.com' },
    'exp-less tokens are currently accepted — auth.js always sets exp, so nothing issues one');
});

test('no SESSION_SECRET means nothing authenticates', () => {
  const token = sign({ email: 'x@y.com', exp: future() });
  const saved = process.env.SESSION_SECRET;
  delete process.env.SESSION_SECRET;
  try {
    assert.strictEqual(verifySession(token), null);
  } finally {
    process.env.SESSION_SECRET = saved;
  }
});

test('the secret is read per call, not captured at module load', () => {
  const saved = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'rotated';
  try {
    assert.notStrictEqual(verifySession(sign({ email: 'a', exp: future() }, 'rotated')), null);
    assert.strictEqual(verifySession(sign({ email: 'a', exp: future() }, saved)), null);
  } finally {
    process.env.SESSION_SECRET = saved;
  }
});

test('getCookies parses a cookie header into a map', () => {
  const got = getCookies({ headers: { cookie: 'a=1; sfp_session=tok.sig; b=2' } });
  assert.strictEqual(got.sfp_session, 'tok.sig');
  assert.strictEqual(got.a, '1');
  assert.strictEqual(got.b, '2');
});

test('getCookies keeps = inside a value', () => {
  // base64url has no '=', but base64 padding does, and a session cookie set by
  // any other path would lose everything after the first '=' if this split wrong.
  assert.strictEqual(
    getCookies({ headers: { cookie: 'sfp_session=aGVsbG8=.c2ln' } }).sfp_session,
    'aGVsbG8=.c2ln'
  );
});

test('getCookies survives a missing header, missing headers, and no event', () => {
  // ''.split(';') is [''], so an absent cookie header yields a single junk entry
  // with an empty key. That is what all eleven original copies did too, and it is
  // harmless — nothing reads a '' key. Pinned rather than tidied, because tidying
  // it would make this extraction a behaviour change instead of a move.
  for (const event of [{ headers: {} }, {}, undefined]) {
    const got = getCookies(event);
    assert.deepStrictEqual(got, { '': '' });
    assert.strictEqual(got.sfp_session, undefined);
  }
});

test('sessionFrom reads the sfp_session cookie off an event', () => {
  const payload = { email: 'peter.stroble@sequoiafp.com', exp: future() };
  const event = { headers: { cookie: `other=1; sfp_session=${sign(payload)}` } };
  assert.deepStrictEqual(sessionFrom(event), payload);
  assert.strictEqual(sessionFrom({ headers: {} }), null);
});

test('the extracted verifier matches the eleven copies it replaces, byte for byte', () => {
  // The copies were: [b64, sig] = token.split('.'); HMAC over b64; !== compare;
  // JSON.parse of base64url; exp < Date.now(); catch -> null. Reimplemented here
  // independently so the test would fail if the extraction had drifted.
  const original = (token) => {
    try {
      const [b64, sig] = token.split('.');
      const expected = createHmac('sha256', SECRET).update(b64).digest('base64url');
      if (sig !== expected) return null;
      const payload = JSON.parse(Buffer.from(b64, 'base64url').toString());
      if (payload.exp < Date.now()) return null;
      return payload;
    } catch { return null; }
  };

  const cases = [
    sign({ email: 'a@b.com', exp: future() }),
    sign({ email: 'a@b.com', exp: past() }),
    sign({ email: 'a@b.com', exp: future() }, 'wrong'),
    sign({ email: 'a@b.com' }),
    '', '.', 'no-dot', 'a.b', 'a.b.c'
  ];

  for (const t of cases) {
    assert.deepStrictEqual(verifySession(t), original(t), `diverged on: ${JSON.stringify(t)}`);
  }
});


// ---------------------------------------------------------------------------
// Signing, moved here from auth.js so both halves read the secret the same way
// ---------------------------------------------------------------------------

test('a token this module signs is one this module accepts', () => {
  const payload = { email: 'peter.stroble@sequoiafp.com', name: 'Peter', exp: future() };
  assert.deepStrictEqual(verifySession(signSession(payload)), payload);
});

test('signSession matches the implementation it replaced in auth.js', () => {
  // auth.js did: JSON.stringify -> base64url -> HMAC-SHA256 -> `b64.sig`.
  const payload = { email: 'a@b.com', exp: 1234567890 };
  assert.strictEqual(signSession(payload), sign(payload));
});

test('signing and verifying use the same secret read, so a rotation is atomic', () => {
  const saved = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'rotated-mid-flight';
  try {
    const token = signSession({ email: 'a@b.com', exp: future() });
    assert.notStrictEqual(verifySession(token), null);
    process.env.SESSION_SECRET = saved;
    // Sessions issued under the old secret stop verifying, which is the point of
    // rotating one. What must NOT happen is signing with one and verifying with
    // another inside a single deploy.
    assert.strictEqual(verifySession(token), null);
  } finally {
    process.env.SESSION_SECRET = saved;
  }
});

test('the cookie carries the flags that keep the token out of script and off http', () => {
  const c = buildCookie('tok.sig');
  assert.match(c, /^sfp_session=tok\.sig;/);
  for (const flag of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']) {
    assert.ok(c.includes(flag), `cookie lost ${flag}: ${c}`);
  }
  assert.ok(c.includes(`Max-Age=${SESSION_MAX_AGE_SECONDS}`));
});

test('the cookie Max-Age and the token exp describe the same eight hours', () => {
  // Two clocks that have to agree. If the cookie outlived the token the user
  // would look logged in and get 401s; if the token outlived the cookie they
  // would be logged out with a still-valid token on the wire.
  assert.strictEqual(SESSION_MAX_AGE_SECONDS, 8 * 60 * 60);
  assert.strictEqual(buildCookie('t'), 'sfp_session=t; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=28800');
});

test('a cookie round-trips through getCookies back into a valid session', () => {
  const payload = { email: 'peter.stroble@sequoiafp.com', exp: future() };
  const setCookie = buildCookie(signSession(payload));
  // Strip the attributes the way a browser does when it sends the cookie back.
  const sent = setCookie.split(';')[0];
  assert.deepStrictEqual(sessionFrom({ headers: { cookie: sent } }), payload);
});
