-- =====================================================================
-- Phase D — permissions, hire_date, and the end of the wage sentinel
--
-- Run in the STAFFING project (zwghbbyzrycpnesuuzgi) ONLY. §0 refuses to
-- proceed anywhere else; the mill ERP project has been the wrong target of a
-- run in this repo more than once.
--
-- Run one section at a time, in order, reading the result of each before the
-- next. Nothing before §2 writes a row.
--
-- DRY-RUN AGAINST POSTGRES 16 before being handed over, on a throwaway database
-- built to the live table shape. Not a substitute for §0 — a fixture cannot
-- know what the real roster holds — but it does mean the SQL parses, the
-- expectations printed beside each query are the ones it actually returns, and
-- every guard was made to FIRE rather than assumed to work:
--
--   * whole file runs clean, twice; the second run is a no-op throughout.
--   * all three CHECKs rejected what they are for: tier 'hourly_wages',
--     'MiXeD@...', '  spaced@...' and 'nodomain'.
--   * §3 refused DELETE of the last admin AND TRUNCATE of the table, and
--     allowed the revoke of one admin out of two.
--   * §5 aborted on a marker row with a null pay_type, and again on one whose
--     pay_type said 'Hourly'; cleared 3 of 3 on the clean fixture; reported 0
--     when re-run.
--   * §8's drop order was WRONG as first written and is corrected: DROP TABLE
--     removes both triggers without firing them, so the trigger does not need
--     dropping first.
-- =====================================================================
--
-- WHAT THIS IS FOR
--
-- Until now there were no roles. Every @sequoiafp.com account had the same
-- access, which is why annual_salary has been kept out of the /api/data
-- projection entirely — there was nobody to show it to and no way to say so.
-- This file creates the place where that is recorded.
--
-- MEMBERSHIP IS DATA, NOT CODE. A grant is a row. Adding somebody to the
-- salaries tier must not require a deploy, a code review, or a person who
-- knows where the repository is. What lives in code (permissions-lib.js) is
-- what a tier MEANS — which columns it unlocks — because that is a decision
-- about the shape of the app, and it belongs where it can be tested.
--
--   hourly_wages   THE BASE. Everyone signed in holds it, and it is NEVER
--                  stored here. A missing row means the base tier, not "no
--                  access": there is no such thing as no access for somebody
--                  who got past the login.
--   salaries       annual_salary, read and write.
--   admin          May grant and revoke the other two.
--
-- The CHECK on `tier` mirrors GRANTABLE_TIERS in permissions-lib.js. Storing
-- 'hourly_wages' is refused by the database, not merely ignored by the code,
-- so nobody can create a row whose absence and presence mean the same thing.
--
-- =====================================================================
-- DEPLOY ORDER
--
-- §1–§4 may run at ANY time relative to the deploy. permissions-lib.fetchTiers
-- fails CLOSED on a missing table: before this runs, every caller resolves to
-- the base tier and annual_salary stays hidden from everybody, which is exactly
-- today's behaviour. hire_date has its own rung in the projection ladder, so a
-- database without it costs hire_date and nothing else.
--
-- §5 (the wage sentinel) needs the pay_type-aware build live. It has been live
-- since Phase B: isSalaried() reads employees.pay_type first and only falls
-- back to the wage marker, in all three runtimes that ask the question
-- (src/js/core.js, netlify/functions/wage-sync.js,
-- netlify/functions/ot-report-lib.js). §0d proves the precondition the clear
-- actually depends on — that nobody is identified as salaried by the marker
-- ALONE — and §5 refuses to run if that is not true.
--
-- ONE WINDOW, AND IT IS NOT THIS FILE'S. The commit that adds the write gate
-- also stops the browser sending `wage`. Netlify ships both together, but a
-- tab left open across the deploy is holding the old bundle and will get a 403
-- naming the column on its next save. It is visible, it is not a data loss,
-- and a refresh fixes it.
--
-- =====================================================================
-- WHAT THIS FILE DOES NOT TOUCH
--
-- The BBSI ingestion and the birthday notifier are both live and both out of
-- scope. §5 was checked against the ingestion before being written: wage-sync
-- SKIPS salaried people outright (`skipped.salaried`), deciding who is salaried
-- through the same pay_type-first isSalaried(), and updateEmployeeWage is only
-- ever called with a numeric rate for an hourly person. Nothing in the daily
-- import writes the string 'Salary', so clearing it does not start a fight with
-- tomorrow morning's file.
-- =====================================================================


