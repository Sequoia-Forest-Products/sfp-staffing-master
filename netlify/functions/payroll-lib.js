// Pure logic for the daily payroll import. No network, no database, no clock
// except the one you hand it — everything here is driven by its arguments so
// the HTTP endpoint (payroll-import.js), the email ingester and the unit tests
// all run the identical code path.
//
// The source is the payroll vendor's "Work Summary Payroll" export: one sheet,
// one header row, one row per employee, and NO date column anywhere. The work
// date is supplied by the caller (picked by a human, or inferred from the
// email's received timestamp) — this module never guesses it.
//
// Two rules here are worth reading before changing anything:
//
//   1. Dollars are a residual, not a formula. total_earnings is the payroll
//      system's own blended figure and is stored verbatim; ot_dollars is
//      whatever is left after regular_hours * pay_rate. California 4x10 pays
//      1.5x from 10-12 hours and 2.0x above 12, so ot_hours * rate * 1.5
//      undercounts the double-time tier by ~3%. Never "simplify" it back.
//
//   2. Employees are matched by employee_number and nothing else. The roster
//      has two people named Smith and several compound surnames (Acosta Ruiz,
//      Salazar De Leon, Sanchez Lopez) that the two systems spell differently.
//      Name matching would silently attribute one person's overtime to another.

const crypto = require('crypto');

// The payroll vendor sends at ~6:04 AM Pacific, so payroll dates are Pacific
// dates. birthday-lib.js uses America/Boise for the mill's own clock — these
// are two different questions and must not be unified.
const DEFAULT_TIME_ZONE = process.env.PAYROLL_TIME_ZONE || 'America/Los_Angeles';

const EXPECTED_SHEET = 'Work Summary Payroll';

const EXPECTED_HEADERS = [
  'Emp #', 'Last Name', 'First Name', 'Is Salary',
  'Pay Rate', 'Regular', 'OT', 'Total Hours', 'Total Earnings'
];

// The PRODUCTION reporting departments, plus the bucket that null lands
// in. The bucket is always shown: hiding unassigned hours is how a report
// quietly stops adding up. Clean-up is the hourly mill clean-up crew — an
// ordinary production department with no special handling anywhere.
const DEPARTMENTS = ['Maintenance', 'Saw Filing', 'Shipping', 'Production', 'Log Yard', 'Clean-up'];
const UNASSIGNED = 'Unassigned';

// NAMING: the constant is NON_PRODUCTION and the value is 'SG&A'. That is not a
// mistake. SG&A IS the non-production bucket — the constant names the ROLE, the
// string is the label the database CHECK constraint now uses for it. The label
// used to be 'Non-Production'; the role is unchanged, so the constant keeps its
// name instead of churning every caller for a rename that says nothing new.
//
// It is the one value employees.department accepts that is not a production
// department: office / salaried staff, who have no home among the production
// departments. The back-fill screen
// requires a department for every active employee, so without an explicit value
// for these people the only option is blank — and blank is indistinguishable
// from "nobody has got to this row yet", which is exactly what that screen's
// counter is trying to drive to zero.
//
// It is NOT in DEPARTMENTS, and the two lists differing is the point rather
// than an inconsistency to tidy up:
//   DEPARTMENTS             the production breakdown this import reports over
//   ASSIGNABLE_DEPARTMENTS  every value employees.department may legally hold
//
// Department is snapshotted from employees.department at import, so an SG&A
// employee with hours imports exactly like anybody else — not rejected, not
// blanked, no flag, and the '&' is carried through verbatim. Its only effect
// here is the bucket's position in the breakdown. SG&A staff are salaried and
// their all-zero rows are dropped above, so this bucket should normally be
// empty; ot-report-lib.js is where a non-empty one is surfaced as a finding.
const NON_PRODUCTION = 'SG&A';
const ASSIGNABLE_DEPARTMENTS = [...DEPARTMENTS, NON_PRODUCTION];

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// A residual this small is float noise or the payroll system's own rounding,
// not a disagreement worth a human's attention.
const RESIDUAL_TOLERANCE = 1.00;

// More than a week between the work date and today means somebody is entering
// history — legitimate, but worth saying out loud before it is committed.
const STALE_DATE_WARNING_DAYS = 7;

