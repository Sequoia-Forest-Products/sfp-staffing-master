-- =====================================================================
-- SFP Staffing — timeclock reconciliation: replace-on-reimport, held rows,
-- day status, BBSI-staff exclusions, and alerts.
-- Run in the STAFFING project (zwghbbyzrycpnesuuzgi) ONLY. Idempotent.
--
-- WHY
-- The October payroll reconciliation found the daily figures ~$37,600 short
-- over 9/28-10/25: new hires missing from the TimeNet report, and open punches
-- frozen at 0.00 by a once-a-day snapshot. BBSI is now sending (a) a daily file
-- covering every Active TimeNet employee — salaried and BBSI staff included —
-- and (b) a weekly file with punch corrections applied.
--
-- That needs four things this schema did not have:
--
--   1. A day that is imported again is REPLACED, atomically. replace_hours()
--      deletes and re-inserts every covered date inside one transaction, so a
--      failure leaves the previous figures exactly as they were and a success
--      leaves no row from the old file behind.
--   2. Rows that must be STORED but never COUNTED live in daily_hours_held,
--      not daily_hours: salaried staff, BBSI staff, and employee numbers the
--      roster does not know. Every reader of daily_hours — cost report, OT
--      report, Monday email, week index — therefore stays correct without
--      learning a new filter. A held 'unknown' row moves into daily_hours when
--      its number is added to the roster as hourly.
--   3. hours_imports records every import (daily, weekly or manual), with the
--      file's received time and row counts; hours_days says whether a day is
--      provisional (daily file only) or reconciled (weekly file applied).
--   4. alerts — one table, deduplicated on (type, alert_key) while open.
--
-- RLS is enabled with ZERO policies on every table, like the rest of public:
-- the service key in the Netlify functions is the only reader and writer.
-- replace_hours() is revoked from public/anon/authenticated for the same
-- reason — a function in public is executable by PUBLIC by default, which would
-- otherwise be a door through the RLS wall over PostgREST /rpc.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Every import, whatever its source.
-- ---------------------------------------------------------------------
create table if not exists public.hours_imports (
  id                uuid primary key default gen_random_uuid(),
  source            text not null check (source in ('daily', 'weekly', 'manual')),
  work_date_from    date not null,
  work_date_to      date not null,
  file_received_at  timestamptz,
  message_id        text,
  file_hash         text,
  subject           text,
  rows_counted      integer not null default 0,
  rows_held         integer not null default 0,
  rows_replaced     integer not null default 0,
  created_by        text,
  created_at        timestamptz not null default now(),
  -- The reconciliation summary for a weekly import: per day and per employee,
  -- hours and dollars before and after, and the zero-hour rows that became
  -- non-zero. Null for daily and manual imports.
  variance          jsonb,
  check (work_date_to >= work_date_from)
);
create index if not exists hours_imports_range_idx on public.hours_imports (work_date_from, work_date_to);
alter table public.hours_imports enable row level security;

-- ---------------------------------------------------------------------
-- 2. A day's status. provisional = daily file only; reconciled = the weekly
--    file has been applied. Absent = nothing imported for that date.
-- ---------------------------------------------------------------------
create table if not exists public.hours_days (
  work_date       date primary key,
  status          text not null check (status in ('provisional', 'reconciled')),
  last_import_id  uuid references public.hours_imports(id) on delete set null,
  reconciled_at   timestamptz,
  updated_at      timestamptz not null default now()
);
alter table public.hours_days enable row level security;

-- Days imported before this table existed were all single snapshots.
insert into public.hours_days (work_date, status)
select distinct work_date, 'provisional' from public.daily_hours
on conflict (work_date) do nothing;

-- ---------------------------------------------------------------------
-- 3. Stored, not counted.
-- ---------------------------------------------------------------------
create table if not exists public.daily_hours_held (
  id               uuid primary key default gen_random_uuid(),
  work_date        date not null,
  employee_number  text not null,
  last_name        text,
  first_name       text,
  is_salary        boolean not null default false,
  regular_hours    numeric(10,2) not null default 0,
  ot_hours         numeric(10,2) not null default 0,
  total_hours      numeric(10,2) not null default 0,
  -- salaried: on the roster (or flagged in the file) as salaried
  -- external: a BBSI staff number listed in timeclock_exclusions
  -- unknown:  not on the roster at all — raises a New employee alert
  reason           text not null check (reason in ('salaried', 'external', 'unknown')),
  import_id        uuid references public.hours_imports(id) on delete set null,
  created_at       timestamptz not null default now(),
  unique (work_date, employee_number)
);
create index if not exists daily_hours_held_reason_idx on public.daily_hours_held (reason, employee_number);
alter table public.daily_hours_held enable row level security;

