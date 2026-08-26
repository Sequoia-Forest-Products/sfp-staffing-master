// wage-edit-lib — an hourly rate typed into the app, decided purely.
//
// ------------------------------------------------------------------------
// WHY THIS EXISTS
// ------------------------------------------------------------------------
//
// Until 2026-08-22 nothing in the app could set employees.wage, and that was
// correct: the daily BBSI file rewrote the column every morning through
// payroll-db.updateEmployeeWage, so a rate typed here would have been replaced
// overnight with nobody told.
//
// The file's Pay Rate column turned out not to be a source of truth at all. It
// was a human transcription out of BBSI's payroll system into Timenet, kept
// alive only so this feed could exist, and nobody maintains it there any more.
// So the import stopped reading it, employees.wage became the record of truth,
// and somebody has to be able to type one — otherwise a new hire's cost cannot
// be computed at all and a raise never reaches any report.
//
// This module decides what an edit MEANS. It writes nothing. data.js performs
// the two writes it returns, in the order it returns them.
//
// ------------------------------------------------------------------------
// THE RULES, and each one is a thing that would otherwise go wrong
// ------------------------------------------------------------------------
//
//   1. HISTORY FIRST, ALWAYS. The wage_history row goes in before the
//      employees.wage update that makes the old rate unrecoverable, exactly as
//      applyWageSync does it. If the history insert fails the update is
//      skipped: an overwrite with no history is the thing wage_history exists
//      to prevent, and a history row for a change that then failed to apply is
//      recoverable — the reverse is not.
//
//   2. A SALARIED PERSON HAS NO HOURLY RATE. Their compensation is
//      annual_salary and the costing reports divide it by 2,080. Writing an
//      hourly rate onto them would be counted a second time, so it is refused
//      rather than accepted and reconciled later.
//
//   3. ZERO IS NOT A RATE. Nor is blank, nor a negative, nor anything
//      unparseable. Rule 2 of wage-sync applies here for the same reason: a
//      rate of zero prices a day's work at nothing and looks exactly like a
//      correctly-computed figure downstream.
//
//   4. CLEARING A RATE IS REFUSED, not silently allowed. wage_history.rate is
//      NOT NULL, so a cleared rate cannot be recorded, and an unrecorded
//      disappearance of somebody's pay is precisely rule 1 in reverse. A rate
//      can be corrected. It cannot be deleted.
//
//   5. NO EMPLOYEE NUMBER, NO EDIT. wage_history.employee_number is NOT NULL —
//      the file identifies people by number and the history is keyed by it. A
//      person with no number cannot have their rate recorded, so the edit is
//      refused with a message that says what to fix.
//
//   6. A BIG MOVE IS FLAGGED, NEVER BLOCKED. Same threshold and same reasoning
//      as the import: a typo and a real raise are indistinguishable in the
//      data, and the difference is that one of them should be looked at.
//      Blocking would stop a legitimate raise on a Friday afternoon.

const { normalizeRate, isSalaried, changePercent, DEFAULT_THRESHOLD_PCT } = require('./wage-sync');

// wage_history.source. 'bbsi' is the import's; this is the other one, and the
// two are what tells a typed correction from a vendor observation.
const SOURCE = 'manual';

const DEFAULT_TIME_ZONE = process.env.PAYROLL_TIME_ZONE || 'America/Los_Angeles';