// ============================================================
// NUMBERS AND IDS
// ============================================================

// Half-away-from-zero at two decimals. Math.round() alone rounds -0.005 to -0,
// which then fails a strictEqual against 0, and loses the half-cent on the
// negative residuals we specifically want to see.
function round2(n) {
  if (!Number.isFinite(n)) return 0;
  const sign = n < 0 ? -1 : 1;
  const rounded = sign * Math.round(Math.abs(n) * 100 + Number.EPSILON) / 100;
  return rounded === 0 ? 0 : rounded;
}

// The live export delivers zero-padded four-character ids ('0319'); an older
// Hours-Analysis-Report export delivered the same ids unpadded ('319'). Both
// sides of every comparison go through this, so the two spellings match.
// Anything that is not all digits (a contractor id, say) keeps its own text.
function normalizeEmpNumber(v) {
  if (v === null || v === undefined) return '';
  const raw = String(v).trim();
  if (!raw) return '';
  return /^\d+$/.test(raw) ? raw.padStart(4, '0') : raw;
}

// Cells arrive as JS numbers from the parser, but a re-saved file can deliver
// "$1,234.50" or " 12.5 " as text. Blank is a real zero. A value that is
// present but unreadable is reported, never silently zeroed — a dropped
// paycheque is much worse than a loud import.
function coerceNumber(value) {
  if (value === null || value === undefined || value === '') return { value: 0, ok: true };
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { value, ok: true } : { value: 0, ok: false };
  }
  if (typeof value === 'boolean') return { value: value ? 1 : 0, ok: true };

  const raw = String(value).trim();
  if (!raw) return { value: 0, ok: true };

  // Accounting-style negatives, "(12.50)", plus the currency and grouping
  // characters Excel adds when a number column gets re-typed as text.
  const negated = /^\(.*\)$/.test(raw);
  const cleaned = raw.replace(/[()$,\s]/g, '').replace(/^\+/, '');
  if (cleaned === '' || cleaned === '-') return { value: 0, ok: true };

  const num = Number(cleaned);
  if (!Number.isFinite(num)) return { value: 0, ok: false, raw };
  return { value: negated ? -num : num, ok: true };
}

function textOf(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  return raw === '' ? null : raw;
}

// 'Yes'/'No' in the live file; booleans if the column is ever retyped.
function coerceSalaryFlag(value) {
  if (value === null || value === undefined || value === '') return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const raw = String(value).trim().toLowerCase();
  return raw === 'yes' || raw === 'y' || raw === 'true' || raw === '1' || raw === 'salary';
}

function hashFile(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ============================================================
// CALENDAR
// ============================================================
//
// Every date in this module is a calendar string. new Date('2026-08-17') is
// UTC midnight, which is Aug 16 in any negative-offset zone — that single
// mistake would move a Monday's payroll onto Sunday. Dates are split and
// rebuilt through Date.UTC(), and "today" comes from Intl.DateTimeFormat with
// an explicit timeZone, exactly as calendarDateInZone() does in birthday-lib.

function parseCalendarDate(dateStr) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim());
  if (!match) return null;
  const [year, month, day] = [+match[1], +match[2], +match[3]];
  const stamp = Date.UTC(year, month - 1, day);
  const back = new Date(stamp);
  // Rejects 2026-02-30 and friends, which Date.UTC would happily roll forward.
  if (back.getUTCFullYear() !== year || back.getUTCMonth() + 1 !== month || back.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day, stamp };
}

function formatCalendarDate({ year, month, day }) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Today's calendar date as seen in `timeZone`, regardless of where this runs.
function todayInZone(timeZone = DEFAULT_TIME_ZONE, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});

  const date = { year: +parts.year, month: +parts.month, day: +parts.day };
  return { ...date, stamp: Date.UTC(date.year, date.month - 1, date.day) };
}

