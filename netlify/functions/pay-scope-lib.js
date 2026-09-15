// WHO MAY CARRY PAY DATA AT ALL.
//
// One rule, one file, because it is enforced in three places that must not be
// able to disagree: the hourly-rate editor (wage-edit-lib), the roster write
// endpoint (data.js, which owns annual_salary), and the costing report
// (cost-report.js, which decides what is reportable).
//
// ------------------------------------------------------------------------
// THE RULE — PER COLUMN, NOT PER PERSON
// ------------------------------------------------------------------------
//
//   annual_salary   Manufacturing, and nobody else.
//   wage            Manufacturing, plus SG&A WHEN THE PERSON IS HOURLY.
//
// Everyone else stays on the roster in full — name, department, phone,
// birthday, hours, points, documents — and carries neither column.
//
// ------------------------------------------------------------------------
// WHY THE TWO COLUMNS DIVERGED, 2026-09-15
// ------------------------------------------------------------------------
//
// The original rule was one line — Manufacturing carries pay, nobody else does
// — recorded on 2026-09-14 when SG&A and Mill Overhead stopped being analysed
// here. It was too blunt by exactly one case, and that case is a real person.
//
// SG&A OVERTIME IS STILL TRACKED. It was the one thing deliberately kept when
// the rest of SG&A analysis was dropped, and today it is one hourly employee.
// An hourly employee who earns overtime has an hourly rate; it is the number
// their own pay is computed from, not an analysis this app invented. Refusing
// to hold it meant the roster could not answer what somebody is paid, and the
// only place it survived was wage_history — which records rate CHANGES and is
// the wrong thing to read for a current rate.
//
// A SALARIED SG&A EMPLOYEE STILL CARRIES NOTHING, and that is the half of the
// original decision that stands. Their salary is the figure the 2026-09-14
// change existed to stop holding: it is not needed for overtime (the payroll
// file drops salaried people, so they earn no OT hour in this system), nothing
// reports on it, and it is the more sensitive of the two numbers.
//
// So pay type now decides something it deliberately did not before. Inside
// Manufacturing it still does not — a Manufacturing person carries whichever
// column their pay type calls for, and which one that is gets decided
// downstream by wage-edit-lib's rule 2 and by the salary field's own gate.
// Outside Manufacturing it is load-bearing: SG&A carries the hourly column
// alone, so being salaried there means carrying nothing.
//
// ------------------------------------------------------------------------
// WHAT IT IS NOT
// ------------------------------------------------------------------------
//
// NOT a permission. permissions-lib.js decides who may read and write
// annual_salary; this decides whether the COLUMN applies to this PERSON at all.
// A reader holding the salaries tier still cannot set a salary on an SG&A
// employee, because there is no such thing to set.
//
// NOT keyed on department. Cost class and department are independent axes — see
// the taxonomy note in src/js/core.js — and this rule is about the accounting
// bucket, which is the axis the decision was made on. Axeri Ramirez is
// department 'Accounting', cost class 'SG&A'.
//
// NOT a route into the costing report. cost-lib filters its members on
// cost_class === 'Manufacturing' and REPORTED_COST_CLASSES has one entry, so an
// SG&A rate cannot reach Manufacturing Costs however it is set. The rate exists
// for the roster and for SG&A overtime, which is reported on its own terms.

const { isSalaried } = require('./wage-sync');

// The class that carries both columns.
const COSTED_COST_CLASS = 'Manufacturing';

// The class that carries the hourly column alone, and only for hourly people.
// Mill Overhead is deliberately NOT here: the v2 model retired it, nobody on
// the roster lands in it, and adding a class nobody holds would be widening the
// rule on speculation.
const HOURLY_ONLY_COST_CLASS = 'SG&A';

// The two compensation columns on `employees`. Listed here so a third one
// added later is a deliberate edit in the place that already governs the other
// two, rather than a column nobody remembers to clear.
const PAY_COLUMNS = ['wage', 'annual_salary'];

function costClassOf(employee) {
  const emp = employee || {};
  const raw = emp.cost_class != null ? emp.cost_class : emp.costClass;
  return String(raw == null ? '' : raw).trim();
}

