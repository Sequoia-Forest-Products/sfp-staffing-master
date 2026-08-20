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

// PostgREST's query-string vocabulary, spelled as options rather than left for
// every caller to concatenate by hand. select/order are PostgREST syntax — the
// commas in a column list and the dots in `work_date.desc` are grammar, not
// data, so they are appended literally; every value that IS data goes through
// encode() at the call site. Only this module supplies them.
function withQuery(path, { select, order, limit, offset } = {}) {
  // Always emitted in the same order — select, order, offset, limit — so the
  // URL a given call produces is stable enough to assert on. offset and limit
  // are floored to integers because PostgREST rejects "limit=5e3", which is
  // what String(5000) is one careless multiplication away from.
  const parts = [];
  if (select) parts.push(`select=${select}`);
  if (order) parts.push(`order=${order}`);
  if (offset !== undefined && offset !== null) {
    parts.push(`offset=${Math.max(0, Math.floor(Number(offset)) || 0)}`);
  }
  if (limit !== undefined && limit !== null) {
    parts.push(`limit=${Math.max(1, Math.floor(Number(limit)) || 1)}`);
  }
  if (!parts.length) return path;
  return `${path}${path.includes('?') ? '&' : '?'}${parts.join('&')}`;
}

// "0-4999/17384" -> 17384. A "*" total (the count was not computed) and a
// missing header both read as null, which means "not proven", never "zero" —
// the caller has to be able to tell "there are none" from "nobody said".
function parseContentRangeTotal(header) {
  const m = /\/(\d+|\*)\s*$/.exec(String(header == null ? '' : header));
  if (!m || m[1] === '*') return null;
  return Number(m[1]);
}

