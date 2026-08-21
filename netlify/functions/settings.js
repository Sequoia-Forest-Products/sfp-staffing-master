const { createHmac } = require('crypto');
const db = require('./db');

const SESSION_SECRET = process.env.SESSION_SECRET;

// This endpoint had NO session check on either method. GET returned any
// settings row by key, and POST wrote to the settings table with the
// service-role key — so anyone on the internet could overwrite emailSettings,
// which carries the manager email list and graceHoursPerEmployee, the
// pre-approved allowance the OT report measures net OT against.
//
// It is the same hole /api/data had, and it survived that fix precisely BECAUSE
// it is a separate endpoint: the table allowlist added there covers the four
// tables /api/data serves and never saw this file.
//
// verifySession and getCookies are copied from data.js rather than shared. That
// is now the fourth copy (data.js, auth.js, send-ot-email.js, here), which is a
// real hazard — a change to session handling has to be made in four places —
// but consolidating security-critical code is not something to do in the same
// commit as closing a live hole. Worth doing on its own.
function verifySession(token) {
  try {
    const [b64, sig] = token.split('.');
    const expected = createHmac('sha256', SESSION_SECRET).update(b64).digest('base64url');
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

function getCookies(event) {
  return Object.fromEntries(
    (event.headers.cookie || '').split(';').map(c => {
      const [k, ...v] = c.trim().split('=');
      return [k, v.join('=')];
    })
  );
}

// The key went into the PostgREST query string raw, so `?key=x&limit=1` did not
// look up the key "x&limit=1" — it appended a second parameter to the request
// and PostgREST honoured it. Anything acceptable in a filter position could be
// injected the same way. Encoding it makes the value a value.
const settingsFilter = (key) => `?key=eq.${encodeURIComponent(key)}`;

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  const session = verifySession(getCookies(event).sfp_session || '');
  if (!session) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };

  const method = event.httpMethod;
  const params = event.queryStringParameters || {};
  const key = params.key || 'default';

  try {
    // GET /api/settings?key=emailSettings
    if (method === 'GET') {
      try {
        const rows = await db.query('settings', settingsFilter(key));
        if (rows.length > 0) {
          return { statusCode: 200, headers, body: JSON.stringify({ data: rows[0] }) };
        }
        return { statusCode: 404, headers, body: JSON.stringify({ data: null }) };
      } catch (err) {
        // Table might not exist yet - return empty
        return { statusCode: 200, headers, body: JSON.stringify({ data: null }) };
      }
    }

    // POST /api/settings - save setting
    if (method === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const settingKey = body.key;
      const settingValue = body.value;

      // Must be a non-empty string. A number or an object here would be
      // template-stringified into the filter, which is how "[object Object]"
      // becomes a settings key nobody can find again.
      if (!settingKey || typeof settingKey !== 'string') {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'key required' }) };
      }

      try {
        // Try to check if exists
        const existing = await db.query('settings', settingsFilter(settingKey)).catch(() => []);

        if (existing.length > 0) {
          // Update existing
          const row = await db.update('settings', existing[0].id, {
            value: JSON.stringify(settingValue),
            updated_at: new Date().toISOString()
          });
          return { statusCode: 200, headers, body: JSON.stringify({ data: row }) };
        } else {
          // Insert new
          const row = await db.insert('settings', {
            key: settingKey,
            value: JSON.stringify(settingValue)
          });
          return { statusCode: 200, headers, body: JSON.stringify({ data: row }) };
        }
      } catch (err) {
        console.error('Settings save error:', err.message);
        return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
      }
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  } catch (err) {
    console.error('Settings error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
