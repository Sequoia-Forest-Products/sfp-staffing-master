-- =====================================================================
-- SFP Staffing — normalise break_1 / break_2 to local 24-hour HH:MM
-- Run in the STAFFING project (zwghbbyzrycpnesuuzgi) ONLY.
--
-- I ARGUED AGAINST THIS MIGRATION AND WAS WRONG. The reasoning was: nothing
-- but the display layer parses these columns, so formatting on display
-- carries the benefit with none of the risk. That holds when the stored
-- values are merely UGLY. It does not hold here, because they are WRONG.
--
-- WHAT THE AUDIT FOUND. 70 of 74 rows in each column hold a spreadsheet
-- serialisation like '1899-12-30T20:45:00.000Z'. The remaining 4 hold text:
-- '7:00 AM' in break_1 and '12:45 PM' in break_2 — the mill's standard
-- breaks, and what openAdd() defaults a new hire to. The modal ISO values
-- are '15:00' (68 rows) and '20:45' (64 rows), and 15:00 - 8h is 07:00
-- while 20:45 - 8h is 12:45. Two independent values landing exactly on the
-- two known break times under one offset is not coincidence: these are
-- Pacific clock times serialised through UTC.
--
-- So a display-only fix means an invisible eight-hour correction living in
-- one JavaScript function, forever, for a column where the stored value
-- reads as a different time of day than it means. Anything that ever reads
-- this column directly — an export, a report, a future feature, somebody
-- eyeballing the table — gets 3:00 PM for a 7:00 AM break. Normalising
-- makes the column say what it means.
--
-- THE FULL DISTRIBUTION, and what each value becomes:
--
--   break_1   15:00  x68  ->  07:00   ( 7:00 AM)
--   break_1   00:30  x 2  ->  16:30   ( 4:30 PM)
--   break_2   20:45  x64  ->  12:45   (12:45 PM)
--   break_2   21:30  x 3  ->  13:30   ( 1:30 PM)
--   break_2   04:45  x 2  ->  20:45   ( 8:45 PM)
--   break_2   21:00  x 1  ->  13:00   ( 1:00 PM)
--
-- The 1899-12-31 rows exist BECAUSE of the shift — a time-only value cannot
-- roll past its own epoch day on its own — and wrap back into the working
-- day: 00:30 - 8h is 16:30 the day before.
--
-- NO TIMESTAMPTZ ANYWHERE. Both columns are `text` (confirmed against
-- information_schema), the arithmetic is done on the digits, and the offset
-- is a flat -8 rather than a DST-aware conversion: 15:00 matching '7:00 AM'
-- exactly is what says the exporter used a flat offset, and 1899 predates
-- US daylight saving regardless. Casting to a time type here would hand the
-- session's TimeZone a say in the answer, which is the hazard the birthday
-- migration had to steer around.
-- =====================================================================


-- =====================================================================
-- §0  PREFLIGHT — ARE YOU IN THE RIGHT PROJECT?
--
-- Run this first, on its own. It writes nothing, and either returns counts
-- or raises. There are four Supabase projects on this account and §1 of the
-- last migration was run against the wrong one.
-- =====================================================================

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

-- Expected: 74 / 70 / 70 / 4 / 4.
select
  (select count(*) from employees)                                    as employees_expect_74,
  (select count(*) from employees where break_1 ~ '^\d{4}-\d{2}-\d{2}T') as break_1_iso_expect_70,
  (select count(*) from employees where break_2 ~ '^\d{4}-\d{2}-\d{2}T') as break_2_iso_expect_70,
  (select count(*) from employees where break_1 ~ '[AaPp][Mm]')          as break_1_text_expect_4,
  (select count(*) from employees where break_2 ~ '[AaPp][Mm]')          as break_2_text_expect_4;


-- =====================================================================
-- §1  BACKUP. Two columns, not a whole-table snapshot: the change is
-- confined to two text columns and a targeted backup is easier to verify
-- and to roll back from than a copy of the roster.
--
-- Idempotent: re-running will NOT overwrite a backup already taken, which
-- matters because a second run after a partial migration would otherwise
-- back up the already-converted values and destroy the originals.
-- =====================================================================