// One PostgREST call. opts: { body, headers, select, order, limit, offset, count }.
//
// It resolves to { rows, contentRange, total } rather than to the rows alone.
// A paged read cannot tell a complete page from a silently capped one without
// seeing Content-Range, and a helper that returns only an array has already
// thrown that away. Everything below that wants just the rows goes through
// requestRows(), so no existing helper's return shape changes.
async function request(method, path, opts = {}) {
  const { body, count } = opts;
  const headers = { ...(opts.headers || {}) };

  // Prefer carries two unrelated things: what a write should hand back, and
  // whether a read should be counted. A caller that sets it itself (the upserts,
  // which need merge-duplicates) keeps what it set and gets the count appended;
  // a plain counted read sends count=exact alone, replacing the return=
  // representation default that means nothing on a GET.
  if (count) {
    const pref = `count=${count === true ? 'exact' : count}`;
    headers.Prefer = headers.Prefer ? `${headers.Prefer},${pref}` : pref;
  }

  const url = withQuery(path, opts);

  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/${url}`, {
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
    throw new Error(`${method} ${url} — ${err.message}${reason}`, { cause: err });
  }
  if (!res.ok) {
    throw new Error(`${method} ${url} ${res.status}: ${await res.text()}`);
  }

  // A proxy is free to strip Content-Range, and a stubbed fetch need not carry
  // headers at all, so reading it is defensive and its absence reads as null.
  const contentRange = res.headers && typeof res.headers.get === 'function'
    ? res.headers.get('content-range')
    : null;
  const envelope = rows => ({ rows, contentRange, total: parseContentRangeTotal(contentRange) });

  // DELETE and PATCH still return representation, but a 204 has no body.
  if (res.status === 204) return envelope([]);
  const text = await res.text();
  if (!text) return envelope([]);
  return envelope(JSON.parse(text));
}

// The rows-only form every helper below is built on. Keeping it separate is what
// lets request() grow a header-aware envelope without touching a dozen call
// sites in payroll-import.js and payroll-email-lib.js.
async function requestRows(method, path, opts) {
  return (await request(method, path, opts)).rows;
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

// The three columns a week index is built from. The 400-day window the OT
// report scans covers ~17,000 rows at a full mill, and pulling all 23
// daily_hours columns for every one of them just to list the weeks that have
// data is most of a megabyte of payroll detail nobody reads.
const DAILY_INDEX_COLUMNS = 'work_date,total_hours,total_earnings';

// One page of the window scan. Big enough that a normal window is one request,
// small enough to stay well inside any proxy's response limits.
const DAILY_INDEX_PAGE_SIZE = 5000;

// ============================================================
// ROSTER
// ============================================================

// employee_number and department are the two columns payroll cares about; wage
// is here for the OT report's dollar fallback, status for headcount filtering.
// The whole roster is returned, inactive people included: somebody terminated
// last week still has hours on last week's file.
function fetchEmployees() {
  return requestRows('GET',
    'employees?select=id,name,employee_number,department,wage,status&order=name.asc');
}

function fetchOvertime() {
  return requestRows('GET',
    'overtime?select=id,name,ot_type,hours,description&order=ot_type.asc,name.asc');
}

// ============================================================
// DAILY HOURS
// ============================================================

// Inclusive on both ends.
function fetchDailyHours(fromDate, toDate) {
  return requestRows('GET',
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

// The narrow projection a week picker needs, one page at a time, with the exact
// count so the caller can prove it saw everything.
//
// Two details here are load-bearing, not preference:
//
//   * `order=work_date.desc` decides which end survives if a project-level row
//     cap does cut the result short. Ordered ascending — the way fetchDailyHours
//     orders it — a cap silently drops the NEWEST rows, the current week
//     disappears from the index, and a report defaults to a stale week while
//     still answering ok. A missing old week is a smaller lie than that.
//   * `count=exact` makes PostgREST report the true number of matching rows in
//     Content-Range, so what arrived can be compared against what exists rather
//     than trusted. `total` is null when the header is missing or unparseable,
//     which means "not proven" — never "zero".
//
// Returns { rows, contentRange, total }; the caller does the paging, because
// only the caller knows how many pages it is willing to walk.
async function fetchDailyHoursIndex(fromDate, toDate, { offset = 0, limit = DAILY_INDEX_PAGE_SIZE } = {}) {
  const page = await request('GET',
    `daily_hours?work_date=gte.${encode(fromDate)}&work_date=lte.${encode(toDate)}`,
    {
      select: DAILY_INDEX_COLUMNS,
      order: 'work_date.desc',
      offset,
      limit,
      count: 'exact'
    });

  // A select answers with an array; anything else is a proxy's error page that
  // arrived with a 200, and it must not be spread into the index as rows.
  return { ...page, rows: Array.isArray(page.rows) ? page.rows : [] };
}

function findRowsByFileHash(fileHash) {
  if (!fileHash) return Promise.resolve([]);
  return requestRows('GET',
    `daily_hours?select=${DAILY_COLUMNS}&file_hash=eq.${encode(fileHash)}` +
    `&order=work_date.asc,employee_number.asc`);
}

function fetchRowsByBatch(uploadBatchId) {
  return requestRows('GET',
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
    const result = await requestRows('POST',
      'daily_hours?on_conflict=work_date,employee_number',
      { body: chunk, headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' } });
    written.push(...result);
  }
  return written;
}

async function deleteDailyHoursForDate(workDate) {
  const deleted = await requestRows('DELETE', `daily_hours?work_date=eq.${encode(workDate)}`);
  return deleted.length;
}

// Removes everything on a date that did NOT come from the batch just written.
// This is the second half of a safe overwrite: the new batch is upserted first,
// then whoever was on the old file and not on the new one is pruned. Doing it
// in that order means a failed write leaves the previous day intact, which a
// delete-then-insert pair — two independent PostgREST calls with no transaction
// around them — cannot promise.
async function deleteOtherBatchesForDate(workDate, uploadBatchId) {
  const deleted = await requestRows('DELETE',
    `daily_hours?work_date=eq.${encode(workDate)}` +
    `&upload_batch_id=neq.${encode(uploadBatchId)}`);
  return deleted.length;
}

async function deleteDailyHoursForBatch(uploadBatchId) {
  const deleted = await requestRows('DELETE',
    `daily_hours?upload_batch_id=eq.${encode(uploadBatchId)}`);
  return deleted.length;
}

// Moves every row of a batch onto a new date. date_source becomes 'manual'
// because a date a human corrected is no longer an inferred one, and the
// missed-delivery check must not treat it as machine-derived afterwards.
async function updateBatchWorkDate(uploadBatchId, newWorkDate) {
  return requestRows('PATCH',
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
      const result = await requestRows('PATCH',
        `daily_hours?id=in.(${slice.map(encode).join(',')})`,
        { body: { department, flags } });
      updated += result.length;
    }
  }

  return { scanned: rows.length, updated, stillUnassigned, changes };
}

// ============================================================
// WAGES
// ============================================================
//
// The writers behind wage-sync.js. The decisions are all made there, purely and
// testably; these four functions do nothing but write what they are handed.
//
// wage_history is append-only and the constraint is a trigger, so the service
// key does not bypass it: there is no PATCH and no DELETE here, and there never
// can be. A correction is a new row.

// One POST per call, chunked only against a bulk back-fill. A normal day moves
// a handful of rates.
async function insertWageHistory(rows) {
  const list = (rows || []).filter(Boolean);
  if (!list.length) return [];

  const written = [];
  for (let i = 0; i < list.length; i += CHUNK_SIZE) {
    written.push(...await requestRows('POST', 'wage_history', { body: list.slice(i, i + CHUNK_SIZE) }));
  }
  return written;
}

// employees.wage is TEXT, holding either an hourly rate or the literal string
// 'Salary'. Only ever called after the matching wage_history row is safely in.
async function updateEmployeeWage(employeeId, wage) {
  const id = String(employeeId || '').trim();
  if (!id) throw new Error('updateEmployeeWage needs an employee id');
  return requestRows('PATCH', `employees?id=eq.${encode(id)}`, { body: { wage } });
}

async function createEmployee(row) {
  const rows = await requestRows('POST', 'employees', { body: row });
  const created = Array.isArray(rows) ? rows[0] || null : rows;
  if (!created || !created.id) {
    // return=representation always echoes what it wrote, so no id back means no
    // row was written — and the wage_history row that follows would then be
    // attached to nobody.
    throw new Error(
      `Creating employee ${row && row.employee_number} returned no row — the insert did not take effect.`
    );
  }
  return created;
}

// unique(employee_number) means one open arrival per person. ignore-duplicates
// (ON CONFLICT DO NOTHING) rather than merge-duplicates on purpose: a re-import
// of the same day must neither fail nor move first_seen_date forward, and must
// certainly not resurrect a task somebody has already signed off. An ignored
// insert comes back as no rows, which is success, not a failure.
async function upsertSetupTask(row) {
  const rows = await requestRows('POST',
    'employee_setup_tasks?on_conflict=employee_number',
    { body: row, headers: { 'Prefer': 'resolution=ignore-duplicates,return=representation' } });
  return Array.isArray(rows) ? rows[0] || null : rows;
}

// employees.wage as text. Two decimals so the column reads like the rest of the
// roster ('24.50'), which humans do still look at.
const wageText = rate => Number(rate).toFixed(2);

// Apply a plan from wage-sync.planWageSync(). Walks plan.ops in order, because
// the order is the safety property: the history row for a change goes in before
// the employees.wage write that makes the old rate unrecoverable, and a created
// employee exists before the history row that references their id.
//
// Two behaviours are deliberate:
//
//   * One row at a time, per op, so a single bad row cannot take the rest of the
//     day's wage sync down with it. A normal day is a handful of writes.
//   * A failed write BLOCKS the rest of that employee's ops. If the history
//     insert fails, the wage update behind it is skipped — an overwrite with no
//     history is exactly what this module exists to prevent. If the create
//     fails, its history row and setup task are skipped too, because both
//     reference an employee that does not exist.
//
// Errors are collected rather than thrown: the hours for the day are already
// written by the time this runs, and turning a wage-sync failure into a failed
// import would report a successful write as a failure and invite a retry.
// The caller surfaces `errors`.
//
// writers is injectable so this can be tested without a network.
async function applyWageSync(plan, writers = {}) {
  const w = {
    insertWageHistory:  writers.insertWageHistory  || insertWageHistory,
    updateEmployeeWage: writers.updateEmployeeWage || updateEmployeeWage,
    createEmployee:     writers.createEmployee     || createEmployee,
    upsertSetupTask:    writers.upsertSetupTask    || upsertSetupTask
  };

  const applied = {
    workDate: (plan && plan.workDate) || null,
    thresholdPct: plan && plan.thresholdPct !== undefined ? plan.thresholdPct : null,
    created: [],
    ratesUpdated: 0,
    historyWritten: 0,
    setupTasks: 0,
    flagged: [],
    skipped: (plan && plan.skipped) || null,
    errors: [],
    blocked: []
  };

  const ops = (plan && plan.ops) || [];
  if (!ops.length) return applied;

  const createdIds = new Map();
  const blocked = new Set();

  // A create or a history row for a brand-new person is planned with a null
  // employee_id, because the id does not exist until the insert returns.
  const withId = row => ({
    ...row,
    employee_id: row.employee_id || createdIds.get(row.employee_number) || null
  });

  for (const op of ops) {
    const key = op.employeeNumber || null;
    if (key && blocked.has(key)) {
      applied.blocked.push(`${op.kind} for Emp # ${key} skipped — an earlier write for this person failed.`);
      continue;
    }

    try {
      if (op.kind === 'create') {
        const created = await w.createEmployee({
          name: op.create.name,
          employee_number: op.create.employeeNumber,
          wage: wageText(op.create.rate),
          status: 'Active',
          // The bullpen, spelled out rather than left to the column defaults:
          // these three being null is what employee_setup_tasks is queuing.
          department: null,
          cost_class: null,
          position_group: null
        });
        createdIds.set(op.create.employeeNumber, created.id);
        applied.created.push({ ...op.create, employeeId: created.id });

      } else if (op.kind === 'history') {
        await w.insertWageHistory([withId(op.row)]);
        applied.historyWritten++;

      } else if (op.kind === 'update') {
        await w.updateEmployeeWage(op.update.employeeId, wageText(op.update.to));
        applied.ratesUpdated++;
        if (op.update.flagged) applied.flagged.push(op.update);

      } else if (op.kind === 'setupTask') {
        await w.upsertSetupTask(withId(op.row));
        applied.setupTasks++;
      }
    } catch (err) {
      if (key) blocked.add(key);
      applied.errors.push(`${op.kind} for Emp # ${key || '(unknown)'} failed: ${err.message}`);
    }
  }

  return applied;
}

