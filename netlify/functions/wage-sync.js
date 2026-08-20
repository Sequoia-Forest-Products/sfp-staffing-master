// Pure logic for the daily wage sync. No network, no database, no clock — the
// work date, the roster and the parsed file rows all arrive as arguments, so
// payroll-import.js, the email ingester and the unit tests run the identical
// code path.
//
// WHY THIS EXISTS
//
// The payroll vendor is BBSI. Their daily file carries a Pay Rate for every
// hourly employee, and that file is the source of truth for hourly wages: it
// overwrites whatever the app holds, every day, and nobody types an hourly wage
// into the app by hand. employees.wage is therefore a cache of the vendor's
// number, and wage_history is the only durable record of how it moved.
//
// Four rules are load-bearing. Each of them is a way this module could quietly
// destroy payroll data, so none of them is a preference:
//
//   1. OVERWRITE ONLY ON PRESENCE. The sync is driven by the rows in the file
//      and never by the roster. An active employee who is not in today's file —
//      vacation, sick, leave, light duty — is not updated, not blanked, not
//      touched at all. Iterating the roster and reading a rate out of the file
//      would zero the rate of everybody who took a day off.
//
//   2. A MISSING OR ZERO RATE IS NOT A RATE. Absent, blank, zero, negative or
//      unparseable all mean "this row carries no wage information". They are
//      skipped and counted, never written as 0. Same failure mode as (1),
//      arriving one column further in.
//
//   3. SALARIED ROWS ARE OUTSIDE THIS FLOW. payroll-lib drops EVERY salaried
//      row at import — unconditionally, whatever it carries for pay rate, hours
//      or earnings — and anything that still reaches here marked salaried, by
//      the file's Is Salary column or by the roster's own pay type, is skipped.
//      An hourly rate is never written onto a salaried person. Pay type is
//      employees.pay_type, with the retired employees.wage = 'Salary' sentinel
//      read only as a fallback (see isSalaried below and SCHEMA_V2_MODEL.sql
//      section 5b). A salaried
//      person's hourly cost is annual_salary / 2080 and nothing else; see
//      effectiveHourlyRate below.
//
//   4. NOTHING MOVES SILENTLY. Every change gets a wage_history row, ordered
//      before the employees.wage write that follows it, and a first observation
//      gets one too (previous_rate null) so the history has a starting point.
//
// A change larger than the threshold is APPLIED AND FLAGGED, never blocked. A
// vendor keying error and a genuine raise are indistinguishable in the data; the
// only difference is that one of them should be looked at. Blocking would stall
// a whole day's import over one row.
//
// planWageSync decides and does not write. payroll-db.js owns the writers and
// applyWageSync(); this module never touches either.

const { normalizeEmpNumber, round2 } = require('./payroll-lib');

// Percent. A move whose magnitude EXCEEDS this is flagged for a human; a move
// exactly equal to it is not, so a policy "flag anything over 20%" reads the
// way it is written. Override with WAGE_CHANGE_ALERT_PCT.
const DEFAULT_THRESHOLD_PCT = 20;

// 40 hours x 52 weeks. The mill's own week is 4x10, which is the same 40, so
// this is the conventional annualisation and not a schedule assumption.
const SALARY_HOURS_PER_YEAR = 2080;

// wage_history.source / employee_setup_tasks.source. The vendor, named.
const SOURCE = 'bbsi';

// The one cost class whose salaried staff are converted to an hourly rate.
// Keyed on the cost class, deliberately: it is a general rule about how
// manufacturing cost is measured, not a special case for a named person.
const MANUFACTURING = 'Manufacturing';

// ============================================================
// SMALL PIECES
// ============================================================

function textOf(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  return raw === '' ? null : raw;
}

// The first key that is actually present on the object. Rows reach this module
// either as payroll-lib's daily_hours-shaped output (snake_case) or, in a test
// or a future caller, as camelCase — so both spellings are read rather than one
// being imposed on every caller.
function pick(row, ...keys) {
  for (const key of keys) {
    if (row && Object.prototype.hasOwnProperty.call(row, key) && row[key] !== undefined) {
      return row[key];
    }
  }
  return undefined;
}