// isScheduledDay is the Mon-Thu 4x10 block. Fri/Sat/Sun work is legitimate —
// maintenance crews work weekends — so this classifies, it never rejects.
function workDateInfo(dateStr, tz = DEFAULT_TIME_ZONE) {
  const parsed = dateStr ? parseCalendarDate(dateStr) : todayInZone(tz);
  if (!parsed) throw new Error(`Invalid work date "${dateStr}" — expected YYYY-MM-DD`);

  const jsDow = new Date(parsed.stamp).getUTCDay();   // 0 = Sunday
  const isoDow = jsDow === 0 ? 7 : jsDow;             // 1 = Monday .. 7 = Sunday

  return {
    date: formatCalendarDate(parsed),
    isoDow,
    dayName: DAY_NAMES[isoDow - 1],
    isScheduledDay: isoDow >= 1 && isoDow <= 4
  };
}

// A future date is always wrong: the file reports hours already worked. An old
// date is only a warning — back-filling a missed day is a supported workflow.
// Fri/Sat/Sun are never flagged; weekend maintenance is normal here.
function validateWorkDate(workDate, tz = DEFAULT_TIME_ZONE, now = new Date()) {
  const errors = [];
  const warnings = [];

  const parsed = parseCalendarDate(workDate);
  if (!parsed) {
    errors.push(`Invalid work date ${JSON.stringify(String(workDate ?? ''))} — expected YYYY-MM-DD.`);
    return { ok: false, errors, warnings };
  }

  const today = todayInZone(tz, now);
  const daysAgo = Math.round((today.stamp - parsed.stamp) / 86400000);

  if (daysAgo < 0) {
    errors.push(
      `${workDate} is in the future (today is ${formatCalendarDate(today)} in ${tz}). ` +
      `Payroll files report hours already worked.`
    );
  } else if (daysAgo > STALE_DATE_WARNING_DAYS) {
    warnings.push(
      `${workDate} is ${daysAgo} days old. Check the date before importing — ` +
      `an import overwrites whatever is already on that day.`
    );
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ============================================================
// HEADERS
// ============================================================
//
// Matching is tolerant of whitespace and case but never fuzzy: every accepted
// spelling is listed here on purpose. A column we do not recognise must fail
// loudly with the headers we did find, because a silently mis-matched column
// imports plausible-looking wrong dollars.

const HEADER_ALIASES = {
  'Emp #':          ['emp #', 'emp#', 'emp no', 'emp no.', 'emp num', 'emp number',
                     'employee #', 'employee#', 'employee no', 'employee no.',
                     'employee number', 'employee id'],
  'Last Name':      ['last name', 'lastname', 'last'],
  'First Name':     ['first name', 'firstname', 'first'],
  'Is Salary':      ['is salary', 'issalary', 'salary', 'salaried', 'is salaried'],
  'Pay Rate':       ['pay rate', 'payrate', 'rate', 'hourly rate', 'base rate'],
  'Regular':        ['regular', 'regular hours', 'reg', 'reg hours', 'regular hrs'],
  'OT':             ['ot', 'ot hours', 'ot hrs', 'overtime', 'overtime hours'],
  'Total Hours':    ['total hours', 'totalhours', 'total hrs', 'hours'],
  'Total Earnings': ['total earnings', 'totalearnings', 'total earning', 'earnings',
                     'gross earnings', 'total pay']
};

// Names are only ever displayed, so a file missing them still imports; every
// other column feeds an hour or a dollar and its absence is fatal.
const REQUIRED_HEADERS = EXPECTED_HEADERS.filter(h => h !== 'Last Name' && h !== 'First Name');

const normalizeHeader = h => String(h ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

// canonical name -> the actual header text in this file.
function mapHeaders(headers) {
  const found = new Map();
  for (const header of headers || []) {
    const key = normalizeHeader(header);
    if (key && !found.has(key)) found.set(key, header);
  }

  const mapping = {};
  const missing = [];

  for (const canonical of EXPECTED_HEADERS) {
    const aliases = HEADER_ALIASES[canonical] || [normalizeHeader(canonical)];
    const hit = aliases.find(alias => found.has(alias));
    if (hit) mapping[canonical] = found.get(hit);
    else if (REQUIRED_HEADERS.includes(canonical)) missing.push(canonical);
  }

  return { mapping, missing };
}

// ============================================================
// IMPORT
// ============================================================

function displayName(employee, row) {
  if (employee && textOf(employee.name)) return textOf(employee.name);
  const parts = [row.firstName, row.lastName].filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

function emptyDepartmentBucket(department) {
  return {
    department,
    employees: 0,
    regularHours: 0,
    otHours: 0,
    totalHours: 0,
    totalEarnings: 0,
    otDollars: 0
  };
}

// buildImport takes EITHER a fileBuffer (the normal path) or an already-parsed
// `sheet` from xlsx-lite (what the email ingester and the tests use when the
// bytes have already been read). fileHash is only meaningful when we hold the
// bytes; with a sheet alone it is null, and duplicate-file detection is simply
// unavailable for that call rather than being faked from the row contents.
function buildImport({
  fileBuffer = null,
  sheet = null,
  workDate = null,
  source = 'manual',
  sourceSubject = null,
  emailReceivedAt = null,
  dateSource = 'manual',
  employees = [],
  uploadBatchId = null,
  timeZone = DEFAULT_TIME_ZONE
} = {}) {
  if (!fileBuffer && !sheet) {
    throw new Error('buildImport needs either a fileBuffer or a parsed sheet');
  }

  const anomalies = [];
  let parsed = sheet;
  let sheetName = sheet ? (sheet.sheetName || EXPECTED_SHEET) : null;

  if (!parsed) {
    const { readSheet } = require('./xlsx-lite');
    try {
      parsed = readSheet(fileBuffer, EXPECTED_SHEET);
      sheetName = parsed.sheetName;
    } catch (err) {
      // The vendor renaming the sheet is the single most likely way this export
      // changes shape, so fall back to the first sheet rather than refusing the
      // whole day — but say so, loudly, in the anomalies the UI and the alert
      // email both render.
      parsed = readSheet(fileBuffer);
      sheetName = parsed.sheetName;
      anomalies.push({
        employeeNumber: null,
        name: null,
        type: 'sheet_name_fallback',
        detail: `Sheet "${EXPECTED_SHEET}" was not in this file; read "${sheetName}" instead. ` +
                `Confirm the payroll export has not changed shape.`
      });
    }
  }

  const { mapping, missing } = mapHeaders(parsed.headers);
  if (missing.length) {
    // This message goes straight to the import screen and to the alert email,
    // so it names what is missing AND what we actually saw.
    throw new Error(
      `Payroll file is missing required column${missing.length > 1 ? 's' : ''}: ` +
      `${missing.join(', ')}. Columns found on sheet "${sheetName}": ` +
      `${(parsed.headers || []).join(', ') || '(none)'}`
    );
  }

  const dateInfo = workDateInfo(workDate, timeZone);
  const batchId = uploadBatchId || crypto.randomUUID();
  const fileHash = fileBuffer ? hashFile(fileBuffer) : null;

  // Roster lookup is by normalized employee_number only — never by name.
  const byNumber = new Map();
  for (const emp of employees || []) {
    const key = normalizeEmpNumber(emp && emp.employee_number);
    if (key && !byNumber.has(key)) byNumber.set(key, emp);
  }

  const rows = [];
  const unmatched = [];
  const missingDepartment = [];
  const seen = new Map();

  let totalRows = 0;
  let salariedSkipped = 0;
  let salariedWithHoursImported = 0;

  const cell = (record, canonical) => {
    const header = mapping[canonical];
    return header === undefined ? null : record[header];
  };

  for (const record of parsed.rows || []) {
    totalRows++;

    const employeeNumber = normalizeEmpNumber(cell(record, 'Emp #'));
    const lastName = textOf(cell(record, 'Last Name'));
    const firstName = textOf(cell(record, 'First Name'));
    const fileName = [firstName, lastName].filter(Boolean).join(' ') || null;

    if (!employeeNumber) {
      anomalies.push({
        employeeNumber: null,
        name: fileName,
        type: 'missing_employee_number',
        detail: `Row ${totalRows} has no Emp # and cannot be matched to anybody. Not imported.`
      });
      continue;
    }

    // unique(work_date, employee_number) means the second copy of an id would
    // silently overwrite the first, making the imported numbers depend on row
    // order. Keep the first, refuse the second, and say so.
    if (seen.has(employeeNumber)) {
      anomalies.push({
        employeeNumber,
        name: fileName,
        type: 'duplicate_employee_in_file',
        detail: `Emp # ${employeeNumber} appears more than once in this file ` +
                `(rows ${seen.get(employeeNumber)} and ${totalRows}). The first row was kept.`
      });
      continue;
    }
    seen.set(employeeNumber, totalRows);

    const flags = [];

    const numbers = {};
    for (const [key, canonical] of [
      ['payRate', 'Pay Rate'], ['regularHours', 'Regular'], ['otHours', 'OT'],
      ['totalHours', 'Total Hours'], ['totalEarnings', 'Total Earnings']
    ]) {
      const coerced = coerceNumber(cell(record, canonical));
      if (!coerced.ok) {
        anomalies.push({
          employeeNumber,
          name: fileName,
          type: 'unparseable_number',
          detail: `${canonical} for Emp # ${employeeNumber} reads ${JSON.stringify(coerced.raw ?? cell(record, canonical))}, ` +
                  `which is not a number. Treated as 0 — check this row before trusting the totals.`
        });
        if (!flags.includes('unparseable_number')) flags.push('unparseable_number');
      }
      numbers[key] = round2(coerced.value);
    }

    const isSalary = coerceSalaryFlag(cell(record, 'Is Salary'));
    const hasActivity =
      numbers.regularHours !== 0 || numbers.otHours !== 0 ||
      numbers.totalHours !== 0 || numbers.totalEarnings !== 0;

    // Salaried people appear on the file every day with a row of zeroes; they
    // are not hourly payroll and are dropped. A salaried row carrying actual
    // hours means the payroll system's behaviour changed, so it is imported
    // and flagged rather than discarded along with the rest.
    if (isSalary && !hasActivity) {
      salariedSkipped++;
      continue;
    }
    if (isSalary) {
      salariedWithHoursImported++;
      flags.push('salaried_with_hours');
    }

    // total_earnings is the payroll system's blended figure and is stored
    // verbatim. ot_dollars is what remains once regular hours are paid.
    const regularDollars = round2(numbers.regularHours * numbers.payRate);
    const residual = round2(numbers.totalEarnings - regularDollars);
    let otDollars;
    if (residual >= 0) {
      otDollars = residual;
    } else if (residual >= -RESIDUAL_TOLERANCE) {
      otDollars = 0;                       // rounding noise, clamped to zero
    } else {
      otDollars = residual;                // a real disagreement — keep it visible
      flags.push('negative_residual');
      anomalies.push({
        employeeNumber,
        name: fileName,
        type: 'negative_residual',
        detail: `Total Earnings ${numbers.totalEarnings.toFixed(2)} is ${Math.abs(residual).toFixed(2)} ` +
                `below Regular x Pay Rate (${regularDollars.toFixed(2)}). Stored as a negative ot_dollars.`
      });
    }

    const employee = byNumber.get(employeeNumber) || null;
    let department = null;

    if (!employee) {
      flags.push('unknown_employee');
      unmatched.push({ employeeNumber, lastName, firstName });
    } else {
      department = textOf(employee.department);
      if (!department) {
        flags.push('missing_department');
        missingDepartment.push({ employeeNumber, name: displayName(employee, { lastName, firstName }) });
      }
    }

    if (isSalary) {
      anomalies.push({
        employeeNumber,
        name: displayName(employee, { lastName, firstName }),
        type: 'salaried_with_hours',
        detail: `Emp # ${employeeNumber} is marked Is Salary = Yes but reported ` +
                `${numbers.totalHours} hours / ${numbers.totalEarnings.toFixed(2)} earnings. Imported anyway.`
      });
    }

    // Column names are the daily_hours columns, so this object POSTs as-is.
    // is_scheduled_day is a generated column — never send it.
    rows.push({
      work_date: dateInfo.date,
      employee_number: employeeNumber,
      last_name: lastName,
      first_name: firstName,
      is_salary: isSalary,
      pay_rate: numbers.payRate,
      regular_hours: numbers.regularHours,
      ot_hours: numbers.otHours,
      total_hours: numbers.totalHours,
      total_earnings: numbers.totalEarnings,
      ot_dollars: otDollars,
      regular_dollars: regularDollars,
      department,
      source,
      source_subject: sourceSubject,
      email_received_at: emailReceivedAt,
      file_hash: fileHash,
      date_source: dateSource,
      flags,
      upload_batch_id: batchId
    });
  }

  // ---- aggregates ----

  const totals = {
    regularHours: 0, otHours: 0, totalHours: 0,
    totalEarnings: 0, regularDollars: 0, otDollars: 0
  };

  const buckets = new Map();
  const bucketEmployees = new Map();

  for (const row of rows) {
    totals.regularHours += row.regular_hours;
    totals.otHours += row.ot_hours;
    totals.totalHours += row.total_hours;
    totals.totalEarnings += row.total_earnings;
    totals.regularDollars += row.regular_dollars;
    totals.otDollars += row.ot_dollars;

    const key = row.department || UNASSIGNED;
    if (!buckets.has(key)) {
      buckets.set(key, emptyDepartmentBucket(key));
      bucketEmployees.set(key, new Set());
    }
    const bucket = buckets.get(key);
    bucket.regularHours += row.regular_hours;
    bucket.otHours += row.ot_hours;
    bucket.totalHours += row.total_hours;
    bucket.totalEarnings += row.total_earnings;
    bucket.otDollars += row.ot_dollars;
    bucketEmployees.get(key).add(row.employee_number);
  }

  for (const key of Object.keys(totals)) totals[key] = round2(totals[key]);

  // Production departments in their reporting order, then NON_PRODUCTION
  // ('SG&A' — assignable, but not one of them), then anything unexpected, then
  // Unassigned last — present even when empty rows put nothing in it, because
  // "Unassigned: 0" and "no Unassigned row" mean different things. A bucket
  // with no rows is skipped below, so SG&A only appears when the file actually
  // carried somebody sitting in it.
  const order = [
    ...DEPARTMENTS,
    NON_PRODUCTION,
    ...[...buckets.keys()].filter(k => !ASSIGNABLE_DEPARTMENTS.includes(k) && k !== UNASSIGNED).sort(),
    UNASSIGNED
  ];
  const departments = [];
  for (const key of order) {
    const bucket = buckets.get(key);
    if (!bucket) continue;
    bucket.employees = bucketEmployees.get(key).size;
    for (const field of ['regularHours', 'otHours', 'totalHours', 'totalEarnings', 'otDollars']) {
      bucket[field] = round2(bucket[field]);
    }
    departments.push(bucket);
  }

  const sample = rows.slice(0, 20).map(row => ({
    employeeNumber: row.employee_number,
    name: [row.first_name, row.last_name].filter(Boolean).join(' ') || null,
    department: row.department,
    isSalary: row.is_salary,
    payRate: row.pay_rate,
    regularHours: row.regular_hours,
    otHours: row.ot_hours,
    totalHours: row.total_hours,
    totalEarnings: row.total_earnings,
    regularDollars: row.regular_dollars,
    otDollars: row.ot_dollars,
    flags: row.flags
  }));

  return {
    workDate: dateInfo.date,
    isScheduledDay: dateInfo.isScheduledDay,
    dayName: dateInfo.dayName,
    fileHash,
    uploadBatchId: batchId,
    sheetName,
    rows,
    counts: {
      totalRows,
      imported: rows.length,
      salariedSkipped,
      salariedWithHoursImported
    },
    totals,
    departments,
    unmatched,
    missingDepartment,
    anomalies,
    sample
  };
}

module.exports = {
  normalizeEmpNumber,
  round2,
  workDateInfo,
  hashFile,
  buildImport,
  validateWorkDate,
  EXPECTED_SHEET,
  EXPECTED_HEADERS,
  // Shared with payroll-db.js / payroll-import.js so the department bucket and
  // the timezone default have exactly one definition. DEPARTMENTS is the
  // production breakdown; ASSIGNABLE_DEPARTMENTS is every value a person may be
  // assigned. Anything validating employees.department wants the latter.
  DEPARTMENTS,
  NON_PRODUCTION,
  ASSIGNABLE_DEPARTMENTS,
  UNASSIGNED,
  DEFAULT_TIME_ZONE
};
