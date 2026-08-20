-- ============================================================================
-- Architecture v2, Phase A — the four-axis employee model
--
-- Additive and idempotent. Run the whole file in the Supabase SQL editor; every
-- statement is guarded, so re-running is safe. Nothing is dropped here except
-- where section 7 says so explicitly, and that part is commented out.
--
-- The model this implements: four independent facts about a person, none
-- inferred from another.
--
--   pay type        do daily hours flow in?        hourly / salaried
--   cost_class      which accounting bucket?       Manufacturing / Mill Overhead / SG&A
--   department      which line within it?          twelve values, section 1
--   position_group  where in the mill?             nine values, planning only
--
-- ----------------------------------------------------------------------------
-- READ THIS BEFORE RUNNING: the department constraint is widened in TWO steps,
-- deliberately.
--
-- The twelve new departments retire two values the constraint currently allows:
-- 'SG&A' (now a cost_class, with its own five departments beneath it) and
-- 'Non-Production' (replaced by real departments). Any row still holding either
-- one would make a constraint of exactly twelve values fail to apply — and the
-- rows cannot be reassigned until the constraint already permits the new
-- values. That is a deadlock if it is done in one step.
--
-- So section 1 sets a TRANSITIONAL constraint: the twelve new values plus the
-- two retired ones. That unblocks reassignment immediately. Once no row holds a
-- retired value, run SCHEMA_V2_TIGHTEN_DEPARTMENTS.sql to cut it to exactly
-- twelve. Audit query 8c tells you when that is true.
--
-- The retired values are not migrated automatically. Each one is a real
-- assignment decision about a real person, and a mapping that is right most of
-- the time produces department costs that are quietly wrong.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. department — the accounting level, twelve values
-- ----------------------------------------------------------------------------
--
--   Manufacturing   Log Yard · Clean-up · Shipping · Maintenance · Production · Saw Filing
--   Mill Overhead   Mill Overhead
--   SG&A            Sales & Marketing · Procurement · Accounting · HR · Corporate
--
-- Note the ampersands in 'Sales & Marketing' and in the SG&A cost_class below.
-- They are data, and they have to survive HTML interpolation, the save payload
-- and any query string. The previous SG&A work found unescaped interpolation
-- sites in the frontend; assume nothing and check.

do $$
begin
  raise notice 'Rows holding a retired department value (reassign these, then run SCHEMA_V2_TIGHTEN_DEPARTMENTS.sql):';
  raise notice '  %', (
    select coalesce(string_agg(department || ' = ' || n::text, ', '), 'none')
    from (
      select department, count(*) as n
      from employees
      where department in ('SG&A', 'Non-Production')
      group by department
    ) t
  );
end $$;

alter table employees drop constraint if exists employees_department_check;

-- TRANSITIONAL: twelve current values plus the two being retired.
alter table employees add constraint employees_department_check
  check (department in (
    -- Manufacturing
    'Log Yard', 'Clean-up', 'Shipping', 'Maintenance', 'Production', 'Saw Filing',
    -- Mill Overhead
    'Mill Overhead',
    -- SG&A
    'Sales & Marketing', 'Procurement', 'Accounting', 'HR', 'Corporate',
    -- Retired, permitted only until the rows holding them are reassigned.
    'SG&A', 'Non-Production'
  ));


-- ----------------------------------------------------------------------------
-- 2. cost_class — which accounting bucket, and which tab
-- ----------------------------------------------------------------------------
--
-- Department no longer carries this meaning. Set directly, never derived: the
-- whole point of the model is that a salaried person can sit in Manufacturing
-- (Eduardo Rivera) and an hourly person can sit in SG&A (Axeri Ramirez)
-- without either being a special case.

alter table employees add column if not exists cost_class text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'employees_cost_class_check' and conrelid = 'employees'::regclass
  ) then
    alter table employees add constraint employees_cost_class_check
      check (cost_class in ('Manufacturing', 'Mill Overhead', 'SG&A'));
  end if;
