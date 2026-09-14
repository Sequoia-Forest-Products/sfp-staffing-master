-- ============================================================================
-- RETIRE THE OVERHEAD ANALYSIS — 2026-09-14
-- ============================================================================
--
-- The Overhead tab is gone and with it the analysis of two cost classes. This
-- is the data half of that change: compensation is held for the Manufacturing
-- cost class and for nobody else.
--
-- WHAT DOES NOT CHANGE, and it is most of it:
--
--   * Nobody leaves the roster. Every SG&A and Mill Overhead employee keeps
--     their row, their department, their cost class, their phone, their
--     birthday, their documents and their points.
--   * Hours and overtime keep flowing. daily_hours is untouched, the payroll
--     import still records these people, and SG&A overtime is now reported on
--     its own view under the Overtime tab — the one thing still tracked about
--     the class.
--   * cost_class keeps all three values. It is still assigned on the employee
--     profile card; what changed is that only one of the three is costed.
--
-- WHAT THIS DOES: nulls employees.wage and employees.annual_salary for every
-- row outside the Manufacturing cost class, active or not.
--
-- THIS IS NOT REVERSIBLE FROM HERE. No snapshot table is written — that was the
-- explicit instruction, and writing one anyway would have quietly kept the
-- compensation this change exists to remove. wage_history still holds the last
-- recorded hourly rate for anybody who ever had one typed or imported;
-- annual_salary has no history table and those figures are gone.
--
-- Run it once, in the Supabase SQL editor. Steps 1 and 4 are read-only.
--
-- The application enforces the same rule from that day on — see
-- netlify/functions/pay-scope-lib.js — so this backfills history rather than
-- holding a line: nothing in the app can put a wage or a salary back onto one
-- of these rows.

-- ----------------------------------------------------------------------------
-- 1. BEFORE — who is about to lose what. Run this first and read it.
-- ----------------------------------------------------------------------------
select cost_class,
       status,
       count(*)                                        as people,
       count(wage)                                     as with_wage,
       count(annual_salary)                            as with_salary
from employees
where coalesce(cost_class, '') <> 'Manufacturing'
group by cost_class, status
order by cost_class nulls first, status;

-- The same thing by name, because a count does not tell you whether the right
-- people are in it.
select name, employee_number, status, cost_class, department, pay_type,
       wage, annual_salary
from employees
where coalesce(cost_class, '') <> 'Manufacturing'
  and (wage is not null or annual_salary is not null)
order by cost_class nulls first, name;

-- ----------------------------------------------------------------------------
-- 2. THE CHANGE
-- ----------------------------------------------------------------------------
--
-- Both columns in one statement, and the WHERE clause names the rule rather
-- than the people: a row reclassified into one of these buckets tomorrow is
-- cleared by the application, not by somebody remembering to re-run this.
--
-- A NULL cost class is included. That is the state the BBSI import auto-creates
-- an arrival in — see payroll-db.applyWageSync — and an unclassified person is
-- not a Manufacturing person. It writes nothing today (those rows are created
-- with a null wage) and it keeps the statement's rule the same as the
-- application's.
update employees
set wage = null,
    annual_salary = null,
    updated_at = now()
where coalesce(cost_class, '') <> 'Manufacturing'
  and (wage is not null or annual_salary is not null);

-- ----------------------------------------------------------------------------
-- 3. THE MANUFACTURING ROSTER IS UNTOUCHED — assert it rather than assume it
-- ----------------------------------------------------------------------------
--
-- Expected: a count matching what step 1 did NOT list. If this returns zero
-- rows with a wage, step 2's WHERE clause was wrong and the mill's own payroll
-- has just been emptied — restore from the point-in-time backup before anybody
-- opens Manufacturing Costs.
select count(*) filter (where wage is not null)          as hourly_rates_intact,
       count(*) filter (where annual_salary is not null) as salaries_intact,
       count(*)                                          as manufacturing_people
from employees
where cost_class = 'Manufacturing';

-- ----------------------------------------------------------------------------
-- 4. AFTER — nothing outside Manufacturing carries pay. Expect zero rows.
-- ----------------------------------------------------------------------------
select name, employee_number, cost_class, wage, annual_salary
from employees
where coalesce(cost_class, '') <> 'Manufacturing'
  and (wage is not null or annual_salary is not null);

-- ----------------------------------------------------------------------------
-- 5. THE SG&A OVERTIME VIEW NEEDS AN EMPLOYEE NUMBER, and only that
-- ----------------------------------------------------------------------------
--
-- Overtime is joined to the roster on employee_number, because that is what the
-- payroll file identifies people by. An hourly SG&A employee without one is
-- invisible on that view — not wrong, just absent, which is the harder failure
-- to notice. Expect zero rows; anybody listed needs a number on their profile.
select name, department, position
from employees
where cost_class = 'SG&A'
  and status = 'Active'
  and coalesce(pay_type, '') <> 'Salaried'
  and coalesce(employee_number, '') = '';