// Whether this person's row may hold an HOURLY RATE.
//
// Manufacturing is true regardless of pay type, and that is not an oversight.
// A salaried Manufacturing person is refused their hourly rate one step later,
// by wage-edit-lib's rule 2, whose sentence is the useful one: their cost comes
// from annual_salary / 2,080 and a rate would be counted twice. Answering
// "Manufacturing staff cannot have an hourly rate" here instead would be false
// and would send somebody looking for the wrong fix.
//
// A BLANK COST CLASS IS NOT COSTED, which is the safe direction rather than an
// oversight: the BBSI import auto-creates a new arrival with a null cost class
// and a null wage (see payroll-db.applyWageSync), so "unclassified" is exactly
// the state of somebody nobody has decided about yet. Classify first, then pay
// — which is also the order employee_setup_tasks queues the work in.
//
// A BLANK PAY TYPE READS AS HOURLY, because isSalaried() says so and it is the
// one answer the whole app already gives: payTypeOf() shows 'Hourly' for a
// blank, and the profile's Pay type select opens on it. Inventing a third state
// here would make this file disagree with every screen.
function carriesWage(employee) {
  const cls = costClassOf(employee);
  if (cls === COSTED_COST_CLASS) return true;
  if (cls === HOURLY_ONLY_COST_CLASS) return !isSalaried(employee);
  return false;
}

// Whether this person's row may hold an ANNUAL SALARY. Unchanged from
// 2026-09-14: Manufacturing alone.
function carriesSalary(employee) {
  return costClassOf(employee) === COSTED_COST_CLASS;
}

// The column-aware entry point. `column` is one of PAY_COLUMNS; anything else
// is treated as the wage, because that is the column every caller that does not
// name one is asking about.
function carriesPay(employee, column) {
  return column === 'annual_salary' ? carriesSalary(employee) : carriesWage(employee);
}

// The refusal, as a sentence somebody can act on. Names the fact that is
// actually in the way — which is the cost class in most cases and the PAY TYPE
// for a salaried SG&A employee, where saying "SG&A staff cannot have an hourly
// rate" would be wrong: their hourly colleague can.
function payRefusal(employee, column) {
  const name = String((employee && employee.name) || '').trim() || 'This employee';
  const cls = costClassOf(employee);
  const salary = column === 'annual_salary';
  const what = salary ? 'An annual salary' : 'An hourly rate';

  if (!cls) {
    return {
      error: `${what} cannot be set until a cost class is chosen.`,
      detail: `${name} is not classified into a cost class yet. Set their cost class on the ` +
              `Employees tab first — pay follows the classification, not the other way round.`
    };
  }

  // Salaried SG&A: the class is not the blocker, the pay type is.
  if (!salary && cls === HOURLY_ONLY_COST_CLASS) {
    return {
      error: 'A salaried SG&A employee has no hourly rate here.',
      detail: `${name} is salaried in the ${cls} cost class. ${cls} carries an hourly rate only ` +
              `for hourly staff — it is the rate their overtime is paid at, and the payroll file ` +
              `drops salaried people, so a salaried ${cls} employee earns no overtime hour and ` +
              `carries no pay in this app. Change their pay type to Hourly if that is wrong.`
    };
  }

  const carrier = salary
    ? COSTED_COST_CLASS
    : `${COSTED_COST_CLASS} and for hourly ${HOURLY_ONLY_COST_CLASS} staff`;

  return {
    error: `${what} cannot be set for ${cls} staff.`,
    detail:
      `${name} is in the ${cls} cost class, and ${salary ? 'an annual salary' : 'an hourly rate'} ` +
      `is only held for ${carrier}. ` +
      `${cls} is not costed in this app — the roster entry, hours and overtime are kept, the pay ` +
      `is not. If this person really is production staff, change their cost class to ` +
      `${COSTED_COST_CLASS} first.`
  };
}

module.exports = {
  COSTED_COST_CLASS, HOURLY_ONLY_COST_CLASS, PAY_COLUMNS,
  costClassOf, carriesWage, carriesSalary, carriesPay, payRefusal
};