-- =====================================================================
-- §0  PREFLIGHT — writes nothing. Read every answer before §1.
-- =====================================================================

-- 0a. Right project, or stop.
do $$
declare found integer; missing text;
begin
  select count(*) into found from information_schema.tables
   where table_schema='public' and table_name in ('employees','overtime','daily_hours');
  if found < 3 then
    select string_agg(t, ', ') into missing
      from unnest(array['employees','overtime','daily_hours']) as t
     where not exists (select 1 from information_schema.tables
                        where table_schema='public' and table_name=t);
    raise exception
      E'WRONG PROJECT.\n\nThis database is missing: %.\n\n'
      'Switch to the project named sfp-staffing (ref zwghbbyzrycpnesuuzgi).', missing;
  end if;
end $$;

-- 0b. What already exists. Expected: user_permissions 0, hire_date 0,
--     annual_salary 1. If user_permissions comes back 1 this file has been run
--     before — read §1 before re-running, it is written to be idempotent but
--     §2's seed is the part worth checking.
select
  (select count(*) from information_schema.tables
    where table_schema='public' and table_name='user_permissions')      as has_user_permissions_expect_0,
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='employees'
      and column_name='hire_date')                                      as has_hire_date_expect_0,
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='employees'
      and column_name='annual_salary')                                  as has_annual_salary_expect_1;

-- 0c. THE THREE PEOPLE, AND THE ADDRESS THE APP WILL ACTUALLY SEE.
--
-- A grant is matched on the email Google hands back at login. Seeding a guessed
-- address produces a row that looks like a grant and grants nothing — the
-- silent failure this whole tier system must not have. So the seed in §2 is
-- written from THIS answer, not from the pattern first.last@sequoiafp.com.
--
-- Expected: three rows — Jeff Cook, Ryley Stanley, Peter Stroble. A blank
-- `email_on_file` for any of them means the roster does not know it and the
-- address has to come from somewhere else before §2 runs.
--
-- RAN 2026-08-22, AND IT EARNED ITS PLACE ON THE FIRST TRY:
--
--   Jeff Cook       jeffrey.cook@sequoiafp.com     <- NOT jeff.cook@
--   Peter Stroble   peter.stroble@sequoiafp.com
--   Ryley Stanley   ryley.stanley@sequoiafp.com
--
-- All three already lowercase, all Active, all pay_type Salaried. Two of the
-- three follow first.last@; the third does not. Seeding from the pattern would
-- have given Jeff a grant that matches no login — a row that reads as access
-- and confers none, failing silently forever, because nothing anywhere reports
-- a grant nobody used. §6c is the standing version of this check.
--
-- (employee_number is null for all three. Salaried staff are skipped by the
-- payroll import so they have never needed one. Noted, not a problem here:
-- grants are matched on email.)
select name, employee_number, status, pay_type,
       coalesce(nullif(btrim(email), ''), '(none on file)') as email_on_file,
       lower(btrim(email)) = btrim(email)                   as already_lowercase
from employees
where name ilike '%cook%' or name ilike '%stanley%' or name ilike '%stroble%'
order by name;

-- 0d. THE PRECONDITION FOR §5, stated as the thing that would actually break.
--
-- Clearing wage='Salary' is safe only if nobody is identified as salaried by
-- that marker alone. Anyone with the marker and no pay_type would flip to
-- reading as HOURLY the moment it is cleared — which puts them into the
-- clock-grace headcount, inflates pre-approved OT, and hands them to the wage
-- sync as somebody whose rate should be imported from tomorrow's file.
--
-- Expected: marker_but_no_pay_type = 0 and pay_type_null_anywhere = 0.
-- `marker_rows` is how many rows §5 will change; keep the number, §6 checks it.
--
-- RAN 2026-08-22 against zwghbbyzrycpnesuuzgi:
--   marker_rows 11, marker_and_salaried 11, marker_but_no_pay_type 0,
--   pay_type_null_anywhere 0, salaried_total 11, salaried_active 10.
-- Both guards clear, so §5 proceeds and clears 11 rows. §0e returned no rows:
-- nobody salaried is carrying a real rate. §6d must still show 11 and 10.
select
  count(*) filter (where btrim(lower(coalesce(wage,''))) = 'salary')      as marker_rows,
  count(*) filter (where btrim(lower(coalesce(wage,''))) = 'salary'
                     and pay_type = 'Salaried')                          as marker_and_salaried,
  count(*) filter (where btrim(lower(coalesce(wage,''))) = 'salary'
                     and coalesce(btrim(pay_type),'') <> 'Salaried')     as marker_but_no_pay_type,
  count(*) filter (where pay_type is null)                               as pay_type_null_anywhere,
  count(*) filter (where pay_type = 'Salaried')                          as salaried_total,
  count(*) filter (where pay_type = 'Salaried' and status = 'Active')    as salaried_active
