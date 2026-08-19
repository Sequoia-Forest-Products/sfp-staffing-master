// Supabase REST access for the payroll tables (daily_hours, processed_emails)
// plus the two roster reads the payroll code needs. Same shape as db.js — the
// service key, the same four headers — kept in its own module because these
// queries carry filters, ordering and an upsert conflict target that db.js's
// generic helpers do not express.
//
// Every helper throws with the Supabase status and body. A payroll import that
// half-succeeds is worse than one that fails loudly, so nothing here swallows
// an error or returns a partial result.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

// PostgREST accepts at most a few thousand rows per request comfortably; the
// vendor file is ~60 rows, so 500 is only a guard against a bulk back-fill.
const CHUNK_SIZE = 500;

// URL length is the real limit on an id=in.(...) filter. UUIDs are 36 bytes
// plus a comma, and PostgREST needs them percent-encoded, so 200 ids measured
// 7449 bytes of request line — inside nginx's default 8 KB header buffer with
// nothing to spare, and reachable only during the bulk re-stamp this module
// exists for. 100 halves it and leaves room for the proxy chain to add its own
// headers.
const ID_FILTER_CHUNK = 100;

function hdrs(extra = {}) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  }
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Prefer': 'return=representation',
    ...extra
  };
}

async function request(method, path, { body, headers } = {}) {
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      method,
      headers: hdrs(headers),
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  } catch (err) {
    // undici reports every transport failure as the bare message 'fetch failed'
    // and hides the reason that would let somebody act on it (DNS, TLS, refused
    // connection) on err.cause. Carry it into the message so the Netlify log
    // says what actually broke, and keep the original as the cause.
    const reason = err && err.cause && err.cause.message ? `: ${err.cause.message}` : '';
    throw new Error(`${method} ${path} — ${err.message}${reason}`, { cause: err });
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} ${res.status}: ${await res.text()}`);
  }
  // DELETE and PATCH still return representation, but a 204 has no body.
  if (res.status === 204) return [];
  const text = await res.text();
  if (!text) return [];
  return JSON.parse(text);
}

const encode = v => encodeURIComponent(String(v));

// The daily_hours columns every payroll reader needs. Spelled out rather than
// select=* so a schema addition cannot quietly change what reports aggregate.
const DAILY_COLUMNS = [
  'id', 'work_date', 'employee_number', 'last_name', 'first_name', 'is_salary',
  'pay_rate', 'regular_hours', 'ot_hours', 'total_hours', 'total_earnings',
  'ot_dollars', 'regular_dollars', 'is_scheduled_day', 'department', 'source',
  'source_subject', 'email_received_at', 'file_hash', 'date_source', 'flags',
  'upload_batch_id', 'created_at'
].join(',');

// ============================================================
// ROSTER
// ============================================================

// employee_number and department are the two columns payroll cares about; wage
// is here for the OT report's dollar fallback, status for headcount filtering.
// The whole roster is returned, inactive people included: somebody terminated
// last week still has hours on last week's file.
function fetchEmployees() {
  return request('GET',
    'employees?select=id,name,employee_number,department,wage,status&order=name.asc');
}

function fetchOvertime() {
  return request('GET',
    'overtime?select=id,name,ot_type,hours,description&order=ot_type.asc,name.asc');
}

// ============================================================
// DAILY HOURS
// ============================================================

// Inclusive on both ends.
function fetchDailyHours(fromDate, toDate) {
  return request('GET',
    `daily_hours?select=${DAILY_COLUMNS}` +
    `&work_date=gte.${encode(fromDate)}&work_date=lte.${encode(toDate)}` +
    `&order=work_date.asc,employee_number.asc`);
}

// Same rows, same range. Named separately because callers aggregating per day
// should not have to know that "a day summary" is just its rows added up — if
// this ever becomes a database view, only this function changes.
function fetchDaySummaries(fromDate, toDate) {
  return fetchDailyHours(fromDate, toDate);
}

function fetchDailyHoursForDate(workDate) {
  return fetchDailyHours(workDate, workDate);
}

function findRowsByFileHash(fileHash) {
  if (!fileHash) return Promise.resolve([]);
  return request('GET',
    `daily_hours?select=${DAILY_COLUMNS}&file_hash=eq.${encode(fileHash)}` +
    `&order=work_date.asc,employee_number.asc`);
}

function fetchRowsByBatch(uploadBatchId) {
  return request('GET',
    `daily_hours?select=${DAILY_COLUMNS}&upload_batch_id=eq.${encode(uploadBatchId)}` +
    `&order=work_date.asc,employee_number.asc`);
}

// Upsert on (work_date, employee_number) — the constraint that makes a vendor
// re-send or a double-forward of the same day idempotent instead of doubling
// the day's payroll. merge-duplicates is what turns the conflict into an
// update rather than a 409.
async function upsertDailyHours(rows) {
  if (!rows || !rows.length) return [];

  const written = [];
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const result = await request('POST',
      'daily_hours?on_conflict=work_date,employee_number',
      { body: chunk, headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' } });
    written.push(...result);
  }
  return written;
}

async function deleteDailyHoursForDate(workDate) {
  const deleted = await request('DELETE', `daily_hours?work_date=eq.${encode(workDate)}`);
  return deleted.length;
}

// Removes everything on a date that did NOT come from the batch just written.
// This is the second half of a safe overwrite: the new batch is upserted first,
// then whoever was on the old file and not on the new one is pruned. Doing it
// in that order means a failed write leaves the previous day intact, which a
// delete-then-insert pair — two independent PostgREST calls with no transaction
// around them — cannot promise.
async function deleteOtherBatchesForDate(workDate, uploadBatchId) {
  const deleted = await request('DELETE',
    `daily_hours?work_date=eq.${encode(workDate)}` +
    `&upload_batch_id=neq.${encode(uploadBatchId)}`);
  return deleted.length;
}

async function deleteDailyHoursForBatch(uploadBatchId) {
  const deleted = await request('DELETE',
    `daily_hours?upload_batch_id=eq.${encode(uploadBatchId)}`);
  return deleted.length;
}

// Moves every row of a batch onto a new date. date_source becomes 'manual'
// because a date a human corrected is no longer an inferred one, and the
// missed-delivery check must not treat it as machine-derived afterwards.
async function updateBatchWorkDate(uploadBatchId, newWorkDate) {
  return request('PATCH',
    `daily_hours?upload_batch_id=eq.${encode(uploadBatchId)}`,
    { body: { work_date: newWorkDate, date_source: 'manual' } });
}

// ============================================================
// DEPARTMENT RE-STAMP
// ============================================================

// daily_hours.department is a snapshot taken at import time, so rows imported
// before employees.department was filled in carry null forever. This re-reads
// the roster and re-stamps them.
//
// It re-stamps a row whose employee now sits in a different department, so the
// caller sees exactly which rows moved in `changes` and can decide whether that
// was what they meant. Only rows whose department actually differs are written,
// and a department is never cleared — see the comment in the loop.
async function restampDepartments(fromDate, toDate) {
  const [rows, employees] = await Promise.all([
    fetchDailyHours(fromDate, toDate),
    fetchEmployees()
  ]);

  const { normalizeEmpNumber } = require('./payroll-lib');

  const byNumber = new Map();
  for (const emp of employees) {
    const key = normalizeEmpNumber(emp.employee_number);
    if (key && !byNumber.has(key)) byNumber.set(key, emp);
  }

  const changes = [];
  // Keyed by department *and* the flags the row will keep, because rows moving
  // to the same department do not necessarily carry the same flags and one
  // PATCH writes one body.
  const byTarget = new Map();
  let stillUnassigned = 0;

  for (const row of rows) {
    const employee = byNumber.get(normalizeEmpNumber(row.employee_number)) || null;
    const next = employee && employee.department ? String(employee.department).trim() : null;
    const current = row.department === undefined || row.department === '' ? null : row.department;

    // A roster entry that is missing, or present with no department, is a gap in
    // the back-fill — not an instruction to erase what the row already carries.
    // daily_hours is the only record of the snapshot, so writing null here would
    // destroy that employee's department history irreversibly, and it would
    // happen precisely when somebody is missed by the back-fill this tool exists
    // to repair. Count it and leave the row alone.
    if (!next) {
      stillUnassigned++;
      continue;
    }

    if (next === current) continue;

    changes.push({
      workDate: row.work_date,
      employeeNumber: row.employee_number,
      from: current,
      to: next
    });

    // Those two flags are assertions that the row has no department, and
    // re-stamping is the event that makes them untrue. Nothing else ever clears
    // them, so a repaired row would otherwise sit in the report's flagged list
    // for ever, describing a problem that was fixed.
    const flags = (Array.isArray(row.flags) ? row.flags : [])
      .filter(flag => flag !== 'missing_department' && flag !== 'unknown_employee');

    const key = `${next}\t${JSON.stringify(flags)}`;
    if (!byTarget.has(key)) byTarget.set(key, { department: next, flags, ids: [] });
    byTarget.get(key).ids.push(row.id);
  }

  let updated = 0;
  for (const { department, flags, ids } of byTarget.values()) {
    for (let i = 0; i < ids.length; i += ID_FILTER_CHUNK) {
      const slice = ids.slice(i, i + ID_FILTER_CHUNK);
      const result = await request('PATCH',
        `daily_hours?id=in.(${slice.map(encode).join(',')})`,
        { body: { department, flags } });
      updated += result.length;
    }
  }

  return { scanned: rows.length, updated, stillUnassigned, changes };
}

// ============================================================
// PROCESSED EMAIL LEDGER
// ============================================================
//
// Processing state lives here and never in the mailbox: info@ is a shared
// human inbox and the ingester must not flag, move or delete anything in it.

async function getProcessedEmail(messageId) {
  const rows = await request('GET',
    `processed_emails?select=*&message_id=eq.${encode(messageId)}&limit=1`);
  return rows[0] || null;
}

async function upsertProcessedEmail(record) {
  const rows = await request('POST',
    'processed_emails?on_conflict=message_id',
    { body: record, headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' } });
  return Array.isArray(rows) ? rows[0] || null : rows;
}

// opts: { status, notStatus, from, to, limit }. `notStatus` is what the pending
// queue asks for — everything that did not end up imported.
function listProcessedEmails(opts = {}) {
  const filters = [`select=*`];
  if (opts.status) filters.push(`status=eq.${encode(opts.status)}`);
  if (opts.notStatus) filters.push(`status=neq.${encode(opts.notStatus)}`);
  if (opts.from) filters.push(`received_at=gte.${encode(opts.from)}`);
  if (opts.to) filters.push(`received_at=lte.${encode(opts.to)}`);
  filters.push('order=processed_at.desc');
  filters.push(`limit=${Number(opts.limit) > 0 ? Math.floor(Number(opts.limit)) : 100}`);
  return request('GET', `processed_emails?${filters.join('&')}`);
}

module.exports = {
  fetchEmployees,
  fetchDailyHours,
  fetchDaySummaries,
  fetchDailyHoursForDate,
  upsertDailyHours,
  deleteDailyHoursForDate,
  deleteOtherBatchesForDate,
  deleteDailyHoursForBatch,
  findRowsByFileHash,
  fetchRowsByBatch,
  updateBatchWorkDate,
  restampDepartments,
  fetchOvertime,
  getProcessedEmail,
  upsertProcessedEmail,
  listProcessedEmails
};
