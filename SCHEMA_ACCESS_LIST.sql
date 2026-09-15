-- SFP Staffing — collapse the three permission tiers into ONE ACCESS LIST
--
-- Run it once, in the Supabase SQL editor, section at a time. Sections 1 and 7
-- are read-only.
--
-- ========================================================================
-- WHAT THIS DOES
-- ========================================================================
--
-- Phase D (SCHEMA_PHASE_D_PERMISSIONS.sql) built three tiers — an implicit
-- `hourly_wages` base, plus `salaries` and `admin` — because anybody with a
-- sequoiafp.com Google account could sign in. The tiers were the only thing
-- standing between the whole company and employees.annual_salary.
--
-- That premise is gone. Sign-in is an explicit list now, so a second mechanism
-- deciding what you may see once you are in is answering a question nobody
-- asked: the list already said yes.
--
-- AFTER THIS, ONE LIST. Being on it means everything — sign in, every column,
-- every setting, the list itself, and the weekly OT email. There are no roles.
--
-- ========================================================================
-- WHAT IT COSTS, STATED PLAINLY
-- ========================================================================
--
--   * Eduardo Rivera is salaried in Manufacturing and his annual_salary IS
--     held — Staffing Economics prices his seat from it. Everyone on the list
--     can now see and edit it.
--   * Everyone on the list can add and remove anyone, including themselves.
--     The app refuses to remove the LAST entry, because an empty list locks
--     every account out and nothing inside the app could put one back. That is
--     enforced in netlify/functions/permissions.js, not here — see §4 for why
--     the database-side trigger goes.
--   * Removing somebody takes effect when their session expires, within 8
--     hours. Sessions are checked at sign-in, not per request.
--
-- ========================================================================
-- THE TABLE IS NOT REPLACED
-- ========================================================================
--
-- `user_permissions` keeps its name, its rows and its columns. `tier` stays
-- NOT NULL and keeps holding something; nothing reads it. This is additive on
-- purpose: the migration is reversible by restoring the CHECK and the trigger,
-- and the existing rows stay legible as a record of who held what.

-- ------------------------------------------------------------------------
-- 1. BEFORE  (read-only — keep this output)
-- ------------------------------------------------------------------------

select email, tier, granted_by, granted_at
  from user_permissions
 order by email, tier;

-- Expect 5 rows / 3 people:
--   peter.stroble@sequoiafp.com   admin, salaries
--   ryley.stanley@sequoiafp.com   admin, salaries
--   jeffrey.cook@sequoiafp.com    salaries

-- And the OTHER list this merges in — the OT email recipients:
select value from settings where key = 'emailSettings';

-- Expect 6 addresses. NOTE THE SPELLING, it is the reason two lists is one
-- list too many:
--   tony.griffith@sequoiafp.com
--   travis.vance@sequoiafp.com
--   peter.stroble@sequoiafp.com
--   jefrey.cook@sequoiafp.com     <-- ONE f. user_permissions has jeffrey.cook
--                                     with two. Nothing in the app could ever
--                                     have noticed those are not the same
--                                     person, and one of them has been wrong
--                                     for as long as both lists existed.
--   cyle.coburn@sequoiafp.com
--   eduardo.rivera@sequoiafp.com

-- ------------------------------------------------------------------------
-- 2. WIDEN THE tier CHECK
-- ------------------------------------------------------------------------
--
-- It currently allows only ('salaries', 'admin'). New rows are written with
-- 'access', and the old values stay valid so nothing existing has to move.

alter table user_permissions
  drop constraint if exists user_permissions_tier_check;

alter table user_permissions
  add constraint user_permissions_tier_check
  check (tier in ('access', 'salaries', 'admin'));

