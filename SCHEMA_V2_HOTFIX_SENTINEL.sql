-- ============================================================================
-- NOT NEEDED. Confirmed against the live database, do not run.
--
--   select count(*) from employees where status='Active' and pay_type='Salaried';
--   -> 0
--
-- There are no active salaried employees, so nothing was ever being miscounted
-- on the live roster. Section 5b's wage-clear also turns out not to have taken
-- effect: every salaried person in the database still carries wage = 'Salary'
-- alongside pay_type = 'Salaried'. Both halves of the alarm this file was
-- written for were wrong.
--
-- CLOSED OUT 2026-08-22. STEP 2 below has now been RUN, as §5 of
-- SCHEMA_PHASE_D_PERMISSIONS.sql, with two guards this file's version did not
-- have: it also refuses if any row carries the marker WITHOUT
-- pay_type = 'Salaried', not only if some row has a null pay_type. It cleared
-- 11 rows — not the 10 named above, because SCHEMA_V2_ROSTER_CLEANUP.sql §6
-- activated the salaried staff in between. Nothing here is left to run; the
-- file is history now, and STEP 1 survives only as the rollback for §5.
--
-- Kept for one reason only: once the roster cleanup activates the salaried
-- staff (SCHEMA_V2_ROSTER_CLEANUP.sql §6), salaried_active stops being zero and
-- the sentinel starts mattering again for as long as the deployed code reads
-- wage. §4 of that script sets it, so this file is still not the thing to run —
-- but STEP 2 below is the correct way to clear the sentinel afterwards, once the
-- pay_type-aware build is live.
-- ============================================================================

-- ============================================================================
-- HOTFIX — restore the wage sentinel until the pay_type code is deployed
--
-- Situation this addresses: SCHEMA_V2_MODEL.sql section 5b ran BEFORE the code
-- that reads pay_type was deployed. 5b back-fills pay_type from the 'Salary'
-- marker and then clears that marker out of wage. The deployed code still
-- decides "is this person salaried" by reading wage, so with the marker gone it
-- reads every salaried employee as HOURLY.
--
-- Nothing was lost: 5b wrote pay_type BEFORE clearing wage, and the clear is
-- guarded on every row having a pay_type. pay_type is now the record of who is
-- salaried, and this file rebuilds the old marker from it.
--
-- Run STEP 1 to make the deployed code correct again in one statement. Run
-- STEP 2 only after the pay_type-aware code is live.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- STEP 0 — confirm the diagnosis before changing anything
-- ----------------------------------------------------------------------------

-- How many people are affected, and what does the deployed code currently think
-- of them? `reads_as` is what app.html's isSalaried() returns today.
-- select
--   pay_type,
--   count(*)                                                        as employees,
--   count(*) filter (where wage is null or btrim(wage) = '')         as wage_empty,
--   count(*) filter (where btrim(lower(coalesce(wage,''))) = 'salary') as wage_marker,
--   case when btrim(lower(coalesce(min(wage), ''))) = 'salary'
--        then 'salaried' else 'HOURLY' end                           as reads_as
-- from employees
-- where status = 'Active'
-- group by pay_type
-- order by pay_type;

-- The two figures the miscount moves. Every salaried employee currently draws a
-- clock-grace allowance they are not entitled to, so pre-approved OT is
-- overstated by grace_hours_overstated per week and net OT is understated by the
-- same.
-- select
--   count(*)                          as salaried_active,
--   count(*) * 0.5                    as grace_hours_overstated_per_week
-- from employees
-- where status = 'Active' and pay_type = 'Salaried';


-- ----------------------------------------------------------------------------
-- STEP 1 — the mitigation. Safe, immediate, and exactly reversible.
-- ----------------------------------------------------------------------------
--
-- Rebuilds the marker the deployed code expects. Touches only people who are
-- salaried per pay_type AND currently have no wage value, so nobody carrying a
-- real hourly rate is affected. Re-introduces the wage/pay-type conflation on
-- purpose — that is what the running code is written against.

update employees
set wage = 'Salary'
where pay_type = 'Salaried'
  and (wage is null or btrim(wage) = '');

-- Verify: should report 0 rows still reading as hourly.
-- select count(*) as salaried_still_reading_as_hourly
-- from employees
-- where status = 'Active' and pay_type = 'Salaried'
--   and btrim(lower(coalesce(wage, ''))) <> 'salary';


-- ----------------------------------------------------------------------------
-- STEP 2 — re-clear the sentinel, AFTER the pay_type code is deployed
-- ----------------------------------------------------------------------------
--
-- Identical to the guarded block in SCHEMA_V2_MODEL.sql section 5b, repeated
-- here so the hotfix has a documented end state rather than leaving wage
-- carrying a marker nothing reads any more.
--
-- Do not run this until /app.html is serving the build whose isSalaried() reads
-- pay_type first. The deployed code tolerates both shapes, so there is no rush.

-- do $$
-- declare unclassified integer;
-- begin
--   select count(*) into unclassified from employees where pay_type is null;
--   if unclassified > 0 then
--     raise exception 'Refusing to clear the wage sentinel: % row(s) have no pay_type.', unclassified;
--   end if;
--
--   update employees
--   set wage = null
--   where pay_type = 'Salaried'
--     and btrim(lower(coalesce(wage, ''))) = 'salary';
-- end $$;


-- ----------------------------------------------------------------------------
-- Unrelated but worth checking now: department has no nulls
-- ----------------------------------------------------------------------------
--
-- SCHEMA_V2_MODEL.sql does not write employees.department anywhere — its only
-- UPDATEs are the position_group rename and the two pay_type statements. So a
-- fully-populated department column means the data was already there, not that
-- the migration filled it in.
--
-- What matters is whether those values are the OLD taxonomy. 'SG&A' is a
-- retired department (it is a cost_class now, with five departments of its own),
-- and the transitional constraint still permits it, so those rows are legal but
-- unfinished.
-- select coalesce(department, '(null)') as department, count(*) as employees,
--        count(*) filter (where cost_class is null) as no_cost_class
-- from employees
-- where status = 'Active'
-- group by 1
-- order by employees desc;
