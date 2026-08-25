-- =====================================================================
-- SFP Staffing — the daily file becomes hours-only
-- Run in the STAFFING project (zwghbbyzrycpnesuuzgi) ONLY.
--
-- WHY. The BBSI daily file carried a Pay Rate column, and every dollar in
-- this system was derived from it: daily_hours.pay_rate, total_earnings
-- (the payroll system's own blended figure), ot_dollars (the residual) and
-- regular_dollars, plus a nightly overwrite of employees.wage.
--
-- That rate was never a source of truth. BBSI keyed it by hand out of their
-- payroll system into Timenet, the hours-tracking software the file is
-- exported from, purely so this feed could exist. Nobody maintains it there
-- any more. The app stopped reading it on 2026-08-22: employees.wage is the
-- record of truth, it is typed on the Salaries & Wages page, and every
-- change is recorded in wage_history.
--
-- WHAT THIS MIGRATION IS FOR. The four money columns are `not null default
-- 0`. The import now writes them as explicit NULL — "the file said nothing
-- about money", which is the truth and is NOT the same statement as zero.
-- Against the current schema every one of those inserts fails on the NOT
-- NULL constraint, so the whole day's import fails.
--
--   THIS MIGRATION MUST BE APPLIED BEFORE THE HOURS-ONLY IMPORT DEPLOYS.
--
-- Not after, and not "some time that week". The ingestion runs unattended
-- every morning at ~06:04 Pacific off the mailbox, and a failed run is a day
-- of hours that is not in the system.
--
-- If the deploy has already gone out and the morning import failed, this is
-- still the fix: apply it, then re-run the ingest for the missed day(s) —
-- the importer is idempotent on (work_date, employee_number), so a re-send
-- overwrites cleanly.
--
-- WHY NOT DROP THE COLUMNS. What is in them is the only record of what BBSI
-- said the money was, day by day, up to 2026-08-22. Nothing reads it now,
-- but a question about a historical paycheck has nowhere else to go. They
-- are kept, documented as historical, and left untouched by this script:
-- rewriting a year of vendor figures to NULL would destroy the record to
-- make the schema tidier.
--
-- SO EVERY ROW FROM BEFORE THIS CHANGE KEEPS ITS DOLLARS AND EVERY ROW
-- AFTER IT HAS NONE. That is a real discontinuity in the table and it is
-- deliberate; the column comments say so, and §3 shows where the boundary
-- fell once the import has run.
--
-- WHAT DOES NOT CHANGE. regular_hours, ot_hours and total_hours are the
-- file's and stay exactly as they are — hours are what the feed is for.
-- pay_rate is already nullable, so only its default and its comment move.
-- =====================================================================


-- =====================================================================
-- §0  PREFLIGHT — right project, and the columns are as expected.
-- Writes nothing.
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

-- Expected BEFORE §1: is_nullable = NO for total_earnings, ot_dollars and
-- regular_dollars; YES for pay_rate. column_default = 0 for all four except
-- pay_rate, which has none.
select column_name, is_nullable, column_default
from information_schema.columns
where table_schema='public' and table_name='daily_hours'
  and column_name in ('pay_rate','total_earnings','ot_dollars','regular_dollars',
                      'regular_hours','ot_hours','total_hours')
order by column_name;


-- =====================================================================
-- §1  THE CHANGE — nullable, and no default.
--
-- Both halves matter and they do different things:
--
--   DROP NOT NULL   lets the import write NULL, which is the whole point.
--   DROP DEFAULT    stops a column the caller OMITS from silently becoming
--                   0.00. A nullable column with a default of zero still
--                   manufactures money for anybody who does not name it,
--                   and "not recorded" reading as "$0.00" downstream is the
--                   exact confusion this change exists to remove.
--
-- No data is touched. Existing rows keep their values.
-- =====================================================================

alter table daily_hours alter column total_earnings  drop not null;
alter table daily_hours alter column total_earnings  drop default;

alter table daily_hours alter column ot_dollars      drop not null;
alter table daily_hours alter column ot_dollars      drop default;

alter table daily_hours alter column regular_dollars drop not null;
alter table daily_hours alter column regular_dollars drop default;

-- Already nullable. The default is dropped for the same reason as the rest.
alter table daily_hours alter column pay_rate        drop default;


-- =====================================================================
-- §2  THE COLUMN COMMENTS — because the next person will find rows with
-- dollars and rows without and need to know which is the bug.
-- =====================================================================

comment on column daily_hours.pay_rate is
  'HISTORICAL. The rate BBSI keyed by hand into Timenet, carried by the daily '
  'file up to 2026-08-22. Never a source of truth and no longer imported: rows '
  'from that date on are NULL. The rate every figure in this system is computed '
  'from is employees.wage, typed on Salaries & Wages and recorded in wage_history.';

comment on column daily_hours.total_earnings is
  'HISTORICAL. The payroll system''s own blended figure, up to 2026-08-22. '
  'Derived from a pay rate nobody maintains, so it is no longer imported and '
  'nothing reads it — rows from that date on are NULL. Earnings are computed '
  'from employees.wage and these hours; see netlify/functions/pay-rules-lib.js.';

comment on column daily_hours.ot_dollars is
  'HISTORICAL, and NULL from 2026-08-22. Was the residual '
  '(total_earnings - regular_hours * pay_rate), which inherited California''s '
  '1.5x/2.0x tiers for free. Now computed from employees.wage by '
  'pay-rules-lib.dayPay, which models those tiers explicitly.';

comment on column daily_hours.regular_dollars is
  'HISTORICAL, and NULL from 2026-08-22. Was regular_hours * pay_rate.';

comment on column daily_hours.regular_hours is
  'The file''s, and unchanged by the 2026-08-22 hours-only change. Hours are '
  'what this feed is for.';

comment on column daily_hours.ot_hours is
  'The file''s, and unchanged by the 2026-08-22 hours-only change. The file '
  'decides HOW MANY hours are overtime; pay-rules-lib decides what tier each '
  'one is paid at.';


-- =====================================================================
-- §3  VERIFY. Run this AFTER §1 — and again after the first hours-only
-- import, when the second query becomes the interesting one.
--
-- A SELECT rather than a RAISE NOTICE: the Supabase SQL editor does not
-- surface notices, so a check written that way looks like it passed
-- whatever it found.
-- =====================================================================

-- Expected: is_nullable = YES and column_default = NULL for all four.
select column_name, is_nullable, column_default
from information_schema.columns
where table_schema='public' and table_name='daily_hours'
  and column_name in ('pay_rate','total_earnings','ot_dollars','regular_dollars')
order by column_name;

-- Where the boundary fell. Before the hours-only deploy every row has money
-- and rows_without_money is 0; after it, the newest work dates are the ones
-- with none, and last_day_with_money should be the last day the old importer
-- ran.
--
-- The last column is not an error condition — a row with no money and no
-- hours is somebody who was in the file and did not work, which is ordinary.
-- It is here so that a sudden jump in it is visible, because that shape is
-- also what a file that parsed into empty rows would produce.
--
-- total_hours is NOT NULL and stays that way, so it is compared to 0 rather
-- than to NULL. Hours are the one thing the feed still carries.
select
  count(*)                                                     as rows_total,
  count(*) filter (where total_earnings is not null)           as rows_with_money,
  count(*) filter (where total_earnings is null)               as rows_without_money,
  max(work_date) filter (where total_earnings is not null)     as last_day_with_money,
  min(work_date) filter (where total_earnings is null)         as first_day_without_money,
  count(*) filter (where total_earnings is null and total_hours = 0) as rows_with_neither
from daily_hours;
