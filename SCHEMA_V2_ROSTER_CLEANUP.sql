-- =====================================================================
-- SFP Staffing — Roster cleanup to the v2 model  (CORRECTED, MERGED)
--
-- Run in the STAFFING project (zwghbbyzrycpnesuuzgi) ONLY.
-- Confirm the project name in the top-left before running anything.
--
-- Supersedes the draft cleanup script and
-- SCHEMA_V2_CLEANUP_CORRECTIONS.sql. Run this file instead of either.
--
-- Order is not arbitrary. §1 proves the name patterns are safe before
-- anything writes by name; §4 sets pay_type and the wage sentinel
-- together so §6 cannot activate somebody into the miscount. Do not
-- reorder.
--
-- Every UPDATE is inside a row-count guard. If a statement touches a
-- different number of rows than you expect, it raises and rolls itself
-- back rather than quietly mis-setting a person. Set each `expected`
-- from the SELECT above it.
-- =====================================================================


-- =====================================================================
-- §0  SNAPSHOT — run first, every time
--
-- Distinctly named per run. `create table if not exists` would silently
-- keep an older snapshot while the count below reported it as current,
-- so a failure on run two would restore you to before run one.
-- =====================================================================

drop table if exists employees_cleanup_snapshot;
create table employees_cleanup_snapshot as
  select *, now() as snapshot_at from employees;

select count(*) as rows_snapshotted, max(snapshot_at) as taken_at
from employees_cleanup_snapshot;


-- =====================================================================
-- §1  PROVE THE NAME PATTERNS — read this before anything writes
--
-- Every write below matches on a name substring. This roster has
-- repeated and compound surnames (two Smiths, Acosta Ruiz, Salazar De
-- Leon, Sanchez Lopez), and '%vance%' also matches Advance and
-- Vancleave, '%cook%' matches Cooke and Cookson.
--
-- An unintended match is silent and expensive: it makes an active
-- hourly employee salaried, which drops them out of Staffing Economics,
-- removes their clock-grace allowance, and — once the wage sync ships —
-- permanently stops their rate updating from the daily file, because
-- salaried rows are skipped unconditionally.
--
-- ANY ROW BELOW WHERE matches <> 1 MEANS THAT PATTERN NEEDS NARROWING.
-- =====================================================================

select p.pattern,
       count(e.id) as matches,
       coalesce(string_agg(e.name || ' [' || e.status || ']', ', ' order by e.name),
                '(none — pattern matches nobody)') as who
from (values
        ('%griffith%'), ('%coburn%'), ('%vance%'), ('%rivera%'),
        ('%stroble%'), ('%jeff%cook%'), ('%bower%'), ('%coppini%'),
        ('%figas%'), ('%stanley%'), ('%axeri%')
     ) as p(pattern)
left join employees e on e.name ilike p.pattern
group by p.pattern
order by matches desc, p.pattern;


-- =====================================================================
-- §2  Axeri Ramirez — off the retired SG&A department value
--
-- SG&A is a COST CLASS in v2, not a department. Her real treatment is a
-- three-way split (1/3 HR / 1/3 Corporate / 1/3 Accounting), but the
-- allocation table does not exist yet, so she carries one primary
-- department in the interim. Accounting.
--
-- When allocations are built the split supplements this; it does not
-- replace it. Accounting stays her primary.
--
-- She is HOURLY, so her hours keep flowing in and the OT report will
-- show an Accounting department row. That is correct — labor spend
-- includes hourly SG&A staff even though manufacturing cost does not.
-- =====================================================================

select name, status, dept, department, cost_class, pay_type, wage
from employees where name ilike '%axeri%';

-- do $$
-- declare n integer; expected integer := 1;
-- begin
--   update employees
--      set department = 'Accounting',
--          cost_class = 'SG&A'
--    where name ilike '%axeri%' and status = 'Active';
--   get diagnostics n = row_count;
--   if n <> expected then
--     raise exception 'Axeri: expected % row(s), updated % — rolled back.', expected, n;
--   end if;
-- end $$;


-- =====================================================================
-- §3  cost_class for the active production roster
--
-- Every active employee except Axeri sits on a manufacturing
-- department, so cost_class follows from department here. This is a
-- one-time back-fill of a known-correct state, NOT a rule — the two
-- columns stay independently settable, and nothing derives one from the
-- other in code.
--
-- The ten salaried people are still Inactive at this point, so this
-- does not touch them. That is why §3 runs before §6.
-- =====================================================================

-- Expect these to sum to 56 (57 active, minus Axeri):
select department, count(*) as employees
from employees
where status = 'Active'
  and department in ('Production','Maintenance','Shipping',
                     'Saw Filing','Log Yard','Clean-up')
group by department order by count(*) desc;

-- Anyone active who this will NOT reach — should be Axeri alone:
select name, department, cost_class
from employees
where status = 'Active'
  and (department is null
       or department not in ('Production','Maintenance','Shipping',
                             'Saw Filing','Log Yard','Clean-up'));

