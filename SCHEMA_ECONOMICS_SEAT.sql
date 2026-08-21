-- =====================================================================
-- SFP Staffing — rename economics.position to economics.seat
-- Run in the STAFFING project (zwghbbyzrycpnesuuzgi) ONLY.
--
-- WHY. Two columns share a name and mean different things:
--
--   employees.position   a person's JOB TITLE.      'Millwright', 'Debarker'
--   economics.position   a numbered SEAT in the     'Millwright 1',
--                        staffing plan.             'Utility 1'..'Utility 7'
--
-- Same vocabulary, different concept. employees.position is authoritative
-- for what somebody does; economics.position is a budgeted headcount slot
-- that may or may not be filled. Anyone reading a query that joins the two
-- has to know which is which from context, and eventually will not.
--
-- THERE IS NO DEPLOY ORDERING PROBLEM. Nothing reads this column, and
-- nothing reads this table. Verified across the whole repository:
--
--   * src/js/economics.js was DELETED in d3ab59a (Phase C). It was the only
--     reader of the column.
--   * `economics` is not in ALLOWED_TABLES in netlify/functions/data.js, so
--     /api/data refuses it on every method including PUT.
--   * No Netlify function references the table.
--   * economics.js is not in session.js's SCRIPT_MODULES.
--   * Every remaining mention in .js is a comment or a test ASSERTING that
--     nothing reads it.
--
-- So the column can be renamed at any time, in any order relative to any
-- deploy, with no window in which code and schema disagree — because no
-- code refers to it in either state.
--
-- WHAT CAN STILL BREAK is database-side. ALTER TABLE ... RENAME COLUMN
-- updates views, indexes, constraints and defaults automatically, because
-- Postgres tracks those dependencies by object id rather than by name. It
-- does NOT update a plpgsql function body: those are strings, parsed when
-- the function runs, so a function mentioning economics.position keeps the
-- old name and fails at call time rather than at rename time. §0b looks
-- for exactly that.
-- =====================================================================


-- =====================================================================
-- §0a  PREFLIGHT — right project, and the column is where we think.
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

-- Expected: position = 1, seat = 0, and a row count for the table.
select
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='economics' and column_name='position') as has_position_expect_1,
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='economics' and column_name='seat')     as has_seat_expect_0,
  (select count(*) from economics)                                                     as economics_rows,
  (select count(*) from economics where position is not null and btrim(position)<>'')  as seats_named;


-- =====================================================================
-- §0b  DATABASE-SIDE DEPENDENCIES — the only thing that can break.
--
-- Anything here has to be dealt with before §1. Expected: NO ROWS.
--
-- Views, indexes, constraints and defaults are deliberately NOT listed:
-- Postgres tracks those by object id and rewrites them itself during the
-- rename. What it cannot rewrite is a name embedded in a function body,
-- because that is a string until the function is called.
-- =====================================================================

select 'function or procedure' as kind, p.proname as name,
       pg_get_functiondef(p.oid) as definition
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and pg_get_functiondef(p.oid) ilike '%economics%'
union all
select 'row level security policy', pol.polname,
       pg_get_expr(pol.polqual, pol.polrelid)
from pg_policy pol
join pg_class c on c.oid = pol.polrelid
where c.relname = 'economics'
union all
select 'trigger', t.tgname, pg_get_triggerdef(t.oid)
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
where c.relname = 'economics' and not t.tgisinternal
union all
-- Listed for information rather than as a blocker: these DO follow the
-- rename automatically. Seeing them makes §2's verification meaningful.
select 'view (will follow the rename)', c.relname, pg_get_viewdef(c.oid)
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('v','m')
  and pg_get_viewdef(c.oid) ilike '%economics%';


-- =====================================================================
-- §1  THE RENAME
--
-- One statement. Instant and transactional: it rewrites a catalog entry,
-- not the table's data, so there is no row-by-row work and no window where
-- half the rows have moved.
--
-- Run §0a and §0b first.
-- =====================================================================

-- alter table economics rename column position to seat;

-- comment on column economics.seat is
--   'A numbered seat in the staffing plan (Millwright 1, Utility 3), NOT a '
--   'person''s job title — that is employees.position. Renamed from '
--   '`position` because the two shared a name and did not share a meaning.';


-- =====================================================================
-- §2  VERIFY
-- =====================================================================

-- 2a. The column moved and nothing else did. Expected: position 0, seat 1,
--     and the same row count and same non-blank count as §0a reported.
select
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='economics' and column_name='position') as has_position_expect_0,
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='economics' and column_name='seat')     as has_seat_expect_1,
  (select count(*) from economics)                                                     as economics_rows,
  (select count(*) from economics where seat is not null and btrim(seat)<>'')          as seats_named;

-- 2b. The DATA is untouched — a rename must not have reordered or altered
--     anything. Spot-check the seats that gave this rename its reason:
--     numbered slots whose base title is also a real job title.
--     Expected: Millwright 1..5 and Utility 1..7, unchanged.
select num, section, seat, name, max_wage
from economics
where seat ~* '^(millwright|utility)'
order by seat;

-- 2c. Nothing in the database still refers to the old name. Expected: NO ROWS.
select 'function' as kind, p.proname as name
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname='public' and pg_get_functiondef(p.oid) ilike '%economics%position%'
union all
select 'view', c.relname
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname='public' and c.relkind in ('v','m')
  and pg_get_viewdef(c.oid) ilike '%position%'
  and pg_get_viewdef(c.oid) ilike '%economics%';


-- =====================================================================
-- §3  ROLLBACK, if §2 finds anything
-- =====================================================================

-- alter table economics rename column seat to position;
