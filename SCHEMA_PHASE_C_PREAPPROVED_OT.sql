-- =====================================================================
-- APPLIED 2026-08-21 to zwghbbyzrycpnesuuzgi (sfp-staffing).
--
-- Verified: 27 rows, 17 people, hours 71.50 -> 59.50, difference 12.00,
-- 0 duplicate (employee, category) pairs, 27 of 27 descriptions kept.
-- §5c returned exactly the three expected rows: Brian McDonald x2 at
-- 1 -> 0 (inactive) and Rey Aispuro's Weekend at 2 -> 1 (duplicate).
--
-- §5c was not a formality. TEN different three-row drop-sets are
-- consistent with all of (27 rows, 17 people, 12.00 difference, 0
-- duplicate pairs) — for instance Abel's Post-Shift 1h plus Rey's
-- Weekend 6h plus Will Gonzalez's Weekend 5h also sums to 12.00 and
-- leaves 17 people. The counts are necessary and nowhere near
-- sufficient; §5c is what identifies WHICH rows went.
--
-- `overtime` is intact, by design. See §6.
-- =====================================================================
-- SFP Staffing — Phase C Task 4: pre-approved OT, keyed on employees.id
-- Run in the STAFFING project (zwghbbyzrycpnesuuzgi) ONLY.
-- Confirm the project name in the top-left before running anything.
--
-- Run section by section. Read the SELECT before running the write
-- beneath it. NOTHING HERE TOUCHES `overtime` — the old table is left
-- exactly as it is, so this migration is reversible by dropping the new
-- table and redeploying.
--
-- WHAT THIS FIXES
--
-- `overtime` matches an employee by NAME. That is why one person could
-- appear as two phantom entries: the daily payroll rows key on the
-- payroll number and the allowance keyed on whatever spelling somebody
-- typed, so the hours landed on one entry and the allowance on another,
-- which then reported as "approved but never worked". The roster has two
-- employees named Smith and several compound surnames.
--
-- It is also saved by replacing the WHOLE TABLE, which is how a
-- byte-identical duplicate row got in (see §3) and how a partial save
-- could wipe rows nobody was editing.
-- =====================================================================


-- =====================================================================
-- §0  PREFLIGHT — ARE YOU IN THE RIGHT PROJECT?
--
-- RUN THIS FIRST, ON ITS OWN. It writes nothing. It either returns one
-- row of counts, or it raises an exception telling you to switch project.
--
-- There are four Supabase projects on this account and only one is the
-- staffing database:
--
--     zwghbbyzrycpnesuuzgi   sfp-staffing        <- this one
--     mwmgasvfyjcmkwdjbesj   Sequoia_Database
--     kfjykimfkeyvuphkiouv   sequoia-maintenance
--     inhixvjmvesynwqwsnrn   Sequoia_Accounting
--
-- This block exists because the comment at the top of this file saying
-- "run this in the staffing project" did not stop §1 being run in
-- Sequoia_Database. That attempt failed harmlessly — a create table whose
-- foreign key references employees(id) cannot succeed where there is no
-- employees table — but harmless was luck, not design:
--
--   * CREATE OR REPLACE FUNCTION succeeds anywhere. plpgsql bodies are
--     not parsed at creation time, so a function referencing tables that
--     do not exist is created without complaint, leaving a stray object
--     in the wrong database.
--   * An INSERT does not need a foreign key to a table it never mentions.
--
-- A warning a human has to read is not a guard. This is.
-- =====================================================================

do $$
declare
  found integer;
  missing text;
begin
  select count(*) into found
    from information_schema.tables
   where table_schema = 'public'
     and table_name in ('employees', 'overtime', 'daily_hours');

  if found < 3 then
    select string_agg(t, ', ') into missing
      from unnest(array['employees', 'overtime', 'daily_hours']) as t
     where not exists (
       select 1 from information_schema.tables
        where table_schema = 'public' and table_name = t);

    raise exception
      E'WRONG PROJECT.\n\nThis database is missing: %.\n\n'
      'You are not in the staffing database. Switch to the project named '
      'sfp-staffing (ref zwghbbyzrycpnesuuzgi), then run this block again '
      'before running anything else in this file.',
      missing;
  end if;
end $$;

-- Reached only if the block above did not raise. Confirms this is the
-- staffing database AND that it holds what the migration expects.
select
  (select count(*) from employees)                         as employees_expect_74,
  (select count(*) from employees where status = 'Active')  as active_expect_67,
  (select count(*) from overtime)                           as overtime_rows_expect_30;