end $$;


-- ----------------------------------------------------------------------------
-- 3. position_group — the planning layer, no accounting meaning
-- ----------------------------------------------------------------------------
--
-- Exists so the mill's layout is visible and plannable. Keeping it separate
-- from department is what lets the floor be reorganised without touching the
-- chart of accounts.
--
-- Nullable, and intended for manufacturing staff. That is deliberately NOT
-- enforced against cost_class: a cross-column CHECK would couple two axes the
-- architecture requires to be set independently, and would make the order you
-- fill the fields in matter. Audit query 8d finds position groups on
-- non-manufacturing people instead, which is the same information without the
-- coupling.
--
-- DEPARTMENT IS NEVER DERIVED FROM POSITION GROUP, for anyone. Some of the two
-- lists share names (Maintenance, Saw Filing, Log Yard, Shipping) and it is
-- tempting to treat the match as a mapping. It is not: Supervisors spans
-- departments, so a supervisor's department is set independently of where they
-- stand in the mill. Once one position group has to be an exception, the mapping
-- is not a rule and reading it as one would file supervisors under a department
-- nobody chose.
--
-- 'Extras' is a real position group — floor staff who move where they are
-- needed. It is NOT the bullpen. The bullpen is the separate condition of having
-- no classification at all, which is what audit query 8a lists.

alter table employees add column if not exists position_group text;

-- Renamed from 'Bench Players'. The data is migrated before the constraint is
-- rebuilt, because the new constraint would reject the old value.
alter table employees drop constraint if exists employees_position_group_check;

update employees set position_group = 'Extras' where position_group = 'Bench Players';

alter table employees add constraint employees_position_group_check
  check (position_group in (
    'Supervisors', 'Maintenance', 'Saw Filing', 'Log Yard', 'Sawmill Operators',
    'Bakerville', 'Green Chain', 'Extras', 'Shipping'
  ));


-- ----------------------------------------------------------------------------
-- 4. Mailing address — HR system of record
-- ----------------------------------------------------------------------------
--
-- All nullable, populated over time. Separate columns rather than one text
-- blob so the data can be sorted, filtered and exported without parsing.

alter table employees add column if not exists address_street text;
alter table employees add column if not exists address_city text;
alter table employees add column if not exists address_state text;
alter table employees add column if not exists address_postal_code text;


-- ----------------------------------------------------------------------------
-- 5. annual_salary — for salaried staff
-- ----------------------------------------------------------------------------
--
-- Needed now because any salaried employee whose cost_class is 'Manufacturing'
-- is converted to an effective hourly rate at salary / 2080, and that rule is
-- keyed on cost class rather than on a named person.
--
-- The Salaries & Wages page that will edit this is not built yet, so today the
-- column is populated by hand in Supabase. Hourly rates never come from here —
-- they come from the daily file (see wage_history below).
--
-- The wage/pay-type conflation this used to note is resolved in section 5b:
-- pay_type is now its own column and wage holds only an hourly rate.

alter table employees add column if not exists annual_salary numeric(12,2);


-- ----------------------------------------------------------------------------
-- 5b. pay_type — how somebody is paid, as its own fact
-- ----------------------------------------------------------------------------
--
-- ############################################################################
-- ORDER MATTERS: DEPLOY THE CODE BEFORE RUNNING THIS SECTION.
--
-- Until now, employees.wage held EITHER an hourly rate OR the literal string
-- 'Salary', so one column was both the wage and the pay-type flag. That is the
-- conflation the architecture removes, and it has already produced one real
-- bug: fmtWage matched 'Salary' case-sensitively, so a lowercase value rendered
-- as $NaN on the roster while the salaried test correctly excluded that person
-- from Staffing Economics — the two disagreed about the same employee.
--
-- This section moves the marker out of wage and into pay_type, which means any
-- code still deciding "is this person salaried" by reading wage will see a
-- salaried person as HOURLY the moment it runs. That would put them into
-- Staffing Economics and into the clock-grace headcount.
--
-- So the deployed code must read pay_type first and fall back to the wage
-- marker only when the column is absent. That order is safe in both directions
-- and is how the app is written. Run this section after that code is live.
-- ############################################################################

