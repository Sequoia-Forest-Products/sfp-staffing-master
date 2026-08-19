-- ============================================================================
-- Daily hours database + automated payroll email ingestion
--
-- Run this whole file in the Supabase SQL editor. It is idempotent — every
-- statement is guarded, so re-running it is safe.
--
-- Order matters: back-fill employees.department (Employees tab -> "Backfill
-- payroll fields") BEFORE importing any payroll data. daily_hours snapshots
-- the department at import time (see the comment on daily_hours.department),
-- so rows imported before the back-fill land with a null department and have
-- to be re-stamped afterwards.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. employees: payroll id + reporting department
-- ----------------------------------------------------------------------------

-- The payroll system id, distinct from employees.id (a UUID). TEXT, never
-- INTEGER: the live export delivers zero-padded four-character ids ('0319'),
-- and an integer column silently destroys the padding. An older
-- Hours-Analysis-Report export delivered the same ids unpadded ('319'), which
-- is why every comparison in code and in SQL goes through lpad(...,4,'0').
alter table employees add column if not exists employee_number text;

do $$
begin
  -- Older installs created this as INTEGER (see SCHEMA_CHANGES.sql). Convert
  -- in place and restore the padding that the integer type threw away.
  if exists (
    select 1 from information_schema.columns
    where table_name = 'employees' and column_name = 'employee_number'
      and data_type in ('integer', 'bigint', 'smallint', 'numeric')
  ) then
    alter table employees
      alter column employee_number type text
      using lpad(employee_number::text, 4, '0');
  end if;
end $$;

create unique index if not exists employees_employee_number_key
  on employees (employee_number)
  where employee_number is not null;

-- The reporting department for the OT report. Deliberately separate from the
-- existing employees.dept column, which carries a different, older taxonomy
-- (Sawmill / Filing Room / Log Yard / SG&A / ...). Nothing maps one onto the
-- other automatically: department is set explicitly, per employee.
alter table employees add column if not exists department text;

-- Guarded through pg_constraint rather than information_schema: a CHECK
-- constraint's appearance in information_schema views depends on the current
-- role's privileges, so a re-run under a different role could try to add it
-- twice and fail.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'employees_department_check'
      and conrelid = 'employees'::regclass
  ) then
    alter table employees add constraint employees_department_check
      check (department in ('Maintenance', 'Saw Filing', 'Shipping', 'Production'));
  end if;
end $$;


-- ----------------------------------------------------------------------------
-- 2. daily_hours — one row per employee per work day
-- ----------------------------------------------------------------------------

create table if not exists daily_hours (
  id uuid primary key default gen_random_uuid(),
  work_date date not null,
  employee_number text not null,          -- zero-padded, e.g. '0319'
  last_name text,
  first_name text,
  is_salary boolean not null default false,
  pay_rate numeric(10,2),
  regular_hours numeric(10,2) not null default 0,
  ot_hours numeric(10,2) not null default 0,
  total_hours numeric(10,2) not null default 0,

  -- The payroll system's own blended figure (regular + OT dollars in one
  -- number). Stored verbatim and never recomputed — it is the source of truth
  -- for payroll dollars.
  total_earnings numeric(12,2) not null default 0,

  -- Derived at import, never by the database. ot_dollars is the residual
  -- (total_earnings - regular_hours * pay_rate), not ot_hours * rate * 1.5:
  -- California 4x10 pays 1.5x from 10-12 hours and 2.0x above 12, and a flat
  -- 1.5x undercounts the double-time tier by ~3%.
  ot_dollars numeric(12,2) not null default 0,
  regular_dollars numeric(12,2) not null default 0,

  -- true Mon-Thu (the scheduled 4x10 week), false Fri/Sat/Sun. Weekend work is
  -- legitimate and expected — maintenance crews work weekends — so this
  -- classifies rather than rejects.
  is_scheduled_day boolean generated always as (
    extract(isodow from work_date) between 1 and 4
  ) stored,

  -- Department SNAPSHOT, copied from employees at import time. Reports read
  -- this column and never join live to employees: people transfer between
  -- departments, and a live join would silently rewrite every historical
  -- report the day somebody moves.
  department text,

  source text not null default 'manual',  -- 'manual' | 'email'
  source_subject text,                    -- raw email subject, for audit
  email_received_at timestamptz,          -- raw received timestamp; work_date is derived from it
  file_hash text,                         -- SHA-256 of the source .xlsx, for duplicate detection
  date_source text not null default 'manual',  -- 'manual' | 'email_received' — flags inferred dates

  -- Import-time findings for this row: 'negative_residual',
  -- 'salaried_with_hours', 'unknown_employee', 'missing_department', ...
  flags text[] not null default '{}',

  upload_batch_id uuid not null,
  created_at timestamptz not null default now(),

  -- Deliberate: makes a re-send or a double-forward of the same day idempotent.
  -- Imports upsert on this key, so a corrected re-send overwrites cleanly.
  unique (work_date, employee_number)
);

