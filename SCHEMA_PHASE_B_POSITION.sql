-- ============================================================================
-- Phase B — employees.position
--
-- Run this whole file in the Supabase SQL editor. It is idempotent and it does
-- not write to any row.
--
-- WHY THIS FILE EXISTS
--
-- `employees.position` is already in the live database. It was added by hand
-- with the classification load, the same way the position_group values were,
-- and it holds 43 distinct values across the roster. But it is in NO committed
-- migration, which means:
--
--   * nothing in this repo declares the column, so a fresh Supabase project
--     built from these files would not have it;
--   * /api/data now names it in its projection, and PostgREST answers a request
--     for a column it does not have with a 400. Before the projection ladder in
--     netlify/functions/data.js, that single 400 dropped the whole roster;
--   * the next person reading the schema files would not know it exists.
--
-- So this is a catch-up, not a change. On the live database every statement
-- below is a no-op — that is the intended outcome, and section 3 proves it.
--
-- This is the same class of problem as the address columns: SCHEMA_V2_MODEL.sql
-- section 4 added address_street / address_city / address_state /
-- address_postal_code, and the API never projected them, so the profile card
-- could not have shown an address even where one was stored. Those columns are
-- declared, so they need no DDL here — only the projection changed.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. The column
-- ----------------------------------------------------------------------------
--
-- Free text, deliberately, and it should STAY free text for now. The vocabulary
-- is still settling: 43 values across 67 people is roughly one distinct title
-- per 1.5 employees, which is not a settled list. A CHECK constraint here would
-- have to be widened every time somebody is hired into a title nobody has held
-- before, and the two-step deadlock that caused for `department` — rows holding
-- a retired value cannot be reassigned until the constraint permits the new
-- ones — is not worth repeating for a field with no reporting logic behind it.
--
-- The UI offers the existing values as suggestions, read from the roster at
-- render time rather than hardcoded, so the vocabulary tightens on its own
-- without a migration. If it does settle, a constraint can be added then.

alter table employees add column if not exists position text;


-- ----------------------------------------------------------------------------
-- 2. Distinct from position_group, and not derivable from it
-- ----------------------------------------------------------------------------
--
-- position_group is mill-floor only: it says where in the mill somebody stands,
-- and it is correctly NULL for the ten non-mill staff. position applies to
-- EVERYONE — the CEO, the CFO and the Account Manager each have a position and
-- no position group.
--
-- Neither is derived from the other, and nothing should start deriving one.
-- 'Supervisors' spans departments; a position group has many positions in it.
-- This is the same independence the three v2 axes have, for the same reason.
--
-- No constraint, no trigger, no default. A position is a fact about a person
-- that somebody types in.


-- ----------------------------------------------------------------------------
-- 3. Verify — expect the column present and every value intact
-- ----------------------------------------------------------------------------

-- 3a. The column exists, and its type.
select column_name, data_type, is_nullable
from information_schema.columns
where table_name = 'employees'
  and column_name in ('position', 'position_group',
                      'address_street', 'address_city',
                      'address_state', 'address_postal_code')
order by column_name;

-- 3b. Nothing was written. Compare against the 43 distinct values already
--     loaded; if this returns 0 rows the column was created by section 1 and
--     the classification load has not happened in this database.
select count(*) as rows_with_position,
       count(distinct position) as distinct_positions
from employees
where position is not null and btrim(position) <> '';

-- 3c. The vocabulary the edit surface offers, and the query the UI derives it
--     from at render time. position applies to everyone, so the null-position_group
--     rows are included deliberately rather than filtered out.
select coalesce(position_group, '(no position group — non-mill)') as position_group,
       position,
       count(*) as people
from employees
where status = 'Active'
group by position_group, position
order by position_group nulls last, position;

-- 3d. Anybody active with no position at all. Not an error — a new hire before
--     anyone has typed a title is a real state — but worth seeing.
select name, department, position_group, cost_class
from employees
where status = 'Active'
  and (position is null or btrim(position) = '')
order by name;


-- ----------------------------------------------------------------------------
-- 4. economics.position — READ ONLY. Do not change either column.
-- ----------------------------------------------------------------------------
--
-- The economics table is `id, num, section, position, name, max_wage`, and it
-- already has a column called `position`. Two columns of that name in one
-- database is the shape of the dept / department problem, so it is worth being
-- precise about what each one is before anybody "reconciles" them.
--
-- From the code that reads it (src/js/economics.js), they are NOT the same
-- concept:
--
--   employees.position   an attribute OF A PERSON. Their job title. One row per
--                        human, null until somebody types it.
--
--   economics.position   the name of a BUDGETED SEAT in the staffing plan. The
--                        row is the seat, not the person: `name` is the employee
--                        assigned to it and is nullable (an unfilled seat is a
--                        real and useful row), `max_wage` is the rate ceiling
--                        FOR THAT SEAT, and `section` groups seats for the
--                        Staffing Economics report. The tab flags a person
--                        appearing in two seats as a duplicate, and lists
--                        eligible employees in no seat as unassigned.
--
-- So they draw on the same vocabulary — both are job titles — while describing
-- different things: one is a fact about a human, the other is a line in a plan
-- that a human may or may not currently fill. Merging them would lose the
-- unfilled seats and the per-seat ceiling.
--
-- What I could NOT check from the code is how far the VALUES actually overlap.
-- Run 4a and 4b and decide from the answer.

-- 4a. Every economics seat, with whether its title is also used as a person's
--     position. Exact match, case- and whitespace-insensitive.
select e.section,
       e.position                as economics_position,
       e.name                    as assigned_employee,
       e.max_wage,
       exists (
         select 1 from employees emp
         where lower(btrim(emp.position)) = lower(btrim(e.position))
       )                         as title_also_a_person_position
from economics e
order by e.section, e.position;

-- 4b. The two vocabularies side by side: which titles are in both, which are
--     only a seat, which are only a person. `only_a_seat` rows are budgeted
--     positions nobody's record names; `only_a_person` rows are titles the
--     staffing plan has no seat for.
with econ as (
  select distinct lower(btrim(position)) as title from economics
  where position is not null and btrim(position) <> ''
), emp as (
  select distinct lower(btrim(position)) as title from employees
  where position is not null and btrim(position) <> ''
)
select coalesce(econ.title, emp.title) as title,
       case
         when econ.title is not null and emp.title is not null then 'both'
         when econ.title is not null                          then 'only_a_seat'
         else                                                      'only_a_person'
       end as appears_in
from econ full outer join emp on econ.title = emp.title
order by appears_in, title;