// ============================================================
// PROCESSED EMAIL LEDGER
// ============================================================
//
// Processing state lives here and never in the mailbox: info@ is a shared
// human inbox and the ingester must not flag, move or delete anything in it.

async function getProcessedEmail(messageId) {
  const rows = await requestRows('GET',
    `processed_emails?select=*&message_id=eq.${encode(messageId)}&limit=1`);
  return rows[0] || null;
}

async function upsertProcessedEmail(record) {
  const rows = await requestRows('POST',
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
  return requestRows('GET', `processed_emails?${filters.join('&')}`);
}

module.exports = {
  // The raw call, for readers that need a projection, a page or the row count.
  // Everything else here is a thin wrapper over it.
  request,
  fetchEmployees,
  fetchDailyHours,
  fetchDaySummaries,
  fetchDailyHoursForDate,
  fetchDailyHoursIndex,
  upsertDailyHours,
  deleteDailyHoursForDate,
  deleteOtherBatchesForDate,
  deleteDailyHoursForBatch,
  findRowsByFileHash,
  fetchRowsByBatch,
  updateBatchWorkDate,
  restampDepartments,
  fetchOvertime,
  // Wage sync writers, plus the applier that orders them. The decisions live in
  // wage-sync.js; nothing here decides anything.
  insertWageHistory,
  updateEmployeeWage,
  createEmployee,
  upsertSetupTask,
  applyWageSync,
  getProcessedEmail,
  upsertProcessedEmail,
  listProcessedEmails
};