// THE backend answer to 'is this person salaried'. Ask it with the whole
// employee, never with a wage on its own.
//
// employees.pay_type is its own column now — 'Hourly' or 'Salaried',
// SCHEMA_V2_MODEL.sql section 5b. Before that migration the marker lived inside
// employees.wage as the literal string 'Salary', and the migration NULLS wage
// for salaried people. So a test that reads wage alone reads every salaried
// person as HOURLY the moment the migration runs, which would hand them an
// hourly rate off the file — the one thing rule 3 at the top of this file
// forbids.
//
// Hence the order: pay_type when it is present and recognised, the legacy wage
// marker only as the fallback. Correct before AND after the migration, and a
// stale 'Salary' left sitting in wage never overrides an explicit 'Hourly'.
//
// Duplicated — deliberately, five lines — as isSalaried() in ot-report-lib.js
// (Netlify bundles those two functions separately) and in src/js/core.js for the
// frontend. Three copies, one rule: change all three together.
function isSalaried(employee) {
  const emp = employee || {};
  const declared = String(pick(emp, 'pay_type', 'payType') ?? '').trim().toLowerCase();
  if (declared === 'salaried') return true;
  if (declared === 'hourly') return false;
  return isSalaryWage(emp.wage);
}

// The value-only path, kept for a caller holding nothing but a wage string. It
// answers a NARROWER question than isSalaried — 'does this wage carry the
// retired sentinel' — and post-migration it is false for everybody, which is why
// no decision in this module is made on it alone.
function isSalaryWage(value) {
  return String(value === null || value === undefined ? '' : value).trim().toLowerCase() === 'salary';
}

// 'Yes'/'No' in the live file; booleans if the column is ever retyped. Mirrors
// coerceSalaryFlag() in payroll-lib.js — false must never read as truthy.
function isSalaryFlag(value) {
  if (value === null || value === undefined || value === '') return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const raw = String(value).trim().toLowerCase();
  return raw === 'yes' || raw === 'y' || raw === 'true' || raw === '1' || raw === 'salary';
}

// A status that is missing or blank reads as active: the roster is the thing
// being audited here, and guessing "inactive" would hide a real person from the
// absent-from-file count.
function isActive(employee) {
  const raw = textOf(employee && employee.status);
  return raw === null || raw.toLowerCase() === 'active';
}

// A usable hourly rate, or null. Zero, negative and unparseable are all "no
// rate" rather than a rate of zero — see rule 2 at the top of this file.
// Accepts the decoration a re-saved xlsx or a hand-typed employees.wage carries
// ("$24.50", " 24.50 ", "(24.50)"), because the alternative is treating a
// perfectly readable number as missing.
function normalizeRate(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return null;

  let num;
  if (typeof value === 'number') {
    num = value;
  } else {
    const raw = String(value).trim();
    if (!raw) return null;
    const negated = /^\(.*\)$/.test(raw);
    const cleaned = raw.replace(/[()$,\s]/g, '').replace(/^\+/, '');
    if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
    num = Number(cleaned);
    if (negated) num = -num;
  }

  if (!Number.isFinite(num) || num <= 0) return null;
  return round2(num);
}

// Percent change from `from` to `to`, signed and rounded to two places before
// anything compares it to the threshold. Rounding first is what stops
// (30 - 25) / 25 * 100 === 20.000000000000004 from being "over 20%".
function changePercent(from, to) {
  if (from === null || from === undefined || !(from > 0)) return null;
  return round2(((to - from) / from) * 100);
}

