const { createHmac } = require('crypto');
const db = require('./db');

const SESSION_SECRET = process.env.SESSION_SECRET;

// Tables this endpoint may touch. Until now `table` came off the query string
// and went straight through to PostgREST, so any signed-in user could read any
// table by URL — wage_history is a complete compensation history by design,
// daily_hours carries per-person earnings, processed_emails carries mailbox
// subjects. The app only ever asks for these four.
//
// The read was not the worst of it. PUT maps to db.replaceAll, which DELETEs
// every row in the table before inserting, so `PUT /api/data?table=daily_hours`
// with an empty rows array would have emptied the table.
const ALLOWED_TABLES = new Set(['employees', 'economics', 'overtime', 'points']);

// An explicit projection, not a denylist. A column added to `employees` later
// is excluded until somebody deliberately lists it here, which is the right
// default for a table that holds compensation.
//
// annual_salary is the reason this exists and is deliberately absent. Without a
// select, PostgREST returns every column, so the salary would sit in the roster
// payload of every signed-in user's browser whether or not anything rendered
// it — and today every sequoiafp.com account has full access. It stays out
// until the Salaries & Wages tier exists to gate it.
const EMPLOYEE_COLUMNS = [
  'id', 'name', 'wage', 'dept', 'status', 'days',
  'clock_in', 'clock_out', 'break_1', 'break_2',
  'birthday', 'phone', 'language', 'email',
  'sms_opted_out', 'text_bolt', 'drive_folder_id',
  'employee_number', 'department', 'pay_type', 'cost_class', 'position_group'
];

// pay_type, cost_class and position_group do not exist until
// SCHEMA_V2_MODEL.sql has run. Naming a missing column is a 400 from PostgREST,
// which would take the roster — and so the whole app — down. Fall back once and
// carry on, the same way writeEmployeeRow does for writes.
const EMPLOYEE_COLUMNS_PRE_V2 = [
  'id', 'name', 'wage', 'dept', 'status', 'days',
  'clock_in', 'clock_out', 'break_1', 'break_2',
  'birthday', 'phone', 'language', 'email',
  'sms_opted_out', 'text_bolt', 'drive_folder_id',
  'employee_number', 'department'
];

// Second layer, and it earns its keep. The projection above is what SHOULD keep
// annual_salary out of the payload, but it is a single string in a single place:
// one future edit — a select passed through from the query string, a helper that
// forgets it — and the salary is in every browser again. Picking the response
// apart against the same list makes the guarantee structural rather than
// dependent on the request staying correct. One list governs both, so they
// cannot drift.
function pickColumns(rows, columns) {
  if (!Array.isArray(rows)) return rows;
  return rows.map(row => {
    const out = {};
    for (const col of columns) if (col in row) out[col] = row[col];
    return out;
  });
}

function isUndefinedColumnError(message) {
  return /\b42703\b|does not exist|could not find/i.test(String(message || ''));
}

async function queryEmployees() {
  try {
    const rows = await db.query('employees', `?select=${EMPLOYEE_COLUMNS.join(',')}&order=name.asc`);
    return pickColumns(rows, EMPLOYEE_COLUMNS);
  } catch (err) {
    if (!isUndefinedColumnError(err.message)) throw err;
    console.warn('employees is missing the v2 columns — run SCHEMA_V2_MODEL.sql. Falling back to the pre-v2 projection.');
    const rows = await db.query('employees', `?select=${EMPLOYEE_COLUMNS_PRE_V2.join(',')}&order=name.asc`);
    return pickColumns(rows, EMPLOYEE_COLUMNS_PRE_V2);
  }
}

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

  // Checked before the method dispatch, so it covers the writes too.
  if (table && !ALLOWED_TABLES.has(table)) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        error: `Table not available through this endpoint: ${table}`,
        allowed: [...ALLOWED_TABLES]
      })
    };
  }

  try {
    // GET /api/data?table=employees
    if (method === 'GET' && table) {
      let orderBy = '';
      if (table === 'employees') orderBy = '?order=name.asc';
      if (table === 'economics') orderBy = '?order=num.asc';
      if (table === 'overtime') orderBy = '?order=ot_type.asc,hours.asc';
      if (table === 'points') orderBy = '?order=points.desc';
      const rows = table === 'employees'
        ? await queryEmployees()
        : await db.query(table, orderBy);
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
