const { randomBytes } = require('crypto');
const { signSession, buildCookie, SESSION_MAX_AGE_SECONDS } = require('./session-lib');
const perms = require('./permissions-lib');
const db = require('./db');

const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const BASE_URL             = process.env.URL || 'http://localhost:8888';
const REDIRECT_URI         = `${BASE_URL}/auth/callback`;

// ------------------------------------------------------------------------
// WHO MAY SIGN IN — THE ACCESS LIST, since 2026-09-15
// ------------------------------------------------------------------------
//
// It used to be the DOMAIN: anybody with a sequoiafp.com Google account could
// sign in and see every hourly rate on the roster. The three permission tiers
// existed to hold one column back from that crowd.
//
// The list replaced both. Access is now an explicit set of addresses managed on
// the Settings tab, and being on it means everything — every column, the
// settings, the list itself, and the weekly OT email. See permissions-lib.js.
//
// THE ENV VARS ARE THE BOOTSTRAP, NOT THE RULE. ALLOWED_DOMAIN and
// ALLOWED_USERS now apply only when the access list cannot answer — the table
// does not exist yet, or the database is unreachable. Everywhere else in this
// app a failed permissions read means no access; here it cannot, because the
// only person who could fix an unreachable table is somebody who needs to sign
// in to do it, and this is the app's one door. A day of domain-wide access
// beats a company locked out of its own system with no way back in.
const ALLOWED_USERS  = (process.env.ALLOWED_USERS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
const ALLOWED_DOMAIN = (process.env.ALLOWED_DOMAIN || 'sequoiafp.com').toLowerCase();

function bootstrapAllows(email) {
  const e = email.toLowerCase();
  if (ALLOWED_DOMAIN && e.endsWith('@' + ALLOWED_DOMAIN)) return true;
  if (ALLOWED_USERS.includes(e)) return true;
  return false;
}

// Returns { allowed, reason }. `reason` is for the log, not the browser — the
// redirect says 'unauthorized' either way, because telling an unknown caller
// whether an address is on the list is telling them something about the list.
async function isAllowed(email) {
  const wanted = perms.normalizeEmail(email);
  if (!wanted) return { allowed: false, reason: 'no email on the Google profile' };

  let list;
  try {
    list = await perms.fetchAccessList(db);
  } catch (err) {
    const why = perms.isMissingTable(err)
      ? 'the access list table does not exist yet'
      : `the access list could not be read (${err.message})`;
    // The one fallback in the app. Logged loudly: running on the domain rule is
    // a temporary state somebody has to notice and fix.
    console.warn(`SIGN-IN FALLBACK: ${why} — falling back to the ${ALLOWED_DOMAIN} domain rule.`);
    return { allowed: bootstrapAllows(email), reason: why };
  }

  // An EMPTY list is a real answer and it means nobody. It should be
  // unreachable — permissions.js refuses to remove the last entry — so if it
  // happens, the domain rule lets somebody back in to repopulate it rather than
  // leaving the app with no way in at all.
  if (!list.length) {
    console.warn('SIGN-IN FALLBACK: the access list is empty — falling back to the domain rule.');
    return { allowed: bootstrapAllows(email), reason: 'the access list is empty' };
  }

  return { allowed: list.includes(wanted), reason: null };
}

exports.handler = async (event) => {
  const action = event.queryStringParameters?.action;
  const code   = event.queryStringParameters?.code;
  const state  = event.queryStringParameters?.state;

  // --- LOGIN: redirect to Google ---
  if (action === 'login') {
    const nonce = randomBytes(16).toString('hex');
    const params = new URLSearchParams({
      client_id:     GOOGLE_CLIENT_ID,
      redirect_uri:  REDIRECT_URI,
      response_type: 'code',
      scope:         'openid email profile https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive',
      access_type:   'offline',
      state:         nonce,
      hd:            ALLOWED_DOMAIN || '',
      prompt:        'select_account'
    });
    return {
      statusCode: 302,
      headers: {
        Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
        'Set-Cookie': `sfp_oauth_state=${nonce}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
      },
      body: ''
    };
  }

  // --- CALLBACK: exchange code for token ---
  if (code) {
    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    new URLSearchParams({
          code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
          redirect_uri: REDIRECT_URI, grant_type: 'authorization_code'
        })
      });
      const tokens = await tokenRes.json();
      if (!tokens.access_token) throw new Error('No access token');

      const userRes  = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` }
      });
      const user = await userRes.json();

      const access = await isAllowed(user.email);
      if (!access.allowed) {
        console.warn(`Sign-in refused for ${perms.normalizeEmail(user.email)}` +
          (access.reason ? ` (${access.reason})` : ' — not on the access list'));
        return { statusCode: 302, headers: { Location: '/?error=unauthorized' }, body: '' };
      }

      const sessionPayload = {
        email:   user.email,
        name:    user.name,
        picture: user.picture,
        exp:     Date.now() + SESSION_MAX_AGE_SECONDS * 1000,
        access_token: tokens.access_token
      };

      return {
        statusCode: 302,
        headers: {
          Location:   '/app.html',
          'Set-Cookie': buildCookie(signSession(sessionPayload))
        },
        body: ''
      };
    } catch (err) {
      console.error('Auth error:', err);
      return { statusCode: 302, headers: { Location: '/?error=auth_failed' }, body: '' };
    }
  }

  return { statusCode: 302, headers: { Location: '/?error=no_code' }, body: '' };
};
