const db = require('./db');

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const method = event.httpMethod;
  const params = event.queryStringParameters || {};
  const key = params.key || 'default';

  try {
    // GET /api/settings?key=emailSettings
    if (method === 'GET') {
      try {
        const rows = await db.query('settings', `?key=eq.${key}`);
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

      if (!settingKey) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'key required' }) };
      }

      try {
        // Try to check if exists
        const existing = await db.query('settings', `?key=eq.${settingKey}`).catch(() => []);

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
