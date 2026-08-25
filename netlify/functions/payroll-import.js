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

const { randomUUID } = require('crypto');

const db = require('./payroll-db');
const {
  buildImport, validateWorkDate, workDateInfo, DEFAULT_TIME_ZONE
} = require('./payroll-lib');
const { planWageSync } = require('./wage-sync');
const { verifySession, getCookies } = require('./session-lib');

const TIME_ZONE = process.env.PAYROLL_TIME_ZONE || DEFAULT_TIME_ZONE;

// Netlify caps a function request at ~6 MB including base64 inflation. The real
// file is ~6.6 KB, so anything near the cap is a mistake (a whole workbook, a
// PDF scan) and is better refused with a sentence a human can act on than left
// to fail as an opaque platform 413.
const MAX_BODY_BYTES = 5 * 1024 * 1024;

// How far back `days` looks when the caller does not say.
const DEFAULT_DAY_WINDOW = 30;

// ============================================================
// HELPERS
// ============================================================

// Thrown for anything the caller can fix by sending different input; anything
// else becomes a 500. Keeping the distinction explicit stops a genuine bug from
// being reported to the user as "bad file".
class BadRequest extends Error {
  constructor(message, options) {
    super(message, options);
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

// buildImport re-reads the ZIP, the sheet and every header, so anything it (or
// xlsx-lite beneath it) throws is a statement about the file the caller chose,
// and its message is already written to be read by a human. Convert it here,
// at the one call site that knows a parse was attempted, rather than guessing
// from the message text later — a Supabase failure can mention "column" too.
function parseUpload(args) {
  try {
    return buildImport(args);
  } catch (err) {
    throw new BadRequest(err.message, { cause: err });
  }
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
  const result = parseUpload({
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
  const result = parseUpload({
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
    // Name the salaried-with-activity count too. Every salaried row is skipped
    // whatever it carries, so a file of nothing but salaried rows that DO carry
    // hours produces zero importable rows — and without saying so, "0 rows"
    // reads like a parsing failure rather than the rule working.
    const withHours = result.counts.salariedWithHoursSkipped || 0;
    throw new BadRequest(
      `${body.fileName || 'That file'} produced no importable rows ` +
      `(${result.counts.totalRows} row(s) read, ${result.counts.salariedSkipped} salaried` +
      `${withHours ? `, ${withHours} of them carrying hours or earnings` : ''}).`
    );
  }

  // The same bytes under a different date is the one duplicate that silently
  // doubles a week's payroll, and audit query 4e in SCHEMA_DAILY_HOURS.sql says
  // it must never exist. The email ingester refuses it outright; the manual path
  // has to refuse it too rather than trusting the browser to honour a warning.
  // The same bytes under the SAME date is just a re-upload and stays allowed.
  const duplicate = describeDuplicateHash(await db.findRowsByFileHash(result.fileHash), workDate);
  if (duplicate && !duplicate.sameDate && body.confirmDuplicateFile !== true) {
    throw new BadRequest(
      `This exact file is already imported as ${duplicate.workDate} ` +
      `(${duplicate.rowCount} row(s), batch ${duplicate.uploadBatchId}). ` +
      `Importing it as ${workDate} as well would count that day's payroll twice. ` +
      `Re-send with confirmDuplicateFile to import it anyway.`
    );
  }

  // Write first, prune second. The old order — delete the day, then insert —
  // was two independent PostgREST requests with no transaction around them, so
  // a 5xx, a schema-cache miss or one bad row on the insert left the day
  // deleted and not replaced. Upserting first is safe because
  // unique(work_date, employee_number) makes it idempotent: the day briefly
  // holds the old rows plus the new ones, and a failure here changes nothing.
  const written = await db.upsertDailyHours(result.rows);
  if (!written.length) {
    // return=representation always echoes what it wrote, so an empty body after
    // a non-empty write means the write did not happen. Reporting the intended
    // count here would present a no-op as a successful import.
    throw new Error(
      `Sent ${result.rows.length} row(s) for ${workDate} but Supabase returned no rows — ` +
      `the write did not take effect.`
    );
  }

  // Only now remove whoever was on the old file and not on the new one: an
  // upsert alone would leave them behind, and dropping somebody is exactly the
  // correction a re-send usually is.
  const removed = existing
    ? await db.deleteOtherBatchesForDate(workDate, result.uploadBatchId)
    : 0;

  // The wage sync runs HERE — at commit, after the hours are safely written,
  // and never at preview. Preview is a dry run: it must not create employees or
  // move a single rate. And a failed hours write must not leave wages moved,
  // which is why this is below the upsert rather than beside it.
  //
  // It is driven by result.rows — the parsed FILE — never by the roster. An
  // active employee absent from today's file keeps their rate untouched; see
  // rule 1 in wage-sync.js.
  //
  // A wage-sync failure does not fail the import. The day's hours are already
  // in by this point, so throwing would report a successful write as a failure
  // and invite a retry; the error is returned instead, and logged so Netlify's
  // alerting sees it.
  let wageSync;
  try {
    wageSync = await db.applyWageSync(
      planWageSync({ fileRows: result.rows, employees, workDate })
    );
    if (wageSync.errors.length) {
      console.error(`payroll-import commit: wage sync reported ${wageSync.errors.length} error(s):`,
        wageSync.errors.join(' | '));
    }
  } catch (err) {
    console.error('payroll-import commit: wage sync failed:', err);
    wageSync = { failed: true, error: err.message, errors: [err.message] };
  }

  return {
    uploadBatchId: result.uploadBatchId,
    inserted: written.length,
    replaced: existing ? existing.rowCount : 0,
    removed,
    wageSync,
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
      /* no money: the feed is hours only */
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

// The only two ledger states that are waiting on a person. duplicate_file and
// rejected are the ingester working correctly and saying so; a resolved row has
// already been dealt with. Listing all of them but marking these two lets the
// screen separate "needs a decision" from "logged and fine".
const ACTIONABLE_STATUSES = new Set(['pending_review', 'error']);

// Everything the email ingester logged that did not end up imported: duplicates,
// rejections, errors and anything held for review.
async function pending() {
  const emails = await db.listProcessedEmails({ notStatus: 'imported', limit: 100 });
  return {
    emails: emails.map(email => ({
      ...email,
      actionable: ACTIONABLE_STATUSES.has(email.status)
    }))
  };
}

// Closes a queue entry that a human has already dealt with by hand. Without it
// nothing can ever leave pending_review or error, so the daily missed-delivery
// check keeps mailing about the same message every morning — which is how
// people learn to ignore the one alert that matters.
async function resolveEmail(body) {
  const messageId = String(body.messageId || '').trim();
  if (!messageId) throw new BadRequest('messageId is required.');

  const record = await db.getProcessedEmail(messageId);
  if (!record) {
    throw new BadRequest(`No ingestion record found for message ${messageId}.`);
  }

  const note = String(body.note || '').trim();
  const resolvedAt = new Date().toISOString();

  // Spread the stored row back: the upsert merges on message_id, so any column
  // left out would be written back as its default and the audit trail — the
  // subject, the file hash, the batch it belonged to — would be lost.
  // `error` is the ledger's only free-text column, so the note goes there,
  // prefixed so a resolved row cannot be misread as a fresh failure, and with
  // the original detail kept alongside it.
  await db.upsertProcessedEmail({
    ...record,
    status: 'resolved',
    processed_at: resolvedAt,
    error: `Resolved ${resolvedAt}${note ? `: ${note}` : ''}` +
           (record.error ? ` — was: ${record.error}` : '')
  });

  return { messageId, status: 'resolved' };
}

const ACTIONS = {
  preview, commit, days, restamp, correctDate, deleteDay, pending, resolveEmail
};

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
    // Only an error raised deliberately as "the caller sent something it can
    // fix" is a 400. Deciding that by matching words in the message meant a
    // Supabase failure whose body happens to say "column" — PGRST204, a schema
    // cache that has not caught up — was answered as bad input and never
    // logged, so Netlify's alerting never saw the outage. Everything that is
    // not explicitly user-facing is a bug or an outage and gets logged.
    const isUserError = err instanceof BadRequest || err.name === 'BadRequest';
    if (!isUserError) console.error(`payroll-import ${action} failed:`, err);
    return fail(isUserError ? 400 : 500, err.message || 'Unexpected error');
  }
};

// Exported for the email ingester, which needs the same session-free helpers.
exports.verifySession = verifySession;
exports.getCookies = getCookies;