-- ---------------------------------------------------------------------
-- 4. TimeNet numbers that are not SFP employees (BBSI staff). Listing a
--    number here is a decision a person makes from the Alerts tab; nothing
--    is ever added automatically.
-- ---------------------------------------------------------------------
create table if not exists public.timeclock_exclusions (
  employee_number  text primary key,
  reason           text not null default 'bbsi_staff' check (reason in ('bbsi_staff')),
  name             text,
  note             text,
  created_by       text,
  created_at       timestamptz not null default now()
);
alter table public.timeclock_exclusions enable row level security;

-- ---------------------------------------------------------------------
-- 5. Alerts.
-- ---------------------------------------------------------------------
create table if not exists public.alerts (
  id               uuid primary key default gen_random_uuid(),
  type             text not null check (type in (
                     'new_employee', 'daily_file_missing', 'weekly_file_missing',
                     'thin_day', 'zero_hour_rows', 'active_no_hours', 'weekly_variance')),
  -- What makes two alerts "the same condition": the date, the employee
  -- number, the week. Unique among open/acknowledged alerts of one type.
  alert_key        text not null,
  severity         text not null check (severity in ('info', 'warning', 'critical')),
  work_date        date,
  employee_number  text,
  title            text not null,
  details          jsonb not null default '{}'::jsonb,
  status           text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  acknowledged_at  timestamptz,
  acknowledged_by  text,
  resolved_at      timestamptz,
  resolved_reason  text
);
create unique index if not exists alerts_one_live_per_condition
  on public.alerts (type, alert_key) where status in ('open', 'acknowledged');
create index if not exists alerts_status_idx on public.alerts (status, created_at desc);
alter table public.alerts enable row level security;

