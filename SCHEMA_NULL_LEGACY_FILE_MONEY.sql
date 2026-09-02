-- =====================================================================
-- SFP Staffing — one shape for daily_hours
-- Run in the STAFFING project (zwghbbyzrycpnesuuzgi) ONLY.
--
-- WHY. 233 rows, work dates 2026-08-19 to 2026-08-25, still carry
-- pay_rate, total_earnings, ot_dollars and regular_dollars. They were
-- written by the old importer in the days before the hours-only change
-- deployed. Every other row in the table has NULL in all four.
--
-- Nothing reads those columns. Verified across netlify/ and src/: the
-- only two mentions in shipped code are payroll-lib writing NULLs and
-- payroll-db's DAILY_COLUMNS select list, which fetches them and never
-- looks at them. No reader spreads a daily_hours row wholesale into a
-- response either, so they do not reach a browser unnamed. Every dollar
-- on every report is employees.wage x that row's hours, with the premium
-- from pay-rules-lib.
--
-- So this changes no figure anywhere. What it changes is that the table
-- stops holding two shapes.
--
-- WHY THAT IS WORTH A MIGRATION. A week of rows carrying numbers that
-- nothing computes from is a trap for the next person who queries this
-- table directly — a SQL export, a spreadsheet, a report somebody writes
-- in good faith six months from now. They would find figures for one
-- week and none for any other, with nothing on the row saying which is
-- authoritative. The answer is neither: the app computes its dollars and
-- does not store them.
--
-- NO PRESERVATION, by decision. The figures came from a rate the app no
-- longer treats as a source of any kind. They are not being archived to
-- a file, a comment or another table.
--
-- SCOPE. Four columns, on rows where total_earnings is not null. Hours
-- are not touched — regular_hours, ot_hours and total_hours are the
-- file's and are what the feed is for. No row is deleted. No employee
-- record is touched.
-- =====================================================================


-- =====================================================================
-- §1  PREFLIGHT. Read-only.
--
-- Expected:
--   rows_total            811
--   with_money            233
--   money_first_day       2026-08-19
--   money_last_day        2026-08-25
--   mixed_days            0     <- no day is part one shape, part the other
--   hours_total           WRITE THIS DOWN. §3 asserts it is unchanged, and
--                         that is the check proving this touched money and
--                         nothing else.
--
-- A non-zero mixed_days would mean a work date is split across both
-- shapes, which nothing in this change accounts for. Stop if so.
-- =====================================================================

do $$
declare found integer;
begin
  select count(*) into found from information_schema.tables
   where table_schema='public' and table_name in ('employees','daily_hours','wage_history');
  if found < 3 then
    raise exception
      E'WRONG PROJECT.\n\nSwitch to sfp-staffing (ref zwghbbyzrycpnesuuzgi).';
  end if;
end $$;

select
  count(*)                                                   as rows_total,
  count(*) filter (where total_earnings is not null)         as with_money,
  min(work_date) filter (where total_earnings is not null)   as money_first_day,
  max(work_date) filter (where total_earnings is not null)   as money_last_day,
  (select count(*) from (
      select work_date
      from daily_hours
      group by work_date
      having count(*) filter (where total_earnings is not null) > 0
         and count(*) filter (where total_earnings is null)     > 0
   ) m)                                                      as mixed_days,
  round(sum(total_hours), 2)                                 as hours_total
from daily_hours;


-- =====================================================================
-- §2  THE UPDATE.
--
-- Filtered on total_earnings is not null so it touches exactly the rows
-- §1 counted, and is idempotent: run it twice and the second run matches
-- nothing.
--
-- The four money columns only. total_hours, regular_hours and ot_hours
-- are absent from the SET list on purpose — hours are the file's.
-- =====================================================================

update daily_hours
   set pay_rate        = null,
       total_earnings  = null,
       ot_dollars      = null,
       regular_dollars = null
 where total_earnings is not null;

-- The editor must report 233 rows affected. Fewer means something wrote
-- to the table between §1 and §2; more is not possible, since §1 counted
-- the same predicate.


-- =====================================================================
-- §3  VERIFY. A SELECT, because the Supabase SQL editor does not surface
-- RAISE NOTICE.
--
-- Expected:
--   rows_total          811    <- unchanged; nothing was deleted
--   any_money_left      0      <- across all four columns
--   hours_total         IDENTICAL to §1's hours_total
--   rows_with_hours     unchanged
--
-- hours_total is the assertion that matters. It is what proves this
-- touched money and nothing else: if an hours column had been caught by
-- the SET list, this number would move.
-- =====================================================================

select
  count(*)                                                        as rows_total,
  count(*) filter (where pay_rate is not null
                      or total_earnings is not null
                      or ot_dollars is not null
                      or regular_dollars is not null)             as any_money_left,
  round(sum(total_hours), 2)                                      as hours_total,
  count(*) filter (where total_hours > 0)                         as rows_with_hours,
  min(work_date)                                                  as first_day,
  max(work_date)                                                  as last_day
from daily_hours;