alter table employees add column if not exists break_1_pre_hhmm text;
alter table employees add column if not exists break_2_pre_hhmm text;

update employees
   set break_1_pre_hhmm = break_1,
       break_2_pre_hhmm = break_2
 where break_1_pre_hhmm is null
   and break_2_pre_hhmm is null;

-- Expected: 74 rows carrying a backup (or as many as have either value).
select count(*) filter (where break_1_pre_hhmm is not null) as break_1_backed_up,
       count(*) filter (where break_2_pre_hhmm is not null) as break_2_backed_up,
       count(*) as total_rows
from employees;


-- =====================================================================
-- §2  PREVIEW — every row that will change, with its before and after.
--
-- Read this before running §3. The conversion is spelled out inline rather
-- than hidden in a function so the arithmetic is visible: take the HH:MM
-- after the 'T', subtract 480 minutes, wrap into the day.
--
-- Expected: 6 rows, not 140. The query GROUPS by distinct stored value, so
-- each row carries a `rows` count and those counts sum to 140. (An earlier
-- version of this comment said 140 rows; it was counting the rows affected,
-- not the rows returned.) More than 6 would mean the ISO strings are not
-- formatted uniformly — still fine, but worth a look before §3.
--
-- Every `reads_as` should be a plausible break time.
-- =====================================================================

with iso as (
  select id, name, 'break_1' as col, break_1 as before from employees
   where break_1 ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}'
  union all
  select id, name, 'break_2', break_2 from employees
   where break_2 ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}'
),
converted as (
  select id, name, col, before,
         (((substring(before from 12 for 2))::int * 60
           + (substring(before from 15 for 2))::int
           - 480) % 1440 + 1440) % 1440 as mins
  from iso
)
select col, before,
       lpad((mins/60)::text, 2, '0') || ':' || lpad((mins%60)::text, 2, '0') as after,
       -- Formatted with integer arithmetic, NOT make_time/to_char. Postgres has
       -- no to_char(time, text) overload, so that version depended on an
       -- implicit cast to interval to resolve at all. It also contradicted this
       -- file's own rule: no time types anywhere, because a time type is how a
       -- session TimeZone gets a say in the answer.
       (case when mins/60 = 0 then 12
             when mins/60 > 12 then mins/60 - 12
             else mins/60 end)::text
         || ':' || lpad((mins%60)::text, 2, '0')
         || (case when mins >= 720 then ' PM' else ' AM' end) as reads_as,
       count(*) as rows
from converted
group by col, before, mins
order by col, rows desc, before;


-- =====================================================================
-- §3  THE MIGRATION
--
-- Only rows matching the ISO shape are touched. The four text rows per
-- column are ALREADY LOCAL — they are the reference the offset was derived
-- from — and shifting them would move correct values a second time.
--
-- Run §0, §1 and §2 first.
-- =====================================================================

-- update employees
--    set break_1 = lpad(((((substring(break_1 from 12 for 2))::int * 60
--                         + (substring(break_1 from 15 for 2))::int
--                         - 480) % 1440 + 1440) % 1440 / 60)::text, 2, '0')
--                  || ':' ||
--                  lpad(((((substring(break_1 from 12 for 2))::int * 60
--                         + (substring(break_1 from 15 for 2))::int
--                         - 480) % 1440 + 1440) % 1440 % 60)::text, 2, '0')
--  where break_1 ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}';

-- update employees
--    set break_2 = lpad(((((substring(break_2 from 12 for 2))::int * 60
--                         + (substring(break_2 from 15 for 2))::int
--                         - 480) % 1440 + 1440) % 1440 / 60)::text, 2, '0')
--                  || ':' ||
--                  lpad(((((substring(break_2 from 12 for 2))::int * 60
--                         + (substring(break_2 from 15 for 2))::int
--                         - 480) % 1440 + 1440) % 1440 % 60)::text, 2, '0')
--  where break_2 ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}';

-- Optional, and a separate decision: normalise the four text rows to HH:MM
-- as well, so the column holds ONE shape. They display identically either
-- way, so this is tidiness rather than a fix.
-- update employees set break_1 = '07:00' where break_1 ~ '^7:00\s*[Aa]';
-- update employees set break_2 = '12:45' where break_2 ~ '^12:45\s*[Pp]';