from employees;

-- 0e. Anyone salaried whose wage holds something OTHER than the marker.
--     Expected: NO ROWS. A real rate sitting on a salaried person is not the
--     sentinel and §5 must not touch it — it is a data question for a human.
select id, name, employee_number, status, pay_type, wage
from employees
where pay_type = 'Salaried'
  and coalesce(btrim(wage), '') <> ''
  and btrim(lower(wage)) <> 'salary'
order by name;


-- =====================================================================
-- §1  THE GRANT TABLE
--
-- Idempotent. Safe to re-run.
-- =====================================================================

create table if not exists user_permissions (
  id          uuid primary key default gen_random_uuid(),
  email       text        not null,
  tier        text        not null,
  granted_by  text,
  granted_at  timestamptz not null default now(),
  note        text,

  -- One row per (person, tier). Ryley holds two tiers, which is two rows.
  constraint user_permissions_email_tier_key unique (email, tier),

  -- MIRRORS GRANTABLE_TIERS IN permissions-lib.js. 'hourly_wages' is refused
  -- here, not just ignored there: it is the base tier, held by everyone and
  -- stored for nobody, and a row asserting it would make presence and absence
  -- mean the same thing.
  constraint user_permissions_tier_check check (tier in ('salaries', 'admin')),

  -- STORED CANONICAL, because the lookup is exact. permissions-lib lowercases
  -- and trims both sides before comparing, so an uncanonical row would still
  -- match — but it would also sort, group and deduplicate as a different
  -- person, and unique(email, tier) would let 'A@x' and 'a@x' both exist.
  constraint user_permissions_email_canonical check (email = lower(btrim(email))),
  constraint user_permissions_email_shape     check (email like '%_@_%')
);

comment on table user_permissions is
  'Who holds which permission tier. Membership is DATA: granting access is an '
  'INSERT, not a deploy. What a tier MEANS is in netlify/functions/'
  'permissions-lib.js. The base tier (hourly_wages) is held by every signed-in '
  'user and is never stored here — a missing row means the base tier, not no '
  'access. See SCHEMA_PHASE_D_PERMISSIONS.sql §7 for the recovery path if the '
  'last admin is ever lost.';

comment on column user_permissions.email is
  'Lowercased and trimmed, matching the address Google returns at login.';
comment on column user_permissions.granted_by is
  'The email of whoever made the grant. ''migration'' for the bootstrap rows.';

create index if not exists user_permissions_email_idx on user_permissions (email);

-- The Netlify functions reach Supabase with the SERVICE key, which bypasses
-- RLS. The anon key never touches this table and no browser talks to PostgREST
-- directly. RLS on with no policy therefore changes nothing about how the app
-- works and closes the table completely to any other key.
--
-- Deliberately NO policies. Not an omission — with none defined, RLS denies
-- everything to every role that is subject to it, which is the correct answer
-- for a table listing who may see salaries. If a policy is ever added here,
-- adding it is the security decision, not a detail of it.
alter table user_permissions enable row level security;

-- Supabase's default privileges hand anon and authenticated a grant on every
-- new table in public. RLS already stops them, but a grant nobody needs is a
-- grant that survives somebody switching RLS off to debug something.
revoke all on user_permissions from anon, authenticated;

-- Explicit rather than inherited, because this one matters: it is the only role
-- that reads the table, and the app fails CLOSED if the read fails — every
-- caller silently drops to the base tier and the admins quietly lose their
-- admin. A missing grant would look exactly like nobody having been granted
-- anything.
grant select, insert, update, delete on user_permissions to service_role;

-- PostgREST answers from a cached schema. Supabase reloads it on DDL through an
-- event trigger, but not instantly, and a stale cache here has a specific and
-- confusing symptom: PGRST205 'could not find the table', which fetchTiers
-- treats as "the migration has not run yet" and answers with the base tier. So
-- the seed in section 2 would appear to have done nothing. Ask for the reload
-- rather than waiting to find out.
notify pgrst, 'reload schema';