-- =====================================================================
-- §1  The table
--
-- One row per employee per category. `description` is kept and is NOT
-- optional decoration: the category says WHEN the overtime happens
-- (before shift, after shift, weekend) and the description says WHAT the
-- work is — 'Quad Saw Change', 'Weekend PM', 'Baker Maintenance'. The
-- category alone cannot answer "what are we paying for".
--
-- unique(employee_id, ot_type) is the whole point. It makes the
-- duplicate in §3 impossible to reintroduce, and it means a save can be
-- an upsert of ONE row instead of a delete-and-replace of the table.
-- =====================================================================

create table if not exists preapproved_ot (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id) on delete cascade,
  ot_type     text not null check (ot_type in ('Pre-Shift', 'Post-Shift', 'Weekend')),
  hours       numeric(6,2) not null default 0 check (hours >= 0),
  description text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (employee_id, ot_type)
);

create index if not exists preapproved_ot_employee_idx on preapproved_ot (employee_id);

-- The three live category values, confirmed against the data rather than
-- taken from the spec draft — which said 'Before Shift / After Shift'.
-- Those strings do not appear in the table and would have failed this
-- CHECK on the first insert.
comment on table preapproved_ot is
  'Standing weekly pre-approved OT allowance, one row per employee per category. '
  'No week column: the same allowance applies every week. Superseded the name-keyed '
  '`overtime` table in Phase C.';


-- =====================================================================
-- §2  BEFORE THE MIGRATION — what is about to happen, row by row
--
-- Run this and read it. Every one of the 30 rows in `overtime` appears
-- exactly once, with the action that §4 will take on it.
--
-- Expected: 30 rows. 27 'migrate', 2 'skip: employee inactive',
--           1 'de-duplicate'. Zero 'skip: no match'.
-- =====================================================================

