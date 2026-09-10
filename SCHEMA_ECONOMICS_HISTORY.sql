-- =====================================================================
-- APPLIED 2026-09-10 to zwghbbyzrycpnesuuzgi (sfp-staffing), in full, one
-- section at a time. Every prediction in this file was checked against what
-- the database actually returned; the per-section results are recorded inline.
--
-- §1 found 55 seats, ALL 55 carrying a ceiling — the fixture this was dry-run
-- against assumed three without one, so §4 wrote 55 opening rows rather than
-- the 52 the dry-run produced. The check that mattered still held: §4's count
-- equalled §1's with_ceiling, which is the assertion, not the number.
--
-- The three CHECK/NOT NULL guards were then fired against the LIVE table
-- inside a rolled-back DO block: field_check rejected 'seat_title',
-- actually_changed rejected previous = new, and changed_by NOT NULL rejected a
-- missing actor. The table was left holding exactly its 55 opening rows and
-- one distinct actor ('migration'), with no test residue.
--
-- Run in the STAFFING project (zwghbbyzrycpnesuuzgi) ONLY. §0 refuses to
-- proceed anywhere else; the mill ERP project has been the wrong target of a
-- run in this repo more than once.
--
-- Run one section at a time, in order, reading the result of each before the
-- next. Nothing before §2 writes or creates anything.
--
-- LEARNED THE HARD WAY AND WORTH REPEATING: THE SUPABASE SQL EDITOR DOES NOT
-- SURFACE 'RAISE NOTICE'. A section that reports only "Success. No rows
-- returned." has told you nothing. Every section here ends in a SELECT.
--
-- DRY-RUN AGAINST POSTGRES 16.13 before being handed over, on a throwaway
-- database built to the live table shape (55 seats, 3 of them with no ceiling).
-- Not a substitute for §0 — a fixture cannot know what the real plan holds —
-- but it does mean the SQL parses, the expectations printed beside each query
-- are the ones it actually returns, and every guard was made to FIRE rather
-- than assumed to work:
--
--   * whole file runs clean, twice; the second run inserted 0 rows and the
--     table still held 52. §4's NOT EXISTS is what makes that true.
--   * §4 wrote 52 rows against 55 seats, which is exactly §1's with_ceiling
--     count — the three seats with no ceiling correctly got no opening row.
--   * economics_history_field_check REJECTED field = 'seat_title'.
--   * economics_history_actually_changed REJECTED previous = new = '35.00'.
--   * changed_by NOT NULL REJECTED a row with no actor.
--   * a legitimate 35.00 -> 38.00 row was ACCEPTED.
--   * deleting a seat left its history rows in place with seat_id nulled,
--     which is the ON DELETE SET NULL doing its job. CASCADE would have taken
--     the audit trail with the seat.
-- =====================================================================
-- economics_history — an audit trail for the staffing plan.
--
-- ---------------------------------------------------------------------
-- WHY THIS EXISTS
-- ---------------------------------------------------------------------
--
-- Until now, two facts about a seat could be changed from the app and neither
-- was recorded anywhere:
--
--   economics.max_wage      the seat's budgeted hourly ceiling — the figure the
--                           whole Variance column is measured against.
--   economics.employee_id   who is sitting in the seat.
--
-- The ceiling was read-only in the app until 2026-09-10, so the absence of a
-- record was tolerable: moving one meant writing SQL by hand, and that at least
-- left a trace in somebody's query history. It is a field on a page now. The
-- response tells the browser what the value used to be and the page says so in
-- a toast, and once that toast fades the previous figure is gone.
--
-- employees.wage has had wage_history since 2026-08-22 for exactly this reason,
-- and the argument does not stop at the employees table: "who changed this
-- seat's budget, from what, and when" deserves the same answer as "who changed
-- this person's rate".
--
-- ---------------------------------------------------------------------
-- WHY BOTH FIELDS, AND NOT JUST THE CEILING
-- ---------------------------------------------------------------------
--
-- The ceiling is what prompted this. Assignment is included because it is the
-- other write this endpoint has, because a seat's occupant moving is exactly as
-- much a change to the plan, and because a table called economics_history that
-- silently covered half the writes would be worse than no table — somebody
-- reading it would reasonably conclude nothing else had changed.
--
-- ---------------------------------------------------------------------
-- WHY THE VALUES ARE TEXT
-- ---------------------------------------------------------------------
--
-- One table holds two kinds of change: a rate and a person. Typed column pairs
-- for each (previous_wage numeric, previous_employee_id uuid, ...) would mean
-- four mostly-null columns and a reader having to know which pair to look at
-- from the `field` discriminator anyway.
--
-- So `previous_value` / `new_value` carry the raw stored value as text, and
-- `previous_display` / `new_display` carry what it MEANT at the time. The
-- display columns are not redundant with the values: an employee_id is an
-- unreadable UUID whose employee may since have been deleted or renamed, and
-- the whole point of a history row is to still make sense years later. NULL in
-- either pair means "none" — no ceiling, or a vacant seat.
--
-- ---------------------------------------------------------------------
-- WHY THE SEAT IS DENORMALISED ONTO EVERY ROW
-- ---------------------------------------------------------------------
--
-- seat_num, seat_section and seat_title are copied in at write time. The FK to
-- economics(id) is ON DELETE SET NULL, matching how every other FK onto that
-- table is declared — a seat being removed must not delete the record of what
-- was done to it. Without the copies, such a row would be an audit entry that
-- cannot say which seat it was about.

