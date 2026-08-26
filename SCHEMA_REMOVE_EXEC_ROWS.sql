-- =====================================================================
-- APPLIED 2026-08-26 to zwghbbyzrycpnesuuzgi (sfp-staffing).
-- 3 rows deleted. still_there 0, roster_total 70 (73 before).
--
-- THE RECORD OF WHAT WAS DELETED. There is no undo and no backup of
-- these rows anywhere else in this repository, so the business fields
-- are written down here. Contact details (phone, birthday, the text_bolt
-- address) were in the deleted rows and are deliberately NOT copied into
-- version control — they are in the session output that produced this
-- delete, which is where they should stay.
--
--   Jeff Cook
--     id             d0d2f2b8-e588-481b-911f-04f197baa063
--     email          jeffrey.cook@sequoiafp.com
--     position       President
--     department     Sales & Marketing      cost_class  SG&A
--     annual_salary  375,000                pay_type    Salaried
--
--   Peter Stroble
--     id             8c917e7a-e79c-4647-a82f-56b3b3d0128a
--     email          peter.stroble@sequoiafp.com
--     position       CEO
--     department     Corporate              cost_class  SG&A
--     annual_salary  375,000                pay_type    Salaried
--
--   Ryley Stanley
--     id             375baa00-a703-480d-9c31-96c9210fa151
--     email          ryley.stanley@sequoiafp.com
--     position       CFO
--     department     Accounting             cost_class  SG&A
--     annual_salary  250,000                pay_type    Salaried
--
-- All three: status Active, days MON-THU, breaks 07:00 / 12:45, no
-- employee_number, no hire_date, wage NULL. Created 2026-07-08.
--
-- ------------------------------------------------------------------
-- WHAT WAS LOST WITHOUT BEING RECORDED
-- ------------------------------------------------------------------
--
-- JEFF COOK'S TWO ALLOCATION ROWS. §1's third query — the one that would
-- have printed their exact departments and percentages — was not run
-- before §2, and ON DELETE CASCADE removed them. Their contents are now
-- unrecoverable from this database.
--
-- The best available reconstruction is section 8 of the architecture
-- document, which states the split as 50% Corporate / 50% Sales. His
-- primary department here was 'Sales & Marketing', so the second half
-- most likely pointed at that. TREAT THOSE PERCENTAGES AS A RECOLLECTION,
-- NOT A RECORD — if the allocation is ever re-created, confirm the split
-- with a person rather than with this comment.
--
-- Nothing else was attached: preapproved_ot, employee_setup_tasks,
-- wage_history and economics_seats were all 0 for all three.
-- =====================================================================
-- SFP Staffing — remove Jeff Cook, Peter Stroble and Ryley Stanley
-- from `employees`
-- Run in the STAFFING project (zwghbbyzrycpnesuuzgi) ONLY.
--
-- WHY. Executive compensation is not managed in this app and should not
-- be visible in it. Confidentiality, decided 2026-08-26. Removing the
-- rows is what makes that true everywhere at once — the Salaries & Wages
-- page, the roster payload, the costing reports and any future screen —
-- rather than hiding them on one page while /api/data keeps sending the
-- figures to every browser holding the salaries tier.
--
-- ------------------------------------------------------------------
-- WHAT THIS COSTS, AND IT IS NOT SMALL
-- ------------------------------------------------------------------
--
-- $1,000,000 OF ANNUAL COMPENSATION LEAVES THE COST REPORTS.
--
--   Jeff Cook       375,000
--   Peter Stroble   375,000
--   Ryley Stanley   250,000
--
-- Their cost is currently counted in Mill Overhead / SG&A at
-- annual_salary / 2,080 x standard hours. After this it is not counted
-- anywhere. Overhead and SG&A figures drop, cost-per-thousand improves,
-- and month-end accruals change — for every period, including closed
-- ones, because the reports recompute from the live roster rather than
-- from a snapshot.
--
-- That is a REPORTING CHANGE, not just a roster edit, and anybody
-- comparing this month against last month will see a discontinuity that
-- has nothing to do with the mill. It is recorded here because the
-- reports themselves will not explain it.
--
-- JEFF COOK'S ALLOCATION IS DESTROYED. He carries 2 employee_allocations
-- rows — the 50% Corporate / 50% Sales split from section 8 of the
-- architecture. employee_allocations.employee_id is ON DELETE CASCADE,
-- so both rows go with him silently and nothing anywhere records that
-- the split existed. If the split ever needs reconstructing, it is in
-- the architecture document and in this comment, and nowhere else.
--
-- ------------------------------------------------------------------
-- WHAT IS NOT AFFECTED
-- ------------------------------------------------------------------
--
--   * THEIR APP ACCESS. user_permissions is keyed by EMAIL, not by
--     employee id. Peter and Ryley keep every tier they hold, including
--     admin. Deleting an employees row does not sign anybody out.
--   * WAGE HISTORY. wage_history.employee_id is ON DELETE SET NULL, so
--     any rows survive with the link blanked. All three have none.
--   * DAILY HOURS. All three are salaried and were never in that feed.
--
-- ------------------------------------------------------------------
-- IF THIS EVER NEEDS UNDOING
-- ------------------------------------------------------------------
--
-- There is no undo. These rows carry a name, a salary, a department, a
-- cost class and a position, and §1 below prints all of it before §2
-- removes it — so the record of what was deleted is the output of §1,
-- which should be kept with this file. Re-creating them later means a
-- new id, so any future reference by id is broken permanently.
--
-- The reversible alternative was marking them Inactive: as of the
-- 2026-08-26 page change the Salaries & Wages list shows active
-- employees only, so that would have removed them from the screen while
-- keeping the cost reports correct. It was considered and declined —
-- inactive rows are still in the roster payload, and the requirement was
-- confidentiality rather than tidiness.
-- =====================================================================


