-- ============================================================================
-- STEP 5 — retire employees.dept
--
-- DO NOT RUN THIS YET.
--
-- This is the last step of the department consolidation, and it is
-- irreversible: `dept` is the only record of the old taxonomy (Sawmill /
-- Filing Room / Log Yard / SG&A), and no mapping can reconstruct it from
-- `department`. Maintenance and Shipping do not exist in the old value set at
-- all, so the two columns are not translations of each other.
--
-- Run the three gates in section 1 first. Every one must return zero rows.
-- Then take the snapshot in section 2. Only then run section 3.
--
-- Sequence for the whole consolidation:
--   1. Audit what reads dept                        (done — app.html only)
--   2. Migrate the dependents to department         (done)
--   3. Back-fill every employee by hand             <- the Employees tab
--   4. Run the gates below
--   5. Drop dept                                    <- this file
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. GATES — all three must return zero rows
-- ----------------------------------------------------------------------------

-- GATE 1: every active employee has a department.
--
-- Until this is empty, dropping dept strands people with no department at all:
-- their hours import with a null department and land in the report's
-- "Unassigned" bucket, and there is no longer a legacy value to work out where
-- they belonged.
--
-- 'Non-Production' counts as assigned and does not appear here. That is the
-- point of the value: SG&A and office staff belong to none of the four
-- production departments, and without it this gate could never reach zero. A
-- blank means nobody has decided yet; 'Non-Production' means somebody did.
select id, name, dept, department, status
from employees
where status = 'Active'
  and (department is null or btrim(department) = '')
order by dept, name;


-- GATE 2: SG&A and salaried describe the same people.
--
-- Staffing Economics used to exclude employees by `dept = 'SG&A'`. That filter
-- now tests salaried status instead, on the basis that SG&A was only ever a
-- proxy for "not hourly" and the report is about labour wages.
--
-- That swap is exactly equivalent ONLY if the two sets coincide. This query
-- lists every employee where they disagree — an SG&A employee who is paid
-- hourly, or a salaried employee who was never tagged SG&A. Each row is
-- somebody whose visibility in Staffing Economics changes.
--
-- If this returns rows, do not drop dept. Decide each case first: either fix
-- the employee's wage/dept so the sets agree, or accept the change knowingly.
select
  name,
  dept,
  wage,
  case
    when dept = 'SG&A' then 'SG&A but paid hourly — will now APPEAR in Staffing Economics'
    else 'salaried but not SG&A — will now DISAPPEAR from Staffing Economics'
  end as consequence
from employees
where status = 'Active'
  and (dept = 'SG&A') is distinct from (btrim(lower(coalesce(wage, ''))) = 'salary')
order by dept, name;


-- GATE 3: nothing is left holding a legacy value we never re-assigned.
--
-- A sanity check on the back-fill rather than on the data model: an active
-- employee whose department was set to a known rename (Filing Room -> Saw
-- Filing, or Maintenance/Shipping keeping their name) is fine, but one still
-- carrying a legacy value in `department` means a bad write got through the
-- constraint somehow.
select id, name, dept, department
from employees
where department is not null
  and department not in ('Maintenance', 'Saw Filing', 'Shipping', 'Production', 'Non-Production')
order by name;


-- NOT A GATE, but worth a look before you finish: employees marked
-- Non-Production who are paid hourly.
--
-- Non-Production exists for salaried office staff, who never reach the OT
-- report because salaried rows are dropped at import. Somebody hourly and
-- non-production is a real combination, not an error — but it means their
-- hours WILL import and the OT report will show a Non-Production department
-- row, which it flags rather than hides. Better to know now than to meet it
-- in a weekly report.
select name, dept, department, wage
from employees
where status = 'Active'
  and department = 'Non-Production'
  and btrim(lower(coalesce(wage, ''))) <> 'salary'
order by name;


-- ----------------------------------------------------------------------------
-- 2. SNAPSHOT — take this before dropping anything
-- ----------------------------------------------------------------------------
--
-- Keeps the old taxonomy recoverable after the column is gone. It costs one
-- small table and it is the only thing standing between a mistaken drop and a
-- permanent loss of who used to be in the Log Yard.

create table if not exists employees_dept_archive as
select id, name, dept, department, wage, status, now() as archived_at
from employees;

-- Confirm it captured everyone before continuing.
-- select count(*) as archived, (select count(*) from employees) as live
-- from employees_dept_archive;


-- ----------------------------------------------------------------------------
-- 3. THE DROP — only after sections 1 and 2
-- ----------------------------------------------------------------------------

-- alter table employees drop column dept;

-- Left commented deliberately. Uncomment and run it as a separate, deliberate
-- action once the gates are clean and the snapshot is verified. A file that
-- drops a column the moment somebody pastes it is a file that will eventually
-- be pasted by accident.


-- ----------------------------------------------------------------------------
-- 4. AFTER THE DROP
-- ----------------------------------------------------------------------------
--
-- app.html still reads `dept` in three places that become dead but harmless
-- (the two loadData mappings coalesce a missing column to '', and the back-fill
-- screen's reference column simply renders an em-dash). Clean them up in the
-- same release, along with this file and the "Roster dept" column itself —
-- there is nothing left to reference once the column is gone.
