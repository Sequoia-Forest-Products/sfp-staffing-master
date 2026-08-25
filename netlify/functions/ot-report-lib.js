// Weekly overtime report — pure aggregation.
//
// EVERY DOLLAR HERE IS OURS NOW. Until 2026-08-22 this report took ot_dollars
// and total_earnings straight from daily_hours — the vendor file's own money,
// computed from a pay rate a human at BBSI re-keyed into Timenet so this feed
// could exist. Nobody maintains that rate there any more, so the file carries
// hours and nothing else, and the money is recomputed from employees.wage with
// the overtime premium from pay-rules-lib.
//
// One consequence, stated because it is not obvious: a rate change re-prices
// history. Give somebody a raise and last month's report moves. wage_history
// records effective dates, so pricing each week at the rate in force that week
// is buildable later without new schema — it is deliberately not done here.
//
// No network, no database, and one local dependency: every input is passed in, so
// tests/ot-report.test.js drives exactly the same code that /api/payroll-report
// runs (netlify/functions/payroll-report.js fetches the rows and calls
// buildReport). Keeping the arithmetic here and the I/O there is the same split
// birthday-lib.js uses.
//
// Inputs
//   weekStart     any 'YYYY-MM-DD' inside the wanted week; snapped to its Monday
//   dailyRows     daily_hours rows (SCHEMA_DAILY_HOURS.sql)
//   overtimeRows  overtime rows: {id, name, ot_type, hours, description}
//   employees     {id, name, employee_number, department, wage, status, pay_type}
//   expectedDays  optional array of 'YYYY-MM-DD' that a delivery was expected
//                 for; defaults to EVERY day of the week, since the vendor
//                 sends daily. The default is deliberately naive about "today"
//                 — it has no clock — so a caller reporting on the current week
//                 must narrow it to days that have already happened, the way
//                 payroll-report.js does. Anything not in the set reads as
//                 'pending' rather than as a missed delivery.
//   graceHoursPerEmployee
//                 the timeclock grace allowance, in hours per active hourly
//                 employee per week; DEFAULT_GRACE_HOURS when it is missing or
//                 unusable. payroll-report.js reads the real one from settings.
//
// Two things about this data that the shape of the report is built around:
//
//   1. The `overtime` table has no week column and no dollars. It is a STANDING
//      weekly allowance that applies to every week, not a per-week entry, and
//      the UI has to say so. Dollars are derived here (hours * rate * 1.5).
//   2. daily_hours carries a department SNAPSHOT taken at import. This module
//      reads that snapshot and never re-derives department from `employees`,
//      because people transfer and a live join would rewrite history. The only
//      exception is a pre-approved allowance for somebody with no rows this
//      week — there is no snapshot to read, so employees.department is the
//      honest fallback and they are listed in preApproved.withoutHoursThisWeek.
//   3. Pre-approved OT has TWO standing components and the report names both.
//      `standing` is the overtime table's allowance. `grace` is the timeclock
//      grace policy below. summary.preApprovedHours is their sum, which is what
//      net OT is measured against; preApproved.standing and preApproved.grace
//      keep them separable, because they are different promises to different
//      people and a single merged number cannot be argued with.
//
// "No data" NEVER means "nobody worked". BBSI sends the Work Summary Payroll
// report seven days a week, so a past day with no rows is a probable missed
// delivery whichever day of the week it is — completeness calls every one of
// them 'missing'. A day that simply has not happened yet is 'pending'.
//
// This used to carve out Fri/Sat/Sun as 'no-data-nonscheduled', on the grounds
// that an empty Saturday might just be a quiet Saturday. That was reasoning
// about the mill's schedule, not the vendor's: the report is owed daily, so the
// ambiguity it described does not exist. The Mon-Thu block is still real and
// still splits scheduled hours from weekend hours below — it just says nothing
// about whether a report was owed.

// The PRODUCTION departments, in reporting order. This is what the report
// breaks the mill down by, and it is deliberately NOT the list of values
// employees.department accepts — see ASSIGNABLE_DEPARTMENTS below.
// Clean-up is the hourly mill clean-up crew: ordinary production labour with no
// special handling anywhere, listed last because that is its reporting order.
const DEPARTMENTS = ['Maintenance', 'Saw Filing', 'Shipping', 'Production', 'Log Yard', 'Clean-up'];
const UNASSIGNED  = 'Unassigned';

// NAMING: the constant is NON_PRODUCTION and the value is 'SG&A'. That is not a
// mistake. SG&A IS the non-production bucket — the constant names the ROLE, the
// string is the label the database CHECK constraint now uses for it. The label
// used to be 'Non-Production'; the role has not changed, so the constant name
// and issues.nonProductionWithHours keep their names rather than churning every
// caller for a rename that says nothing new.
//
// It is the one value employees.department accepts that is NOT a production
// department: office / salaried staff, who have no home among the production
// departments. The back-fill screen requires a department for every active
// employee — its "still needs a department" counter is what gates retiring the
// legacy `dept` column, so with no correct value to pick that counter could
// never honestly reach zero. Leaving those people blank is not a fix: blank is
// indistinguishable from "nobody has got to this row yet". SG&A makes it an
// explicit, recorded decision.
//
// The two lists differ ON PURPOSE and must not be reconciled into one:
//   DEPARTMENTS             what the report's normal breakdown is over
//   ASSIGNABLE_DEPARTMENTS  what a person may legally be assigned to
// Adding SG&A to DEPARTMENTS would put a non-production row in every production
// breakdown. Dropping it from ASSIGNABLE_DEPARTMENTS would make the back-fill
// screen reject a value the database and the roster both accept.
//
// SG&A staff are salaried, so the import drops their rows and this bucket
// should normally be empty. A bucket that exists is a finding, carried in
// issues.nonProductionWithHours — never folded away, never silently dropped.
const NON_PRODUCTION = 'SG&A';
const ASSIGNABLE_DEPARTMENTS = [...DEPARTMENTS, NON_PRODUCTION];

const OT_TYPES    = ['Pre-Shift', 'Post-Shift', 'Weekend'];

// Pre-approved dollars use a flat 1.5x. Unlike imported ot_dollars (which is the
// residual of the payroll system's own blended Total Earnings) there is no
// authoritative dollar figure for an allowance, so 1.5x is the stated estimate.
const { dayPay } = require('./pay-rules-lib');

const PRE_APPROVED_MULTIPLIER = 1.5;

