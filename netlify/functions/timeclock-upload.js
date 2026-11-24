// POST /api/timeclock-upload — manual timeclock uploads, daily and weekly.
//
// Replaces the automatic BBSI email import (switched off; see
// timeclock-config.js). A person uploads every file and states what it covers:
//
//   DAILY   one or more files, each with its own work date, confirmed before
//           anything is written. Each day is REPLACED in one transaction
//           through replace_hours() — the same path Settings → Daily Hours
//           used — and marked provisional.
//   WEEKLY  the Wednesday file for the previous Monday–Sunday. A CHECK ONLY:
//           stored as week totals per person (timeclock_week_totals) and
//           compared with the sum of the daily rows. It never writes a day
//           row. Corrections come from re-uploaded daily files, and each one
//           re-runs its week's comparison.
//
// Session-authed like every endpoint. Everyone on the access list may read;
// only the uploaders in timeclock-config.js may commit or accept.
//
// Like payroll-import, commit re-parses the bytes and re-derives every number
// and every check. The browser's preview is never trusted.

const { randomUUID } = require('crypto');

const db = require('./payroll-db');
const { buildImport, validateWorkDate } = require('./payroll-lib');
const { classifyRows } = require('./hours-import-lib');
const { verifySession, getCookies } = require('./session-lib');
const { pacificParts } = require('./alerts-lib');
const {
  TIME_ZONE, DAILY_UPLOAD, WEEKLY_UPLOAD, DAILY_GUARD, canUpload
} = require('./timeclock-config');
const lib = require('./timeclock-upload-lib');

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round2 = n => Math.round(num(n) * 100) / 100;

class BadRequest extends Error {
  constructor(message) { super(message); this.name = 'BadRequest'; }
}
class Forbidden extends Error {
  constructor(message) { super(message); this.name = 'Forbidden'; }
}

function decodeUpload(fileBase64, fileName) {
  if (!fileBase64 || typeof fileBase64 !== 'string') {
    throw new BadRequest(`No file was uploaded${fileName ? ' for ' + fileName : ''}.`);
  }
  const payload = fileBase64.slice(0, 64).includes('base64,')
    ? fileBase64.slice(fileBase64.indexOf(',') + 1) : fileBase64;
  const buffer = Buffer.from(payload, 'base64');
  if (!buffer.length) throw new BadRequest(`${fileName || 'The uploaded file'} is empty.`);
  return buffer;
}

function parse(args) {
  try {
    return buildImport(args);
  } catch (err) {
    throw new BadRequest(`${args.sourceSubject || 'That file'}: ${err.message}`);
  }
}

function requireDate(value, label) {
  const s = String(value || '').trim();
  if (!lib.isIsoDate(s)) throw new BadRequest(`${label} must be a YYYY-MM-DD date.`);
  return s;
}

function requireUploader(body) {
  if (!canUpload(body.__user)) {
    throw new Forbidden('Only the timeclock uploaders (Peter and Axeri) can commit uploads. You can view everything here.');
  }
}

function today(now = new Date()) { return pacificParts(now, TIME_ZONE).date; }

// ---------------------------------------------------------------------------
// Daily: everything a preview or a commit needs to know about one file
// ---------------------------------------------------------------------------

// Recent day totals, for the "looks like a weekly file" test. A day that itself
// looks weekly (anyone above 24 hours) is left out, so a mistake already in the
// table cannot raise the bar for the next one.
async function trailingDayTotals(workDate) {
  const from = lib.addDays(workDate, -DAILY_GUARD.lookbackDays);
  const to = lib.addDays(workDate, DAILY_GUARD.lookbackDays);
  const rows = await db.fetchDailyHoursAll(from, to);
  const byDay = new Map();
  for (const r of rows || []) {
    const d = String(r.work_date).slice(0, 10);
    if (d === workDate) continue;
    if (!byDay.has(d)) byDay.set(d, { total: 0, max: 0 });
    const t = byDay.get(d);
    t.total += num(r.total_hours);
    t.max = Math.max(t.max, num(r.total_hours));
  }
  return [...byDay.values()].filter(t => t.max <= DAILY_GUARD.maxPersonHours).map(t => round2(t.total));
}

