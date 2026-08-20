-- ============================================================================
-- Set the full list of allowed employees.department values
--
-- Seven values: six production departments plus SG&A.
--
-- Safe to run on a live database. It alters one CHECK constraint and touches
-- no data and no column definitions.
--
-- Run this if your database still has an older version of this rule. A fresh
-- install does not need it — SCHEMA_DAILY_HOURS.sql now creates the constraint
-- with all seven. Re-running is harmless: it replaces the rule with the same
-- rule.
--
-- Log Yard and Clean-up are ordinary production departments and behave like any
-- other on the OT report.
--
-- SG&A is the exception: office and salaried staff, who belong to none of the
-- production departments. It is a real assignment rather than a blank, which
-- matters because a blank cannot be told apart from a row nobody has filled in
-- yet.
--
-- These employees do not appear in the OT report. Salaried rows are dropped at
-- import before department is ever consulted, so the SG&A bucket is normally
-- empty — and if it ever is not, that means somebody is hourly AND
-- non-production, which the report surfaces as a finding rather than hiding.
--
-- Supersedes an earlier revision of this file that allowed a 'Non-Production'
-- value. That value is gone; SG&A took over its role. If any row still holds
-- it, the ALTER below will fail — the second query at the bottom finds them.
-- ============================================================================

-- Dropped and re-added rather than modified: Postgres has no ALTER CONSTRAINT
-- for a CHECK expression. The column, its data and its indexes are untouched —
-- only the rule is replaced, and only inside this transaction.
begin;

alter table employees drop constraint if exists employees_department_check;

alter table employees add constraint employees_department_check
  check (department in ('Maintenance', 'Saw Filing', 'Shipping', 'Production', 'Log Yard', 'Clean-up',
                        'SG&A'));

commit;


-- Confirm the new rule is in place and lists all seven values.
-- select conname, pg_get_constraintdef(oid) as definition
-- from pg_constraint
-- where conname = 'employees_department_check'
--   and conrelid = 'employees'::regclass;

-- Any row that would now violate the constraint would have blocked the ALTER
-- above, so this should return zero rows. Run it if the ALTER failed, to see
-- what is in the column that should not be.
-- select id, name, department
-- from employees
-- where department is not null
--   and department not in ('Maintenance', 'Saw Filing', 'Shipping', 'Production', 'Log Yard',
--                          'Clean-up', 'SG&A');
