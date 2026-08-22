-- =====================================================================
-- APPLIED 2026-08-22 to zwghbbyzrycpnesuuzgi (sfp-staffing), in full.
--
-- §0b: 55 seats, 55 filled, 0 vacant, no employee_id. §2a: 55 will backfill,
-- 0 unmatched, 0 ambiguous — the plan and the roster agree on spelling
-- throughout. §2c: one row, Eduardo Rivera (Active, Salaried) in Production
-- Lead, which found a real UI bug before this file wrote anything — see the
-- note at §2c. §3: 55 linked. §4a: 55 / 55 / 0 / 0. §4b: no rows. §4c: 55
-- rows, every note blank. §4d: FOREIGN KEY (employee_id) REFERENCES
-- employees(id) ON DELETE SET NULL.
--
-- A CORRECTION TO THE DEPLOY-ORDER CLAIM BELOW, recorded because it was stated
-- too broadly. "Order-free" is true of the code that SHIPS WITH this migration:
-- it reads either shape and refuses to write the wrong one. It was NOT true of
-- the code deployed BEFORE it, whose PATCH writes `name` alone and never
-- touches employee_id. So between this migration running and that deploy
-- landing, a seat assignment made in the app updates the text and leaves the
-- key pointing at the previous person — after which the seat displays the
-- previous occupant, silently. The window was minutes and nobody assigned a
-- seat in it. The general lesson is the one this file is about: "works before
-- and after" has to be asserted of BOTH builds, not just the new one.
-- =====================================================================
-- economics.employee_id — make a seat point at a PERSON, not at a string
--
-- Run in the STAFFING project (zwghbbyzrycpnesuuzgi) ONLY. §0a refuses to
-- proceed anywhere else.
--
-- Run one section at a time, in order. §0 and §2 write nothing; §2 is the one
-- to read carefully, because it is where a name that does not match anybody
-- shows up, and those are decisions rather than data.
-- =====================================================================
--
-- WHY
--
-- `economics.name` is TEXT holding a person's name. It is the last place in
-- this database where one row refers to another by spelling.
--
-- That is not a hypothetical problem here. 'Tim Green' and 'Timothy Green'
-- became two people earlier in this project, and the pre-approved OT table was
-- restructured in Phase C for exactly this reason — it matched employees by a
-- name typed into a free-text box, and the roster has two people called Smith.
-- Every other cross-table reference in this schema is now an employees(id)
-- foreign key. This is the one that was left.
--
-- WHAT BREAKS TODAY, silently: renaming somebody on the Employees tab orphans
-- their seat. The plan keeps the old spelling, the seat reads as "not on the
-- active hourly roster", and nothing anywhere reports that a rename did it. The
-- API added a guard in Phase D — an assignment must match an active hourly
-- employee exactly — which stops a BAD name going IN. It cannot stop a good
-- name going stale afterwards.
--
-- =====================================================================
-- WHAT THIS DOES NOT DO
--
-- IT DOES NOT DROP `name`. The column stays, holding what it holds, for two
-- reasons: any row §2 cannot match keeps its only record of who was meant to be
-- in that seat, and a rollback needs somewhere to roll back to. Nothing READS
-- it once the code that goes with this migration is deployed — /api/economics
-- resolves the occupant's name from employees(id) on every read, which is what
-- makes a rename propagate instead of orphaning. Dropping it is a later,
-- deliberate change, the way `dept` and the wage sentinel were handled.
--
-- IT DOES NOT ADD A UNIQUE CONSTRAINT on employee_id. Somebody in two seats is
-- a plan error and the page says so loudly — but the API allows it on purpose,
-- because refusing would make a straight swap impossible without unassigning
-- first. A database constraint would take that decision away from the code that
-- reasoned about it.
--
-- =====================================================================
-- DEPLOY ORDER — this one is genuinely order-free, by construction
--
-- The code that goes with this migration works before AND after it:
--
--   READ  /api/economics asks for employee_id and falls back to a projection
--         without it on a 42703, exactly the way /api/data's ladder does. With
--         no column it resolves the occupant from the stored `name`, which is
--         today's behaviour.
--   WRITE assignment REQUIRES the column and says so — a 503 naming this file
--         rather than a silent write to the text column. An assignment that
--         landed in `name` after the read had switched to employee_id would be
--         a write nobody could see, which is worse than a refusal.
--
-- So: deploy whenever, run this whenever. The only window is one where seat
-- assignment reports "run the migration", which is a sentence rather than a
-- symptom.
--
-- THAT HOLDS FOR THIS BUILD ONWARDS, and not for the one before it. The
-- previous build's PATCH wrote `name` alone; run against a database that has
-- the key, it leaves employee_id stale and the seat then displays whoever was
-- there before. See the correction in the APPLIED header. Any future migration
-- that adds a column the WRITE path must maintain has the same shape, and the
-- question to ask is not "does the new code cope" but "what does the OLD code
-- do to a migrated database".
-- =====================================================================