async function assessDaily({ fileName, fileBase64, workDate, employees, exclusions, now }) {
  const buffer = decodeUpload(fileBase64, fileName);
  const date = requireDate(workDate, `The work date for ${fileName || 'this file'}`);
  const uploadBatchId = randomUUID();
  const result = parse({
    fileBuffer: buffer, workDate: date, source: 'manual', sourceSubject: fileName || null,
    dateSource: 'manual', employees, uploadBatchId, timeZone: TIME_ZONE
  });
  const classified = classifyRows({
    rows: result.rows, salariedRows: result.salariedRows, employees, exclusions
  });

  const weekStart = lib.weekStartOf(date);
  const [existingRows, hashRows, weekHash, totals, hoursDays, week] = await Promise.all([
    db.fetchDailyHoursForDate(date),
    db.findRowsByFileHash(result.fileHash),
    db.findWeekByFileHash(result.fileHash),
    trailingDayTotals(date),
    db.fetchHoursDays(date, date),
    db.fetchTimeclockWeek(weekStart)
  ]);

  const validation = validateWorkDate(date, TIME_ZONE, now);
  const look = lib.weeklyLook({ rows: result.rows, salariedRows: result.salariedRows, trailingDayTotals: totals });
  const fileNameDate = lib.dateFromFileName(fileName, today(now));

  const errors = [...validation.errors];
  if (look.blocked) {
    errors.push(`This looks like a WEEKLY file, not a day: ${look.reasons.join(' ')} ` +
      `Upload it under Weekly reconciliation instead.`);
  }
  if (weekHash && weekHash.length) {
    errors.push(`This exact file is already stored as the weekly file for the week of ${weekHash[0].week_start}.`);
  }

  const warnings = [...validation.warnings];
  if (fileNameDate && fileNameDate !== date) {
    warnings.push(`The file name says ${fileNameDate}, but you chose ${date}. Check the date before committing.`);
  }
  // Salaried rows are counted in the held figure already; one line each would
  // bury anything worth reading.
  for (const a of result.anomalies || []) {
    if (a.type !== 'salaried_with_hours') warnings.push(a.detail || String(a.type));
  }

  const elsewhere = (hashRows || []).filter(r => String(r.work_date).slice(0, 10) !== date);
  const duplicate = elsewhere.length ? {
    workDate: String(elsewhere[0].work_date).slice(0, 10),
    rowCount: elsewhere.filter(r => r.work_date === elsewhere[0].work_date).length
  } : null;

  const existing = existingRows && existingRows.length ? {
    rowCount: existingRows.length,
    totalHours: round2(existingRows.reduce((s, r) => s + num(r.total_hours), 0)),
    otHours: round2(existingRows.reduce((s, r) => s + num(r.ot_hours), 0)),
    source: existingRows[0].source || null,
    createdAt: existingRows.map(r => r.created_at).filter(Boolean).sort()[0] || null
  } : null;
  const dayStatus = hoursDays && hoursDays[0] ? hoursDays[0].status : null;
  const reconciled = dayStatus === 'reconciled' ||
    !!(week && (week.status === 'reconciled' || week.status === 'accepted'));

  const heldBy = reason => classified.held.filter(h => h.reason === reason).length;
  const counted = classified.counted;
  return {
    result, classified, buffer,
    preview: {
      fileName: fileName || null,
      workDate: date,
      dayName: result.dayName,
      fileHash: result.fileHash,
      fileNameDate,
      counted: counted.length,
      totalHours: round2(counted.reduce((s, r) => s + num(r.total_hours), 0)),
      otHours: round2(counted.reduce((s, r) => s + num(r.ot_hours), 0)),
      held: {
        salaried: heldBy('salaried'),
        external: heldBy('external'),
        unknown: heldBy('unknown'),
        unknownPeople: classified.unknown.map(u => ({ employeeNumber: u.employeeNumber, name: u.name, hours: u.hours }))
      },
      looksWeekly: look,
      existing,
      dayStatus,
      reconciled,
      weekStatus: week ? week.status : null,
      duplicateFile: duplicate,
      errors,
      warnings,
      blocked: errors.length > 0,
      needs: {
        confirmOverwrite: !!existing,
        confirmReconciled: reconciled,
        confirmDuplicateFile: !!duplicate
      }
    }
  };
}

async function suggest(body, { now }) {
  const names = Array.isArray(body.fileNames) ? body.fileNames.map(String) : [];
  return { today: today(now), suggestions: lib.suggestDates(names, today(now)) };
}

