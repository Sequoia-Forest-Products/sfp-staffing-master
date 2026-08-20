-- =====================================================================
-- Corrections to the roster cleanup script
--
-- Three things in the draft need changing before it runs. Everything
-- else in it is sound — §0's intent, §1, §2, and §6 are fine as
-- written apart from the snapshot note below.
-- =====================================================================


-- =====================================================================
-- CORRECTION 1 — §5 re-creates the salaried miscount for six people
--
-- §3 sets wage = 'Salary' for Griffith / Coburn / Vance / Rivera, so
-- the deployed code reads those four as salaried. §4 sets ONLY
-- cost_class and department for Stroble / Cook / Bower / Coppini /
-- Figas / Stanley — it never touches pay_type or wage.
--
-- Section 5b of the migration cleared the 'Salary' marker out of wage
-- for everyone who held it. So those six most likely have wage = NULL
-- right now, and the deployed code decides who is salaried by reading
-- wage (app.html isSalaried, and ot-report-lib line 649). Activating
-- them in §5 therefore drops all six into Staffing Economics as
-- unassigned hourly employees and adds them to the clock-grace
-- headcount at 0.5 hrs each — 3 hrs/week of pre-approved OT that does
-- not exist.
--
-- §5's own warning covers the case where wage holds a NUMBER. The
-- likelier state after 5b is wage IS NULL, which the warning misses.
--
-- This is not only a pre-deploy problem. If 5b read a number in their
-- wage it also set pay_type = 'Hourly', and that is wrong in the new
-- model too — so the pay_type-aware build would keep reading them as
-- hourly after the deploy. pay_type has to be corrected, not just the
-- sentinel.
-- =====================================================================

-- 1a. Look first. This is the question §4 never asks: what does the
--     database currently believe about these ten people?
select
  name,
  status,
  pay_type,
  coalesce(wage, '(null)')                                    as wage,
  annual_salary,
  case when btrim(lower(coalesce(wage, ''))) = 'salary'
       then 'salaried' else 'HOURLY' end                      as deployed_code_reads_as
from employees
where name ilike any (array[
        '%griffith%','%coburn%','%vance%','%rivera%',
        '%stroble%','%jeff%cook%','%bower%','%coppini%','%figas%','%stanley%'])
order by status, name;

-- 1b. Set pay_type AND the sentinel together, for everyone who is
--     genuinely salaried. Adjust the array to match what 1a showed —
--     do not assume all six SG&A people are salaried.
--
--     The row-count guard is the point: if the pattern matches a
--     different number of people than you expect, the whole thing
--     rolls back instead of quietly mis-setting somebody.
--
-- do $$
-- declare n integer; expected integer := 10;   -- <<< set to what 1a showed
-- begin
--   update employees
--      set pay_type = 'Salaried',
--          wage     = 'Salary'    -- sentinel; the deployed code reads it.
--                                 -- Remove after the pay_type build is live
--                                 -- (SCHEMA_V2_HOTFIX_SENTINEL.sql step 2).
--    where name ilike any (array[
--            '%griffith%','%coburn%','%vance%','%rivera%',
--            '%stroble%','%jeff%cook%','%bower%','%coppini%','%figas%','%stanley%']);
--
--   get diagnostics n = row_count;
--   if n <> expected then
--     raise exception 'Expected % rows, updated % — rolling back. Re-run 1a and fix the patterns.', expected, n;
--   end if;
-- end $$;


-- =====================================================================
-- CORRECTION 2 — the name patterns are too loose to run unguarded
--
-- §3, §4 and §5 match on substrings with no status filter (§1 has one;
-- the others do not) and no check on how many rows were hit.
--
-- '%vance%' also matches Advance, Vancleave, Vancouver. '%rivera%'
-- matches every Rivera on the roster, and this roster is known to
-- contain repeated surnames and compound surnames — Acosta Ruiz,
-- Salazar De Leon, Sanchez Lopez, two Smiths. '%cook%' matches Cooke
-- and Cookson; §4 correctly narrows that one to '%jeff%cook%' but §3
-- and §5 do not narrow theirs.
--
-- A single unintended match sets pay_type = 'Salaried' and wage =
-- 'Salary' on an active hourly employee. That removes them from
-- Staffing Economics, removes their grace allowance, and — once the
-- wage sync is deployed — permanently stops their rate updating from
-- the daily file, because salaried rows are skipped unconditionally.
-- Nothing would surface it.
-- =====================================================================

-- 2a. Prove the patterns are unique before trusting them. Any row where
--     n <> 1 is a pattern that needs narrowing.
select p.pattern, count(e.id) as matches,
       coalesce(string_agg(e.name || ' [' || e.status || ']', ', ' order by e.name), '(none)') as who
from (values
        ('%griffith%'),('%coburn%'),('%vance%'),('%rivera%'),
        ('%stroble%'),('%jeff%cook%'),('%bower%'),('%coppini%'),
        ('%figas%'),('%stanley%')
     ) as p(pattern)
left join employees e on e.name ilike p.pattern
group by p.pattern
order by matches desc, p.pattern;

-- 2b. Once 2a is clean, prefer employee_number or id over names for
--     anything that writes. A number does not become ambiguous when
--     somebody new is hired.
--     select id, employee_number, name from employees where name ilike '%rivera%';


-- =====================================================================
-- CORRECTION 3 — §0's snapshot silently does not refresh
--
-- `create table if not exists ... as select` does nothing on a second
-- run, and the count query underneath it then reports the FIRST run's
-- snapshot as though it were current. If a section goes wrong on run
-- two, the thing you restore from is a state that predates run one.
--
-- Take a distinctly-named snapshot per run instead.
-- =====================================================================

-- drop table if exists employees_pre_v2_cleanup_2;
-- create table employees_pre_v2_cleanup_2 as
--   select *, now() as snapshot_at from employees;
-- select count(*) as rows_snapshotted, max(snapshot_at) as taken_at
-- from employees_pre_v2_cleanup_2;


-- =====================================================================
-- NOT A CORRECTION — two things to know, no change needed
-- =====================================================================

-- A. The deployed UI does not know most of these department values.
--    origin/main's assignable list is Maintenance, Saw Filing,
--    Shipping, Production, Log Yard, Non-Production. It has no
--    Clean-up, no Mill Overhead, and none of the five SG&A
--    departments — those arrive with the branch that is not merged.
--
--    Consequence in the edit modal: when an employee's department
--    matches no option, none is marked selected, so the browser shows
--    the first one — "— not set —" — while the database holds a real
--    value. The value survives a save as long as nobody touches that
--    dropdown, and is silently replaced if they do. Worth not editing
--    those people in the app until the branch is deployed.

-- B. Eduardo contributes nothing to Manufacturing Costs until a salary
--    is entered. §3 leaves annual_salary NULL on purpose, and
--    effectiveHourlyRate returns {rate: null, source: 'none'} without
--    one — it never invents a figure. So he will appear on the
--    manufacturing roster at zero cost. That is the intended trade,
--    but it means the tab is understated until the number is typed in.
--    Audit query 8e in SCHEMA_V2_MODEL.sql lists exactly who is in
--    that state.