-- =====================================================================
-- §2  THE BOOTSTRAP SEED
--
-- FILL IN THE THREE ADDRESSES FROM §0c BEFORE RUNNING. They are left as
-- obvious placeholders on purpose: a guessed address produces a row that looks
-- like a grant and silently is not.
--
--   Administrators:  Peter Stroble, Ryley Stanley
--   Salaries tier:   Jeff Cook, Ryley Stanley, Peter Stroble
--
-- Ryley and Peter appear twice, once per tier. That is the intended shape.
--
-- on conflict do nothing, so re-running adds nobody twice and overwrites
-- nobody's granted_by.
-- =====================================================================

-- FILLED IN FROM §0c's ACTUAL OUTPUT, 2026-08-22. Note jeffrey.cook@, which is
-- not what the first.last@ pattern the other two follow would have produced.
insert into user_permissions (email, tier, granted_by, note) values
  ('peter.stroble@sequoiafp.com', 'admin',    'migration', 'Phase D bootstrap'),
  ('ryley.stanley@sequoiafp.com', 'admin',    'migration', 'Phase D bootstrap'),
  ('peter.stroble@sequoiafp.com', 'salaries', 'migration', 'Phase D bootstrap'),
  ('ryley.stanley@sequoiafp.com', 'salaries', 'migration', 'Phase D bootstrap'),
  ('jeffrey.cook@sequoiafp.com',  'salaries', 'migration', 'Phase D bootstrap')
on conflict (email, tier) do nothing;

-- Expected after the insert: 5 rows, 2 admins, 3 salaries, 3 distinct people.
--
-- RAN 2026-08-22: INSERT 0 5, then 5 / 2 / 3 / 3 exactly. The ON CONFLICT
-- clause succeeding is itself proof of the unique constraint: Postgres rejects
-- 'on conflict (email, tier)' outright when no unique index matches it.
select count(*) as rows_expect_5,
       count(*) filter (where tier='admin')    as admins_expect_2,
       count(*) filter (where tier='salaries') as salaries_expect_3,
       count(distinct email)                   as people_expect_3
from user_permissions;


-- =====================================================================
-- §3  THE LAST ADMIN CANNOT BE REVOKED
--
-- The obvious way to lose this system is not an attack, it is somebody tidying
-- up: two admins, one leaves, their row is deleted, and now the grant page
-- cannot be opened by anybody who could fix it. §7 documents the way back, but
-- a recovery nobody needs is better than one that works.
--
-- STATEMENT-LEVEL, not row-level, and AFTER rather than BEFORE: the question is
-- about the state of the whole table once the statement has finished, which no
-- single row can answer. PostgREST runs each HTTP request in its own
-- transaction, so a revoke-then-grant done as one statement is judged on its
-- end state and passes.
--
-- ORDER MATTERS FOR A HANDOVER. Each statement is judged on its own, so
-- deleting the outgoing admin BEFORE granting the incoming one is refused even
-- inside a transaction that would have ended up fine. Grant first, then revoke.
-- That is what the error message says, because it is the thing somebody will be
-- doing when they see it.
--
-- TRUNCATE IS COVERED SEPARATELY, and has to be: a delete trigger does not fire
-- on TRUNCATE, which would leave the one statement that empties the whole table
-- in a single word as the only way past this guard. Verified both ways against
-- Postgres 16 — without the truncate clause the table empties silently.
--
-- DROP TABLE is NOT covered and cannot be. Dropping the table takes the trigger
-- with it, so there is nothing left to object. That is the case section 7
-- exists for.
-- =====================================================================

create or replace function refuse_last_admin_removal() returns trigger
language plpgsql as $$
declare remaining integer;
begin
  select count(*) into remaining from user_permissions where tier = 'admin';
  if remaining = 0 then
    raise exception
      E'Refusing to remove the last administrator.\n\n'
      'With no admin row nobody can grant or revoke through the app. If this is '
      'deliberate, see SCHEMA_PHASE_D_PERMISSIONS.sql section 7 — grant somebody '
      'else admin first, then remove this one.'
      using errcode = 'check_violation';
  end if;
  return null;
end $$;

drop trigger if exists user_permissions_keep_an_admin on user_permissions;
create trigger user_permissions_keep_an_admin
  after delete or update on user_permissions
  for each statement execute function refuse_last_admin_removal();

-- TRUNCATE needs its own trigger: Postgres will not accept it in the same
-- CREATE TRIGGER as DELETE and UPDATE. Same function, same verdict.
drop trigger if exists user_permissions_keep_an_admin_truncate on user_permissions;
create trigger user_permissions_keep_an_admin_truncate
  after truncate on user_permissions
  for each statement execute function refuse_last_admin_removal();


