// POST /api/payroll-import — the manual side of daily payroll ingestion.
//
// Session-authed exactly like data.js. One endpoint, several actions, chosen by
// `action` in the JSON body; every response is {ok:true, ...} or
// {ok:false, error}. The upload arrives as base64 in the body rather than as
// multipart, because Netlify functions hand us a plain string body and the
// vendor's file is ~6.6 KB — a multipart parser would be more code than the
// feature.
//
// The important rule here: `commit` re-parses the uploaded bytes server-side
// and re-derives every number. The client's preview is a display artefact and
// is never trusted, so a tampered or simply stale browser tab cannot write
// dollars that the file does not contain.

const { createHmac, randomUUID } = require('crypto');

const db = require('./payroll-db');
const {
  buildImport, validateWorkDate, workDateInfo, DEFAULT_TIME_ZONE
} = require('./payroll-lib');

const SESSION_SECRET = process.env.SESSION_SECRET;
const TIME_ZONE = process.env.PAYROLL_TIME_ZONE || DEFAULT_TIME_ZONE;

// Netlify caps a function request at ~6 MB including base64 inflation. The real
// file is ~6.6 KB, so anything near the cap is a mistake (a whole workbook, a
// PDF scan) and is better refused with a sentence a human can act on than left
// to fail as an opaque platform 413.
const MAX_BODY_BYTES = 5 * 1024 * 1024;

// How far back `days` looks when the caller does not say.
const DEFAULT_DAY_WINDOW = 30;

// ============================================================
// SESSION  (identical to data.js — same cookie, same HMAC)
// ============================================================

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

// ============================================================
// HELPERS
// ============================================================

// Thrown for anything the caller can fix by sending different input; anything
// else becomes a 500. Keeping the distinction explicit stops a genuine bug from
// being reported to the user as "bad file".
class BadRequest extends Error {
  constructor(message) {
    super(message);
    this.name = 'BadRequest';
  }
}

function decodeUpload(fileBase64, fileName) {
  if (!fileBase64 || typeof fileBase64 !== 'string') {
    throw new BadRequest('No file was uploaded. Choose the payroll .xlsx and try again.');
  }
  // Tolerate a data: URL prefix, which is what a FileReader.readAsDataURL gives.
  const payload = fileBase64.includes(',') && fileBase64.slice(0, 64).includes('base64,')
    ? fileBase64.slice(fileBase64.indexOf(',') + 1)
    : fileBase64;

  const buffer = Buffer.from(payload, 'base64');
  if (!buffer.length) {
    throw new BadRequest(`${fileName || 'The uploaded file'} is empty.`);
  }
  return buffer;
}

// The rows already sitting on a date, summarised for the overwrite prompt.
function describeExisting(rows) {
  if (!rows || !rows.length) return null;
  const batches = [...new Set(rows.map(r => r.upload_batch_id))];
  const created = rows.map(r => r.created_at).filter(Boolean).sort();
  return {
    rowCount: rows.length,
    uploadBatchId: batches[0] || null,
    batchCount: batches.length,
    source: rows[0].source || null,
    createdAt: created[0] || null
  };
}

// The same file imported before — the vendor re-sending a day, or the same
// attachment forwarded twice under two different inferred dates.
function describeDuplicateHash(rows, workDate) {
  if (!rows || !rows.length) return null;
  // Prefer a match on a *different* day: that is the dangerous one, because it
  // means the same numbers are about to be counted on two dates.
  const elsewhere = rows.filter(r => r.work_date !== workDate);
  const match = (elsewhere.length ? elsewhere : rows)[0];
  return {
    workDate: match.work_date,
    uploadBatchId: match.upload_batch_id,
    createdAt: match.created_at || null,
    rowCount: rows.filter(r => r.work_date === match.work_date).length,
    sameDate: match.work_date === workDate
  };
}

// buildImport's result minus the rows themselves. The preview screen renders
// counts, totals and the department split; it has no use for 60 full rows, and
// not shipping them keeps it obvious that the client never supplies them back.
function summaryOf(result) {
  const { rows, ...rest } = result;
  return rest;
}

function shiftDate(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const stamp = Date.UTC(y, m - 1, d) + days * 86400000;
  const back = new Date(stamp);
  return `${back.getUTCFullYear()}-${String(back.getUTCMonth() + 1).padStart(2, '0')}-` +
         `${String(back.getUTCDate()).padStart(2, '0')}`;
}

