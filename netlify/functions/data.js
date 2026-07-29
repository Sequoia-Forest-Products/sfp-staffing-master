const { createHmac } = require('crypto');
const db = require('./db');

const SESSION_SECRET = process.env.SESSION_SECRET;

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

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  const session = verifySession(getCookies(event).sfp_session || '');
  if (!session) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };

  const method = event.httpMethod;
  const params = event.queryStringParameters || {};
  const table = params.table;

  try {
    // GET /api/data?table=employees
    if (method === 'GET' && table) {
      let orderBy = '';
      if (table === 'employees') orderBy = '?order=name.asc';
      if (table === 'economics') orderBy = '?order=num.asc';
      if (table === 'overtime') orderBy = '?order=ot_type.asc,hours.asc';
      if (table === 'points') orderBy = '?order=points.desc';
      const rows = await db.query(table, orderBy);
      return { statusCode: 200, headers, body: JSON.stringify({ data: rows }) };
    }

    // POST /api/data?table=employees — insert single row
    if (method === 'POST' && table) {
      const body = JSON.parse(event.body || '{}');
      const row = await db.insert(table, body);
      return { statusCode: 200, headers, body: JSON.stringify({ data: row }) };
    }

    // PATCH /api/data?table=employees&id=uuid — update single row
    if (method === 'PATCH' && table && params.id) {
      const body = JSON.parse(event.body || '{}');
      const row = await db.update(table, params.id, body);
      return { statusCode: 200, headers, body: JSON.stringify({ data: row }) };
    }

    // DELETE /api/data?table=employees&id=uuid — delete single row
    if (method === 'DELETE' && table && params.id) {
      await db.remove(table, params.id);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    // PUT /api/data?table=overtime — replace entire table (for OT and Points batch saves)
    if (method === 'PUT' && table) {
      const body = JSON.parse(event.body || '{}');
      const rows = await db.replaceAll(table, body.rows || []);
      return { statusCode: 200, headers, body: JSON.stringify({ data: rows }) };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  } catch (err) {
    console.error('Data error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