-- =====================================================================
-- §4  employees.hire_date
--
-- Added EMPTY. No backfill — the roster has never held a start date, and BBSI
-- probably has them. Guessing one would put a fabricated date in front of
-- somebody who would reasonably read it as a fact.
--
-- Nothing reads it yet. It is added now because the projection ladder in
-- data.js already has a rung for it, and because the salaried-week question
-- Phase C could not answer needs it.
-- =====================================================================

alter table employees add column if not exists hire_date date;

comment on column employees.hire_date is
  'First day worked. Added empty in Phase D and deliberately not backfilled — '
  'a guessed start date reads as a fact. Populate from BBSI.';


-- =====================================================================
-- §5  RETIRE THE 'Salary' SENTINEL IN employees.wage
--
-- employees.wage is TEXT and has been carrying the literal string 'Salary' for
-- salaried people since before pay_type existed. pay_type has been the answer
-- since SCHEMA_V2_MODEL.sql §5b; the marker has outlived it, and every reader
-- now has to carry a fallback for a value that means the same thing as the
-- column beside it.
--
-- This is STEP 2 of SCHEMA_V2_HOTFIX_SENTINEL.sql, finally run. That file put
-- the marker BACK in when 5b cleared it ahead of the deploy that could read
-- pay_type. The deploy has long since happened.
--
-- GUARDED TWICE, and it aborts rather than warns:
--   * no row anywhere may have a null pay_type;
--   * no row carrying the marker may lack pay_type = 'Salaried'.
-- Either would mean somebody whose only claim to being salaried is the string
-- this statement is about to delete.
-- =====================================================================

do $$
declare unclassified integer; marker_only integer; cleared integer;
begin
  select count(*) into unclassified from employees where pay_type is null;
  if unclassified > 0 then
    raise exception
      'Refusing to clear the wage sentinel: % row(s) have no pay_type. '
      'Clearing the marker would read every one of them as HOURLY.', unclassified;
  end if;

  select count(*) into marker_only from employees
   where btrim(lower(coalesce(wage,''))) = 'salary'
     and coalesce(btrim(pay_type),'') <> 'Salaried';
  if marker_only > 0 then
    raise exception
      'Refusing to clear the wage sentinel: % row(s) carry the marker without '
      'pay_type = ''Salaried''. Set their pay_type first.', marker_only;
  end if;

  update employees
     set wage = null
   where pay_type = 'Salaried'
     and btrim(lower(coalesce(wage,''))) = 'salary';

  get diagnostics cleared = row_count;
  raise notice 'Cleared the wage sentinel on % row(s).', cleared;
end $$;


-- =====================================================================
-- §6  VERIFY
-- =====================================================================

-- 6a. The table, its constraints and its trigger are all present.
--     Expected: 3 check constraints — tier, email-canonical, email-shape. The
--     primary key and the unique are their own contype and are not counted
--     here. 2 triggers — one for delete/update, one for truncate, which
--     Postgres will not combine. rls_enabled true.
select
  (select count(*) from information_schema.tables
    where table_schema='public' and table_name='user_permissions')       as table_exists_expect_1,
  (select count(*) from pg_constraint
    where conrelid = 'user_permissions'::regclass and contype = 'c')     as check_constraints_expect_3,
  (select count(*) from pg_trigger t
    where t.tgrelid = 'user_permissions'::regclass and not t.tgisinternal) as triggers_expect_2,
  (select relrowsecurity from pg_class
    where oid = 'user_permissions'::regclass)                            as rls_enabled_expect_true;

-- 6b. WHO ACTUALLY HOLDS WHAT — one row per person, tiers listed.
--     Expected: three people. Peter and Ryley with {admin,salaries}; Jeff with
--     {salaries}. Read the addresses against §0c character by character; this
--     is the whole point of the section.
select email,
       string_agg(tier, ', ' order by tier) as tiers,
       min(granted_at)                      as first_granted
from user_permissions
group by email
order by email;

-- 6c. EVERY GRANT MATCHES A REAL LOGIN. A grant whose address is on nobody's
--     employee record is not necessarily wrong — an address can be right
--     without being on the roster — but it is worth seeing, because a typo
--     looks exactly like this and nothing else will ever report it.
select p.email, p.tier,
       coalesce(e.name, '(no employee row with this email)') as matches_employee