alter table employees add column if not exists pay_type text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'employees_pay_type_check' and conrelid = 'employees'::regclass
  ) then
    alter table employees add constraint employees_pay_type_check
      check (pay_type in ('Hourly', 'Salaried'));
  end if;
end $$;

-- Back-fill from the marker being retired. Anyone not carrying it is hourly,
-- including somebody with a blank wage — a new hire with no rate yet is hourly
-- without a rate, not a person of unknown pay type. Audit query 8h lists them
-- so a genuine unknown can be corrected by hand.
update employees
set pay_type = case
                 when btrim(lower(coalesce(wage, ''))) = 'salary' then 'Salaried'
                 else 'Hourly'
               end
where pay_type is null;

-- Now clear the sentinel, so wage means one thing: an hourly rate, or nothing.
-- Guarded, because clearing it before every row has a pay_type would erase the
-- only record of who was salaried.
do $$
declare unclassified integer;
begin
  select count(*) into unclassified from employees where pay_type is null;
  if unclassified > 0 then
    raise exception 'Refusing to clear the wage sentinel: % row(s) still have no pay_type.', unclassified;
  end if;

  update employees
  set wage = null
  where pay_type = 'Salaried'
    and btrim(lower(coalesce(wage, ''))) = 'salary';

  raise notice 'pay_type back-filled and the wage sentinel cleared. wage is now a rate or null.';
end $$;

-- Salaried compensation lives in annual_salary (section 5), never in wage.
-- Hourly rates come from the daily file and nowhere else.


-- ----------------------------------------------------------------------------
-- 6. wage_history — every observed change to an hourly rate
-- ----------------------------------------------------------------------------
--
-- Append-only. The daily file overwrites the app's stored rate every day, and
-- without this there would be no way to answer "what was this person making in
-- March", and no way to tell a genuine raise from a bad vendor file.
--
-- Keyed by employee_number as well as employee_id: the file identifies people
-- by number, and a row auto-created from the file must be able to record its
-- rate even if the id linkage is later corrected.

create table if not exists wage_history (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid references employees(id) on delete set null,
  employee_number text not null,
  employee_name text,

  rate numeric(10,2) not null,
  previous_rate numeric(10,2),          -- null on the first observation
  change_pct numeric(8,2),              -- signed, relative to previous_rate

  -- The work date of the file that carried the rate, NOT the day it was
  -- processed. A late-arriving file must land on the day it describes.
  effective_date date not null,

  source text not null default 'bbsi',  -- 'bbsi' | 'manual'

  -- A move larger than the configured threshold is applied AND flagged. A
  -- vendor error and a real raise look identical in the data; the difference is
  -- that one of them should be looked at. Flagging beats blocking, which would
  -- stall a whole day's import over one row.
  flagged boolean not null default false,
  note text,

  created_at timestamptz not null default now()
);

-- "What was this person's rate on date X" is the query this table exists for.
create index if not exists wage_history_emp_date_idx
  on wage_history (employee_number, effective_date desc);
create index if not exists wage_history_effective_date_idx on wage_history (effective_date);
create index if not exists wage_history_flagged_idx on wage_history (flagged) where flagged;

-- Append-only, enforced rather than merely intended. A wage history that can be
-- edited is not a history. The service-role key bypasses row-level security but
-- not triggers, so this holds for the app as well as for a person in the SQL
-- editor.
--
-- To make a genuine correction: disable the trigger, fix the row, re-enable it,
-- and record why. Do not drop it.
--   alter table wage_history disable trigger wage_history_append_only;
create or replace function wage_history_reject_mutation() returns trigger as $$
begin
  raise exception 'wage_history is append-only (attempted %). Insert a correcting row instead, or see the comment in SCHEMA_V2_MODEL.sql.', tg_op;
