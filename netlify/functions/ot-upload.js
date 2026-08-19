// DEPRECATED — superseded by payroll-import.js and the daily_hours table.
//
// This endpoint wrote a weekly Hours-Analysis-Report into `weekly_hours` and is no
// longer called by anything: the OT Report now reads `daily_hours`, which is imported
// one day at a time by payroll-import.js (manual upload) and payroll-email-ingest.js
// (the hourly IMAP pipeline). It stays deployed only so an in-flight browser tab
// holding the old app.html cannot 404 mid-upload. Delete it and the `weekly_hours`
// table together once nobody is on the old page.

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

// Helper to insert weekly hours
async function insertWeeklyHours(uploadBatchId, rows) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  const hdrs = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Prefer': 'return=representation'
  };

  if (!rows.length) return [];

  const res = await fetch(`${SUPABASE_URL}/rest/v1/weekly_hours`, {
    method: 'POST',
    headers: hdrs,
    body: JSON.stringify(rows)
  });

  if (!res.ok) throw new Error(`INSERT weekly_hours ${res.status}: ${await res.text()}`);
  return res.json();
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  const session = verifySession(getCookies(event).sfp_session || '');
  if (!session) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };

  try {
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { uploadBatchId, rows } = body;

      if (!uploadBatchId || !rows || !Array.isArray(rows)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing uploadBatchId or rows' }) };
      }

      // Insert the rows
      const inserted = await insertWeeklyHours(uploadBatchId, rows.map(r => ({
        upload_batch_id: uploadBatchId,
        employee_number: r.employee_number,
        work_date: r.work_date,
        regular_hours: parseFloat(r.regular_hours) || 0,
        ot_hours: parseFloat(r.ot_hours) || 0,
        supervisor_comment: r.supervisor_comment || null
      })));

      return { statusCode: 200, headers, body: JSON.stringify({ data: inserted }) };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (err) {
    console.error('OT upload error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