-- ---------------------------------------------------------------------
-- 6. The replace path. One transaction: record the import, delete every
--    covered date from both row tables, insert the new rows, stamp the days.
--
--    p_import  jsonb  {source, work_date_from, work_date_to, file_received_at,
--                      message_id, file_hash, subject, created_by, variance}
--    p_dates   date[] every date the file covers — INCLUDING dates on which it
--                     carries no rows, so a day that was wrong and is now empty
--                     really is emptied
--    p_rows    jsonb  daily_hours rows (counted)
--    p_held    jsonb  daily_hours_held rows (stored, not counted)
--
--    A daily import never overwrites a reconciled day: the weekly file has
--    punch corrections the snapshot does not, so letting a later daily
--    "replace" it would undo the reconciliation. That raises, and the caller
--    parks the file for a person.
-- ---------------------------------------------------------------------
create or replace function public.replace_hours(
  p_import jsonb, p_dates date[], p_rows jsonb, p_held jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_import  uuid;
  v_source  text := p_import->>'source';
  v_removed integer;
  v_removed_held integer;
  v_counted integer;
  v_held    integer;
begin
  if p_dates is null or array_length(p_dates, 1) is null then
    raise exception 'replace_hours: no dates given';
  end if;
  if v_source = 'daily' and exists (
       select 1 from hours_days where work_date = any(p_dates) and status = 'reconciled') then
    raise exception 'replace_hours: a daily file cannot replace a reconciled day (%)',
      (select string_agg(work_date::text, ', ') from hours_days
        where work_date = any(p_dates) and status = 'reconciled');
  end if;

  insert into hours_imports (source, work_date_from, work_date_to, file_received_at,
                             message_id, file_hash, subject, created_by, variance)
  values (v_source,
          (select min(d) from unnest(p_dates) d),
          (select max(d) from unnest(p_dates) d),
          nullif(p_import->>'file_received_at', '')::timestamptz,
          p_import->>'message_id', p_import->>'file_hash', p_import->>'subject',
          p_import->>'created_by', p_import->'variance')
  returning id into v_import;

  delete from daily_hours where work_date = any(p_dates);
  get diagnostics v_removed = row_count;
  delete from daily_hours_held where work_date = any(p_dates);
  get diagnostics v_removed_held = row_count;

  insert into daily_hours (work_date, employee_number, last_name, first_name, is_salary,
                           pay_rate, regular_hours, ot_hours, total_hours, total_earnings,
                           ot_dollars, regular_dollars, department, source, source_subject,
                           email_received_at, file_hash, date_source, flags, upload_batch_id)
  select r.work_date, r.employee_number, r.last_name, r.first_name, coalesce(r.is_salary, false),
         r.pay_rate, coalesce(r.regular_hours, 0), coalesce(r.ot_hours, 0), coalesce(r.total_hours, 0),
         r.total_earnings, r.ot_dollars, r.regular_dollars, r.department,
         coalesce(r.source, 'manual'), r.source_subject, r.email_received_at, r.file_hash,
         coalesce(r.date_source, 'manual'), coalesce(r.flags, '{}'), v_import
  from jsonb_populate_recordset(null::daily_hours, coalesce(p_rows, '[]'::jsonb)) r;
  get diagnostics v_counted = row_count;

  insert into daily_hours_held (work_date, employee_number, last_name, first_name, is_salary,
                                regular_hours, ot_hours, total_hours, reason, import_id)
  select h.work_date, h.employee_number, h.last_name, h.first_name, coalesce(h.is_salary, false),
         coalesce(h.regular_hours, 0), coalesce(h.ot_hours, 0), coalesce(h.total_hours, 0),
         h.reason, v_import
  from jsonb_populate_recordset(null::daily_hours_held, coalesce(p_held, '[]'::jsonb)) h;
  get diagnostics v_held = row_count;

  update hours_imports
     set rows_counted = v_counted, rows_held = v_held, rows_replaced = v_removed + v_removed_held
   where id = v_import;

  insert into hours_days (work_date, status, last_import_id, reconciled_at, updated_at)
  select d,
         case when v_source = 'weekly' then 'reconciled' else 'provisional' end,
         v_import,
         case when v_source = 'weekly' then now() end,
         now()
  from unnest(p_dates) d
  on conflict (work_date) do update
     set status = excluded.status,
         last_import_id = excluded.last_import_id,
         reconciled_at = excluded.reconciled_at,
         updated_at = now();

  return jsonb_build_object(
    'import_id', v_import, 'counted', v_counted, 'held', v_held,
    'replaced', v_removed, 'replaced_held', v_removed_held);
end;
$$;

revoke all on function public.replace_hours(jsonb, date[], jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.replace_hours(jsonb, date[], jsonb, jsonb) to service_role;

-- ---------------------------------------------------------------------
-- 7. Re-attribution: a held 'unknown' number has been added to the roster
--    as an hourly employee. Its held rows move into daily_hours, stamped with
--    the roster department, in one transaction. A date that already has a
--    counted row for the number is left alone (the held copy is dropped).
-- ---------------------------------------------------------------------
create or replace function public.reattribute_held(p_employee_number text, p_department text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_moved integer;
begin
  insert into daily_hours (work_date, employee_number, last_name, first_name, is_salary,
                           regular_hours, ot_hours, total_hours, department, source,
                           date_source, flags, upload_batch_id)
  select h.work_date, h.employee_number, h.last_name, h.first_name, false,
         h.regular_hours, h.ot_hours, h.total_hours, p_department, 'reattributed',
         'reattributed', array['reattributed_from_held'], coalesce(h.import_id, gen_random_uuid())
  from daily_hours_held h
  where h.employee_number = p_employee_number and h.reason = 'unknown'
  on conflict (work_date, employee_number) do nothing;
  get diagnostics v_moved = row_count;

  delete from daily_hours_held where employee_number = p_employee_number and reason = 'unknown';
  return v_moved;
end;
$$;

revoke all on function public.reattribute_held(text, text) from public, anon, authenticated;
grant execute on function public.reattribute_held(text, text) to service_role;

-- Verify: RLS on and zero policies on every new table.
-- select relname, relrowsecurity from pg_class
--  where relname in ('hours_imports','hours_days','daily_hours_held','timeclock_exclusions','alerts');
-- select count(*) from pg_policies
--  where tablename in ('hours_imports','hours_days','daily_hours_held','timeclock_exclusions','alerts');