const signed = pct => `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
const money = rate => (rate === null || rate === undefined ? 'no rate' : rate.toFixed(2));

// ============================================================
// EFFECTIVE HOURLY RATE
// ============================================================

// The one place that answers "what does an hour of this person's time cost?",
// exported so the OT report and the Salaries & Wages page cannot drift apart on
// the answer.
//
// SALARIED IS DECIDED FIRST, AND THE FILE IS NEVER CONSULTED FOR THEM.
//
// The ordering below is the rule, not an implementation detail. Salaried staff
// are outside the BBSI flow entirely (rule 3 at the top of this file): every
// salaried row is skipped at import regardless of what it carries — pay rate,
// hours, earnings, any of it. So a Pay Rate sitting on a salaried row is not
// evidence of anything. It is whatever the vendor happened to put in a column
// that nobody in this business maintains for salaried people, and using it
// would silently substitute a number nobody entered for the salary somebody
// did.
//
// For a salaried employee the ONLY answer is annual_salary / 2080, using the
// salary entered in the app, and only for cost class Manufacturing — a general
// rule about how manufacturing cost is measured, keyed on the cost class rather
// than on a named person. A salaried person in any other cost class has no
// hourly rate at all, and neither does one whose annual_salary is missing.
// Both say null. There is deliberately no "use the file rate if it looks
// usable" path here: if you are about to add one back, that is the exact
// regression this ordering exists to prevent, and tests/wage-sync.test.js pins
// it with a salaried employee who carries a pay_rate.
//
// For an hourly employee a rate from the file wins, then the stored
// employees.wage. `source: 'file'` covers both, and that is not a fudge:
// employees.wage holds nothing but what the BBSI file last put there. The result
// is never written back onto a salaried person's row — employees.wage means an
// hourly rate or nothing, and pay type is employees.pay_type.
function effectiveHourlyRate(employee) {
  const emp = employee || {};

  // ---- salaried: the file is not read, at all, on any branch ----
  if (isSalaried(emp)) {
    const costClass = textOf(pick(emp, 'cost_class', 'costClass'));
    if (costClass !== MANUFACTURING) return { rate: null, source: 'none' };

    // A null annual_salary here is audit query 8e's finding: the conversion
    // cannot be computed and that person's cost is missing from the
    // manufacturing figures. Say null rather than invent a number — and
    // rather than reaching for the file rate, which is not their wage.
    const annual = normalizeRate(pick(emp, 'annual_salary', 'annualSalary'));
    if (annual === null) return { rate: null, source: 'none' };

    return { rate: round2(annual / SALARY_HOURS_PER_YEAR), source: 'salary/2080' };
  }

  // ---- hourly ----
  const fileRate = normalizeRate(pick(emp, 'fileRate', 'file_rate', 'payRate', 'pay_rate'));
  if (fileRate !== null) return { rate: fileRate, source: 'file' };

  const stored = normalizeRate(emp.wage);
  if (stored !== null) return { rate: stored, source: 'file' };

  return { rate: null, source: 'none' };
}

// ============================================================
// THE PLAN
// ============================================================

// Env is read per call rather than at module load, so a manual run or a test can
// change the threshold between runs. An explicit thresholdPct always wins, which
// is what keeps planWageSync deterministic for its callers.
function resolveThreshold(thresholdPct) {
  if (thresholdPct !== undefined && thresholdPct !== null && thresholdPct !== '') {
    const explicit = Number(thresholdPct);
    if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  }
  const fromEnv = Number(process.env.WAGE_CHANGE_ALERT_PCT);
  if (Number.isFinite(fromEnv) && fromEnv >= 0) return fromEnv;
  return DEFAULT_THRESHOLD_PCT;
}

// The work date of the file, not the day it is processed. A file that arrives
// late must record its rate against the day it describes, so this is required
// and never defaulted to "today" — wage_history.effective_date is NOT NULL and a
// guessed date is worse than a refused import.
function resolveWorkDate(workDate) {
  const raw = textOf(workDate);
  const match = raw && /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  if (!match) {
    throw new Error(
      `planWageSync needs the file's work date as YYYY-MM-DD (got ${JSON.stringify(workDate ?? null)}). ` +
      `wage_history.effective_date is the day the file describes, never the day it was processed.`
    );
  }
  return match[1];
}