// Today's calendar date in a named zone, regardless of where Netlify runs this.
// Built from Intl parts so it is a literal calendar date and not an instant —
// a rate typed at 5pm Pacific must not record itself against tomorrow because
// the lambda runs in UTC. Five lines, duplicated from week-index-lib.todayInZone
// rather than imported: that module reaches payroll-db, and this one is loaded
// by the roster endpoint on every write.
function todayInZone(now = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function textOf(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  return raw === '' ? null : raw;
}

function resolveThreshold(thresholdPct) {
  if (thresholdPct !== undefined && thresholdPct !== null && thresholdPct !== '') {
    const explicit = Number(thresholdPct);
    if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  }
  const fromEnv = Number(process.env.WAGE_CHANGE_ALERT_PCT);
  if (Number.isFinite(fromEnv) && fromEnv >= 0) return fromEnv;
  return DEFAULT_THRESHOLD_PCT;
}

const refuse = (error, detail) => ({ ok: false, error, detail });

// What a typed rate means for one person.
//
//   employee     the row as the database has it RIGHT NOW, read before the
//                write. previous_rate comes from here and nowhere else — the
//                browser's copy can be minutes stale, and a history row whose
//                previous_rate is a value that was never current is worse than
//                no history at all.
//   value        exactly what the caller sent, undecorated or not.
//
// Returns one of three shapes, and the caller must distinguish all three:
//
//   { ok:false, error, detail }        refused. Nothing is written.
//   { ok:true, unchanged:true }        the same rate, retyped. Nothing is
//                                      written — a history row for a change
//                                      that did not happen is a false record.
//   { ok:true, history, wage, ... }    write history, THEN wage. In that order.
function planWageEdit({ employee, value, editorEmail = null, now = new Date(),
                        timeZone, thresholdPct } = {}) {
  const emp = employee || null;
  if (!emp || !emp.id) {
    return refuse('That employee no longer exists.',
      'The row was not found. Reload the page — somebody may have removed them.');
  }

  if (isSalaried(emp)) {
    return refuse('A salaried employee has no hourly rate.',
      'Their cost comes from Annual salary ÷ 2,080. Setting an hourly rate as well ' +
      'would count them twice. Change their pay type on the Employees tab first if ' +
      'this person really is hourly.');
  }

  const employeeNumber = textOf(emp.employee_number);
  if (!employeeNumber) {
    return refuse('This person has no employee number.',
      'Every rate change is recorded in wage history, which is keyed by employee ' +
      'number. Set their Emp # on the Employees tab and the rate can be saved.');
  }

  // Blank is caught BEFORE normalizeRate, which reads it as "no rate" — the
  // same answer it gives for "$0.00" and for "abc". Three different mistakes
  // deserve three different sentences.
  if (textOf(value) === null) {
    return refuse('A rate cannot be cleared, only corrected.',
      'Wage history has no way to record a rate that went away, and an unrecorded ' +
      'disappearance of somebody\'s pay is the one thing this history exists to ' +
      'prevent. Type the correct rate instead.');
  }

  const rate = normalizeRate(value);
  if (rate === null) {
    return refuse(`"${String(value).trim()}" is not an hourly rate.`,
      'Enter a number greater than zero, e.g. 24.50. A rate of zero prices a day\'s ' +
      'work at nothing and reads downstream exactly like a correctly computed figure.');
  }

  const previousRate = normalizeRate(emp.wage);

  // Compared as rounded numbers, not as strings: '24.5' typed over a stored
  // '24.50' is not a change, and writing it would append a history row saying
  // a rate moved when it did not.
  if (previousRate !== null && Math.abs(previousRate - rate) < 0.005) {
    return { ok: true, unchanged: true, rate, previousRate };
  }

  const threshold = resolveThreshold(thresholdPct);
  // changePercent, not an inline expression. It rounds to two places BEFORE
  // anything compares the result to the threshold, which is what stops
  // (30 - 25) / 25 * 100 === 20.000000000000004 reading as "over 20%". This
  // file had its own copy of that arithmetic; a rule whose whole point is a
  // floating-point subtlety must not exist twice.
  const changePct = changePercent(previousRate, rate);
  const flagged = changePct !== null && Math.abs(changePct) > threshold;

  const who = textOf(editorEmail) || 'an app user';
  const note = previousRate === null
    ? `First rate on file, set on Salaries & Wages by ${who}.`
    : `Changed from ${previousRate.toFixed(2)} to ${rate.toFixed(2)} on Salaries & Wages by ${who}.` +
      (flagged ? ` Flagged: a move of ${changePct}% is beyond the ${threshold}% threshold.` : '');

  return {
    ok: true,
    unchanged: false,
    rate,
    previousRate,
    changePct,
    flagged,
    thresholdPct: threshold,

    // Exactly the wage_history columns from SCHEMA_V2_MODEL.sql section 6. id
    // and created_at are database defaults and are never sent.
    history: {
      employee_id: emp.id,
      employee_number: employeeNumber,
      employee_name: textOf(emp.name),
      rate,
      previous_rate: previousRate,
      change_pct: changePct,
      // The day the edit is made, which for a typed rate IS its effective date.
      // The import refuses to guess this because a late file must land on the
      // day it describes; a person at a keyboard is describing today.
      effective_date: todayInZone(now, timeZone || DEFAULT_TIME_ZONE),
      source: SOURCE,
      flagged,
      note
    },

    // employees.wage is TEXT. Two decimals so the column reads like the rest of
    // the roster, matching payroll-db.wageText.
    wage: rate.toFixed(2)
  };
}

module.exports = { planWageEdit, todayInZone, SOURCE };