function resolveRange(body) {
  const today = workDateInfo(null, TIME_ZONE).date;
  const to = body.to || today;
  const from = body.from || shiftDate(to, -DEFAULT_DAY_WINDOW);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new BadRequest('from and to must be YYYY-MM-DD dates.');
  }
  if (from > to) throw new BadRequest(`from (${from}) is after to (${to}).`);
  return { from, to };
}

// ============================================================
// ACTIONS
// ============================================================

// Parse the upload and report what committing it would do — without writing
// anything. Everything the confirm dialog needs is here: what is already on the
// day, whether this exact file has been imported before, and whether the date
// itself looks wrong.
async function preview(body) {
  const buffer = decodeUpload(body.fileBase64, body.fileName);
  const workDate = workDateInfo(body.workDate || null, TIME_ZONE).date;

  const employees = await db.fetchEmployees();
  const result = buildImport({
    fileBuffer: buffer,
    workDate,
    source: 'manual',
    dateSource: 'manual',
    employees,
    timeZone: TIME_ZONE
  });

  const [existingRows, hashRows] = await Promise.all([
    db.fetchDailyHoursForDate(workDate),
    db.findRowsByFileHash(result.fileHash)
  ]);

  return {
    preview: {
      ...summaryOf(result),
      fileName: body.fileName || null,
      existing: describeExisting(existingRows),
      duplicateFileHash: describeDuplicateHash(hashRows, workDate),
      validation: validateWorkDate(workDate, TIME_ZONE)
    }
  };
}

// Re-parses the bytes and writes. Never reads rows, totals or flags from the
// request — only the file, the date and the confirmation flag.
async function commit(body) {
  const buffer = decodeUpload(body.fileBase64, body.fileName);
  const workDate = workDateInfo(body.workDate || null, TIME_ZONE).date;

  const validation = validateWorkDate(workDate, TIME_ZONE);
  if (!validation.ok) throw new BadRequest(validation.errors.join(' '));

  const existingRows = await db.fetchDailyHoursForDate(workDate);
  const existing = describeExisting(existingRows);
  if (existing && body.confirmOverwrite !== true) {
    throw new BadRequest(
      `${workDate} already has ${existing.rowCount} row(s) imported from ${existing.source || 'an earlier upload'}. ` +
      `Re-send with confirmOverwrite to replace them.`
    );
  }

  const employees = await db.fetchEmployees();
  const result = buildImport({
    fileBuffer: buffer,
    workDate,
    source: 'manual',
    sourceSubject: body.fileName || null,
    dateSource: 'manual',
    employees,
    uploadBatchId: randomUUID(),
    timeZone: TIME_ZONE
  });

  if (!result.rows.length) {
    throw new BadRequest(
      `${body.fileName || 'That file'} produced no importable rows ` +
      `(${result.counts.totalRows} row(s) read, ${result.counts.salariedSkipped} salaried).`
    );
  }

  // Replace rather than merge on an overwrite: an upsert alone would leave
  // behind anybody who was on the old file and not on the new one, which is
  // exactly the correction a re-send usually is.
  if (existing) await db.deleteDailyHoursForDate(workDate);

  const written = await db.upsertDailyHours(result.rows);

  return {
    uploadBatchId: result.uploadBatchId,
    inserted: written.length || result.rows.length,
    replaced: existing ? existing.rowCount : 0,
    summary: { ...summaryOf(result), validation }
  };
}

// One entry per day that has data, newest first — the Daily Hours tab's list.
async function days(body) {
  const { from, to } = resolveRange(body);
  const rows = await db.fetchDaySummaries(from, to);

  const byDate = new Map();
  for (const row of rows) {
    if (!byDate.has(row.work_date)) {
      const info = workDateInfo(row.work_date, TIME_ZONE);
      byDate.set(row.work_date, {
        workDate: info.date,
        isScheduledDay: info.isScheduledDay,
        dayName: info.dayName,
        rowCount: 0,
        employees: 0,
        totalHours: 0,
        otHours: 0,
        totalEarnings: 0,
        source: row.source || null,
        dateSource: row.date_source || null,
        uploadBatchId: row.upload_batch_id || null,
        createdAt: row.created_at || null,
        emailReceivedAt: row.email_received_at || null,
        flagCount: 0,
        unassignedCount: 0,
        _employees: new Set()
      });
    }
    const day = byDate.get(row.work_date);
    day.rowCount++;
    day.totalHours += Number(row.total_hours) || 0;
    day.otHours += Number(row.ot_hours) || 0;
    day.totalEarnings += Number(row.total_earnings) || 0;
    day._employees.add(row.employee_number);
    if (Array.isArray(row.flags) && row.flags.length) day.flagCount++;
    if (!row.department) day.unassignedCount++;
    // Earliest created_at wins so the timestamp describes the import, not the
    // last row PostgREST happened to return.
    if (row.created_at && (!day.createdAt || row.created_at < day.createdAt)) {
      day.createdAt = row.created_at;
    }
  }

  const out = [...byDate.values()].map(day => {
    const { _employees, ...rest } = day;
    return {
      ...rest,
      employees: _employees.size,
      totalHours: Math.round(rest.totalHours * 100) / 100,
      otHours: Math.round(rest.otHours * 100) / 100,
      totalEarnings: Math.round(rest.totalEarnings * 100) / 100
    };
  }).sort((a, b) => (a.workDate < b.workDate ? 1 : a.workDate > b.workDate ? -1 : 0));

  return { from, to, days: out };
}