-- =====================================================================
-- §1  PREFLIGHT AND RECORD. Read-only. KEEP THIS OUTPUT.
--
-- Two queries. The first is the reference counts; the second is the full
-- content of the rows, which is the only record of them that will exist
-- after §2.
--
-- Expected on the counts: 3 rows; allocations 2 for Jeff Cook and 0 for
-- the other two; every other count 0. ANYTHING ELSE MEANS STOP — a
-- non-zero preapproved_ot, setup_task or economics_seat is a reference
-- this change has not accounted for.
-- =====================================================================

do $$
declare found integer;
begin
  select count(*) into found from information_schema.tables
   where table_schema='public' and table_name in ('employees','daily_hours','wage_history');
  if found < 3 then
    raise exception
      E'WRONG PROJECT.\n\nSwitch to sfp-staffing (ref zwghbbyzrycpnesuuzgi).';
  end if;
end $$;

with them as (
  select id, name, annual_salary from employees
   where name in ('Jeff Cook','Ryley Stanley','Peter Stroble')
)
select t.name, t.annual_salary,
  (select count(*) from employee_allocations a where a.employee_id = t.id) as allocations,
  (select count(*) from preapproved_ot p       where p.employee_id = t.id) as preapproved_ot,
  (select count(*) from employee_setup_tasks s where s.employee_id = t.id) as setup_tasks,
  (select count(*) from wage_history w         where w.employee_id = t.id) as wage_history,
  (select count(*) from economics e            where e.employee_id = t.id) as economics_seats
from them t order by t.name;

-- The rows themselves, and Jeff's allocation, in full. This is the
-- record. Save it somewhere that is not this database.
select * from employees where name in ('Jeff Cook','Ryley Stanley','Peter Stroble') order by name;

select a.*, e.name
from employee_allocations a
join employees e on e.id = a.employee_id
where e.name in ('Jeff Cook','Ryley Stanley','Peter Stroble')
order by e.name, a.department;


-- =====================================================================
-- §2  THE DELETE. Run only after §1's output is saved.
--
-- Matched on name. §1 establishes that exactly one row answers to each,
-- which is what makes that safe.
-- =====================================================================

delete from employees where name in ('Jeff Cook','Ryley Stanley','Peter Stroble');

-- The editor must report 3 rows affected. Fewer means a name did not
-- match — check for trailing whitespace with §1's second query rather
-- than reaching for a LIKE. More means a name is shared with somebody
-- this change did not intend to remove, and somebody else has just been
-- deleted too.


-- =====================================================================
-- §3  VERIFY. A SELECT, because the Supabase SQL editor does not surface
-- RAISE NOTICE.
--
-- Expected:
--   still_there          0
--   roster_total         70   (73 after the Howard Hoffman delete)
--   orphaned_allocations 0    (Jeff's two cascaded)
-- =====================================================================

select
  (select count(*) from employees
    where name in ('Jeff Cook','Ryley Stanley','Peter Stroble'))            as still_there,
  (select count(*) from employees)                                          as roster_total,
  (select count(*) from employee_allocations a
    where not exists (select 1 from employees e where e.id = a.employee_id)) as orphaned_allocations;