-- ------------------------------------------------------------------------
-- 3. SEED THE LIST — the UNION of both lists
-- ------------------------------------------------------------------------
--
-- THIS ALSO RESTORES RYLEY. The app was deployed before this file was run, and
-- in that window the CHECK in §2 refused every INSERT while refusing no DELETE
-- — so the list could only shrink. ryley.stanley@sequoiafp.com was removed on
-- 2026-09-15 and could not be added back. The seed below puts him in.
--
-- The app no longer allows that state: permissions.js now holds BOTH writes
-- until this migration has run. See migrationPending() in permissions-lib.js.
--
-- Anybody who held a grant, plus anybody who was receiving the weekly email.
-- Taking either one alone would silently drop people: the grant list alone
-- unsubscribes four managers from the report, and the recipient list alone
-- locks Ryley out of the app.
--
-- jefrey.cook@ (one f) IS DELIBERATELY NOT SEEDED. jeffrey.cook@ (two f's) is
-- in the union already, from user_permissions, and seeding both would put one
-- person on the list twice under two addresses — with one of them being an
-- address that may not receive mail at all. If the one-f spelling turns out to
-- be the real one, add it on the Settings tab and remove the other; that is a
-- 30-second job and it is better done by somebody who knows which is right
-- than guessed at here.

insert into user_permissions (email, tier, granted_by, note) values
  ('peter.stroble@sequoiafp.com',  'access', 'access-list-migration', 'held admin + salaries'),
  ('ryley.stanley@sequoiafp.com',  'access', 'access-list-migration', 'held admin + salaries'),
  ('jeffrey.cook@sequoiafp.com',   'access', 'access-list-migration', 'held salaries'),
  ('tony.griffith@sequoiafp.com',  'access', 'access-list-migration', 'OT email recipient'),
  ('travis.vance@sequoiafp.com',   'access', 'access-list-migration', 'OT email recipient'),
  ('cyle.coburn@sequoiafp.com',    'access', 'access-list-migration', 'OT email recipient'),
  ('eduardo.rivera@sequoiafp.com', 'access', 'access-list-migration', 'OT email recipient')
on conflict (email, tier) do nothing;

-- ------------------------------------------------------------------------
-- 4. DROP THE LAST-ADMIN TRIGGER
-- ------------------------------------------------------------------------
--
-- It refused the removal of the last row with tier='admin'. There is no admin
-- any more, so it now guards a condition that means nothing — and worse, it
-- would refuse a perfectly ordinary removal of Peter or Ryley while letting the
-- list be emptied of everybody else.
--
-- The guard that replaces it is in the API (permissions.js): the last ENTRY,
-- whatever its tier, cannot be removed. It lives there rather than here because
-- the app needs to return a sentence somebody can act on, and a plpgsql
-- exception arrives wrapped in PostgREST's envelope.
--
-- THAT IS A REAL LOSS AND IT IS WORTH NAMING: the database will no longer stop
-- a hand-written DELETE from emptying the table. If that happens, sign-in falls
-- back to the ALLOWED_DOMAIN rule (see auth.js) rather than locking everybody
-- out — which is exactly why that fallback exists.

drop trigger if exists user_permissions_keep_an_admin on user_permissions;
drop trigger if exists user_permissions_keep_an_admin_truncate on user_permissions;
drop function if exists refuse_last_admin_removal();

-- ------------------------------------------------------------------------
-- 5. RETIRE THE OLD TIER ROWS  (optional, and deliberately last)
-- ------------------------------------------------------------------------
--
-- Nothing reads `tier`, so the old rows are harmless — resolveAccessList()
-- deduplicates by email and Peter's two rows read as one entry. Removing them
-- makes the table one row per person, which is easier to read in Studio.
--
-- Left COMMENTED because it is not needed and because running it before §3 has
-- been verified would drop the grant rows the seed was derived from. Run §7
-- first, confirm the list, then uncomment if you want the tidy-up.

-- delete from user_permissions where tier in ('salaries', 'admin');

-- ------------------------------------------------------------------------
-- 6. THE OLD RECIPIENT LIST STAYS IN settings
-- ------------------------------------------------------------------------
--
-- emailSettings.managers is no longer written by anything and is read only by
-- send-ot-email.js, as a FALLBACK for a week where the access list cannot be
-- reached. Sending the weekly per-person dollars to nobody is worse than
-- sending them to the list that was correct yesterday, so it is kept rather
-- than cleared. Do not edit it; it is a snapshot, not a setting.

-- ------------------------------------------------------------------------
-- 7. AFTER  (read-only)
-- ------------------------------------------------------------------------

select email,
       string_agg(tier, ', ' order by tier) as tiers,
       count(*)                             as rows
  from user_permissions
 group by email
 order by email;

-- Expect 7 people. peter.stroble and ryley.stanley show three tiers each
-- (access, admin, salaries) until §5 is run; everybody else shows one.

select count(distinct email) as people_with_access,   -- expect 7
       count(*)              as rows_total            -- expect 12
  from user_permissions;

-- And the triggers are gone:
select count(*) as triggers_expect_0
  from pg_trigger t
 where t.tgrelid = 'user_permissions'::regclass and not t.tgisinternal;
