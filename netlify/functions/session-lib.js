// Session cookie verification, in one place.
//
// This function existed in ELEVEN copies: auth.js, session.js, data.js,
// settings.js, documents.js, ot-upload.js, payroll-import.js, payroll-report.js,
// payroll-email-test.js, birthday-test.js and send-ot-email.js. (A comment in
// settings.js called it "the fourth copy" — that was a count of the copies I had
// happened to open, not of the copies that exist.)
//
// Eleven copies of the function that decides whether a request is authenticated
// is a standing hazard, and it has already cost this project once: /api/settings
// shipped with no session check at all, and the reason nobody noticed is that
// there was no single place where "an endpoint checks the session" was written
// down — each file carried its own, so a file carrying none looked no different.
//
// The bodies were logically identical (whitespace only), so this consolidation
// is behaviour-preserving by construction. Two things were deliberately NOT
// changed while moving the code:
//
//   * The signature comparison stays `!==` rather than timingSafeEqual. It is a
//     theoretical timing side-channel on a 256-bit HMAC over the public
//     internet, which is not the same class of problem as a missing check, and
//     changing it here would mean this commit no longer preserves behaviour.
//     birthday-test.js and payroll-email-test.js already use timingSafeEqual —
//     for their trigger SECRETS, which is a different comparison.
//   * SESSION_SECRET is read at call time, not at module load. Netlify sets
//     env vars before invoking the handler, but a module-scope read makes the
//     value a load-order dependency for no benefit.

const { createHmac } = require('crypto');

// Returns the session payload, or null. Null means "not authenticated" for every
// reason — bad signature, expired, malformed, missing — because a caller has
// nothing different to do about any of them, and distinguishing them in the
// response tells an attacker which part of the token to fix.
function verifySession(token) {
  try {
    const secret = process.env.SESSION_SECRET;
    if (!secret) return null;
    const [b64, sig] = String(token || '').split('.');
    const expected = createHmac('sha256', secret).update(b64).digest('base64url');
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

function getCookies(event) {
  return Object.fromEntries(
    ((event && event.headers && event.headers.cookie) || '').split(';').map(c => {
      const [k, ...v] = c.trim().split('=');
      return [k, v.join('=')];
    })
  );
}

// Signing lives here too, next to verification. auth.js was the only signer, and
// having the two halves in different files is how a secret-read mismatch would
// ship silently: a token signed with one reading of SESSION_SECRET and verified
// against another fails as "not logged in" with nothing to point at.
function signSession(payload) {
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', process.env.SESSION_SECRET).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

// 8 hours, matching the exp auth.js puts in the payload. The cookie expiry and
// the token expiry are two separate clocks and they have to agree, so the number
// is defined once.
const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

function buildCookie(token, maxAge = SESSION_MAX_AGE_SECONDS) {
  return `sfp_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

// The one thing every protected endpoint does. Having it named means a new
// endpoint that forgets to authenticate is a visibly missing line rather than an
// absence nobody can see.
function sessionFrom(event) {
  return verifySession(getCookies(event).sfp_session || '');
}

module.exports = {
  verifySession, getCookies, sessionFrom,
  signSession, buildCookie, SESSION_MAX_AGE_SECONDS
};
