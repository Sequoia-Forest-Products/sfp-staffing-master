// WHO MAY CARRY PAY DATA AT ALL.
//
// One rule, one file, because it is enforced in three places that must not be
// able to disagree: the hourly-rate editor (wage-edit-lib), the roster write
// endpoint (data.js, which owns annual_salary), and the costing report
// (cost-report.js, which decides what is reportable).
//
// ------------------------------------------------------------------------
// THE RULE
// ------------------------------------------------------------------------
//
// Compensation is held for the MANUFACTURING cost class and for nobody else.
// A person outside it stays on the roster in full — name, department, phone,
// birthday, hours, points, documents — and carries no `wage` and no
// `annual_salary`.
//
// This is a business decision recorded on 2026-09-14, not a permission: SG&A
// and Mill Overhead are no longer analysed in this app, so their pay is not
// data this system has any use for. Holding compensation that nothing reads is
// a liability with no offsetting benefit — it still sits in every backup, it
// still has to be gated, and the gate is the only thing standing between it and
// every signed-in sequoiafp.com account.
//
// It is enforced rather than merely intended, because the alternative is a rule
// that holds until somebody types into the wrong field. The UI hides the
// inputs; this refuses the write.
//
// ------------------------------------------------------------------------
// WHAT IT IS NOT
// ------------------------------------------------------------------------
//
// NOT a cost-class-derived permission. permissions-lib.js decides who may read
// and write annual_salary; this decides whether the COLUMN applies to this
// PERSON at all. A reader holding the salaries tier still cannot set a salary
// on an SG&A employee, because there is no such thing to set.
//
// NOT keyed on pay type. A salaried Manufacturing person (Eduardo Rivera) keeps
// their annual_salary; an hourly SG&A person (Axeri Ramirez) has no wage. Pay
// type says WHICH column would apply, never whether one does.
//
// NOT keyed on department. Cost class and department are independent axes — see
// the taxonomy note in src/js/core.js — and this rule is about the accounting
// bucket, which is the axis the decision was made on.

const COSTED_COST_CLASS = 'Manufacturing';

// The two compensation columns on `employees`. Listed here so a third one
// added later is a deliberate edit in the place that already governs the other
// two, rather than a column nobody remembers to clear.
const PAY_COLUMNS = ['wage', 'annual_salary'];

function costClassOf(employee) {
  const emp = employee || {};
  const raw = emp.cost_class != null ? emp.cost_class : emp.costClass;
  return String(raw == null ? '' : raw).trim();
}

// Whether this person's row may hold compensation.
//
// A BLANK COST CLASS IS NOT COSTED, and that is the safe direction rather than
// an oversight: the BBSI import auto-creates a new arrival with a null cost
// class and a null wage (see payroll-db.applyWageSync), so "unclassified" is
// exactly the state of somebody nobody has decided about yet. Classify first,
// then pay — which is also the order employee_setup_tasks queues the work in.
function carriesPay(employee) {
  return costClassOf(employee) === COSTED_COST_CLASS;
}

// The refusal, as a sentence somebody can act on. Names the person's actual
// cost class so the reader is not left guessing which fact is in the way.
function payRefusal(employee, column) {
  const name = String((employee && employee.name) || '').trim() || 'This employee';
  const cls = costClassOf(employee);
  const what = column === 'annual_salary' ? 'An annual salary' : 'An hourly rate';
  return {
    error: cls
      ? `${what} cannot be set for ${cls} staff.`
      : `${what} cannot be set until a cost class is chosen.`,
    detail:
      `${name} is ${cls ? `in the ${cls} cost class` : 'not classified into a cost class yet'}, and ` +
      `compensation is only held for ${COSTED_COST_CLASS}. ` +
      (cls
        ? `${cls} is not costed in this app — the roster entry, hours and overtime are kept, the pay is not. ` +
          `If this person really is production staff, change their cost class to ${COSTED_COST_CLASS} first.`
        : `Set their cost class on the Employees tab first.`)
  };
}

module.exports = { COSTED_COST_CLASS, PAY_COLUMNS, costClassOf, carriesPay, payRefusal };