with alias as (
  -- The ONE name variant in the data. 'Tim Green' in `overtime` is
  -- Timothy Green on the roster (Active, Production, #7324) — confirmed
  -- independently by the `economics` staffing plan, which has him
  -- holding the Trimmer position. He is a real active employee with an
  -- informal first name, not an unmatched row.
  --
  -- Spelled out as data rather than solved with fuzzy matching on
  -- purpose. A LIKE or a trigram threshold that gets Tim/Timothy right
  -- also silently pairs people it should not, and the failure mode is a
  -- misattributed allowance that nothing on screen would explain.
  select * from (values ('Tim Green', 'Timothy Green')) as t(from_name, to_name)
),
resolved as (
  select o.id, o.name as ot_name, o.ot_type, o.hours, o.description, o.created_at,
         e.id as employee_id, e.name as roster_name, e.status, e.department,
         row_number() over (
           partition by e.id, o.ot_type
           order by o.created_at, o.id
         ) as dup_rank
  from overtime o
  left join alias a on a.from_name = o.name
  left join employees e on e.name = coalesce(a.to_name, o.name)
)
select ot_name, ot_type, hours, description, roster_name, status, department,
       case
         when employee_id is null   then 'skip: no match'
         when status <> 'Active'    then 'skip: employee inactive'
         when dup_rank > 1          then 'de-duplicate'
         else 'migrate'
       end as action
from resolved
order by action, ot_name, ot_type;


-- =====================================================================
-- §2b  The same thing as a count, so §4 can be checked against it
--
-- Expected exactly:
--   de-duplicate              1
--   migrate                  27
--   skip: employee inactive   2
-- =====================================================================

with alias as (select * from (values ('Tim Green', 'Timothy Green')) as t(from_name, to_name)),
resolved as (
  select o.id, o.name as ot_name, o.ot_type, e.id as employee_id, e.status,
         row_number() over (partition by e.id, o.ot_type order by o.created_at, o.id) as dup_rank
  from overtime o
  left join alias a on a.from_name = o.name
  left join employees e on e.name = coalesce(a.to_name, o.name)
)
select case
         when employee_id is null then 'skip: no match'
         when status <> 'Active'  then 'skip: employee inactive'
         when dup_rank > 1        then 'de-duplicate'
         else 'migrate'
       end as action,
       count(*) as rows
from resolved group by 1 order by 1;


-- =====================================================================
-- §3  The three exceptions, named, because each one is a decision
--
-- Two of the three are 12.00 hours per week of pre-approved OT counted
-- TODAY that should not be — the current report loop has no status filter
-- and no de-duplication — so Net OT is understated by 12.00 hours every
-- week. Migrating them unchanged would carry that forward.
--
-- The third, Tim Green, is NOT part of that 12.00. His 0.75h is already
-- in the total and stays in it; what changes is WHO it is attributed to.
-- Today it lands in Unassigned and reports as an unmatched name, so it is
-- misattributed rather than inflated. (An earlier note of mine added his
-- 0.75 to the 12.00 and called the total inflation 12.75 — wrong: a row
-- that is re-attributed does not change a total.)
--
-- 1. REY AISPURO — Weekend 6h 'Clean-up', TWICE. Byte-identical, same
--    created_at to the microsecond: a double insert from the
--    replace-whole-table save. Counted as 12h today.
--    DECISION: keep one. They are identical, so "which" is not a
--    question; §4 keeps the lower id for determinism.
--
-- 2. BRIAN McDONALD — Inactive, no department, no cost class.
--    Post-Shift 1h 'Ensure Start-up' + Weekend 5h 'Weekend PM' = 6h.
--    Counted today because he matches the roster by name, so he is
--    flagged nowhere.
--    DECISION: drop. An inactive employee cannot work the overtime, so
--    an allowance held against them inflates pre-approved OT and
--    understates Net OT. Generalised in §4 to `status = 'Active'`
--    rather than written as his name — the next person to go inactive
--    gets the same treatment without another migration.
--
-- 3. TIM GREEN — is Timothy Green. See the alias note in §2.
--    Post-Shift 0.5h 'Quad Saw Change' + Pre-Shift 0.25h
--    'Machine Warm-up'. Lands in Unassigned today and reports as an
--    unmatched name.
--    DECISION: keep, under his employee_id.
--
-- Look at all three before migrating:
-- =====================================================================

select o.name, o.ot_type, o.hours, o.description, o.created_at,
       e.id as employee_id, e.name as roster_name, e.status
from overtime o
left join employees e on e.name = o.name
where o.name in ('Rey Aispuro', 'Brian McDonald', 'Tim Green')
order by o.name, o.ot_type, o.created_at;


-- =====================================================================
-- §4  THE MIGRATION
--
-- Idempotent: on conflict it updates, so running it twice is a no-op
-- rather than a duplicate-key error. That matters because §5 verifies
-- the result and you may want to re-run after fixing a row by hand.
--
-- Run §2 and §2b first and confirm the counts.
-- =====================================================================

-- with alias as (select * from (values ('Tim Green', 'Timothy Green')) as t(from_name, to_name)),
-- resolved as (
--   select o.id, o.ot_type, o.hours, o.description, o.created_at, e.id as employee_id,
--          row_number() over (partition by e.id, o.ot_type order by o.created_at, o.id) as dup_rank
--   from overtime o
--   left join alias a on a.from_name = o.name
--   left join employees e on e.name = coalesce(a.to_name, o.name)
--   where e.id is not null
--     and e.status = 'Active'
-- )
-- insert into preapproved_ot (employee_id, ot_type, hours, description, created_at)
-- select employee_id, ot_type, hours, description, created_at
-- from resolved
-- where dup_rank = 1
-- on conflict (employee_id, ot_type) do update
--   set hours       = excluded.hours,
--       description = excluded.description,
--       updated_at  = now();


-- =====================================================================
-- §5  VERIFY — run every one of these
-- =====================================================================

-- 5a. Row count. Expected 27.
select count(*) as migrated_rows from preapproved_ot;

-- 5b. Hours reconciliation. This is the number that proves the three
--     decisions landed and nothing else moved.
--       old total (all 30 rows)              =  71.50
--       Rey's duplicate                      =  -6.00
--       Brian, inactive (1.00 + 5.00)        =  -6.00
--       new total (27 rows)                  =  59.50
--     Tim Green's 0.75 is in BOTH totals — he is re-attributed, not
--     removed — so the difference is 12.00, not 12.75.
select
  (select coalesce(sum(hours), 0) from overtime)        as old_total_should_be_71_50,
  (select coalesce(sum(hours), 0) from preapproved_ot)  as new_total_should_be_59_50,
  (select coalesce(sum(hours), 0) from overtime)
    - (select coalesce(sum(hours), 0) from preapproved_ot) as difference_should_be_12_00;

-- 5c. NOTHING DROPPED SILENTLY. Every (employee, category) pair in
--     `overtime` with a count of how many rows it had there and how many
--     it has here, so a shortfall is visible as a NUMBER rather than
--     inferred from a row's absence.
--
--     Written this way after the obvious version got it wrong. Matching
--     each old row against the new table on its VALUES cannot see a
--     value-identical duplicate: the surviving row matches both copies,
--     so neither is reported and the check silently passes whether the
--     de-duplication happened or not. Counting per pair does see it.
--
--     EXPECTED, exactly 3 rows:
--       Brian McDonald  Post-Shift  1 -> 0   employee inactive
--       Brian McDonald  Weekend     1 -> 0   employee inactive
--       Rey Aispuro     Weekend     2 -> 1   duplicate removed, one kept
--
--     Anything else is a finding. In particular a row reading 'no match'
--     means somebody's allowance was dropped without being accounted
--     for — stop and report it rather than proceeding.
with alias as (select * from (values ('Tim Green', 'Timothy Green')) as t(from_name, to_name)),
resolved as (
  select coalesce(a.to_name, o.name) as resolved_name, o.ot_type,
         e.id as employee_id, e.status
  from overtime o
  left join alias a on a.from_name = o.name
  left join employees e on e.name = coalesce(a.to_name, o.name)
),
old_counts as (
  select resolved_name, ot_type, employee_id, min(status) as status, count(*) as in_overtime
  from resolved group by 1, 2, 3
),
new_counts as (
  select employee_id, ot_type, count(*) as in_preapproved
  from preapproved_ot group by 1, 2
)
select o.resolved_name, o.ot_type, o.in_overtime,
       coalesce(n.in_preapproved, 0) as in_preapproved,
       case
         when o.employee_id is null                              then 'no match — INVESTIGATE'
         when o.status <> 'Active'                               then 'employee inactive'
         when o.in_overtime > coalesce(n.in_preapproved, 0)      then 'duplicate removed, one kept'
         else 'unexplained shortfall — INVESTIGATE'
       end as reason
from old_counts o
left join new_counts n
  on n.employee_id = o.employee_id and n.ot_type = o.ot_type
where o.in_overtime <> coalesce(n.in_preapproved, 0)
order by o.resolved_name, o.ot_type;

-- 5d. Per-person, old vs new. Every active employee should match exactly;
--     Brian McDonald should be the only name with old > 0 and new null.
with alias as (select * from (values ('Tim Green', 'Timothy Green')) as t(from_name, to_name)),
old as (
  select coalesce(a.to_name, o.name) as name, sum(o.hours) as old_hours, count(*) as old_rows
  from overtime o left join alias a on a.from_name = o.name
  group by 1
),
new as (
  select e.name, sum(p.hours) as new_hours, count(*) as new_rows
  from preapproved_ot p join employees e on e.id = p.employee_id
  group by 1
)
select coalesce(old.name, new.name) as name,
       old.old_hours, new.new_hours, old.old_rows, new.new_rows,
       case when coalesce(old.old_hours,0) = coalesce(new.new_hours,0) then 'match' else 'DIFFERS' end as status
from old full outer join new on new.name = old.name
order by status desc, name;

-- 5e. Nobody can hold two rows of the same category any more.
--     Expected: 0 rows, and this is enforced by the unique constraint —
--     the query is here so the constraint is seen to be doing its job.
select employee_id, ot_type, count(*)
from preapproved_ot group by 1, 2 having count(*) > 1;

-- 5f. Every description survived. Expected: 27 of 27.
select count(*) filter (where description is not null and btrim(description) <> '') as with_description,
       count(*) as total
from preapproved_ot;


-- =====================================================================
-- §6  `overtime` IS NOT DROPPED
--
-- Deliberately. It is the only record of what the allowance was before
-- this migration, including the two dropped rows and the duplicate, and
-- §5 reconciles against it. The app stops reading it once this is
-- deployed — ot-report-lib.js prefers preapproved_ot and falls back to
-- `overtime` only when the new table is absent, so the report keeps
-- working between deploy and migration in either order.
--
-- Drop it in Phase D, deliberately, after a few weeks of the new table
-- reconciling. Not now, and not in the same change as the migration.
--
-- drop table overtime;   -- NOT YET
-- =====================================================================