// The timeclock grace policy, in hours per active hourly employee per week.
//
// Employees may clock in up to 7.5 minutes early and out up to 7.5 minutes
// late. Over a four-day week that accrues to half an hour, and under California
// wage-and-hour law it is compensable time that cannot be rounded away — so it
// is overtime that was approved before anybody worked it, and it belongs in the
// pre-approved pool rather than in the net figure a manager is asked about.
//
// It is a CONSTANT here and a settings value in payroll-report.js, never a bare
// number inside an expression. An earlier version of this report added
// `0.5 * numWeeks` inline, and it was deleted as an unexplained fudge factor —
// the policy was sound, the invisibility was the defect.
const DEFAULT_GRACE_HOURS = 0.5;

// isoDow 1..4 = Mon..Thu = the scheduled 4x10 block.
const LAST_SCHEDULED_ISO_DOW = 4;
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAY_MS = 86400000;

// Everything is rounded to 2 decimals on the way out, so any genuine
// disagreement is at least 0.01. Half a cent is comfortably inside the noise.
const TOLERANCE = 0.005;

// ============================================================
// DATE LOGIC
// ============================================================

function pad2(n) { return String(n).padStart(2, '0'); }

// 'YYYY-MM-DD' (or an ISO timestamp) -> UTC-midnight milliseconds, or null.
//
// Never `new Date(str)` for a date-only string: that parses as UTC midnight and
// then reads back through the local clock, which lands on the previous calendar
// day in every negative-offset zone — including the Pacific zone this report is
// scored in. Splitting the string and using Date.UTC (the approach
// birthday-lib.js explains at length) keeps the calendar date literal.
function dateToUTC(value) {
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
  }

  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(value == null ? '' : value).trim());
  if (!m) return null;

  const year = +m[1], month = +m[2], day = +m[3];
  const ms = Date.UTC(year, month - 1, day);
  const back = new Date(ms);

  // Rejects 2026-02-31 and friends, which Date.UTC would silently roll forward.
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) {
    return null;
  }
  return ms;
}