end;
$$ language plpgsql;

drop trigger if exists wage_history_append_only on wage_history;
create trigger wage_history_append_only
  before update or delete on wage_history
  for each row execute function wage_history_reject_mutation();


-- ----------------------------------------------------------------------------
-- 6b. employee_setup_tasks — the arrivals queue
-- ----------------------------------------------------------------------------
--
-- The daily file creates an employee record for any employee number it carries
-- that the app does not know. That person has hours and a wage immediately and
-- no department, no cost class and no position group — so their cost is real
-- and is landing nowhere until somebody assigns them.
--
-- One row per auto-created person, marking that they need setting up. The
-- CHECKLIST IS NOT STORED HERE: it is computed from the employees row itself
-- (is department set? cost_class? position_group? drive_folder_id? birthday?
-- phone? address?). Storing a copy would let it drift out of date, and the
-- live row is always the truth.
--
-- resolved_at is set when a person signs the arrival off, which is a separate
-- act from the fields happening to be filled — somebody should confirm the
-- classification is right, not just present.

create table if not exists employee_setup_tasks (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid references employees(id) on delete cascade,
  employee_number text not null,
  employee_name text,

  -- The work date of the file that first carried them.
  first_seen_date date,
  source text not null default 'bbsi',

  resolved_at timestamptz,
  resolved_by text,
  note text,

  created_at timestamptz not null default now(),

  -- One open arrival per person. A re-import of the same day must not queue
  -- them twice.
  unique (employee_number)
);

create index if not exists employee_setup_tasks_open_idx
  on employee_setup_tasks (created_at desc) where resolved_at is null;

-- The queue, with the checklist computed live:
-- select t.employee_number, t.employee_name, t.first_seen_date,
--        e.department is null      as needs_department,
--        e.cost_class is null      as needs_cost_class,
--        e.position_group is null  as needs_position_group,
--        e.drive_folder_id is null as needs_drive_file,
--        e.birthday is null or btrim(e.birthday) = '' as needs_dob,
--        e.phone    is null or btrim(e.phone)    = '' as needs_contact,
--        e.address_street is null                     as needs_address
-- from employee_setup_tasks t
-- left join employees e on e.id = t.employee_id
-- where t.resolved_at is null
-- order by t.created_at;


-- ----------------------------------------------------------------------------
-- 7. Retiring employees.dept
-- ----------------------------------------------------------------------------
--
-- The audit found exactly two readers, both dead: `dept:r.dept||''` in the two
-- loadData mappings in the frontend. No writes, no backend reads, no test
-- references, and no function selects the column. Because the reads coalesce a
-- missing column to '', dropping it cannot break the running app.
--
-- BUT DO NOT DROP IT YET, and this is the one place this file argues with the
-- build order it was asked to follow.
--
-- `dept` holds the legacy taxonomy (Sawmill / Filing Room / Log Yard / SG&A).
-- The manual assignment of ~68 people to the new twelve departments has not
-- happened, and `dept` is the only record of where those people currently sit
-- — it is the input to that exercise. The back-fill screen that used to display
-- it has been deleted, so the reference is now read from the database directly.
-- Dropping the column first destroys the information the task depends on.
--
-- Take the snapshot, do the assignment against it, then drop.

-- 7a. Snapshot. Cheap, and the only thing standing between a mistaken drop and
--     permanently losing who used to be in the Log Yard.
create table if not exists employees_dept_archive as
select id, name, dept, department, wage, status, now() as archived_at
from employees;

-- Query it while assigning:
--   select a.name, a.dept as was, e.department as now, e.cost_class, e.position_group
--   from employees_dept_archive a join employees e on e.id = a.id
--   where e.status = 'Active' order by a.dept, a.name;