-- =====================================================================
-- §0  GUARD: right project, and the table this hangs off exists
-- =====================================================================
-- Expect: economics_exists = true, permissions_exists = true, and a seat count
-- around 55. If economics does not exist, STOP — you are in the wrong project.
select
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_name = 'economics')  = 1 as economics_exists,
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_name = 'user_permissions') = 1 as permissions_exists,
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_name = 'economics_history') = 1 as already_ran,
  (select count(*) from public.economics) as seat_count;

-- =====================================================================
-- §1  WHAT IS THERE NOW  (read-only)
-- =====================================================================
-- The starting state, recorded before anything is created. Every one of these
-- ceilings predates the audit trail and no row below will explain where it came
-- from — which is the point of §4's note.
-- Expect: 55 rows, most with a ceiling.
-- GOT: seats 55, with_ceiling 55, without_ceiling 0, filled 55. Every seat on
-- the live plan carries a ceiling and has somebody in it.
select
  count(*)                                             as seats,
  count(max_wage)                                      as with_ceiling,
  count(*) - count(max_wage)                           as without_ceiling,
  count(employee_id)                                   as filled
from public.economics;

-- =====================================================================
-- §2  CREATE THE TABLE  (first write)
-- =====================================================================
create table if not exists public.economics_history (
  id               uuid primary key default gen_random_uuid(),

  -- SET NULL, not CASCADE. The same choice every other FK onto economics
  -- makes: removing a seat must not remove the record of what was done to it.
  seat_id          uuid references public.economics(id) on delete set null,

  -- Copied in at write time so the row still identifies its seat after the
  -- seat is renamed, renumbered or deleted. See the note at the top.
  seat_num         integer,
  seat_section     text,
  seat_title       text,

  -- Which fact changed. Mirrors WRITABLE in netlify/functions/economics.js;
  -- a value outside this list means somebody added a writable column and did
  -- not come here, which should fail loudly rather than record an unlabelled
  -- change.
  field            text        not null
                   constraint economics_history_field_check
                   check (field in ('max_wage', 'employee_id')),

  -- The raw stored values, as text. NULL means "none": no ceiling, or vacant.
  previous_value   text,
  new_value        text,

  -- What those values MEANT when the change was made — '35.00', 'Ana Reyes'.
  -- Kept because a UUID is unreadable and its employee may since be gone.
  previous_display text,
  new_display      text,

  -- The signed-in account that made the change. NOT NULL: a history row that
  -- cannot say who is doing half the job, and every write path through
  -- /api/economics has a verified session by the time it gets here.
  changed_by       text        not null,
  changed_at       timestamptz not null default now(),

  -- Free text for anything the columns cannot carry — today, only §4's
  -- backfill marker. Deliberately not where the actor goes: wage_history put
  -- the editor's email inside a sentence in its note, and the result is an
  -- immutable record whose one machine-readable field is a prose string that
  -- still names a page which no longer exists.
  note             text,

  -- A change that moved nothing is not a change. The app already refuses to
  -- write one — it answers `unchanged` instead — so a row like this would mean
  -- that check regressed.
  constraint economics_history_actually_changed
    check (previous_value is distinct from new_value)
);

