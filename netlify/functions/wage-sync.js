// Pure logic for the daily file's ARRIVAL CHECK, and for deciding what an hour
// of somebody costs. No network, no database, no clock — the work date, the
// roster and the parsed file rows all arrive as arguments, so
// payroll-import.js, the email ingester and the unit tests run the identical
// code path.
//
// THE NAME IS HISTORICAL. There is no wage sync any more.
//
// The payroll vendor is BBSI, and their daily file used to carry a Pay Rate for
// every hourly employee. This module existed to move that rate onto
// employees.wage every morning, record every move in wage_history, and flag
// anything past a threshold. Four rules governed it, each of them a way the
// sync could quietly destroy payroll data.
//
// All four are retired, because the thing they protected is gone. The rate in
// that file was re-keyed by hand out of BBSI's payroll system into Timenet so
// the feed could exist, and nobody maintains it there. On 2026-08-22 the import
// stopped reading it and employees.wage became the record of truth, typed on
// the Salaries & Wages page.
//
// What the retired rules were, because each named a real hazard and the hazards
// have moved rather than vanished:
//
//   1. OVERWRITE ONLY ON PRESENCE — never iterate the roster and read a rate
//      out of the file, or everybody who took a day off is zeroed. Now moot:
//      nothing here writes a rate at all.
//   2. A MISSING OR ZERO RATE IS NOT A RATE. Still true, and still enforced —
//      by normalizeRate below, and by wage-edit-lib on the typed side.
//   3. SALARIED ROWS ARE OUTSIDE THIS FLOW. Still true. payroll-lib drops every
//      salaried row at import, and anything reaching here marked salaried is
//      skipped. An hourly rate is never written onto a salaried person.
//   4. NOTHING MOVES SILENTLY. Still true, and now wage-edit-lib's to keep: it
//      writes the wage_history row BEFORE the rate, and data.js performs them
//      in that order.
//
// WHAT THIS MODULE STILL DOES:
//
//   planWageSync        finds people in the file the roster has never seen, and
//                       raises a setup task for each. Arrival detection. It
//                       plans no rate change, because there is no rate to plan
//                       one from.
//   effectiveHourlyRate what an hour of somebody costs — employees.wage for an
//                       hourly person, annual_salary / 2080 for a salaried one.
//                       Read by cost-lib for every costing report.
//
// planWageSync decides and does not write. payroll-db.js owns the writers and
// applyWageSync(); this module never touches either.

const { normalizeEmpNumber, round2 } = require('./payroll-lib');

// Percent. A move whose magnitude EXCEEDS this is flagged for a human; a move
// exactly equal to it is not, so a policy "flag anything over 20%" reads the
// way it is written. Override with WAGE_CHANGE_ALERT_PCT.
//
// NOTHING IN THIS FILE USES IT. It is declared here and exported for
// wage-edit-lib, which applies it to a rate somebody types, because moving it
// would mean two modules importing each other. The threshold survived the
// retirement of the wage sync; the sync did not.
const DEFAULT_THRESHOLD_PCT = 20;

// 40 hours x 52 weeks. The mill's own week is 4x10, which is the same 40, so
// this is the conventional annualisation and not a schedule assumption.
const SALARY_HOURS_PER_YEAR = 2080;

