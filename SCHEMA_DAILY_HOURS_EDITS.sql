-- =====================================================================
-- SFP Staffing — daily_hours_edits: the audit trail for hand corrections
-- Run in the STAFFING project (zwghbbyzrycpnesuuzgi) ONLY.
--
-- WHY
--
-- The payroll file is the record of hours, but it is sometimes wrong in a
-- way only a person can fix: a missed clock-out arrives as a 24-hour day
-- (10 regular + 14 OT, next day 0). The OT Report now lets anyone on the
-- access list correct a day in place. daily_hours keeps only the current
-- figure, so every correction writes one row here with what it was, what
-- it became, who changed it and why. Nothing is ever updated or deleted
-- here: the trail is append-only.
--
-- A later re-import of the same day (a corrected file from BBSI) upserts
-- daily_hours on (work_date, employee_number) and overwrites a hand edit.
-- That is intended — the file is the record — and this table still shows
-- the edit happened.
--
-- RLS on with no policies, like every table in public: the service key in
-- the Netlify functions is the only reader and writer.
-- =====================================================================

create table if not exists public.daily_hours_edits (
  id                     uuid primary key default gen_random_uuid(),
  daily_hours_id         uuid,
  work_date              date not null,
  employee_number        text not null,
  employee_name          text,
  previous_regular_hours numeric(6,2),
  previous_ot_hours      numeric(6,2),
  previous_total_hours   numeric(6,2),
  new_regular_hours      numeric(6,2) not null,
  new_ot_hours           numeric(6,2) not null,
  new_total_hours        numeric(6,2) not null,
  note                   text,
  edited_by              text not null,
  edited_at              timestamptz not null default now()
);

create index if not exists daily_hours_edits_day_idx
  on public.daily_hours_edits (work_date, employee_number);

alter table public.daily_hours_edits enable row level security;

-- Verify: one table, RLS on, zero policies.
-- select relrowsecurity from pg_class where relname = 'daily_hours_edits';
-- select count(*) from pg_policies where tablename = 'daily_hours_edits';