-- =====================================================================
-- §0  PREFLIGHT — writes nothing.
-- =====================================================================

-- 0a. Right project, or stop.
do $$
declare found integer; missing text;
begin
  select count(*) into found from information_schema.tables
   where table_schema='public' and table_name in ('employees','economics','daily_hours');
  if found < 3 then
    select string_agg(t, ', ') into missing
      from unnest(array['employees','economics','daily_hours']) as t
     where not exists (select 1 from information_schema.tables
                        where table_schema='public' and table_name=t);
    raise exception
      E'WRONG PROJECT.\n\nThis database is missing: %.\n\n'
      'Switch to the project named sfp-staffing (ref zwghbbyzrycpnesuuzgi).', missing;
  end if;
end $$;

-- 0b. Where we are starting. Expected: employee_id 0, and the seat counts.
select
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='economics' and column_name='employee_id') as has_employee_id_expect_0,
  (select count(*) from economics)                                              as seats,
  (select count(*) from economics where name is not null and btrim(name) <> '') as seats_filled,
  (select count(*) from economics where name is null or btrim(name) = '')       as seats_vacant;


-- =====================================================================
-- §1  THE COLUMN
--
-- Nullable, because a vacant seat is a real row — that is the whole point of a
-- staffing plan.
--
-- ON DELETE SET NULL, and the alternatives are both wrong:
--   RESTRICT/NO ACTION would make removing an employee depend on the staffing
--     plan, so somebody deleting a leaver would hit an error about a table they
--     have never heard of.
--   CASCADE would delete the SEAT when the person in it goes, taking max_wage
--     with it — the budgeted ceiling is the one thing here with no other copy.
-- A seat outlives its occupant. Emptying it is the correct answer.
-- =====================================================================

alter table economics
  add column if not exists employee_id uuid references employees(id) on delete set null;

create index if not exists economics_employee_id_idx on economics (employee_id);

comment on column economics.employee_id is
  'The person in this seat. AUTHORITATIVE — the occupant''s name is resolved '
  'through this on every read, so a rename follows the person instead of '
  'orphaning the seat. NULL means vacant, which is a real state. The legacy '
  '`name` column is retained but no longer read; see '
  'SCHEMA_ECONOMICS_EMPLOYEE_ID.sql.';


-- =====================================================================
-- §2  WHO MATCHES WHOM — READ THIS BEFORE §3. Writes nothing.
--
-- The backfill can only be as good as the spelling, and the spelling is the
-- reason this migration exists. So the match is computed and SHOWN first, and
-- §3 then applies exactly what §2 displayed.
--
-- Matching is case- and whitespace-insensitive and NOTHING ELSE. No fuzzy
-- matching, no nickname table, no 'first initial plus surname'. 'Tim Green' and
-- 'Timothy Green' are a real pair on this roster and an algorithm that pairs
-- them is an algorithm that will pair somebody else wrongly and silently. A
-- name that does not match exactly is a decision for a person, and §4 is where
-- those get made.
-- =====================================================================