// wage_history.source / employee_setup_tasks.source. The vendor, named.
const SOURCE = 'bbsi';

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
//
// Nothing HERE calls it any more — no rate in the file to compare. It is
// exported for wage-edit-lib, which had reimplemented the same expression
// inline, rounding included. Two copies of a rule whose whole point is a
// floating-point subtlety is exactly the drift this project has paid for
// before, so there is one.
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
// salary entered in the app. A missing annual_salary says null; nothing else
// does. There is deliberately no "use the file rate if it looks usable" path
// here: if you are about to add one back, that is the exact regression this
// ordering exists to prevent, and tests/wage-sync.test.js pins it with a
// salaried employee who carries a pay_rate.
//
// THE COST CLASS IS NOT ASKED ABOUT HERE, AND THAT IS A FIX, NOT A RELAXATION.
//
// This function used to return null for any salaried person whose cost class
// was not Manufacturing, before it looked at annual_salary at all. The rule it
// was reaching for is real — a salaried person outside Manufacturing does not
// belong in MANUFACTURING cost — but it was enforced in the wrong place, and
// the effect was that nobody salaried outside Manufacturing was costed
// ANYWHERE.
//
// Mill Overhead is three salaried people and SG&A is almost entirely salaried.
// Both tabs exist to report exactly those costs, and both were reporting
// almost none of them: the figures were understated by the whole salaried
// payroll of the class being displayed, every week, since the tabs shipped.
// Worse, cost-lib's gap message read "salaried with no annual_salary on file",
// so the screen blamed missing data for a salary that was sitting right there.
//
// buildCostReport ALREADY filters its members by cost class before pricing
// anybody (see cost-lib.js, `members`). By the time this function runs, the
// caller has established that this person belongs in this report. Asking the
// question a second time here could only ever disagree with the caller — and
// where it disagreed, it won, silently.
//
// So the cost class decides WHICH REPORT somebody appears in, which is the
// caller's job. This decides WHAT AN HOUR OF THEM COSTS, which does not depend
// on the report they are being shown in.
//
// For an hourly employee there is one answer, employees.wage, which is typed on
// the Salaries & Wages page and recorded in wage_history. The file's rate used
// to win over it and no longer exists — see the hourly branch below.
function effectiveHourlyRate(employee) {
  const emp = employee || {};

  // ---- salaried: the file is not read, at all, on any branch ----
  if (isSalaried(emp)) {
    // A null annual_salary is audit query 8e's finding: the conversion cannot
    // be computed and that person's cost is missing from the figures. Say null
    // rather than invent a number — and rather than reaching for the file rate,
    // which is not their wage. This is now the ONLY reason a salaried person
    // has no rate, which is what lets the caller say so without guessing.
    const annual = normalizeRate(pick(emp, 'annual_salary', 'annualSalary'));
    if (annual === null) return { rate: null, source: 'none' };

    return { rate: round2(annual / SALARY_HOURS_PER_YEAR), source: 'salary/2080' };
  }

  // ---- hourly ----
  //
  // ONE ANSWER: employees.wage. The file's rate used to win over it, and that
  // was right while the file was believed — but it was a human transcription
  // from BBSI's payroll system into Timenet, kept alive only so this feed could
  // exist, and nobody maintains it there any more.
  //
  // There is deliberately no "fall back to the file rate" path. If you are
  // about to add one back, it is the same regression the salaried branch above
  // has guarded against since Phase B, one column over: a rate nobody owns
  // silently outranking the one somebody does.
  const stored = normalizeRate(emp.wage);
  if (stored !== null) return { rate: stored, source: 'employees.wage' };

  // No rate on file. Null, never zero — a person with hours and no rate is a
  // data problem to report by name, and a zero folds into a total and
  // understates it.
  return { rate: null, source: 'none' };
}

// ============================================================
// THE PLAN
// ============================================================

// resolveThreshold() WAS HERE TOO, and planWageSync called it on every run to
// compute a number it then did nothing with. The threshold is a real rule and
// it lives in wage-edit-lib now, where a typed rate is compared against it.
// The file has no rate to compare.