from user_permissions p
left join employees e on lower(btrim(e.email)) = p.email
order by p.email, p.tier;

-- 6d. The sentinel is gone and nobody lost their pay type.
--     Expected: marker_rows 0, and salaried_total / salaried_active unchanged
--     from §0d.
select
  count(*) filter (where btrim(lower(coalesce(wage,''))) = 'salary')   as marker_rows_expect_0,
  count(*) filter (where pay_type = 'Salaried')                        as salaried_total,
  count(*) filter (where pay_type = 'Salaried' and status = 'Active')  as salaried_active,
  count(*) filter (where pay_type is null)                             as pay_type_null_expect_0,
  count(*) filter (where pay_type = 'Salaried'
                     and coalesce(btrim(wage),'') <> '')               as salaried_with_a_wage_expect_0
from employees;

-- 6e. hire_date exists, is a date, and is empty.
select column_name, data_type, is_nullable,
       (select count(*) from employees where hire_date is not null) as populated_expect_0
from information_schema.columns
where table_schema='public' and table_name='employees' and column_name='hire_date';

-- 6f. The base tier is not storable. Expected: BOTH of these RAISE.
--     Run them one at a time and confirm the error, then move on. Neither
--     leaves a row behind.
-- insert into user_permissions (email, tier) values ('x@sequoiafp.com', 'hourly_wages');
-- insert into user_permissions (email, tier) values ('MiXeD@sequoiafp.com', 'admin');

-- 6g. The last admin is protected. Expected: BOTH of these RAISE, and both
--     leave every row where it was. Wrapped so they cannot succeed by accident;
--     run each block whole, rollback included.
-- begin;
--   delete from user_permissions where tier = 'admin';
-- rollback;

-- begin;
--   truncate user_permissions;
-- rollback;

-- 6h. And a legitimate revoke still works — one of two admins goes, and the
--     table is left with one. Expected: admins_left = 1, then rolled back.
-- begin;
--   delete from user_permissions where tier = 'admin' and email = (
--     select min(email) from user_permissions where tier = 'admin');
--   select count(*) as admins_left_expect_1 from user_permissions where tier = 'admin';
-- rollback;


-- =====================================================================
-- §7  RECOVERY — no admin left
--
-- The trigger in §3 makes this hard to reach: the last admin row cannot be
-- deleted through any path, including the service key, including psql. What is
-- left that could still get here is the table being dropped and rebuilt, or a
-- restore from a backup taken before the seed.
--
-- THE WAY BACK IS ALWAYS THIS, and it needs nothing but the Supabase SQL
-- editor, which is reached with the project owner's own login and does not
-- depend on this table at all:
--
--   insert into user_permissions (email, tier, granted_by, note)
--   values ('peter.stroble@sequoiafp.com', 'admin', 'recovery', 'restored manually')
--   on conflict (email, tier) do nothing;
--
-- Confirm the address against employees.email before running it. The one thing
-- that makes this recovery fail is the thing §0c caught: an address that is
-- right in shape and wrong in fact inserts cleanly, grants nothing, and leaves
-- you believing you are back in.
--
-- That is the entire recovery. It is deliberately not automated and there is no
-- back door in the application: a hardcoded fallback admin in the code would be
-- a permanent grant that no revoke could reach, which is a worse failure than
-- the one it prevents.
--
-- If instead the app has locked everybody out because the permissions READ is
-- failing, the answer is not here — fetchTiers falls back to the base tier on
-- any error, so a broken read costs the admins their admin and costs nobody
-- else anything. The roster keeps working.
-- =====================================================================


-- =====================================================================
-- §8  ROLLBACK
--
-- §1–§4 are reversible. §5 IS NOT, in the sense that matters: it deletes the
-- only copy of a marker. It is recoverable from pay_type, which is what the
-- marker duplicated — the statement below rebuilds it exactly, and is STEP 1
-- of SCHEMA_V2_HOTFIX_SENTINEL.sql.
-- =====================================================================

-- Undo §5 — rebuild the marker from pay_type.
-- update employees set wage = 'Salary'
--  where pay_type = 'Salaried' and (wage is null or btrim(wage) = '');

-- Undo §4.
-- alter table employees drop column if exists hire_date;

-- Undo §3 and §1. DROP TABLE is enough on its own — it takes both triggers
-- with it and does not fire them, verified rather than assumed. The function is
-- schema-level and does outlive the table, so it is dropped separately.
-- drop table if exists user_permissions;
-- drop function if exists refuse_last_admin_removal();