create index if not exists daily_hours_work_date_idx        on daily_hours (work_date);
create index if not exists daily_hours_employee_number_idx  on daily_hours (employee_number);
create index if not exists daily_hours_batch_idx            on daily_hours (upload_batch_id);
create index if not exists daily_hours_file_hash_idx        on daily_hours (file_hash);
create index if not exists daily_hours_department_idx       on daily_hours (department);

-- Columns added after the first release land here so an existing install
-- picks them up without a table drop.
alter table daily_hours add column if not exists flags text[] not null default '{}';
alter table daily_hours add column if not exists date_source text not null default 'manual';
alter table daily_hours add column if not exists file_hash text;
alter table daily_hours add column if not exists email_received_at timestamptz;
alter table daily_hours add column if not exists source_subject text;
alter table daily_hours add column if not exists department text;


-- ----------------------------------------------------------------------------
-- 3. processed_emails — ingestion ledger
-- ----------------------------------------------------------------------------
--
-- Processing state lives here, never in the mailbox. The Gmail filter on
-- info@ marks these messages read on arrival, so read/unread carries no
-- information; and info@ is a shared human inbox, so the ingester must not
-- write to it at all (no flag, move, archive, or delete).
--
-- Keyed by the RFC822 Message-ID, which is stable across reconnects, unlike
-- the IMAP UID.

create table if not exists processed_emails (
  message_id text primary key,
  processed_at timestamptz not null default now(),
  work_date date,
  -- 'imported' | 'duplicate_file' | 'duplicate_day' | 'pending_review'
  -- | 'rejected' | 'error'
  status text not null,
  error text,
  subject text,
  from_address text,
  received_at timestamptz,
  file_hash text,
  upload_batch_id uuid,
  rows_imported integer not null default 0,
  flags text[] not null default '{}',
  notified_at timestamptz
);

create index if not exists processed_emails_work_date_idx on processed_emails (work_date);
create index if not exists processed_emails_status_idx    on processed_emails (status);
create index if not exists processed_emails_hash_idx      on processed_emails (file_hash);


-- ----------------------------------------------------------------------------
-- 4. Audit queries — run these after the back-fill, before trusting a report
-- ----------------------------------------------------------------------------

-- 4a. Employees still missing a payroll id or a department. Both must be
--     filled in before any import, or those rows snapshot a null department.
-- select name, dept, employee_number, department
-- from employees
-- where status = 'Active' and (employee_number is null or department is null)
-- order by name;

-- 4b. Imported rows whose employee_number matches nobody on the roster.
-- select d.work_date, d.employee_number, d.last_name, d.first_name
-- from daily_hours d
-- where not exists (
--   select 1 from employees e
--   where lpad(e.employee_number, 4, '0') = lpad(d.employee_number, 4, '0')
-- )
-- order by d.work_date desc, d.employee_number;

-- 4c. Imported rows carrying no department. These show as "Unassigned" on the
--     report. Fix employees.department, then re-stamp from the Daily Hours tab.
-- select work_date, employee_number, last_name, first_name
-- from daily_hours where department is null
-- order by work_date desc;

-- 4d. Every row an import flagged. negative_residual below -$1.00 means the
--     payroll system's Total Earnings and Regular x Pay Rate genuinely disagree.
-- select work_date, employee_number, last_name, flags,
--        pay_rate, regular_hours, ot_hours, total_earnings, regular_dollars, ot_dollars
-- from daily_hours where flags <> '{}' order by work_date desc;

-- 4e. Two different days that imported the identical file — a vendor re-send
--     that landed under the wrong inferred date. Should return zero rows.
-- select file_hash, count(distinct work_date) as days,
--        array_agg(distinct work_date order by work_date) as dates
-- from daily_hours where file_hash is not null
-- group by file_hash having count(distinct work_date) > 1;

-- 4f. Scheduled work days (Mon-Thu) in the last 30 days with no data at all.
--     Every one of these is a missed delivery.
-- select d::date as missing_day
-- from generate_series(current_date - 30, current_date - 1, '1 day') d
-- where extract(isodow from d) between 1 and 4
--   and not exists (select 1 from daily_hours where work_date = d::date)
-- order by missing_day;
