-- ============================================================================
-- Add the Non-Production department value
--
-- Safe to run on a live database. It alters one CHECK constraint and touches
-- no data and no column definitions.
--
-- Run this if you already ran SCHEMA_DAILY_HOURS.sql before this value
-- existed. A fresh install does not need it — SCHEMA_DAILY_HOURS.sql now
-- creates the constraint with all five values.
--
-- Why a fifth value: the other four are production departments, and SG&A /
-- office / salaried staff belong to none of them. The back-fill screen asks
-- for a department for every active employee, and its "still needs a
-- department" count is what gates retiring the legacy employees.dept column —
-- so with no correct value to pick for those people, that count could never
-- honestly reach zero. Leaving them blank does not work either: blank is
-- indistinguishable from "nobody has got to this row yet". Non-Production
-- makes it a decision somebody made, recorded in the data.
--
-- These employees do not appear in the OT report. Salaried rows are dropped at
-- import before department is ever consulted, so the bucket is normally empty
-- — and if it ever is not, that means somebody is hourly AND non-production,
-- which the report surfaces as a finding rather than hiding.
-- ============================================================================

-- Dropped and re-added rather than modified: Postgres has no ALTER CONSTRAINT
-- for a CHECK expression. The column, its data and its indexes are untouched —
-- only the rule is replaced, and only inside this transaction.
begin;

alter table employees drop constraint if exists employees_department_check;

alter table employees add constraint employees_department_check
  check (department in ('Maintenance', 'Saw Filing', 'Shipping', 'Production', 'Non-Production'));

commit;


-- Confirm the new rule is in place and lists all five values.
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
--   and department not in ('Maintenance', 'Saw Filing', 'Shipping', 'Production', 'Non-Production');


-- ----------------------------------------------------------------------------
-- Sizing the back-fill
-- ----------------------------------------------------------------------------
--
-- The back-fill screen shows this same breakdown live, but running it first
-- tells you how much manual work is waiting and where it is concentrated,
-- before you open the app.
--
-- The `suggestion` column says what the screen will offer, and offers it only
-- where the mapping involves no guesswork: an identical name, or the single
-- known rename. Sawmill, Log Yard and SG&A get nothing, because no mapping
-- from them is defensible — Maintenance and Shipping do not exist in the old
-- taxonomy at all, so the people now in them are sitting under some other
-- legacy value and only a person can say which.
--
-- select
--   coalesce(nullif(btrim(dept), ''), '(no legacy value)') as legacy_dept,
--   count(*)                                              as employees,
--   count(*) filter (where department is null
--                      or btrim(department) = '')          as still_unassigned,
--   case btrim(dept)
--     when 'Filing Room' then 'Saw Filing  (rename)'
--     when 'Maintenance' then 'Maintenance (same name)'
--     when 'Shipping'    then 'Shipping    (same name)'
--     else '— set by hand'
--   end                                                    as suggestion
-- from employees
-- where status = 'Active'
-- group by 1, 4
-- order by still_unassigned desc, employees desc;