-- do $$
-- declare n integer; expected integer := 56;   -- <<< from the sum above
-- begin
--   update employees
--      set cost_class = 'Manufacturing'
--    where status = 'Active'
--      and department in ('Production','Maintenance','Shipping',
--                         'Saw Filing','Log Yard','Clean-up');
--   get diagnostics n = row_count;
--   if n <> expected then
--     raise exception 'Production cost_class: expected %, updated % — rolled back.', expected, n;
--   end if;
-- end $$;


-- =====================================================================
-- §4  THE SALARIED ROSTER — pay_type AND the wage sentinel, together
--
-- This is the section the draft got wrong, and it is the one that
-- matters most.
--
-- The draft set wage = 'Salary' for only four people (Griffith, Coburn,
-- Vance, Rivera) and set nothing at all on pay_type or wage for the
-- other six. Migration section 5b had already cleared the 'Salary'
-- marker out of wage for everyone who held it, and the DEPLOYED code
-- still decides who is salaried by reading wage — so activating those
-- six in §6 would drop all of them into Staffing Economics as
-- unassigned hourly employees and add 0.5 hrs each to the clock-grace
-- headcount: 3 hrs a week of pre-approved OT that does not exist.
--
-- It also outlives the deploy. Where 5b saw a NUMBER in wage it set
-- pay_type = 'Hourly', and the pay_type-aware build would go on reading
-- those people as hourly. So pay_type has to be corrected too, not just
-- the sentinel.
--
-- Both are set here, in one statement, before anyone is activated.
--
-- The numeric wages on Griffith / Coburn / Vance / Rivera (0, 50, 45,
-- 45) are stale placeholders, not conversions. They are replaced by the
-- sentinel, and annual_salary stays NULL — a derived figure entered now
-- would be indistinguishable from a real one later.
-- =====================================================================

-- 4a. What does the database currently believe about these ten people?
--     `deployed_code_reads_as` is what app.html's isSalaried() returns
--     today. Every row should read 'salaried' when this section is done.
select
  name,
  status,
  pay_type,
  coalesce(wage, '(null)')  as wage,
  annual_salary,
  case when btrim(lower(coalesce(wage, ''))) = 'salary'
       then 'salaried' else 'HOURLY' end as deployed_code_reads_as
from employees
where name ilike any (array[
        '%griffith%','%coburn%','%vance%','%rivera%',
        '%stroble%','%jeff%cook%','%bower%','%coppini%','%figas%','%stanley%'])
order by status, name;

-- 4b. Confirm from 4a that all ten really are salaried before running
--     this. Anyone hourly must come out of the array — making an hourly
--     employee salaried is the failure mode described above.
--
-- do $$
-- declare n integer; expected integer := 10;   -- <<< from 4a
-- begin
--   update employees
--      set pay_type = 'Salaried',
--          wage     = 'Salary'   -- sentinel the deployed code reads.
--                                -- Cleared by SCHEMA_V2_HOTFIX_SENTINEL.sql
--                                -- step 2 once the pay_type build is live.
--    where name ilike any (array[
--            '%griffith%','%coburn%','%vance%','%rivera%',
--            '%stroble%','%jeff%cook%','%bower%','%coppini%','%figas%','%stanley%']);
--   get diagnostics n = row_count;
--   if n <> expected then
--     raise exception 'Salaried roster: expected %, updated % — rolled back. Re-read 4a.', expected, n;
--   end if;
-- end $$;

-- 4c. Re-run 4a. Every row must now read 'salaried'. If any says
--     HOURLY, stop — §6 would mis-activate them.


-- =====================================================================
-- §5  cost_class and department for the salaried roster
--
-- These people are still Inactive, so none of this changes what any
-- view shows yet. Activation is §6, deliberately separate.
--
-- Every value here is permitted by the transitional CHECK from
-- SCHEMA_V2_MODEL.sql. Note the deployed UI does not offer most of them
-- yet — see the closing note.
-- =====================================================================

select name, status, pay_type, dept, department, cost_class, position_group
from employees
where name ilike any (array[
        '%griffith%','%coburn%','%vance%','%rivera%',
        '%stroble%','%jeff%cook%','%bower%','%coppini%','%figas%','%stanley%'])
order by name;

-- Mill Overhead — salaried mill leadership. Real mill cost, not direct
-- manufacturing cost, which is why it is its own cost class.
-- do $$
-- declare n integer; expected integer := 3;
-- begin
--   update employees set cost_class = 'Mill Overhead', department = 'Mill Overhead'
--    where name ilike any (array['%griffith%','%coburn%','%vance%']);
--   get diagnostics n = row_count;
--   if n <> expected then raise exception 'Mill Overhead: expected %, got % — rolled back.', expected, n; end if;
-- end $$;

-- Eduardo — salaried, but his cost is manufacturing cost. The
-- salary/2080 conversion is keyed on cost_class = 'Manufacturing', so it
-- applies to him automatically once a salary exists. Until then he
-- appears at zero cost; see the closing note.
-- do $$
-- declare n integer; expected integer := 1;
-- begin
--   update employees set cost_class = 'Manufacturing', department = 'Production',
--          position_group = 'Supervisors'
--    where name ilike '%rivera%';
--   get diagnostics n = row_count;
--   if n <> expected then raise exception 'Rivera: expected %, got % — rolled back.', expected, n; end if;
-- end $$;