function nameFromRow(row) {
  const first = textOf(pick(row, 'first_name', 'firstName', 'First Name'));
  const last = textOf(pick(row, 'last_name', 'lastName', 'Last Name'));
  const joined = [first, last].filter(Boolean).join(' ');
  return { first, last, name: joined || textOf(pick(row, 'name')) };
}

function historyRow({ employeeId, employeeNumber, name, rate, previousRate, changePct, flagged, note, effectiveDate }) {
  // Exactly the wage_history columns from SCHEMA_V2_MODEL.sql section 6, ready
  // to POST. id and created_at are database defaults and are never sent.
  return {
    employee_id: employeeId,
    employee_number: employeeNumber,
    employee_name: name,
    rate,
    previous_rate: previousRate,
    change_pct: changePct,
    effective_date: effectiveDate,
    source: SOURCE,
    flagged,
    note
  };
}

// Decide what the day's file means for wages. Writes nothing.
//
// Returns updates / creates / history / setupTasks / skipped / flagged, plus:
//
//   ops           every write this plan implies, in the order it must happen.
//                 The applier walks this rather than the four arrays, because
//                 the ordering IS the safety property: the wage_history row for
//                 a change is emitted before the employees.wage update that
//                 makes the old rate unrecoverable, and a create is emitted
//                 before its own history row (the row needs the new employee's
//                 id, and wage_history is append-only — it cannot be patched
//                 afterwards).
//   thresholdPct  what was actually used, so the alert email can say so.
//   workDate      the resolved effective date, for the same reason.
function planWageSync({ fileRows = [], employees = [], workDate = null, thresholdPct } = {}) {
  const threshold = resolveThreshold(thresholdPct);
  const effectiveDate = resolveWorkDate(workDate);

  // Roster lookup is by normalized employee_number and nothing else — the same
  // rule, for the same reason, as payroll-lib.buildImport: the roster has two
  // people called Smith and several compound surnames the two systems spell
  // differently, and name matching would move one person's wage onto another.
  const byNumber = new Map();
  for (const emp of employees || []) {
    const key = normalizeEmpNumber(emp && emp.employee_number);
    if (key && !byNumber.has(key)) byNumber.set(key, emp);
  }

  const updates = [];
  const creates = [];
  const history = [];
  const setupTasks = [];
  const flagged = [];
  const ops = [];

  const skipped = {
    noRate: 0,
    salaried: 0,
    unchanged: 0,
    absentFromFile: 0,
    // Two more that would otherwise hide inside the four above. A row with no
    // employee number carries no wage information but is not "no rate", and the
    // second row for one person is neither.
    noEmployeeNumber: 0,
    duplicateInFile: 0
  };

  const seen = new Set();

  for (const raw of fileRows || []) {
    const row = raw || {};
    const employeeNumber = normalizeEmpNumber(pick(row, 'employee_number', 'employeeNumber', 'Emp #'));

    if (!employeeNumber) {
      skipped.noEmployeeNumber++;
      continue;
    }

    // First row for a number wins, matching buildImport's duplicate handling, so
    // which rate lands does not depend on row order.
    if (seen.has(employeeNumber)) {
      skipped.duplicateInFile++;
      continue;
    }
    seen.add(employeeNumber);

    const employee = byNumber.get(employeeNumber) || null;
    const { first, last, name: fileName } = nameFromRow(row);
    const name = (employee && textOf(employee.name)) || fileName;

    // Salaried is decided BEFORE the rate is read. A salaried row normally
    // carries $0, so testing the rate first would file every salaried person
    // under "no rate" and hide the fact that they were correctly skipped.
    const salaried = isSalaryFlag(pick(row, 'is_salary', 'isSalary', 'Is Salary')) ||
                     (employee && isSalaried(employee));
    if (salaried) {
      skipped.salaried++;
      continue;
    }

    const rate = normalizeRate(pick(row, 'pay_rate', 'payRate', 'Pay Rate', 'rate'));
    if (rate === null) {
      skipped.noRate++;
      continue;
    }

    // ---- somebody the app has never heard of ----
    //
    // They have hours and a wage today and no department, cost class or
    // position group, so their cost is real and is landing nowhere. Create them
    // into the bullpen and queue the arrival; the checklist is computed from the
    // employees row itself and is deliberately not stored (schema section 6b).
    if (!employee) {
      const create = { employeeNumber, name, firstName: first, lastName: last, rate };
      creates.push(create);
      ops.push({ kind: 'create', employeeNumber, create });

      const hist = historyRow({
        employeeId: null,          // filled in by the applier from the new row
        employeeNumber,
        name,
        rate,
        previousRate: null,
        changePct: null,
        flagged: false,
        note: `First rate observed for Emp # ${employeeNumber}, auto-created from the BBSI daily file.`,
        effectiveDate
      });
      history.push(hist);
      ops.push({ kind: 'history', employeeNumber, row: hist });

      const task = {
        employee_id: null,
        employee_number: employeeNumber,
        employee_name: name,
        first_seen_date: effectiveDate,
        source: SOURCE,
        note: `Auto-created from the BBSI daily payroll file for ${effectiveDate} at ` +
              `${rate.toFixed(2)}/hr. Needs department, cost class and position group.`
      };
      setupTasks.push(task);
      ops.push({ kind: 'setupTask', employeeNumber, row: task });
      continue;
    }

    // ---- somebody we already hold a rate for ----

    const from = normalizeRate(employee.wage);

    if (from !== null && from === rate) {
      skipped.unchanged++;
      continue;
    }

    const changePct = changePercent(from, rate);
    const isFlagged = changePct !== null && Math.abs(changePct) > threshold;

    let note = null;
    if (isFlagged) {
      note =
        `Rate moved ${money(from)} -> ${money(rate)} (${signed(changePct)}), beyond the ` +
        `${threshold}% alert threshold. Applied and flagged for review — a vendor keying error ` +
        `and a genuine raise look identical here.`;
    } else if (from === null) {
      // Not a change: the app simply had no usable rate for this person until
      // now. Recorded so the history has a starting point to measure from.
      note = `First rate observed for Emp # ${employeeNumber} (employees.wage held ` +
             `${JSON.stringify(employee.wage ?? null)}).`;
    }

    const hist = historyRow({
      employeeId: (employee.id ?? null) || null,
      employeeNumber,
      name,
      rate,
      previousRate: from,
      changePct,
      flagged: isFlagged,
      note,
      effectiveDate
    });
    history.push(hist);
    ops.push({ kind: 'history', employeeNumber, row: hist });

    const update = {
      employeeId: (employee.id ?? null) || null,
      employeeNumber,
      name,
      from,
      to: rate,
      changePct,
      flagged: isFlagged,
      note
    };
    updates.push(update);
    ops.push({ kind: 'update', employeeNumber, update });

    if (isFlagged) flagged.push(update);
  }

  // Everybody active who the file did not mention. Counted, never touched —
  // this number is the population rule 1 protects, so it is reported rather
  // than left implicit. Salaried staff are excluded because they are outside
  // this flow entirely and would otherwise dominate the count every day.
  for (const emp of byNumber.values()) {
    const key = normalizeEmpNumber(emp && emp.employee_number);
    if (seen.has(key)) continue;
    if (!isActive(emp)) continue;
    if (isSalaried(emp)) continue;
    skipped.absentFromFile++;
  }

  return {
    workDate: effectiveDate,
    thresholdPct: threshold,
    updates,
    creates,
    history,
    setupTasks,
    skipped,
    flagged,
    ops
  };
}

module.exports = {
  normalizeRate,
  effectiveHourlyRate,
  planWageSync,
  DEFAULT_THRESHOLD_PCT,
  SALARY_HOURS_PER_YEAR,
  // Shared with payroll-db.js so the source string and the salaried test have
  // one definition each rather than a copy in the writer.
  SOURCE,
  // isSalaried takes the whole employee and is what every decision here uses;
  // isSalaryWage is the narrow value-only sentinel test kept for callers that
  // hold nothing else.
  isSalaried,
  isSalaryWage
};