async function previewDaily(body, { now }) {
  const files = Array.isArray(body.files) ? body.files : [];
  if (!files.length) throw new BadRequest('Choose at least one daily file.');
  const [employees, exclusions] = await Promise.all([db.fetchEmployees(), db.fetchExclusions()]);

  const previews = [];
  for (const f of files) {
    try {
      previews.push((await assessDaily({ ...f, employees, exclusions, now })).preview);
    } catch (err) {
      if (!(err instanceof BadRequest)) throw err;
      previews.push({ fileName: f.fileName || null, workDate: f.workDate || null,
        errors: [err.message], warnings: [], blocked: true, needs: {} });
    }
  }

  // Inside one batch: two files on one date, or one file twice.
  const byDate = new Map(), byHash = new Map();
  previews.forEach((p, i) => {
    if (p.workDate) byDate.set(p.workDate, [...(byDate.get(p.workDate) || []), i]);
    if (p.fileHash) byHash.set(p.fileHash, [...(byHash.get(p.fileHash) || []), i]);
  });
  for (const [date, idx] of byDate) {
    if (idx.length < 2) continue;
    for (const i of idx) {
      previews[i].errors.push(`${idx.length} files in this upload are dated ${date}. Each file needs its own day.`);
      previews[i].blocked = true;
    }
  }
  for (const idx of byHash.values()) {
    if (idx.length < 2) continue;
    for (const i of idx) {
      previews[i].errors.push(`The same file is in this upload ${idx.length} times, under ` +
        `${idx.map(j => previews[j].workDate).join(' and ')}.`);
      previews[i].blocked = true;
    }
  }
  return { previews };
}

async function commitDaily(body, { now }) {
  requireUploader(body);
  const [employees, exclusions] = await Promise.all([db.fetchEmployees(), db.fetchExclusions()]);
  const { result, classified, preview } = await assessDaily({ ...body, employees, exclusions, now });

  if (preview.blocked) throw new BadRequest(preview.errors.join(' '));
  if (preview.existing && body.confirmOverwrite !== true) {
    throw new BadRequest(`${preview.workDate} already has ${preview.existing.rowCount} row(s) ` +
      `(${preview.existing.totalHours} hours). Confirm the replacement to overwrite them.`);
  }
  if (preview.reconciled && body.confirmReconciled !== true) {
    throw new BadRequest(`${preview.workDate} has already been reconciled by a weekly file. ` +
      `Confirm explicitly to overwrite a reconciled day.`);
  }
  if (preview.duplicateFile && body.confirmDuplicateFile !== true) {
    throw new BadRequest(`This exact file is already imported as ${preview.duplicateFile.workDate}. ` +
      `Importing it as ${preview.workDate} as well would count that day twice.`);
  }
  if (!classified.counted.length && !classified.held.length && result.counts.totalRows > 0) {
    throw new BadRequest(`${body.fileName || 'That file'} produced no importable rows.`);
  }

  const written = await db.replaceHours({
    importMeta: {
      source: 'manual',
      file_hash: result.fileHash,
      subject: body.fileName || null,
      created_by: body.__user || null
    },
    dates: [preview.workDate],
    rows: classified.counted,
    held: classified.held
  });

  // The week's comparison, re-run now that one of its days changed.
  const week = await refreshWeek(lib.weekStartOf(preview.workDate), { employees, exclusions });
  await evaluateAlerts();

  return {
    workDate: preview.workDate,
    importId: written ? written.import_id : null,
    inserted: written ? written.counted : classified.counted.length,
    held: written ? written.held : classified.held.length,
    replaced: written ? written.replaced : (preview.existing ? preview.existing.rowCount : 0),
    newEmployees: classified.unknown,
    week: week ? weekSummary(week) : null
  };
}