-- 2a. The summary. `ambiguous` is the one that must be 0 before §3 — it means
--     two employees share a name, so the match cannot say which.
--
--     RAN 2026-08-22: 55 seats, 55 filled, 55 will backfill, 0 no_such_employee,
--     0 ambiguous. Every seat matched exactly, so §3 links all 55 and §4b is
--     empty. Better than expected — the plan and the roster agree on spelling
--     throughout, including 'Adren Wilbur Flowers Jr.' and 'Jorge Salazar De
--     Leon', which is precisely the shape of name this migration exists for.
with m as (
  select e.id as seat_id, e.seat, btrim(e.name) as seat_name,
         (select count(*) from employees emp
           where lower(btrim(emp.name)) = lower(btrim(e.name))) as matches
  from economics e
  where e.name is not null and btrim(e.name) <> ''
)
select
  (select count(*) from economics)                    as seats,
  (select count(*) from m)                            as seats_filled,
  count(*) filter (where matches = 1)                 as will_backfill,
  count(*) filter (where matches = 0)                 as no_such_employee,
  count(*) filter (where matches > 1)                 as ambiguous_must_be_0
from m;

-- 2b. Every filled seat and what it resolves to. This is the list §3 applies.
--     Read the `resolves_to` column: a blank one is a row §3 will leave alone.
select e.num, e.seat, btrim(e.name) as seat_name,
       emp.name    as resolves_to,
       emp.status  as employee_status,
       emp.pay_type,
       case
         when emp.id is not null then 'will backfill'
         when (select count(*) from employees x
                where lower(btrim(x.name)) = lower(btrim(e.name))) > 1 then 'AMBIGUOUS — two employees share this name'
         else 'NO MATCH — decide in section 4'
       end as outcome
from economics e
left join employees emp
  on lower(btrim(emp.name)) = lower(btrim(e.name))
 and (select count(*) from employees x where lower(btrim(x.name)) = lower(btrim(e.name))) = 1
where e.name is not null and btrim(e.name) <> ''
order by (emp.id is not null), e.num;

-- 2c. Anybody the seat resolves to who is NOT active and hourly. Not a blocker
--     — the plan can legitimately record who was in a seat — but the API will
--     refuse to REASSIGN them, and the page marks them, so it is worth knowing
--     which rows will look that way afterwards.
--
--     RAN 2026-08-22: one row, Eduardo Rivera in Production Lead, Active and
--     Salaried. It found a real bug before this migration touched anything.
--     The page's assignment select offers active hourly people only, so a seat
--     linked to Eduardo had no option matching its own occupant — the browser
--     then falls back to displaying the FIRST option, which on that select is
--     '— vacant —'. Production Lead would have rendered as empty while he sat
--     in it, and one stray change on that select would have cleared him.
--
--     Fixed before §3 was run: a linked-but-not-offerable occupant now gets an
--     option of their own, selected, saying they cannot be reassigned here. A
--     test asserts every seat select has EXACTLY ONE selected option, which is
--     the general form and would catch a fourth state nobody has thought of.
select e.num, e.seat, emp.name, emp.status, emp.pay_type
from economics e
join employees emp on lower(btrim(emp.name)) = lower(btrim(e.name))
where e.name is not null and btrim(e.name) <> ''
  and (emp.status <> 'Active' or coalesce(emp.pay_type,'') = 'Salaried')
order by e.num;


-- =====================================================================
-- §3  THE BACKFILL
--
-- Applies exactly what §2b showed as 'will backfill' and nothing else. Guarded:
-- it refuses to run if any seat name matches more than one employee, because
-- then the match is a guess.
--
-- Idempotent — it only fills rows where employee_id is still null.
-- =====================================================================