function utcToDateStr(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function normalizeDate(value) {
  const ms = dateToUTC(value);
  return ms === null ? null : utcToDateStr(ms);
}

// ISO weekday: Monday 1 ... Sunday 7. getUTCDay() calls Sunday 0.
function isoDowFromMs(ms) {
  const day = new Date(ms).getUTCDay();
  return day === 0 ? 7 : day;
}

function mondayMs(ms) {
  return ms - (isoDowFromMs(ms) - 1) * DAY_MS;
}

// Monday of the ISO week containing dateStr. A Sunday belongs to the week that
// started six days earlier, not to the one starting the next day.
function weekStartFor(dateStr) {
  const ms = dateToUTC(dateStr);
  if (ms === null) throw new Error(`weekStartFor: not a YYYY-MM-DD date: ${JSON.stringify(String(dateStr))}`);
  return utcToDateStr(mondayMs(ms));
}

// Mon..Sun as seven calendar strings. Tolerates a mid-week argument (it snaps to
// the Monday first) so callers can hand it a raw ?week= value.
function weekDates(weekStart) {
  const ms = dateToUTC(weekStart);
  if (ms === null) throw new Error(`weekDates: not a YYYY-MM-DD date: ${JSON.stringify(String(weekStart))}`);
  const start = mondayMs(ms);
  const out = [];
  for (let i = 0; i < 7; i++) out.push(utcToDateStr(start + i * DAY_MS));
  return out;
}

// ============================================================
// NUMBERS
// ============================================================

// The single rounding point for the whole report. Sign-aware so -0.005 does not
// come back as -0, which JSON.stringify would emit as a confusing "0" that
// compares unequal in a strict test.
function round2(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  const r = (Math.round(Math.abs(v) * 100 + Number.EPSILON) / 100) * Math.sign(v);
  return r === 0 ? 0 : r;
}

// numeric(10,2) arrives from PostgREST as a JSON number, but hand-entered
// columns (employees.wage) are free text like "$24.50", so strip the decoration.
function num(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// A usable pay rate, or null. Zero and negative rates are "no rate", not a rate.
function toRate(value) {
  const n = num(value);
  return n > 0 ? n : null;
}

// Matches payroll-lib's normalizeEmpNumber: the live export sends zero-padded
// four-character ids ('0319'), an older export sent them unpadded ('319').
// Both sides of every comparison go through this.
function normalizeEmpNumber(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  return /^\d+$/.test(raw) ? raw.padStart(4, '0') : raw;
}

function cleanText(value) {
  const s = String(value == null ? '' : value).trim();
  return s || null;
}

// The form a person's name is COMPARED in — never the form it is displayed in.
// Case and spacing are typing accidents, not identity: the overtime tab is
// hand-maintained and the payroll export is machine-generated, so the same
// person arrives as 'Hank Boyd' from one and 'HANK  BOYD' from the other.
// Collapsing runs of whitespace and lowercasing is as far as this goes —
// anything cleverer (nicknames, initials, suffixes) would start merging people
// who really are different, and an unmatched name is reported rather than
// guessed at.
function nameKey(value) {
  return String(value == null ? '' : value).trim().toLowerCase().replace(/\s+/g, ' ');
}

// daily_hours.is_salary arrives as a boolean from PostgREST and as the source
// file's 'Yes'/'No' from anything that shortcut the import, so read both.
function isYes(value) {
  if (typeof value === 'boolean') return value;
  const s = String(value == null ? '' : value).trim().toLowerCase();
  return s === 'yes' || s === 'true' || s === 'y' || s === 't' || s === '1';
}

// Salaried staff have no hourly rate to grace and a $0 pay rate in the payroll
// export, so there are no dollars that could honestly be derived for them and no
// place for them in the hourly headcount.
//
// employees.pay_type is its own column now — 'Hourly' or 'Salaried',
// SCHEMA_V2_MODEL.sql section 5b. Before that migration the marker lived inside
// employees.wage as the literal word 'Salary', and the migration NULLS wage for
// salaried people. A test that reads wage alone therefore reads every salaried
// person as HOURLY the moment the migration runs, silently inflating the
// clock-grace headcount and the allowance built on it.
//
// So: pay_type when present and recognised, the legacy wage marker only as the
// fallback. Correct before AND after the migration, and a stale 'Salary' in wage
// never overrides an explicit 'Hourly'.
//
// This is a deliberate five-line copy of isSalaried() in wage-sync.js (Netlify
// bundles the two functions separately) and of the one in src/js/core.js. Three
// copies, one rule: change all three together.
function isSalaryWage(value) {
  return String(value == null ? '' : value).trim().toLowerCase() === 'salary';
}

function isSalaried(emp) {
  const e = emp || {};
  const declared = String((e.pay_type != null ? e.pay_type : e.payType) ?? '').trim().toLowerCase();
  if (declared === 'salaried') return true;
  if (declared === 'hourly') return false;
  return isSalaryWage(e.wage);
}

// employees.status is 'Active' | 'Inactive', and the roster UI writes 'Active'
// when the field is blank — so blank reads as active. Anything else is
// deliberately NOT active: a standing entitlement must not attach itself to a
// status nobody has defined.
function isActiveEmployee(emp) {
  const s = String(emp && emp.status == null ? '' : emp.status).trim().toLowerCase();
  return s === '' || s === 'active';
}

// A configured grace allowance, or null when the value cannot be used as one.
// Zero is a real setting — it switches the policy off — so this can never be a
// truthiness test. Negative is not: hours cannot be owed backwards.
function toGraceHours(value) {
  // Only a number or a string can be one. Everything else — null, an object, an
  // empty array — is rejected here rather than left to Number(), which reads
  // several of them as a perfectly convincing 0 and would switch the policy off.
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const trimmed = typeof value === 'string' ? value.trim() : value;
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

// null department => the "Unassigned" bucket. Never guess a real department.
function departmentBucket(value) {
  return cleanText(value) || UNASSIGNED;
}

// ============================================================
// ACCUMULATORS
// ============================================================
//
// A "block" is the {hours, otHours, otDollars, earnings, headcount} shape that
// repeats all over the report. Totals accumulate unrounded and are rounded once
// by finishBlock, so a long column of cents cannot drift.

function newBlock() {
  return { hours: 0, otHours: 0, otDollars: 0, earnings: 0, people: new Set() };
}

function addRow(block, row) {
  block.hours     += row.hours;
  block.otHours   += row.otHours;
  block.otDollars += num(row.otDollars);
  // num() because a row with no rate carries null money, not zero. The
  // established contract is unchanged — the dollars are honestly 0 and the
  // person is named in rateMissing rather than being given an invented rate —
  // but `+= null` would arrive at the same place by accident rather than on
  // purpose, and would stop doing so the day somebody switches to a sum that
  // propagates null.
  block.earnings  += num(row.earnings);
  block.people.add(row.key);
}

function finishBlock(block) {
  return {
    hours:     round2(block.hours),
    otHours:   round2(block.otHours),
    otDollars: round2(block.otDollars),
    earnings:  round2(block.earnings),
    headcount: block.people.size
  };
}

// DEPARTMENTS first in their canonical order, then NON_PRODUCTION ('SG&A') — a
// real assignable value, but not a production department — then anything
// unexpected that the data actually contains, then Unassigned last so it reads
// as the remainder. SG&A sits between the production departments and the
// unknowns because it is neither a real department nor an unknown one.
function sortDepartments(names) {
  const rank = (name) => {
    if (name === UNASSIGNED)      return DEPARTMENTS.length + 2;
    if (name === NON_PRODUCTION)  return DEPARTMENTS.length;
    const i = DEPARTMENTS.indexOf(name);
    return i === -1 ? DEPARTMENTS.length + 1 : i;
  };
  return names.slice().sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

function displayName(row) {
  const name = `${cleanText(row.first_name) || ''} ${cleanText(row.last_name) || ''}`.trim();
  if (name) return name;
  const number = normalizeEmpNumber(row.employee_number);
  return number ? `Employee ${number}` : '(unnamed)';
}

// ============================================================
// REPORT
// ============================================================

function buildReport({
  weekStart,
  dailyRows = [],
  // The standing allowance. Phase C keys these on employees.id
  // (`preapproved_ot`); before that migration they arrive keyed on `name`
  // (`overtime`). Both shapes are accepted by the SAME loop below — an id when
  // the row has one, a name when it does not — so there is no second code path
  // to drift, and the report keeps working whichever order the deploy and the
  // migration happen in.
  preApprovedRows = null,
  overtimeRows = [],
  employees = [],
  expectedDays = null,
  graceHoursPerEmployee = null
} = {}) {
  const standingRows = preApprovedRows === null ? (overtimeRows || []) : (preApprovedRows || []);
  const dates    = weekDates(weekStart);
  const dateSet  = new Set(dates);
  const monday   = dates[0];
  const sunday   = dates[6];

  const configuredGrace  = toGraceHours(graceHoursPerEmployee);
  const gracePerEmployee = configuredGrace === null ? DEFAULT_GRACE_HOURS : configuredGrace;

  // ---- roster indexes -------------------------------------------------
  // employee_number matches daily_hours; employees.id matches preapproved_ot;
  // the comparison name matches the legacy `overtime` table, which has neither
  // an id nor an employee number. Duplicate names keep the first roster entry —
  // nothing else can disambiguate them, which is the entire reason the standing
  // allowance stopped being keyed on one.
  const byNumber = new Map();
  const byName   = new Map();
  const byId     = new Map();
  for (const emp of employees || []) {
    const number = normalizeEmpNumber(emp.employee_number);
    if (number && !byNumber.has(number)) byNumber.set(number, emp);
    const name = nameKey(emp.name);
    if (name && !byName.has(name)) byName.set(name, emp);
    const id = cleanText(emp.id);
    if (id) byId.set(id, emp);
  }

  // The identity one person is accumulated under, asked of the ROSTER ENTRY
  // rather than of whichever table happened to be in hand. Both inputs reach a
  // person by a different route — daily_hours by employee_number, `overtime` by
  // name — so they only agree if the last step is the same for both.
  //
  // This is what the null-employee_number case used to get wrong: the daily
  // rows keyed on the payroll file's spelling of the name and the standing
  // allowance keyed on the overtime tab's spelling, so one person became two
  // phantom entries — one holding the hours, the other holding the allowance,
  // which then reported as "approved but never worked". employees.id is the
  // stable handle for a roster row with no payroll number; the canonical name
  // is the last resort for a roster that has neither.
  const rosterKey = (emp) => {
    const number = normalizeEmpNumber(emp.employee_number);
    if (number) return number;
    const id = cleanText(emp.id);
    if (id) return `emp:${id}`;
    return `name:${nameKey(emp.name)}`;
  };

  // ---- normalize the daily rows ---------------------------------------
  const rows = [];
  for (const raw of dailyRows || []) {
    const date = normalizeDate(raw.work_date);
    if (!date || !dateSet.has(date)) continue; // defensive: the caller may over-fetch

    const isoDow          = isoDowFromMs(dateToUTC(date));
    const employeeNumber  = normalizeEmpNumber(raw.employee_number);
    const fileName        = displayName(raw);

    // The payroll number is the match wherever there is one. A row that carries
    // no number at all falls back to the name — the same fallback, through the
    // same roster, that the standing-allowance loop below uses, so the two
    // cannot disagree about who this is.
    //
    // A row whose number is simply not on the roster is deliberately NOT
    // name-matched: an unrecognised payroll number is a real finding that
    // issues.unknownEmployeeNumbers exists to surface, and quietly guessing
    // past it would hide the roster gap it is asking somebody to fix.
    const rosterEmp = employeeNumber
      ? (byNumber.get(employeeNumber) || null)
      : (byName.get(nameKey(fileName)) || null);

    const name          = rosterEmp ? String(rosterEmp.name || '').trim() || fileName : fileName;
    const hasDepartment = cleanText(raw.department) !== null;

    // total_hours is authoritative; regular + ot is only a fallback for a row
    // that somehow arrived without it.
    const hours = (raw.total_hours === null || raw.total_hours === undefined)
      ? num(raw.regular_hours) + num(raw.ot_hours)
      : num(raw.total_hours);

    rows.push({
      date,
      isoDow,
      isScheduledDay: isoDow <= LAST_SCHEDULED_ISO_DOW,
      employeeNumber: employeeNumber || null,
      // Rows with no employee number still need to count as one person — and
      // as the SAME person their standing allowance is attributed to.
      key: rosterEmp ? rosterKey(rosterEmp) : (employeeNumber || `name:${nameKey(name)}`),
      name,
      department: departmentBucket(raw.department),
      hasDepartment,
      onRoster: !!rosterEmp,
      hours,
      // Salaried staff are skipped at import unless they arrived with hours, so
      // a true here is the week's own evidence that this person is not hourly.
      isSalary: isYes(raw.is_salary),
      otHours: num(raw.ot_hours),
      // COMPUTED, not read. The file's ot_dollars and total_earnings are null
      // on every row imported since the feed became hours-only, and were a
      // transcribed rate's output before that. dayPay applies the daily premium
      // tiers — 1.5x from 10 to 12 hours, 2.0x above — to OUR rate.
      //
      // Null when there is no rate on file, never zero: that person is named in
      // rateMissing below, and a zero would fold into the totals and understate
      // them without saying so.
      ...(() => {
        const pay = dayPay(num(raw.regular_hours), num(raw.ot_hours), toRate(rosterEmp && rosterEmp.wage));
        return { otDollars: pay.otDollars, earnings: pay.earnings, payRate: pay.rate };
      })(),
      flags: Array.isArray(raw.flags) ? raw.flags.filter(Boolean) : [],
      source: cleanText(raw.source),
      dateSource: cleanText(raw.date_source)
    });
  }

  // ---- per employee ----------------------------------------------------
  const people = new Map();
  const personFor = (key) => {
    if (!people.has(key)) {
      people.set(key, {
        key,
        employeeNumber: null,
        name: '',
        onRoster: false,
        departmentHours: new Map(), // department -> hours, to pick the dominant one
        isSalary: false,
        scheduled: newBlock(),
        nonScheduled: newBlock(),
        days: new Set(),
        nonScheduledDays: new Set(),
        preApprovedHours: 0,
        preApprovedDollars: 0,
        hasStandingAllowance: false,
        graceHours: 0,
        graceDollars: 0,
        hasHoursThisWeek: false
      });
    }
    return people.get(key);
  };

  for (const row of rows) {
    const person = personFor(row.key);
    person.employeeNumber = person.employeeNumber || row.employeeNumber;
    person.name = person.name || row.name;
    person.onRoster = person.onRoster || row.onRoster;
    person.hasHoursThisWeek = true;
    person.departmentHours.set(row.department, (person.departmentHours.get(row.department) || 0) + row.hours);
    if (row.isSalary) person.isSalary = true;
    // The per-week rate reconciliation that used to live here is gone with the
    // rates it reconciled. It picked the highest rate seen in the week for the
    // standing allowance and the most recent one for the clock grace, because
    // daily_hours carried a rate per row that could move mid-week. It cannot
    // now: every row of a person prices at the one employees.wage holds, so
    // "highest" and "most recent" are the same number as "the rate".
    addRow(row.isScheduledDay ? person.scheduled : person.nonScheduled, row);
    person.days.add(row.date);
    if (!row.isScheduledDay) person.nonScheduledDays.add(row.date);
  }

  // The department a person is reported under: the snapshot carrying the most of
  // their hours this week. Ties fall back to the canonical department order, so
  // the answer is stable rather than dependent on row order.
  for (const person of people.values()) {
    const names = sortDepartments([...person.departmentHours.keys()]);
    let best = null, bestHours = -1;
    for (const name of names) {
      const hours = person.departmentHours.get(name);
      if (hours > bestHours) { best = name; bestHours = hours; }
    }
    person.department = best || UNASSIGNED;
  }

  // ---- pre-approved (standing) allowances ------------------------------
  const preRows            = [];
  const preByType          = {};
  const preByDepartment    = new Map();
  const unmatchedNames     = [];
  const rateMissing        = [];
  const inactiveSkipped    = [];
  const seenUnmatched      = new Set();
  const seenRateMissing    = new Set();
  const seenInactive       = new Set();
  let preApprovedHours     = 0;
  let preApprovedDollars   = 0;

  for (const type of OT_TYPES) preByType[type] = { hours: 0, dollars: 0 };

  for (const raw of standingRows) {
    // An id row and a name row are resolved here and nowhere else, so the two
    // input shapes share every line below this point.
    const employeeId = cleanText(raw.employee_id != null ? raw.employee_id : raw.employeeId);
    const rosterEmp  = employeeId
      ? (byId.get(employeeId) || null)
      : (byName.get(nameKey(String(raw.name || '').trim())) || null);

    // The name to report this row under. The roster's spelling wins when there
    // is a roster entry: 'Tim Green' in the old table is Timothy Green on the
    // roster, and showing two spellings of one person is how somebody concludes
    // there are two people.
    const name = rosterEmp
      ? (String(rosterEmp.name || '').trim() || String(raw.name || '').trim())
      : String(raw.name || '').trim();

    // A row that names nobody at all attributes to nobody. With an id-keyed
    // table this means an id that is not on the roster AND no name to fall back
    // on — a row whose employee was deleted. It is reported, not dropped.
    if (!name && !rosterEmp) {
      if (employeeId && !seenUnmatched.has(`id:${employeeId}`)) {
        seenUnmatched.add(`id:${employeeId}`);
        unmatchedNames.push(`(deleted employee ${employeeId})`);
      }
      continue;
    }

    // AN INACTIVE EMPLOYEE'S ALLOWANCE DOES NOT COUNT, and is not silent.
    //
    // A standing allowance is an entitlement to work overtime. Somebody who has
    // left cannot exercise it, so counting it inflates pre-approved OT and
    // therefore understates Net OT — every week, invisibly. This is exactly what
    // Brian McDonald's 6 hours were doing: he matched the roster by name, so
    // nothing flagged him, and the loop had no status filter.
    //
    // The Phase C migration drops his rows, but the filter belongs HERE as well:
    // the next person to go inactive keeps their row until somebody deletes it,
    // and the report must not start over-crediting them in the meantime.
    if (rosterEmp && !isActiveEmployee(rosterEmp)) {
      const label = name || `(employee ${employeeId})`;
      if (!seenInactive.has(label)) {
        seenInactive.add(label);
        inactiveSkipped.push({
          name: label,
          department: departmentBucket(rosterEmp.department),
          hours: 0
        });
      }
      const entry = inactiveSkipped.find(x => x.name === label);
      entry.hours = round2(entry.hours + num(raw.hours));
      continue;
    }

    const hours     = num(raw.hours);
    const number    = rosterEmp ? normalizeEmpNumber(rosterEmp.employee_number) : '';
    // Resolved through the roster first, exactly as the daily rows are, so a
    // person with no employee_number lands on the same key from both sides. A
    // row with no roster entry keys on itself and is reported in unmatchedNames.
    const key       = rosterEmp ? rosterKey(rosterEmp) : `name:${nameKey(name)}`;
    const worked    = people.get(key);
    const hasHours  = !!(worked && worked.hasHoursThisWeek);

    // Department: the snapshot on this week's rows when there is one, otherwise
    // the roster's current department. An unmatched name has neither, so it
    // lands in Unassigned rather than being dropped from the totals.
    const department = hasHours
      ? worked.department
      : (rosterEmp ? departmentBucket(rosterEmp.department) : UNASSIGNED);

    // Rate: ours. It used to be the highest pay_rate seen in daily_hours this
    // week, falling back to the roster — but daily_hours no longer carries one,
    // and the transcribed rate that used to be there is exactly what
    // employees.wage replaced. Nothing, in which case the dollars are honestly
    // 0 and the name is reported in rateMissing instead of being invented.
    const rate = toRate(rosterEmp && rosterEmp.wage);
    const rateSource = rate ? 'employees.wage' : 'none';

    const dollars = rate ? round2(hours * rate * PRE_APPROVED_MULTIPLIER) : 0;

    // Deduped on the comparison form so the same name typed twice with
    // different spacing is reported once, but reported with its original text.
    if (rateSource === 'none' && !seenRateMissing.has(nameKey(name))) {
      seenRateMissing.add(nameKey(name));
      rateMissing.push(name);
    }
    if (!rosterEmp && !seenUnmatched.has(nameKey(name))) {
      seenUnmatched.add(nameKey(name));
      unmatchedNames.push(name);
    }

    // An ot_type outside the three known values still counts; it gets its own
    // byType key so byType always sums to the standing totals (which is the
    // whole pre-approved total whenever the grace allowance is switched off).
    const otType = cleanText(raw.ot_type) || 'Unspecified';
    if (!preByType[otType]) preByType[otType] = { hours: 0, dollars: 0 };
    preByType[otType].hours   += hours;
    preByType[otType].dollars += dollars;

    preApprovedHours   += hours;
    preApprovedDollars += dollars;

    const deptTotals = preByDepartment.get(department) || { hours: 0, dollars: 0 };
    deptTotals.hours   += hours;
    deptTotals.dollars += dollars;
    preByDepartment.set(department, deptTotals);

    const person = personFor(key);
    person.name           = person.name || name;
    person.employeeNumber = person.employeeNumber || (number || null);
    person.onRoster       = person.onRoster || !!rosterEmp;
    person.department     = person.department || department;
    person.hasStandingAllowance = true;
    person.preApprovedHours   += hours;
    person.preApprovedDollars += dollars;

    preRows.push({
      name,
      employeeId: rosterEmp ? (cleanText(rosterEmp.id) || null) : null,
      employeeNumber: number || null,
      otType,
      hours: round2(hours),
      dollars: round2(dollars),
      // The description is the point of keeping three categories: the category
      // says WHEN, the description says WHAT. Carried through to the report so
      // the per-employee detail can show what the allowance is actually for.
      description: cleanText(raw.description),
      department,
      rateSource,
      matched: !!rosterEmp
    });
  }

  // ---- timeclock grace allowance ---------------------------------------
  //
  // The second standing component. Every active hourly employee on the roster
  // is allowed the same fixed grace every week — DEFAULT_GRACE_HOURS says what
  // the policy is and why it is not a number buried in an expression.
  //
  // Flat, per employee, per week. NOT prorated by days worked, not scaled by
  // anything: the weekend maintenance man who came in once and the employee who
  // was out all week both get the whole allowance, because the policy is an
  // entitlement rather than something earned an hour at a time. The visible
  // consequence is that the pre-approved pool does not shrink on a light week,
  // so net OT goes further negative — that is the policy being reported, not an
  // error to correct.
  //
  // Headcount is therefore asked of the ROSTER, not of daily_hours: who is
  // entitled, not who showed up.
  const standingHours   = preApprovedHours;
  const standingDollars = preApprovedDollars;

  const graceRateMissing  = [];
  // Two buckets, not three. There was a 'daily_hours' one, for a rate observed
  // in the week's own rows; the file carries no rate any more, so it could only
  // ever report zero and would read as "the file supplied none this week"
  // rather than "the file does not supply these".
  const graceByRateSource = { 'employees.wage': 0, 'none': 0 };
  let graceHeadcount   = 0;
  let graceHoursTotal  = 0;
  let graceDollarsTotal = 0;

  // An allowance of zero is the policy switched off, and off has to mean the
  // report reads exactly as it did before the policy was written down: no
  // employee rows for people who did not work, no department rows carrying
  // nothing. So the whole block is skipped rather than run to produce zeros.
  if (gracePerEmployee > 0) {
    const graced = new Set();

    for (const emp of employees || []) {
      // One roster identity, one allowance — through rosterKey, the same handle
      // the hours and the standing allowance are accumulated under, so somebody
      // who both worked and holds an overtime row is graced once and lands in
      // the same bucket all three times. A roster listing the same person twice
      // still only pays them once.
      const key = rosterKey(emp);
      if (graced.has(key)) continue;
      graced.add(key);

      if (!isActiveEmployee(emp)) continue;

      const worked   = people.get(key) || null;
      const hasHours = !!(worked && worked.hasHoursThisWeek);

      // Salaried by the roster's own pay type, or by the week's rows. Either way
      // there is no hourly rate and no grace.
      if (isSalaried(emp) || (worked && worked.isSalary)) continue;

      graceHeadcount++;

      // The same attribution rule the standing allowance uses: this week's
      // department snapshot when there is one, the roster's current department
      // when there is not, Unassigned when there is neither. A pre-approved
      // figure and the OT it offsets have to land in the same bucket.
      const department = hasHours ? worked.department : departmentBucket(emp.department);

      // Rate: ours, the same single answer the worked-hours branch above uses.
      // It used to prefer the most recent daily_hours rate inside the week; that
      // column is empty now and the rate that used to be in it is the one
      // employees.wage replaced. No rate means the HOURS still count and the
      // dollars are honestly zero — with the name reported, because a zero
      // contributed silently is a number nobody can audit afterwards.
      const rate = toRate(emp.wage);
      const rateSource = rate ? 'employees.wage' : 'none';
      graceByRateSource[rateSource]++;

      const hours   = gracePerEmployee;
      const dollars = rate ? round2(hours * rate * PRE_APPROVED_MULTIPLIER) : 0;

      if (rateSource === 'none') {
        graceRateMissing.push(cleanText(emp.name)
          || (normalizeEmpNumber(emp.employee_number) ? `Employee ${normalizeEmpNumber(emp.employee_number)}` : '(unnamed)'));
      }

      graceHoursTotal   += hours;
      graceDollarsTotal += dollars;
      preApprovedHours   += hours;
      preApprovedDollars += dollars;

      const deptTotals = preByDepartment.get(department) || { hours: 0, dollars: 0 };
      deptTotals.hours   += hours;
      deptTotals.dollars += dollars;
      preByDepartment.set(department, deptTotals);

      // Somebody who was out all week has no rows and no overtime entry, so this
      // is where their employee row comes from. Without it their grace would be
      // in the summary and in a department total with no line to trace it to.
      const person = personFor(key);
      person.name           = person.name || cleanText(emp.name) || '(unnamed)';
      person.employeeNumber = person.employeeNumber || (normalizeEmpNumber(emp.employee_number) || null);
      person.onRoster       = true;
      person.department     = person.department || department;
      person.graceHours    += hours;
      person.graceDollars  += dollars;
    }
  }

  // Standing allowances for people with no rows this week are netted anyway —
  // that is what makes net OT go negative, and clamping it would hide the fact
  // that an allowance is being carried against nothing.
  //
  // This list is the OVERTIME TABLE's allowance only, which is what it has
  // always meant: "approved for this person, and they never worked". The grace
  // allowance is held by everybody on the roster, so folding it in here would
  // list the whole absent roster every week and drown the finding.
  const withoutHoursThisWeek = [];
  for (const person of people.values()) {
    if (person.hasHoursThisWeek || !person.hasStandingAllowance) continue;
    withoutHoursThisWeek.push({
      name: person.name,
      department: person.department || UNASSIGNED,
      hours: round2(person.preApprovedHours),
      dollars: round2(person.preApprovedDollars)
    });
  }
  withoutHoursThisWeek.sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name));

  const byTypeOut = {};
  for (const type of Object.keys(preByType)) {
    byTypeOut[type] = { hours: round2(preByType[type].hours), dollars: round2(preByType[type].dollars) };
  }

  // Pre-approved OT by department, as its own breakdown. It was already being
  // accumulated for the departments block; Task 4 asks for it by category AND by
  // department, and deriving it a second time on the client from preRows would
  // be a second implementation of the same sum.
  const preByDepartmentOut = [...preByDepartment.entries()]
    .map(([department, t]) => ({
      department,
      hours: round2(t.hours),
      dollars: round2(t.dollars)
    }))
    .sort((a, b) => b.hours - a.hours || a.department.localeCompare(b.department));

  // ---- per day ---------------------------------------------------------
  const rowsByDate = new Map(dates.map(d => [d, []]));
  for (const row of rows) rowsByDate.get(row.date).push(row);

  const days = dates.map((date) => {
    const dayRows = rowsByDate.get(date);
    const isoDow  = isoDowFromMs(dateToUTC(date));
    const block   = newBlock();
    const workers = new Map();

    for (const row of dayRows) {
      addRow(block, row);
      const w = workers.get(row.key) || {
        employeeNumber: row.employeeNumber,
        name: row.name,
        department: row.department,
        hours: 0, otHours: 0, otDollars: 0, earnings: 0
      };
      w.hours     += row.hours;
      w.otHours   += row.otHours;
      w.otDollars += num(row.otDollars);
      w.earnings  += num(row.earnings);
      workers.set(row.key, w);
    }

    const distinct = (field) => {
      const values = [...new Set(dayRows.map(r => r[field]).filter(Boolean))];
      if (values.length === 0) return null;
      return values.length === 1 ? values[0] : values.join(', ');
    };

    const totals = finishBlock(block);
    return {
      date,
      dayName: DAY_NAMES[isoDow - 1],
      isoDow,
      isScheduledDay: isoDow <= LAST_SCHEDULED_ISO_DOW,
      hasData: dayRows.length > 0,
      rowCount: dayRows.length,
      hours: totals.hours,
      otHours: totals.otHours,
      otDollars: totals.otDollars,
      earnings: totals.earnings,
      headcount: totals.headcount,
      source: distinct('source'),
      dateSource: distinct('dateSource'),
      workers: [...workers.values()]
        .map(w => ({
          employeeNumber: w.employeeNumber,
          name: w.name,
          department: w.department,
          hours: round2(w.hours),
          otHours: round2(w.otHours),
          otDollars: round2(w.otDollars),
          earnings: round2(w.earnings)
        }))
        .sort((a, b) => b.otHours - a.otHours || b.hours - a.hours || a.name.localeCompare(b.name))
    };
  });

  // ---- per department --------------------------------------------------
  const deptAcc = new Map();
  const deptFor = (name) => {
    if (!deptAcc.has(name)) {
      deptAcc.set(name, { week: newBlock(), scheduled: newBlock(), weekend: newBlock() });
    }
    return deptAcc.get(name);
  };

  for (const row of rows) {
    const acc = deptFor(row.department);
    addRow(acc.week, row);
    addRow(row.isScheduledDay ? acc.scheduled : acc.weekend, row);
  }
  // A department that only shows up through a standing allowance still gets a
  // row, otherwise its pre-approved hours would vanish from the department view
  // while still counting in the summary.
  for (const name of preByDepartment.keys()) deptFor(name);

  const departments = sortDepartments([...deptAcc.keys()]).map((name) => {
    const acc = deptAcc.get(name);
    const pre = preByDepartment.get(name) || { hours: 0, dollars: 0 };
    const week = finishBlock(acc.week);
    return {
      department: name,
      week,
      scheduled: finishBlock(acc.scheduled),
      weekend: finishBlock(acc.weekend),
      preApprovedHours: round2(pre.hours),
      preApprovedDollars: round2(pre.dollars),
      netOtHours: round2(acc.week.otHours - pre.hours),
      netOtDollars: round2(acc.week.otDollars - pre.dollars)
    };
  });

  // ---- summary + split -------------------------------------------------
  const weekBlock         = newBlock();
  const scheduledBlock    = newBlock();
  const nonScheduledBlock = newBlock();
  for (const row of rows) {
    addRow(weekBlock, row);
    addRow(row.isScheduledDay ? scheduledBlock : nonScheduledBlock, row);
  }

  const week         = finishBlock(weekBlock);
  const scheduled    = finishBlock(scheduledBlock);
  // "weekend" and "nonScheduled" are the same Fri-Sun block under two names, so
  // scheduled + weekend is always exactly the week. Friday belongs here: the
  // scheduled week is Mon-Thu, and Friday work is maintenance work.
  const nonScheduled = finishBlock(nonScheduledBlock);

  const totalHourlyPayroll = week.earnings;
  const netOtHours   = round2(week.otHours - preApprovedHours);
  const netOtDollars = round2(week.otDollars - preApprovedDollars);

  const summary = {
    allOtHours: week.otHours,
    allOtDollars: week.otDollars,
    preApprovedHours: round2(preApprovedHours),
    preApprovedDollars: round2(preApprovedDollars),
    // Net OT is reported exactly as it lands. A standing allowance larger than
    // the OT actually worked makes this negative, and that is the finding.
    netOtHours,
    netOtDollars,
    totalHourlyPayroll,
    // A fraction (0.0731), not a percentage. null rather than 0 or Infinity when
    // there is no payroll to divide by — a week with no data has no percentage.
    netOtPctOfPayroll: totalHourlyPayroll === 0 ? null : round2Pct(netOtDollars / totalHourlyPayroll),
    totalHours: week.hours,
    headcount: week.headcount,
    weekendHours: nonScheduled.hours,
    weekendDollars: nonScheduled.earnings,
    weekendOtHours: nonScheduled.otHours,
    weekendOtDollars: nonScheduled.otDollars,
    weekendHeadcount: nonScheduled.headcount
  };

  const split = {
    scheduled: {
      hours: scheduled.hours, otHours: scheduled.otHours, otDollars: scheduled.otDollars,
      earnings: scheduled.earnings, headcount: scheduled.headcount
    },
    nonScheduled: {
      // earnings, not otDollars: a Saturday maintenance shift paid entirely at
      // the regular rate has 0 OT dollars and still costs real money.
      hours: nonScheduled.hours, otHours: nonScheduled.otHours, otDollars: nonScheduled.otDollars,
      earnings: nonScheduled.earnings, headcount: nonScheduled.headcount
    }
  };

  // ---- employees -------------------------------------------------------
  const employeeList = [...people.values()].map((person) => {
    const scheduledTotals    = finishBlock(person.scheduled);
    const nonScheduledTotals = finishBlock(person.nonScheduled);
    const otHours   = round2(person.scheduled.otHours + person.nonScheduled.otHours);
    const otDollars = round2(person.scheduled.otDollars + person.nonScheduled.otDollars);
    return {
      employeeNumber: person.employeeNumber,
      name: person.name,
      department: person.department || UNASSIGNED,
      onRoster: person.onRoster,
      scheduledHours: scheduledTotals.hours,
      scheduledEarnings: scheduledTotals.earnings,
      nonScheduledHours: nonScheduledTotals.hours,
      nonScheduledEarnings: nonScheduledTotals.earnings,
      otHours,
      otDollars,
      totalHours: round2(person.scheduled.hours + person.nonScheduled.hours),
      totalEarnings: round2(person.scheduled.earnings + person.nonScheduled.earnings),
      // preApproved* here stays the OVERTIME TABLE's allowance, unchanged, and
      // grace is reported beside it rather than merged into it — one is specific
      // to this person, the other is everybody's. Add the two to reconcile a
      // column of this table against summary.preApprovedHours.
      preApprovedHours: round2(person.preApprovedHours),
      preApprovedDollars: round2(person.preApprovedDollars),
      graceHours: round2(person.graceHours),
      graceDollars: round2(person.graceDollars),
      netOtHours: round2(person.scheduled.otHours + person.nonScheduled.otHours - person.preApprovedHours),
      netOtDollars: round2(person.scheduled.otDollars + person.nonScheduled.otDollars - person.preApprovedDollars),
      daysWorked: person.days.size,
      nonScheduledDaysWorked: person.nonScheduledDays.size
    };
  }).sort((a, b) => b.otHours - a.otHours || b.totalHours - a.totalHours || a.name.localeCompare(b.name));

  // ---- completeness ----------------------------------------------------
  // "Expected" now means every day, because the vendor sends every day. The
  // only reason a day is not expected is that it has not happened yet, and the
  // caller is the one that knows when "now" is — see the expectedDays note at
  // the top of this file.
  const expectedSet = Array.isArray(expectedDays)
    ? new Set(expectedDays.map(normalizeDate).filter(Boolean))
    : new Set(dates);

  const completenessDays = days.map(day => {
    const expected = expectedSet.has(day.date);
    return {
      date: day.date,
      dayName: day.dayName,
      // Kept because the report splits scheduled hours from weekend hours and
      // the UI badges the difference. It no longer decides whether an empty day
      // is a missed delivery.
      isScheduledDay: day.isScheduledDay,
      hasData: day.hasData,
      rowCount: day.rowCount,
      expected,
      // Three states, and every day of the week reaches all three:
      //   'data'     rows are present
      //   'missing'  the day has passed and is empty — a probable missed delivery
      //   'pending'  the day is not in the expected set, i.e. it has not
      //              happened yet. Never a judgement about whether anyone worked.
      status: day.hasData ? 'data' : (expected ? 'missing' : 'pending')
    };
  });

  const expectedDayList = completenessDays.filter(d => d.expected);
  const completeness = {
    days: completenessDays,
    // Renamed off "scheduled": these count every day the vendor owed a report,
    // which is all of them. A name promising Mon-Thu would now be a lie.
    missingDays: expectedDayList.filter(d => !d.hasData).map(d => d.date),
    daysWithData: expectedDayList.filter(d => d.hasData).length,
    daysExpected: expectedDayList.length
  };

  // ---- issues ----------------------------------------------------------
  const unknownEmployeeNumbers = [];
  const seenUnknown = new Set();
  const unassignedEmployees = [];
  const seenUnassigned = new Set();
  const flagged = [];
  let unassignedRows = 0;

  // Somebody who WORKED and has no rate on file.
  //
  // This did not need to exist while the daily file carried a rate: almost
  // everybody had one, and the pre-approved section's rateMissing covered the
  // rest. It needs to exist now. A person the file creates arrives with NO rate
  // and cannot have one until somebody types it on Salaries & Wages, and until
  // then dayPay returns null earnings for every one of their days — which the
  // aggregations fold to 0. Their hours are in the report and their dollars are
  // missing from it, and without this list nothing says so.
  //
  // Keyed on row.key, the same identity the department and allowance
  // attribution use, so one person is reported once however many days they
  // worked and whether or not they carry an employee number.
  const workedRateMissing = [];
  const workedRateMissingHours = new Map();

  for (const row of rows) {
    // payRate is dayPay's answer, which is null for a missing, zero or
    // unparseable wage — the three cases that must not price a day at nothing.
    if (row.payRate === null && row.hours > 0) {
      if (!workedRateMissingHours.has(row.key)) {
        workedRateMissingHours.set(row.key, 0);
        workedRateMissing.push({ key: row.key, employeeNumber: row.employeeNumber,
                                 name: row.name, department: row.department, hours: 0 });
      }
      workedRateMissingHours.set(row.key, round2(workedRateMissingHours.get(row.key) + row.hours));
    }
  }
  for (const person of workedRateMissing) {
    person.hours = workedRateMissingHours.get(person.key);
    delete person.key;
  }
  workedRateMissing.sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name));

  for (const row of rows) {
    if (!row.onRoster) {
      const label = row.employeeNumber || `(no number) ${row.name}`;
      if (!seenUnknown.has(label)) { seenUnknown.add(label); unknownEmployeeNumbers.push(label); }
    }
    if (!row.hasDepartment) {
      unassignedRows++;
      if (!seenUnassigned.has(row.key)) {
        seenUnassigned.add(row.key);
        unassignedEmployees.push({ employeeNumber: row.employeeNumber, name: row.name });
      }
    }
    if (row.flags.length) {
      flagged.push({
        workDate: row.date,
        employeeNumber: row.employeeNumber,
        name: row.name,
        flags: row.flags.slice()
      });
    }
  }

  // Reconciliation compares the rounded department figures — the ones a reader
  // can add up on screen — against the rounded summary. Anything that does not
  // tie is reported with its delta rather than quietly absorbed.
  const departmentHours    = round2(departments.reduce((sum, d) => sum + d.week.hours, 0));
  const departmentEarnings = round2(departments.reduce((sum, d) => sum + d.week.earnings, 0));
  const hoursDelta         = round2(departmentHours - summary.totalHours);
  const earningsDelta      = round2(departmentEarnings - totalHourlyPayroll);

  // An SG&A bucket with anything in it is a FINDING, not a normal row. These
  // people are salaried and dropped at import, so nothing should reach this
  // bucket at all. Anything that does means somebody is hourly AND
  // non-production, and one of those two facts is wrong.
  //
  // The grace allowance counts as evidence on its own, with no daily_hours
  // behind it: clock grace is a policy about hourly staff, not about which
  // department they sit in, so an hourly SG&A employee draws it even in a week
  // they never clocked in — and that allowance is then sitting in a
  // department that should not have one. hours is 0 for such a row, and
  // graceHours says where it came from.
  //
  // The bucket itself stays in report.departments regardless, so the department
  // rows still add up to the summary. This list is what makes it legible.
  const nonProductionWithHours = employeeList
    .filter(e => e.department === NON_PRODUCTION &&
                 (e.totalHours !== 0 || e.graceHours !== 0 || e.preApprovedHours !== 0))
    .map(e => ({
      employeeNumber: e.employeeNumber,
      name: e.name,
      hours: e.totalHours,
      otHours: e.otHours,
      otDollars: e.otDollars,
      earnings: e.totalEarnings,
      graceHours: e.graceHours,
      preApprovedHours: e.preApprovedHours
    }))
    .sort((a, b) => b.hours - a.hours || b.graceHours - a.graceHours || a.name.localeCompare(b.name));

  const issues = {
    unknownEmployeeNumbers,
    unassignedRows,
    unassignedEmployees,
    nonProductionWithHours,
    workedRateMissing,
    flagged,
    reconciliation: {
      departmentHours,
      summaryHours: summary.totalHours,
      departmentEarnings,
      summaryEarnings: totalHourlyPayroll,
      hoursDelta,
      earningsDelta,
      balanced: Math.abs(hoursDelta) < TOLERANCE && Math.abs(earningsDelta) < TOLERANCE
    }
  };

  return {
    weekStart: monday,
    weekEnd: sunday,
    summary,
    split,
    departments,
    days,
    employees: employeeList,
    preApproved: {
      // byType, rows, unmatchedNames, withoutHoursThisWeek and rateMissing are
      // all the OVERTIME TABLE's allowance and mean exactly what they always
      // did. standing and grace are the two components of the total that
      // summary.preApprovedHours reports, kept apart on purpose.
      byType: byTypeOut,
      byDepartment: preByDepartmentOut,
      rows: preRows,
      unmatchedNames,
      withoutHoursThisWeek,
      rateMissing,
      // Allowances held by people who have left. NOT counted in any total —
      // somebody who is gone cannot work the overtime, and crediting them
      // understates Net OT every week. Reported so the row can be deleted
      // rather than silently ignored forever.
      inactiveSkipped,
      // True while the report is still reading the name-keyed `overtime` table,
      // so the UI can say the allowance is not yet per-employee. Derived from
      // the rows in hand rather than from a flag the caller sets, because the
      // caller passing the wrong flag is the failure this is meant to catch.
      keyedOnEmployeeId: standingRows.length > 0
        && standingRows.every(r => cleanText(r.employee_id != null ? r.employee_id : r.employeeId) !== null),
      standing: { hours: round2(standingHours), dollars: round2(standingDollars) },
      grace: {
        hoursPerEmployee: gracePerEmployee,   // the value actually used, so the number can be audited
        headcount: graceHeadcount,            // active hourly employees on the roster
        hours: round2(graceHoursTotal),
        dollars: round2(graceDollarsTotal),
        rateMissing: graceRateMissing,        // counted in hours, contributed $0
        byRateSource: graceByRateSource
      }
    },
    completeness,
    issues
  };
}

// Percentages are fractions, and 2 decimals would flatten every realistic OT
// share to 0.07. Four keeps a tenth of a percent visible.
function round2Pct(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  const r = (Math.round(Math.abs(v) * 10000 + Number.EPSILON) / 10000) * Math.sign(v);
  return r === 0 ? 0 : r;
}

module.exports = {
  weekStartFor, weekDates, buildReport, DEFAULT_GRACE_HOURS,
  // DEPARTMENTS is the production breakdown; ASSIGNABLE_DEPARTMENTS is the full
  // set of values employees.department may hold. They are different questions
  // and both are exported so neither caller has to rebuild the other's list.
  DEPARTMENTS, NON_PRODUCTION, ASSIGNABLE_DEPARTMENTS, UNASSIGNED,
  // Exported so the grace exclusion can be asserted directly rather than only
  // through the headcount it moves.
  isSalaried
};