-- SG&A — five real departments under one cost class.
-- do $$
-- declare n integer;
-- begin
--   update employees set cost_class = 'SG&A', department = 'Corporate'
--    where name ilike '%stroble%';
--   get diagnostics n = row_count;
--   if n <> 1 then raise exception 'Stroble: expected 1, got % — rolled back.', n; end if;
--
--   update employees set cost_class = 'SG&A', department = 'Sales & Marketing'
--    where name ilike any (array['%jeff%cook%','%bower%','%coppini%']);
--   get diagnostics n = row_count;
--   if n <> 3 then raise exception 'Sales & Marketing: expected 3, got % — rolled back.', n; end if;
--
--   update employees set cost_class = 'SG&A', department = 'Procurement'
--    where name ilike '%figas%';
--   get diagnostics n = row_count;
--   if n <> 1 then raise exception 'Figas: expected 1, got % — rolled back.', n; end if;
--
--   update employees set cost_class = 'SG&A', department = 'Accounting'
--    where name ilike '%stanley%';
--   get diagnostics n = row_count;
--   if n <> 1 then raise exception 'Stanley: expected 1, got % — rolled back.', n; end if;
-- end $$;


-- =====================================================================
-- §6  ACTIVATION — your decision, run only when ready
--
-- The Overhead tab, the allocations, and Eduardo's inclusion in
-- Manufacturing Costs all need these people to exist as ACTIVE records.
-- None of it renders on Inactive rows.
--
-- DO NOT RUN THIS UNTIL 4c SHOWS ALL TEN READING 'salaried'. That check
-- is the entire guard: the deployed code reads wage, and activating
-- somebody whose wage is null or numeric puts them into Staffing
-- Economics and the grace headcount on a live app.
-- =====================================================================

-- Last look before the switch — expect 10 rows, all Inactive, all
-- pay_type Salaried, all wage 'Salary':
select name, status, pay_type, wage, cost_class, department
from employees
where name ilike any (array[
        '%griffith%','%coburn%','%vance%','%rivera%',
        '%stroble%','%jeff%cook%','%bower%','%coppini%','%figas%','%stanley%'])
order by name;

-- do $$
-- declare n integer; expected integer := 10;
-- begin
--   update employees set status = 'Active'
--    where name ilike any (array[
--            '%griffith%','%coburn%','%vance%','%rivera%',
--            '%stroble%','%jeff%cook%','%bower%','%coppini%','%figas%','%stanley%']);
--   get diagnostics n = row_count;
--   if n <> expected then raise exception 'Activation: expected %, got % — rolled back.', expected, n; end if;
-- end $$;


-- =====================================================================
-- §7  VERIFY — run after each section, and again at the end
-- =====================================================================

-- The shape of the roster. After §6: 67 active, and every active row
-- should have a cost_class.
select status, cost_class, pay_type, count(*)
from employees group by status, cost_class, pay_type
order by status, cost_class, pay_type;

-- Anything still on a retired department value. When this returns zero,
-- SCHEMA_V2_TIGHTEN_DEPARTMENTS.sql can cut the CHECK to twelve.
select name, status, department from employees
where department in ('SG&A','Non-Production');

-- No active employee should be here after §3 and §5:
select name, status, department from employees
where status = 'Active' and cost_class is null;

-- Nobody should read as hourly who is not:
select name, status, pay_type, coalesce(wage,'(null)') as wage
from employees
where pay_type = 'Salaried'
  and btrim(lower(coalesce(wage,''))) <> 'salary';

-- Remaining work: position_group on the production roster.
select department, count(*) as still_need_position_group
from employees
where status = 'Active' and position_group is null
group by department order by count(*) desc;

-- Salaried people with no salary on file. Expected until entered by
-- hand; each is a person whose cost cannot be computed.
select name, status, cost_class, annual_salary
from employees where pay_type = 'Salaried' and annual_salary is null
order by cost_class, name;


-- =====================================================================
-- CLOSING NOTES — no action, but know these
--
-- A. The deployed UI does not know most of these department values.
--    origin/main offers Maintenance, Saw Filing, Shipping, Production,
--    Log Yard, Non-Production — no Clean-up, no Mill Overhead, none of
--    the five SG&A departments. In the edit modal, a department that
--    matches no option leaves none selected, so the browser shows the
--    first one, "— not set —", while the database holds a real value.
--    It survives a save unless somebody touches that dropdown, and is
--    silently replaced if they do. Avoid editing these people in the
--    app until the branch is deployed.
--
-- B. Eduardo contributes nothing to Manufacturing Costs until a salary
--    is entered. effectiveHourlyRate returns no rate without an
--    annual_salary rather than inventing one, so he appears on the
--    manufacturing roster at zero cost. Intended, but the tab is
--    understated until the figure is typed in.
--
-- C. The wage sentinel is temporary. Once the pay_type-aware build is
--    live, run SCHEMA_V2_HOTFIX_SENTINEL.sql step 2 to clear it, and
--    wage means one thing again: an hourly rate, or nothing.
-- =====================================================================