// The work date of the file, not the day it is processed. A file that arrives
// late must record its rate against the day it describes, so this is required
// and never defaulted to "today" — the setup task's first_seen_date and a
// guessed date is worse than a refused import.
function resolveWorkDate(workDate) {
  const raw = textOf(workDate);
  const match = raw && /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  if (!match) {
    throw new Error(
      `planWageSync needs the file's work date as YYYY-MM-DD (got ${JSON.stringify(workDate ?? null)}). ` +
      `employee_setup_tasks.first_seen_date is the day the file describes, never the day it ` +
      `was processed. (This message named wage_history.effective_date until the file stopped ` +
      `carrying a rate; the setup task is the only dated thing this plan still produces.)`
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

// historyRow() WAS HERE. It built a wage_history row from a rate observed in
// the daily file — employee, rate, previous_rate, change_pct, flagged, all of
// it. Nothing has called it since the file stopped carrying a rate, and the
// shape it built is now wage-edit-lib's to build, from a rate somebody typed.
// Deleted rather than kept: a ready-made wage_history row sitting in the
// importer is an invitation to start writing them from the file again.

// Who is in the day's file that the roster has never seen. Writes nothing.
//
// Returns creates / setupTasks / skipped, plus:
//
//   ops       every write this plan implies, in the order it must happen. The
//             applier walks this rather than the arrays, because the ordering
//             IS the safety property: a create is emitted before its own setup
//             task, which references the new employee's id.
//
//             It used to carry rate updates and wage_history rows too, and the
//             ordering mattered far more then — the history row had to precede
//             the employees.wage write that made the old rate unrecoverable.
//             That ordering rule still exists; it lives in data.js now, on the
//             typed edit.
//   workDate  the resolved effective date, for the setup task.
function planWageSync({ fileRows = [], employees = [], workDate = null } = {}) {
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

  const creates = [];
  const setupTasks = [];
  const ops = [];

  // `updates`, `history` and `flagged` are gone from this plan. They were
  // always empty — nothing has planned a rate change since the file stopped
  // carrying one — and an empty array in a returned shape reads as "no changes
  // today" rather than "this cannot happen", which is the more dangerous of
  // the two.
  const skipped = {
    salaried: 0,
    unchanged: 0,
    absentFromFile: 0,
    // `noRate` is gone with them: no rate is read, so nobody can be skipped
    // for the want of one. It counted zero on every run.
    //
    // These two would otherwise hide inside the three above. A row with no
    // employee number is not "unchanged", and the second row for one person is
    // neither.
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

    // ---- somebody the app has never heard of ----
    //
    // THIS IS ALL THAT IS LEFT OF THE WAGE SYNC, and it is not about wages.
    //
    // Until 2026-08-22 this loop read Pay Rate from the file, wrote it onto
    // employees.wage, recorded a wage_history row and flagged any move beyond
    // the alert threshold. All of it is gone: the rate in that file was a human
    // transcription from BBSI's payroll system into Timenet, kept alive only so
    // this feed could exist, and nobody maintains it there any more.
    // employees.wage is the record of truth and is edited in the app.
    //
    // What survives is arrival detection, which was never about money. A person
    // in the file that the roster does not have is a new hire whose hours are
    // landing nowhere, and the setup task is how anybody finds out. They are
    // created with NO rate — somebody has to type one before their cost can be
    // computed, and the task says so.
    if (!employee) {
      const create = { employeeNumber, name, firstName: first, lastName: last };
      creates.push(create);
      ops.push({ kind: 'create', employeeNumber, create });

      const task = {
        employee_id: null,
        employee_number: employeeNumber,
        employee_name: name,
        first_seen_date: effectiveDate,
        source: SOURCE,
        note: `Auto-created from the BBSI daily file for ${effectiveDate}. Needs a pay rate, ` +
              `department, cost class and position group. Until the rate is set on ` +
              `Salaries & Wages this person's cost cannot be computed at all.`
      };
      setupTasks.push(task);
      ops.push({ kind: 'setupTask', employeeNumber, row: task });
      continue;
    }

    // Already on the roster. There is nothing to do with them here any more:
    // their rate is ours, and this file has no opinion about it.
    skipped.unchanged++;
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
    creates,
    setupTasks,
    skipped,
    ops
  };
}

module.exports = {
  changePercent,
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