-- 7b. The gates in SCHEMA_DROP_DEPT.sql still apply — in particular the one
--     that checks whether 'SG&A' in the legacy dept column and salaried status
--     describe the same people, since Staffing Economics now filters on
--     salaried status rather than on dept. Run them before the drop.

-- 7c. The drop itself. Left commented deliberately; a file that drops a column
--     the moment somebody pastes it is a file that will eventually be pasted by
--     accident. Uncomment it as its own deliberate action, and delete the two
--     dead frontend reads in the same release.
--
-- alter table employees drop column dept;


-- ----------------------------------------------------------------------------
-- 8. Audit queries
-- ----------------------------------------------------------------------------

-- 8a. The assignment worklist: active employees missing any classification.
--     This is the back-fill, and it is done when this returns zero rows.
-- select
--   e.name,
--   a.dept                     as legacy_dept,
--   e.department,
--   e.cost_class,
--   e.position_group,
--   e.wage
-- from employees e
-- left join employees_dept_archive a on a.id = e.id
-- where e.status = 'Active'
--   and (e.department is null or e.cost_class is null)
-- order by a.dept nulls last, e.name;

-- 8b. Headcount per department, with its cost class. The shape of the mill.
-- select coalesce(cost_class, '(no cost class)') as cost_class,
--        coalesce(department, '(no department)') as department,
--        count(*) as employees,
--        count(*) filter (where btrim(lower(coalesce(wage,''))) = 'salary') as salaried,
--        count(*) filter (where btrim(lower(coalesce(wage,''))) <> 'salary') as hourly
-- from employees
-- where status = 'Active'
-- group by 1, 2
-- order by 1, 2;

-- 8c. Rows still holding a retired department value. When this returns zero,
--     run SCHEMA_V2_TIGHTEN_DEPARTMENTS.sql.
-- select id, name, department, cost_class
-- from employees
-- where department in ('SG&A', 'Non-Production')
-- order by department, name;

-- 8d. Position group set on somebody who is not in Manufacturing. Not illegal
--     — the columns are deliberately independent — but position group has no
--     meaning outside the mill floor, so these are probably mistakes.
-- select name, cost_class, department, position_group
-- from employees
-- where position_group is not null
--   and coalesce(cost_class, '') <> 'Manufacturing'
-- order by name;

-- 8e. Salaried people in Manufacturing, who are converted at salary / 2080.
--     A null annual_salary here means the conversion cannot be computed and
--     that person's cost is missing from the manufacturing figures.
-- select name, department, position_group, annual_salary,
--        round(annual_salary / 2080.0, 2) as effective_hourly
-- from employees
-- where status = 'Active'
--   and cost_class = 'Manufacturing'
--   and btrim(lower(coalesce(wage, ''))) = 'salary'
-- order by annual_salary nulls first, name;

-- 8h. Pay type worth a second look: hourly people with no rate at all, and
--     salaried people with no salary. The first is normal for a brand-new hire
--     and wrong for anybody else; the second means their cost cannot be
--     computed.
-- select name, pay_type, wage, annual_salary, cost_class, department
-- from employees
-- where status = 'Active'
--   and ((pay_type = 'Hourly'   and (wage is null or btrim(wage) = ''))
--     or (pay_type = 'Salaried' and annual_salary is null))
-- order by pay_type, name;

-- 8i. Anybody still carrying the retired position group name. Should be zero;
--     the migration renames them.
-- select name, position_group from employees where position_group = 'Bench Players';

-- 8f. Wage changes the sync flagged as large. Each is either a real raise or a
--     bad vendor file, and they are indistinguishable without looking.
-- select w.effective_date, w.employee_number, w.employee_name,
--        w.previous_rate, w.rate, w.change_pct, w.note
-- from wage_history w
-- where w.flagged
-- order by w.effective_date desc, w.employee_number;

-- 8g. Rate history for one person, newest first.
-- select effective_date, rate, previous_rate, change_pct, source, flagged
-- from wage_history
-- where employee_number = lpad('319', 4, '0')
-- order by effective_date desc;
