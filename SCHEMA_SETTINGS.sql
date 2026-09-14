-- ============================================================================
-- THE SETTINGS TABLE — 2026-09-15
-- ============================================================================
--
-- public.settings did not exist. Not dropped, not renamed: never created. Every
-- other table in this database arrived with a SCHEMA_*.sql file and this one
-- did not, so it was missing from the day the Settings tab shipped.
--
-- WHAT THAT BROKE, and why it took this long to notice:
--
--   THE WEEKLY MANAGER OT EMAIL has never sent. ot-weekly-email-lib.js reads
--   this table for the recipient list and the auto-send flag, and refuses the
--   whole run when it cannot — correctly, and it says so in the alert:
--   "the settings row could not be read: ... Could not find the table
--   'public.settings' in the schema cache". That alert is the only surface in
--   the system that ever complained.
--
--   NOTHING ON THE SETTINGS TAB COULD BE SAVED. A save POSTs /api/settings,
--   which inserts into this table and returns a 500.
--
--   EVERYTHING ELSE DEGRADED QUIETLY, which is the actual reason this ran for
--   months without being seen:
--     * /api/settings GET catches the missing-table error and answers
--       {data: null} with a 200, so the Settings tab renders its defaults and
--       looks entirely healthy.
--     * payroll-report.js falls back to DEFAULT_GRACE_HOURS when the read
--       fails, so every OT report has been computed at the documented default
--       of 0.5 hrs/employee/week and 10% OT budget — the right numbers, but
--       not because anybody chose them here.
--
-- So the figures on the reports were never wrong. What was wrong is that they
-- could not be changed, and that the one job which needed a real recipient list
-- could not run at all.
--
-- Run this once in the Supabase SQL editor. It is additive and idempotent.

-- ----------------------------------------------------------------------------
-- 1. THE TABLE
-- ----------------------------------------------------------------------------
--
-- Shape taken from the code that already reads and writes it, not invented:
--
--   id          settings.js updates by id (db.update sends ?id=eq.<id>), so the
--               primary key is named id and is a uuid, matching every other
--               table in this database.
--   key         settings.js filters on ?key=eq.<key>. UNIQUE because the app
--               treats a key as naming at most one row: it reads rows[0] and
--               decides insert-or-update on whether the lookup found anything.
--               Without the constraint a double-submit silently creates a
--               second row and the reader starts answering from whichever
--               PostgREST returns first.
--   value       jsonb, and it has to tolerate TWO shapes of the same content.
--               settings.js inserts the raw object and updates with
--               JSON.stringify(...), so a row written by an insert holds a JSON
--               object and one written by an update holds a JSON string. Every
--               reader already copes — parseSettingsValue in core.js,
--               graceHoursFromSettingsRow in payroll-report.js and
--               managersFromSettingsRow in send-ot-email.js each accept either
--               — so this column must not be typed in a way that refuses one of
--               them. jsonb accepts both; text would refuse the insert.
--   updated_at  settings.js sets it explicitly on every update.
--
-- The insert/update asymmetry is a wart, documented here because the column
-- type depends on it. Fixing it is a code change, not a schema change, and
-- doing it here would break the rows the current code writes.
create table if not exists public.settings (
  id         uuid primary key default gen_random_uuid(),
  key        text not null unique,
  value      jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 2. ROW LEVEL SECURITY — on, with no policies, exactly like every neighbour
-- ----------------------------------------------------------------------------
--
-- Enabled with NO policies is not an oversight and not a half-finished job: it
-- is how every table in this database is configured (employees, points,
-- overtime, preapproved_ot, employee_allocations — all RLS on, zero policies).
--
-- The browser never talks to PostgREST. It talks to Netlify functions, which
-- hold SUPABASE_SERVICE_KEY and bypass RLS; the anon and authenticated roles
-- are never used against this project. So RLS on with no policies means "no
-- path except the service key", which is the intended access model stated
-- structurally rather than relied upon.
--
-- This matters more here than on most tables. settings.emailSettings.managers
-- is the recipient list for a report carrying every hourly employee's pay — the
-- /api/settings write gate is admin-only for exactly that reason, and this is
-- the layer underneath it.
alter table public.settings enable row level security;

-- ----------------------------------------------------------------------------
-- 3. THE emailSettings ROW
-- ----------------------------------------------------------------------------
--
-- Seeded with the defaults the app already falls back to, so the stored state
-- and the displayed state agree from the start. An absent row and a row holding
-- the defaults are indistinguishable to every reader — the difference is that
-- one of them can be looked at.
--
-- MANAGERS IS DELIBERATELY EMPTY and autoSend is deliberately false. Guessing a
-- recipient list for a report that carries per-person pay is not a thing a
-- migration should do; both are set on the Settings tab, which works the moment
-- this table exists. Until they are, the Monday job refuses with "auto-send is
-- off" — a decision, rather than the error it has been refusing with.
--
-- ON CONFLICT DO NOTHING so a re-run cannot flatten a configured list back to
-- the defaults.
insert into public.settings (key, value)
values ('emailSettings', jsonb_build_object(
  'managers', jsonb_build_array(),
  'autoSend', false,
  'otBudgetPercent', 10,
  'graceHoursPerEmployee', 0.5
))
on conflict (key) do nothing;

-- ----------------------------------------------------------------------------
-- 4. VERIFY
-- ----------------------------------------------------------------------------
--
-- Expect one row, and the four keys the app reads. If `value` comes back as a
-- quoted string rather than an object after somebody saves on the Settings tab,
-- that is the insert/update asymmetry in section 1 and is expected — the
-- readers handle it.
select key,
       jsonb_typeof(value)                       as value_shape,
       value -> 'managers'                       as managers,
       value -> 'autoSend'                       as auto_send,
       value -> 'otBudgetPercent'                as ot_budget_percent,
       value -> 'graceHoursPerEmployee'          as grace_hours,
       updated_at
from public.settings
order by key;

-- The RLS posture, asserted rather than assumed. Expect rls = true, policies = 0.
select c.relrowsecurity as rls_enabled,
       (select count(*) from pg_policies p where p.schemaname='public' and p.tablename='settings') as policies
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'settings';