async function restamp(body) {
  const { from, to } = resolveRange(body);
  return db.restampDepartments(from, to);
}

// Moves a whole batch to a different day — the fix for a file that landed under
// the wrong inferred date. Refuses to merge two batches onto one day, because
// unique(work_date, employee_number) would resolve that by silently dropping
// half of somebody's payroll.
async function correctDate(body) {
  const uploadBatchId = String(body.uploadBatchId || '').trim();
  if (!uploadBatchId) throw new BadRequest('uploadBatchId is required.');

  const newWorkDate = workDateInfo(body.newWorkDate || null, TIME_ZONE).date;
  const validation = validateWorkDate(newWorkDate, TIME_ZONE);
  if (!validation.ok) throw new BadRequest(validation.errors.join(' '));

  const [batchRows, targetRows] = await Promise.all([
    db.fetchRowsByBatch(uploadBatchId),
    db.fetchDailyHoursForDate(newWorkDate)
  ]);

  if (!batchRows.length) throw new BadRequest(`No rows found for batch ${uploadBatchId}.`);

  const foreign = targetRows.filter(r => r.upload_batch_id !== uploadBatchId);
  if (foreign.length) {
    throw new BadRequest(
      `${newWorkDate} already holds ${foreign.length} row(s) from a different import ` +
      `(batch ${foreign[0].upload_batch_id}). Delete that day first, then move this batch.`
    );
  }

  const fromDate = batchRows[0].work_date;
  const moved = await db.updateBatchWorkDate(uploadBatchId, newWorkDate);

  return {
    moved: moved.length || batchRows.length,
    from: fromDate,
    workDate: newWorkDate,
    validation
  };
}

async function deleteDay(body) {
  const workDate = String(body.workDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) {
    throw new BadRequest('workDate must be a YYYY-MM-DD date.');
  }
  const deleted = await db.deleteDailyHoursForDate(workDate);
  return { workDate, deleted };
}

// Everything the email ingester logged that did not end up imported: duplicates,
// rejections, errors and anything held for review.
async function pending() {
  const emails = await db.listProcessedEmails({ notStatus: 'imported', limit: 100 });
  return { emails };
}

const ACTIONS = { preview, commit, days, restamp, correctDate, deleteDay, pending };

// ============================================================
// HANDLER
// ============================================================

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const fail = (statusCode, error) => ({ statusCode, headers, body: JSON.stringify({ ok: false, error }) });

  const session = verifySession(getCookies(event).sfp_session || '');
  if (!session) {
    return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'Unauthorized' }) };
  }

  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed — use POST.');

  const rawBody = event.body || '';
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
    return fail(400,
      `That upload is too large (limit ${Math.round(MAX_BODY_BYTES / 1024 / 1024)} MB). ` +
      `The payroll export is only a few KB — check you selected the right file.`);
  }

  let body;
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    return fail(400, 'Request body is not valid JSON.');
  }

  const action = String(body.action || '').trim();
  const run = Object.prototype.hasOwnProperty.call(ACTIONS, action) ? ACTIONS[action] : null;
  if (!run) {
    return fail(400, `Unknown action ${JSON.stringify(action)}. Expected one of: ${Object.keys(ACTIONS).join(', ')}.`);
  }

  try {
    const result = await run(body);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ...result }) };
  } catch (err) {
    // Anything raised by payroll-lib (a missing column, an unreadable file) is
    // the user's input too, and its message is written to be read by a human.
    const isUserError = err instanceof BadRequest || err.name === 'BadRequest' || /\b(column|sheet|\.xlsx|ZIP)\b/i.test(err.message || '');
    if (!isUserError) console.error(`payroll-import ${action} failed:`, err);
    return fail(isUserError ? 400 : 500, err.message || 'Unexpected error');
  }
};

// Exported for the email ingester, which needs the same session-free helpers.
exports.verifySession = verifySession;
exports.getCookies = getCookies;
