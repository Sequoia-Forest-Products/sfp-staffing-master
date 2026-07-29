const { createHmac, randomBytes } = require('crypto');

const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const SESSION_SECRET       = process.env.SESSION_SECRET;
const BASE_URL             = process.env.URL || 'http://localhost:8888';
const REDIRECT_URI         = `${BASE_URL}/auth/callback`;

// Allowed users: comma-separated emails in env var, e.g.:
// ALLOWED_USERS=peter.stroble@sequoiafp.com,mary.bower@sequoiafp.com
// Or set ALLOWED_DOMAIN=sequoiafp.com to allow the whole domain
const ALLOWED_USERS  = (process.env.ALLOWED_USERS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
const ALLOWED_DOMAIN = (process.env.ALLOWED_DOMAIN || 'sequoiafp.com').toLowerCase();

function isAllowed(email) {
  const e = email.toLowerCase();
  if (ALLOWED_DOMAIN && e.endsWith('@' + ALLOWED_DOMAIN)) return true;
  if (ALLOWED_USERS.includes(e)) return true;
  return false;
}

function signSession(payload) {
  const data = JSON.stringify(payload);
  const b64  = Buffer.from(data).toString('base64url');
  const sig  = createHmac('sha256', SESSION_SECRET).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

function verifySession(token) {
  try {
    const [b64, sig] = token.split('.');
    const expected   = createHmac('sha256', SESSION_SECRET).update(b64).digest('base64url');
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

function buildCookie(token) {
  const maxAge = 8 * 60 * 60; // 8 hours
  return `sfp_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
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

      if (!isAllowed(user.email)) {
        return { statusCode: 302, headers: { Location: '/?error=unauthorized' }, body: '' };
      }

      const sessionPayload = {
        email:   user.email,
        name:    user.name,
        picture: user.picture,
        exp:     Date.now() + 8 * 60 * 60 * 1000,
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