-- Reads are "this seat, newest first" and "everything, newest first". Both are
-- served by one index; the table grows by a handful of rows a week, so this is
-- for correctness of ordering under a LIMIT rather than for speed.
create index if not exists economics_history_seat_changed_at_idx
  on public.economics_history (seat_id, changed_at desc);
create index if not exists economics_history_changed_at_idx
  on public.economics_history (changed_at desc);

-- Verify §2. Expect: 13 columns, 1 primary key, 1 FK to economics, 2 checks
-- (field, actually_changed) plus the not-nulls, and the two indexes.
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'economics_history'
order by ordinal_position;

-- =====================================================================
-- §3  LOCK IT DOWN  (second write)
-- =====================================================================
-- The app reaches this table with the service key, which bypasses RLS. RLS is
-- enabled anyway, with NO policy, so that anon and authenticated roles get
-- nothing — the same posture the plan itself has. A table of who-changed-whose-
-- budget must not be readable by a browser holding only the publishable key.
--
-- This is also why the read is served by /api/economics rather than by
-- /api/data: the endpoint resolves the caller's tiers itself.
alter table public.economics_history enable row level security;

-- INSERT-ONLY BY INTENT, and this is where that intent is written down rather
-- than merely assumed. The service key can still update and delete — no grant
-- can stop it — so this revoke does not make the table immutable. What it does
-- is make an UPDATE from any other role fail rather than silently succeed, and
-- record that editing a history row is not a thing anybody is supposed to do.
revoke update, delete on public.economics_history from anon, authenticated;

-- Verify §3. Expect: relrowsecurity = true, and no policies.
select c.relrowsecurity as rls_enabled,
       (select count(*) from pg_policy pol where pol.polrelid = c.oid) as policy_count
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'economics_history';

-- =====================================================================
-- §4  MARK THE STARTING LINE  (third write)
-- =====================================================================
-- NOT A BACKFILL. There is nothing to backfill from — no previous values were
-- ever recorded, which is the whole reason this table exists. Inventing rows
-- that claim today's ceiling was "set" today by "migration" would be writing
-- fiction into an audit trail on its first day.
--
-- Instead: one row per seat that HAS a ceiling, recording that the figure
-- predates the trail and where it came from. previous_value is NULL and
-- new_value is the current figure, which is literally true — before this table
-- existed there is no recorded prior value.
--
-- This is what stops the first real edit of a seat looking like the first time
-- its ceiling was ever set.
insert into public.economics_history
  (seat_id, seat_num, seat_section, seat_title,
   field, previous_value, new_value, previous_display, new_display,
   changed_by, note)
select
  e.id, e.num, e.section, e.seat,
  'max_wage',
  null,
  e.max_wage::text,
  null,
  to_char(e.max_wage, 'FM999990.00'),
  'migration',
  'Opening balance. This ceiling predates economics_history and was set before '
    || 'any change to it was recorded; SCHEMA_ECONOMICS_HISTORY.sql created the '
    || 'trail on this date. It is NOT a record of somebody setting this figure.'
from public.economics e
where e.max_wage is not null
  -- Idempotent: a second run of this file inserts nothing.
  and not exists (
    select 1 from public.economics_history h
    where h.seat_id = e.id and h.changed_by = 'migration'
  );

-- Verify §4. Expect: rows = the with_ceiling count from §1, every one with a
-- null previous_value, and changed_by = 'migration'.
-- GOT: opening_rows 55, should_be_zero 0, ceilings 22.00 to 50.00, across 55
-- distinct seats — one per seat, exactly §1's with_ceiling.
select count(*)                          as opening_rows,
       count(previous_value)             as should_be_zero,
       min(new_display)                  as lowest_ceiling,
       max(new_display)                  as highest_ceiling
from public.economics_history
where changed_by = 'migration';

-- =====================================================================
-- §5  WHAT THE APP WILL SEE  (read-only)
-- =====================================================================
-- The shape /api/economics returns for one seat's history, newest first.
-- Expect: the opening row for whichever seat this picks, and nothing else yet.
select seat_num, seat_title, field,
       previous_display, new_display, changed_by, changed_at
from public.economics_history
order by changed_at desc, seat_num
limit 20;
