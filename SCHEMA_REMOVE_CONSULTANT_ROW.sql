-- =====================================================================
-- SFP Staffing — remove Howard Hoffman from `employees`
-- Run in the STAFFING project (zwghbbyzrycpnesuuzgi) ONLY.
--
-- WHY. He is a consultant. He has never been an employee, has no hours,
-- no wage history and nothing attached to his record — and since Phase A
-- he has been a false positive in every audit that asks a reasonable
-- question about the roster: "salaried with no annual_salary", "salaried
-- with no hire_date". Every future audit surfaces him again, and each
-- time somebody has to remember why he is not a finding.
--
-- WHY NOT A CONSULTANT FLAG. A new pay_type value or a boolean would
-- have to be understood by isSalaried() in three places (wage-sync.js,
-- ot-report-lib.js, core.js), by effectiveHourlyRate, by the costing
-- filter and by the roster UI — a schema change and six code paths, for
-- one person who should not be in a table called `employees`.
--
-- WHAT COULD GO WRONG, and §1 is how we find out first. Four tables
-- reference employees(id), and they do NOT agree about what a delete
-- means:
--
--   employee_allocations.employee_id   ON DELETE CASCADE
--   preapproved_ot.employee_id         ON DELETE CASCADE
--   employee_setup_tasks.employee_id   ON DELETE CASCADE
--   wage_history.employee_id           ON DELETE SET NULL
--   economics.employee_id              ON DELETE SET NULL
--
-- So nothing will BLOCK this delete — but three of those would silently
-- take rows with him, and two would silently blank a link. If he has any
-- of them, the premise "nothing is attached to his record" is wrong and
-- this should stop rather than cascade. §1 is read-only and answers that
-- before §2 runs.
--
-- daily_hours is deliberately absent from that list: it is keyed by
-- employee_number as TEXT with no foreign key, so his rows (if any)
-- would survive the delete rather than be removed by it. §1 counts them
-- too, for the same reason.
-- =====================================================================


-- =====================================================================
-- §1  PREFLIGHT. Read-only. Run this FIRST and read every number.
--
-- Expected, if the premise holds:
--   matched_rows            1
--   allocations             0
--   preapproved_ot          0
--   setup_tasks             0
--   wage_history            0
--   economics_seats         0
--   daily_hours_rows        0
--   roster_total            74
--
-- ANY non-zero in the middle six means STOP. Do not run §2 — say what
-- came back instead. A cascade that quietly removes his allocation or
-- his pre-approved OT is a different change from deleting an empty row,
-- and it is not the change that was agreed.
-- =====================================================================

do $$
declare found integer;
begin
  select count(*) into found from information_schema.tables
   where table_schema='public' and table_name in ('employees','overtime','daily_hours');
  if found < 3 then
    raise exception
      E'WRONG PROJECT.\n\nSwitch to the project named sfp-staffing (ref zwghbbyzrycpnesuuzgi).';
  end if;
end $$;

with him as (
  select id, employee_number from employees where name = 'Howard Hoffman'
)
select
  (select count(*) from him)                                                   as matched_rows,
  (select count(*) from employee_allocations a  join him on a.employee_id = him.id) as allocations,
  (select count(*) from preapproved_ot p        join him on p.employee_id = him.id) as preapproved_ot,
  (select count(*) from employee_setup_tasks t  join him on t.employee_id = him.id) as setup_tasks,
  (select count(*) from wage_history w          join him on w.employee_id = him.id) as wage_history,
  (select count(*) from economics e             join him on e.employee_id = him.id) as economics_seats,
  (select count(*) from daily_hours d           join him on d.employee_number = him.employee_number) as daily_hours_rows,
  (select count(*) from employees)                                             as roster_total;

-- Him, in full, so the row being deleted is looked at before it is
-- deleted rather than trusted to be the one we mean. Two people could
-- share a name; the count above is 1, and this is what that 1 is.
select id, name, employee_number, pay_type, status, department, cost_class,
       position, position_group, wage, annual_salary, hire_date, created_at
from employees where name = 'Howard Hoffman';


-- =====================================================================
-- §2  THE DELETE. Run only if §1 came back as expected.
--
-- Matched on name, which is what identifies him — he has no employee
-- number the payroll system knows. The count in §1 is what makes that
-- safe: exactly one row answers to it.
-- =====================================================================

delete from employees where name = 'Howard Hoffman';

-- The Supabase SQL editor reports the affected row count for a DELETE.
-- It must say 1. If it says 0, §1 and §2 disagree about the spelling —
-- check for trailing whitespace with the §1 select above before trying
-- anything else. If it says more than 1, the row you read in §1 was not
-- the only one and this has removed somebody else too.


-- =====================================================================
-- §3  VERIFY. A SELECT, because the Supabase SQL editor does not surface
-- RAISE NOTICE — a check written that way looks like it passed whatever
-- it found.
--
-- Expected:
--   still_there   0
--   roster_total  73
-- =====================================================================

select
  (select count(*) from employees where name = 'Howard Hoffman') as still_there,
  (select count(*) from employees)                               as roster_total;
