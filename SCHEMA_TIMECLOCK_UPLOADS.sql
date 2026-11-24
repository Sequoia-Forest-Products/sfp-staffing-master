-- =====================================================================
-- SFP Staffing — manual timeclock uploads: the weekly reconciliation file.
-- Run in the STAFFING project (zwghbbyzrycpnesuuzgi) ONLY. Idempotent.
--
-- WHY
-- BBSI's "Work Summary Payroll" report has no date in it. The daily and the
-- weekly versions have the same nine columns; only the period differs. The
-- email importer guessed each file's date from when the email arrived, and
-- that is how two Monday weekly files were stored as single days (11/15 and
-- 11/22). Uploads are now done by a person, who states what each file covers.
--
-- The weekly file is a CHECK, never a source of day rows. Its regular and
-- overtime hours are week totals per person, so it cannot say which day a
-- difference belongs to. It is stored here, per person, tied to its week, and
-- compared against the sum of that person's daily rows. Corrections come from
-- re-uploaded daily files.
--
-- weekly_hours was looked at and NOT reused: it is the deprecated
-- Hours-Analysis-Report table (per-day rows keyed on work_date, no total hours,
-- 1,742 rows from Jul–Aug 2026, written only by the retired ot-upload.js).
--
-- RLS is enabled with ZERO policies, like every table in public: the service
-- key in the Netlify functions is the only reader and writer.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. One row per week (Monday-Sunday) that has had a weekly file uploaded.
--    status:
--      open        the file is in and at least one person's daily sum differs
--      reconciled  every person's daily sum matches the file within 0.02 hrs
--      accepted    the remaining variances were accepted by a person, with a note
-- ---------------------------------------------------------------------
create table if not exists public.timeclock_weeks (
  week_start      date primary key,
  week_end        date not null,
  status          text not null default 'open' check (status in ('open', 'reconciled', 'accepted')),
  file_hash       text,
  file_name       text,
  uploaded_by     text,
  uploaded_at     timestamptz not null default now(),
  -- The latest comparison against the daily rows, re-run on every daily
  -- upload inside the week.
  comparison      jsonb,
  compared_at     timestamptz,
  reconciled_at   timestamptz,
  accepted_by     text,
  accepted_at     timestamptz,
  accept_note     text,
  -- What was accepted: the variance list at the moment of acceptance. A later
  -- daily upload that changes the variances re-opens the week.
  accepted_variances jsonb,
  updated_at      timestamptz not null default now(),
  check (extract(isodow from week_start) = 1),
  check (week_end = week_start + 6)
);
alter table public.timeclock_weeks enable row level security;

-- ---------------------------------------------------------------------
-- 2. The weekly file's rows: week totals per person. Never day rows.
-- ---------------------------------------------------------------------
create table if not exists public.timeclock_week_totals (
  week_start       date not null references public.timeclock_weeks(week_start) on delete cascade,
  employee_number  text not null,
  last_name        text,
  first_name       text,
  is_salary        boolean not null default false,
  pay_rate         numeric(10,2),
  regular_hours    numeric(10,2) not null default 0,
  ot_hours         numeric(10,2) not null default 0,
  total_hours      numeric(10,2) not null default 0,
  total_earnings   numeric(12,2),
  primary key (week_start, employee_number)
);
alter table public.timeclock_week_totals enable row level security;

-- ---------------------------------------------------------------------
-- 3. Replace a week's file in one transaction. Re-uploading the weekly file
--    for a week swaps every row; nothing is merged. Status and comparison are
--    reset — the caller re-runs the comparison straight after.
-- ---------------------------------------------------------------------
create or replace function public.replace_week_totals(p_week jsonb, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_start date := (p_week->>'week_start')::date;
  v_count integer;
begin
  if v_start is null or extract(isodow from v_start) <> 1 then
    raise exception 'replace_week_totals: week_start must be a Monday (got %)', p_week->>'week_start';
  end if;

  insert into timeclock_weeks (week_start, week_end, status, file_hash, file_name, uploaded_by, uploaded_at,
                               comparison, compared_at, reconciled_at, accepted_by, accepted_at,
                               accept_note, accepted_variances, updated_at)
  values (v_start, v_start + 6, 'open', p_week->>'file_hash', p_week->>'file_name',
          p_week->>'uploaded_by', now(), null, null, null, null, null, null, null, now())
  on conflict (week_start) do update
     set status = 'open', file_hash = excluded.file_hash, file_name = excluded.file_name,
         uploaded_by = excluded.uploaded_by, uploaded_at = now(),
         comparison = null, compared_at = null, reconciled_at = null,
         accepted_by = null, accepted_at = null, accept_note = null, accepted_variances = null,
         updated_at = now();

  delete from timeclock_week_totals where week_start = v_start;

  insert into timeclock_week_totals (week_start, employee_number, last_name, first_name, is_salary,
                                     pay_rate, regular_hours, ot_hours, total_hours, total_earnings)
  select v_start, r.employee_number, r.last_name, r.first_name, coalesce(r.is_salary, false),
         r.pay_rate, coalesce(r.regular_hours, 0), coalesce(r.ot_hours, 0), coalesce(r.total_hours, 0),
         r.total_earnings
  from jsonb_populate_recordset(null::timeclock_week_totals, coalesce(p_rows, '[]'::jsonb)) r;
  get diagnostics v_count = row_count;

  return jsonb_build_object('week_start', v_start, 'rows', v_count);
end;
$$;

revoke all on function public.replace_week_totals(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.replace_week_totals(jsonb, jsonb) to service_role;

-- ---------------------------------------------------------------------
-- 4. Alerts: the upload-schedule alerts replace the email-arrival ones.
--    daily_file_missing / weekly_file_missing stay in the list so their
--    resolved history remains valid rows.
-- ---------------------------------------------------------------------
alter table public.alerts drop constraint if exists alerts_type_check;
alter table public.alerts add constraint alerts_type_check check (type in (
  'new_employee', 'daily_file_missing', 'weekly_file_missing',
  'thin_day', 'zero_hour_rows', 'active_no_hours', 'weekly_variance',
  'daily_upload_missing', 'weekly_upload_missing', 'weekly_unreconciled'));

-- Verify: RLS on and zero policies on both new tables.
-- select relname, relrowsecurity from pg_class where relname in ('timeclock_weeks','timeclock_week_totals');
-- select count(*) from pg_policies where tablename in ('timeclock_weeks','timeclock_week_totals');