do $$
declare ambiguous integer; filled integer;
begin
  select count(*) into ambiguous
    from economics e
   where e.name is not null and btrim(e.name) <> ''
     and (select count(*) from employees emp
           where lower(btrim(emp.name)) = lower(btrim(e.name))) > 1;
  if ambiguous > 0 then
    raise exception
      'Refusing to backfill: % seat name(s) match more than one employee. '
      'The match would be a guess. See section 2b and resolve them by hand.', ambiguous;
  end if;

  update economics e
     set employee_id = emp.id
    from employees emp
   where e.employee_id is null
     and e.name is not null and btrim(e.name) <> ''
     and lower(btrim(emp.name)) = lower(btrim(e.name));

  get diagnostics filled = row_count;
  -- The Supabase SQL editor does not show NOTICE. §4a is the verification that
  -- actually reports this; the notice is for psql.
  raise notice 'Backfilled % seat(s).', filled;
end $$;


-- =====================================================================
-- §4  VERIFY, and decide about anything left
-- =====================================================================

-- 4a. The counts. `filled_and_linked` should equal §2a's `will_backfill`, and
--     `filled_but_unlinked` should equal `no_such_employee`.
select
  count(*)                                                                as seats,
  count(*) filter (where employee_id is not null)                         as linked,
  count(*) filter (where employee_id is null
                     and name is not null and btrim(name) <> '')          as filled_but_unlinked,
  count(*) filter (where employee_id is null
                     and (name is null or btrim(name) = ''))              as vacant
from economics;

-- 4b. Every row the backfill could not link, with its seat. THESE ARE THE
--     DECISIONS. Each one is a seat whose recorded occupant is not on the
--     roster under that spelling. For each: correct the spelling on the
--     Employees tab if it is a typo there, reassign the seat in the app if the
--     person changed, or vacate it if nobody is in it.
--
--     Nothing here is broken while they sit unresolved: the page shows them,
--     flags them as not on the active hourly roster, and the seat still carries
--     its ceiling. They are simply not linked to anybody.
select num, section, seat, name as recorded_occupant, max_wage
from economics
where employee_id is null and name is not null and btrim(name) <> ''
order by num;

-- 4c. THE POINT OF THE WHOLE MIGRATION, demonstrated. The occupant's name now
--     comes from employees, so it is whatever that row says today. Compare
--     `stored_name` against `live_name`: a difference is a rename that used to
--     orphan the seat and now does not.
--
--     Compared case- and whitespace-insensitively, matching how §3 linked them.
--     A strict comparison reports '  bo tran ' -> 'Bo Tran' as a rename, which
--     is not one — it is the match working — and a diagnostic that cries wolf
--     on its first run is one nobody reads on its second.
select e.num, e.seat,
       e.name      as stored_name,
       emp.name    as live_name,
       case when lower(btrim(coalesce(e.name,''))) is distinct from lower(btrim(coalesce(emp.name,'')))
            then 'RENAMED SINCE' else '' end as note
from economics e
join employees emp on emp.id = e.employee_id
order by (lower(btrim(coalesce(e.name,''))) is distinct from lower(btrim(coalesce(emp.name,'')))) desc, e.num;

-- 4d. The constraint is real and points where we think.
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'economics'::regclass and contype = 'f';


-- =====================================================================
-- §5  LATER, NOT NOW — dropping `name`
--
-- Once §4b is empty and the app has been running on employee_id for a while,
-- the text column has no remaining job. It is NOT dropped here, because a
-- column holding the only record of an unmatched seat's occupant is not
-- something to drop in the same change that created its replacement.
--
-- When that day comes:
--
--   alter table economics drop column name;
--
-- Check first that nothing reads it: /api/economics resolves the name from
-- employees(id), and `name` should appear in no select= anywhere.
-- =====================================================================


-- =====================================================================
-- §6  ROLLBACK
--
-- Everything here is reversible and loses nothing: `name` was never modified,
-- so dropping employee_id returns the table to exactly its previous state.
-- =====================================================================

-- drop index if exists economics_employee_id_idx;
-- alter table economics drop column if exists employee_id;