async function evaluateAlerts() {
  try {
    await require('./alerts-engine').runAlertEvaluation({ db });
  } catch (err) {
    console.warn('timeclock-upload: alert evaluation failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Weekly
// ---------------------------------------------------------------------------

function requireMonday(value) {
  const s = requireDate(value, 'The week');
  if (lib.isoDow(s) !== 1) throw new BadRequest(`${s} is not a Monday. Pick the Monday the week starts on.`);
  return s;
}

async function assessWeekly({ fileName, fileBase64, weekStart, now }) {
  const buffer = decodeUpload(fileBase64, fileName);
  const start = requireMonday(weekStart);
  const end = lib.addDays(start, 6);
  const errors = [], warnings = [];
  if (end >= today(now)) errors.push(`The week of ${start} has not finished yet (it ends ${end}).`);

  const employees = await db.fetchEmployees();
  const result = parse({
    fileBuffer: buffer, workDate: start, source: 'manual', sourceSubject: fileName || null,
    dateSource: 'manual', employees, timeZone: TIME_ZONE
  });
  const rows = [...result.rows, ...result.salariedRows].map(r => ({
    employee_number: r.employee_number, last_name: r.last_name || null, first_name: r.first_name || null,
    is_salary: !!r.is_salary, pay_rate: r.pay_rate == null ? null : r.pay_rate,
    regular_hours: num(r.regular_hours), ot_hours: num(r.ot_hours), total_hours: num(r.total_hours),
    total_earnings: r.total_earnings == null ? null : r.total_earnings
  }));

  const [existingWeek, weekHash, dayHash] = await Promise.all([
    db.fetchTimeclockWeek(start),
    db.findWeekByFileHash(result.fileHash),
    db.findRowsByFileHash(result.fileHash)
  ]);
  if (dayHash && dayHash.length) {
    errors.push(`This exact file is already imported as the DAILY file for ${String(dayHash[0].work_date).slice(0, 10)}.`);
  }
  const otherWeek = (weekHash || []).find(w => String(w.week_start).slice(0, 10) !== start);
  if (otherWeek) {
    errors.push(`This exact file is already stored as the weekly file for the week of ${String(otherWeek.week_start).slice(0, 10)}.`);
  }
  if (!rows.some(r => r.total_hours > DAILY_GUARD.maxPersonHours)) {
    warnings.push(`Nobody in this file has more than ${DAILY_GUARD.maxPersonHours} hours. ` +
      `Check it is the weekly file and not a single day.`);
  }
  // Per-day anomalies (a "long day") are meaningless on week totals.
  for (const a of result.anomalies || []) {
    if (!['salaried_with_hours', 'long_day'].includes(a.type)) warnings.push(a.detail || String(a.type));
  }

  return {
    rows, result,
    preview: {
      fileName: fileName || null,
      weekStart: start,
      weekEnd: end,
      fileHash: result.fileHash,
      people: rows.length,
      totalHours: round2(rows.filter(r => !r.is_salary).reduce((s, r) => s + r.total_hours, 0)),
      otHours: round2(rows.filter(r => !r.is_salary).reduce((s, r) => s + r.ot_hours, 0)),
      existing: existingWeek ? { status: existingWeek.status, uploadedAt: existingWeek.uploaded_at,
        uploadedBy: existingWeek.uploaded_by, fileName: existingWeek.file_name } : null,
      errors, warnings,
      blocked: errors.length > 0,
      needs: { confirmReplace: !!existingWeek }
    }
  };
}

async function previewWeekly(body, { now }) {
  const { rows, preview } = await assessWeekly({ ...body, now });
  // What the comparison would say, without storing anything.
  const comparison = await compareFor(preview.weekStart, rows);
  return { preview: { ...preview, comparison: compactComparison(comparison) } };
}

async function commitWeekly(body, { now }) {
  requireUploader(body);
  const { rows, preview } = await assessWeekly({ ...body, now });
  if (preview.blocked) throw new BadRequest(preview.errors.join(' '));
  if (preview.existing && body.confirmReplace !== true) {
    throw new BadRequest(`The week of ${preview.weekStart} already has a weekly file. Confirm to replace it.`);
  }
  await db.replaceWeekTotals({
    week: { week_start: preview.weekStart, file_hash: preview.fileHash, file_name: body.fileName || null,
            uploaded_by: body.__user || null },
    rows
  });
  const week = await refreshWeek(preview.weekStart);
  await evaluateAlerts();
  return { week: weekSummary(week), comparison: week ? compactComparison(week.comparison) : null };
}

async function compareFor(weekStart, weeklyRows, ctx = {}) {
  const end = lib.addDays(weekStart, 6);
  const [employees, exclusions, dailyRows, heldRows, hoursDays] = await Promise.all([
    ctx.employees || db.fetchEmployees(),
    ctx.exclusions || db.fetchExclusions(),
    db.fetchDailyHours(weekStart, end),
    db.fetchHeldRows({ from: weekStart, to: end }),
    db.fetchHoursDays(weekStart, end)
  ]);
  return lib.compareWeek({
    weekStart, weeklyRows, dailyRows: dailyRows || [], heldRows: heldRows || [],
    employees: employees || [], exclusions: exclusions || [],
    uploadedDates: (hoursDays || []).map(h => String(h.work_date).slice(0, 10))
  });
}

// Re-run a week's comparison and store it, with the status that follows. A
// week with no weekly file has nothing to compare and is left alone.
async function refreshWeek(weekStart, ctx = {}) {
  const week = await db.fetchTimeclockWeek(weekStart);
  if (!week) return null;
  const totals = await db.fetchWeekTotals(weekStart);
  const comparison = await compareFor(weekStart, totals || [], ctx);
  const status = lib.nextWeekStatus({ week, comparison });
  const nowIso = new Date().toISOString();
  const patch = {
    comparison, compared_at: nowIso, status,
    reconciled_at: status === 'reconciled' ? (week.status === 'reconciled' && week.reconciled_at) || nowIso : null
  };
  if (status === 'open' && week.status === 'accepted') {
    // The variances moved since they were accepted; the acceptance no longer
    // describes the week.
    Object.assign(patch, { accepted_by: null, accepted_at: null, accept_note: null, accepted_variances: null });
  }
  await db.updateTimeclockWeek(weekStart, patch);

  const uploaded = comparison.dates.filter(d => !comparison.daysNotUploaded.includes(d));
  if (status === 'reconciled' || status === 'accepted') await db.setDaysStatus(uploaded, 'reconciled');
  else if (week.status === 'reconciled' || week.status === 'accepted') await db.setDaysStatus(uploaded, 'provisional');
  return { ...week, ...patch };
}

function compactComparison(c) {
  if (!c) return null;
  return {
    weekStart: c.weekStart, weekEnd: c.weekEnd, dates: c.dates, daysNotUploaded: c.daysNotUploaded,
    matched: c.matched, totals: c.totals, variances: c.variances
  };
}

function weekSummary(week) {
  if (!week) return null;
  const c = week.comparison || null;
  return {
    weekStart: String(week.week_start).slice(0, 10),
    weekEnd: String(week.week_end).slice(0, 10),
    status: week.status,
    fileName: week.file_name || null,
    uploadedBy: week.uploaded_by || null,
    uploadedAt: week.uploaded_at || null,
    comparedAt: week.compared_at || null,
    acceptedBy: week.accepted_by || null,
    acceptedAt: week.accepted_at || null,
    acceptNote: week.accept_note || null,
    varianceCount: c && c.totals ? c.totals.varianceCount : null,
    hoursDiff: c && c.totals ? c.totals.hoursDiff : null,
    absHoursOff: c && c.totals ? c.totals.absHoursOff : null,
    dollarsDiff: c && c.totals ? c.totals.dollarsDiff : null
  };
}

async function weekDetail(body) {
  const weekStart = requireMonday(body.weekStart);
  const week = await refreshWeek(weekStart);
  return { week: weekSummary(week), comparison: week ? compactComparison(week.comparison) : null };
}

async function acceptWeek(body) {
  requireUploader(body);
  const weekStart = requireMonday(body.weekStart);
  const note = String(body.note || '').trim();
  if (note.length < 3) throw new BadRequest('Say why the remaining variances are accepted — the note is required.');
  const week = await refreshWeek(weekStart);
  if (!week) throw new BadRequest(`No weekly file has been uploaded for the week of ${weekStart}.`);
  if (week.status === 'reconciled') return { week: weekSummary(week), alreadyReconciled: true };

  const variances = week.comparison.variances;
  await db.updateTimeclockWeek(weekStart, {
    status: 'accepted', accepted_by: body.__user || null, accepted_at: new Date().toISOString(),
    accept_note: note, accepted_variances: variances
  });
  const c = week.comparison;
  await db.setDaysStatus(c.dates.filter(d => !c.daysNotUploaded.includes(d)), 'reconciled');
  await evaluateAlerts();
  const after = await db.fetchTimeclockWeek(weekStart);
  return { week: weekSummary(after) };
}

// ---------------------------------------------------------------------------
// Overview: the schedule — what was due, what is in, what is still owed
// ---------------------------------------------------------------------------

const OVERVIEW_DAYS = 21;
const OVERVIEW_WEEKS = 8;

async function overview(body, { now, user }) {
  const clock = pacificParts(now, TIME_ZONE);
  const t = clock.date;
  const yesterday = lib.addDays(t, -1);
  const from = lib.addDays(t, -OVERVIEW_DAYS);
  const weeksFrom = lib.addDays(lib.weekStartOf(t), -7 * OVERVIEW_WEEKS);

  const [hoursDays, daily, weeks] = await Promise.all([
    db.fetchHoursDays(from, yesterday),
    db.fetchDailyHoursAll(from, yesterday),
    db.fetchTimeclockWeeks({ from: weeksFrom })
  ]);
  const status = new Map((hoursDays || []).map(h => [String(h.work_date).slice(0, 10), h.status]));
  const sums = new Map();
  for (const r of daily || []) {
    const d = String(r.work_date).slice(0, 10);
    const s = sums.get(d) || { people: 0, hours: 0, ot: 0 };
    s.people++; s.hours += num(r.total_hours); s.ot += num(r.ot_hours);
    sums.set(d, s);
  }
  const pastDue = due => t > due || (t === due && clock.hour >= DAILY_UPLOAD.dueHour);

  const days = [];
  for (let d = yesterday; d >= from; d = lib.addDays(d, -1)) {
    const due = lib.dailyDueDate(d);
    const s = sums.get(d) || { people: 0, hours: 0, ot: 0 };
    const uploaded = status.has(d);
    days.push({
      workDate: d, dow: lib.isoDow(d), dueDate: due, uploaded,
      status: status.get(d) || null,
      people: s.people, totalHours: round2(s.hours), otHours: round2(s.ot),
      overdue: !uploaded && d >= DAILY_UPLOAD.firstWorkDate && pastDue(due),
      owed: d >= DAILY_UPLOAD.firstWorkDate
    });
  }

  const byWeek = new Map((weeks || []).map(w => [String(w.week_start).slice(0, 10), w]));
  const lastDone = lib.lastCompletedWeekStart(t);
  const weekList = [];
  for (let w = lastDone; w >= weeksFrom; w = lib.addDays(w, -7)) {
    const row = byWeek.get(w);
    const due = lib.weeklyDueDate(w);
    weekList.push({
      ...(row ? weekSummary(row) : { weekStart: w, weekEnd: lib.addDays(w, 6), status: null }),
      dueDate: due,
      uploaded: !!row,
      owed: w >= WEEKLY_UPLOAD.firstWeekStart,
      overdue: !row && w >= WEEKLY_UPLOAD.firstWeekStart &&
        (t > due || (t === due && clock.hour >= WEEKLY_UPLOAD.dueHour))
    });
  }

  return {
    today: t,
    canUpload: canUpload(user),
    defaultWeekStart: lastDone,
    dailyDueHour: DAILY_UPLOAD.dueHour,
    weeklyDue: { dayOfWeek: WEEKLY_UPLOAD.dueDayOfWeek, hour: WEEKLY_UPLOAD.dueHour },
    days,
    weeks: weekList
  };
}

const ACTIONS = {
  overview, suggest, previewDaily, commitDaily, previewWeekly, commitWeekly,
  week: weekDetail, acceptWeek
};

exports.handler = async (event, context, { now = new Date() } = {}) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const fail = (statusCode, error) => ({ statusCode, headers, body: JSON.stringify({ ok: false, error }) });

  const session = verifySession(getCookies(event).sfp_session || '');
  if (!session) return fail(401, 'Unauthorized');
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed — use POST.');

  const rawBody = event.body || '';
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
    return fail(400, 'That upload is too large. The timeclock export is a few KB — check you selected the right files.');
  }
  let body;
  try { body = JSON.parse(rawBody || '{}'); } catch { return fail(400, 'Request body is not valid JSON.'); }

  const action = String(body.action || '').trim();
  const run = Object.prototype.hasOwnProperty.call(ACTIONS, action) ? ACTIONS[action] : null;
  if (!run) return fail(400, `Unknown action ${JSON.stringify(action)}. Expected one of: ${Object.keys(ACTIONS).join(', ')}.`);

  try {
    const user = session.email || null;
    const result = await run({ ...body, __user: user }, { now, user });
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ...result }) };
  } catch (err) {
    if (err instanceof Forbidden) return fail(403, err.message);
    if (err instanceof BadRequest) return fail(400, err.message);
    console.error(`timeclock-upload ${action} failed:`, err);
    return fail(500, err.message || 'Unexpected error');
  }
};

exports.__private = { refreshWeek, assessDaily, compareFor };