-- =====================================================================
-- §4  VERIFY — run all of these
-- =====================================================================

-- 4a. Shape census. Expected: no ISO rows left, and 74 in HH:MM
--     (70 migrated + 4 text) if the optional step ran, else 70 + 4 AM/PM.
select 'break_1' as col,
       count(*) filter (where break_1 ~ '^\d{4}-\d{2}-\d{2}T') as still_iso_expect_0,
       count(*) filter (where break_1 ~ '^\d{2}:\d{2}$')        as hhmm,
       count(*) filter (where break_1 ~ '[AaPp][Mm]')           as am_pm,
       count(*) filter (where break_1 is null or btrim(break_1)='') as blank
from employees
union all
select 'break_2',
       count(*) filter (where break_2 ~ '^\d{4}-\d{2}-\d{2}T'),
       count(*) filter (where break_2 ~ '^\d{2}:\d{2}$'),
       count(*) filter (where break_2 ~ '[AaPp][Mm]'),
       count(*) filter (where break_2 is null or btrim(break_2)='')
from employees;

-- 4b. The new distribution. Expected, and this is the check that matters:
--       break_1  07:00 x68, 16:30 x2   (plus 4 text rows at 7:00 AM)
--       break_2  12:45 x64, 13:30 x3, 20:45 x2, 13:00 x1  (plus 4 at 12:45 PM)
select 'break_1' as col, break_1 as value, count(*) as rows
from employees where break_1 is not null and btrim(break_1) <> '' group by 1,2
union all
select 'break_2', break_2, count(*)
from employees where break_2 is not null and btrim(break_2) <> '' group by 1,2
order by col, rows desc, value;

-- 4c. NOTHING CHANGED MEANING. Every migrated row's new value must be
--     exactly 8 hours behind its backup. Expected: 0 rows.
--
--     This is the query that would catch a wrong offset, an off-by-one in
--     the substring positions, or a row converted twice.
--
--     Written with a CTE rather than one nested expression per side: the
--     inline version of this had unbalanced parentheses and would not have
--     run at all, which is a poor property for the check that everything
--     else is trusted on.
with pairs as (
  select id, name, 'break_1' as col, break_1_pre_hhmm as was, break_1 as now from employees
  union all
  select id, name, 'break_2', break_2_pre_hhmm, break_2 from employees
),
checkable as (
  select id, name, col, was, now,
         -- minutes encoded in the backup's ISO time part
         (substring(was from 12 for 2))::int * 60
           + (substring(was from 15 for 2))::int as was_mins,
         -- minutes encoded in the current HH:MM value
         (substring(now from 1 for 2))::int * 60
           + (substring(now from 4 for 2))::int as now_mins
  from pairs
  where was ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}'
    and now ~ '^\d{2}:\d{2}$'
)
select id, name, col, was, now, was_mins, now_mins,
       ((was_mins - 480) % 1440 + 1440) % 1440 as expected_mins
from checkable
where now_mins <> ((was_mins - 480) % 1440 + 1440) % 1440
order by col, name;

-- 4d. Nobody LOST a break time. Expected: 0 rows.
select id, name, break_1_pre_hhmm, break_1, break_2_pre_hhmm, break_2
from employees
where (break_1_pre_hhmm is not null and btrim(break_1_pre_hhmm) <> ''
       and (break_1 is null or btrim(break_1) = ''))
   or (break_2_pre_hhmm is not null and btrim(break_2_pre_hhmm) <> ''
       and (break_2 is null or btrim(break_2) = ''));


-- =====================================================================
-- §5  ROLLBACK, if §4 finds anything
-- =====================================================================

-- update employees set break_1 = break_1_pre_hhmm, break_2 = break_2_pre_hhmm
--  where break_1_pre_hhmm is not null or break_2_pre_hhmm is not null;


-- =====================================================================
-- §6  THE BACKUP COLUMNS STAY for now, the way birthday_raw_backup did.
-- Drop them in Phase D once the app has been reading the new values for a
-- while. They cost two nullable text columns and they are the only record
-- of what the times were before this ran.
--
-- alter table employees drop column break_1_pre_hhmm;   -- NOT YET
-- alter table employees drop column break_2_pre_hhmm;   -- NOT YET
-- =====================================================================
