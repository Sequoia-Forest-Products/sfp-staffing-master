-- =====================================================================
-- NOT YET APPLIED. Run in the STAFFING project (zwghbbyzrycpnesuuzgi) ONLY.
--
-- Walk it one section at a time. §0 and §1 are READ-ONLY and tell you
-- exactly what §2 will change — including which weeks' reported figures
-- move. Do not run §2 until you have looked at §1.
-- =====================================================================
-- SFP Staffing — remove the vendor's system accounts and their hours
--
-- WHAT THESE ARE. Four rows in the BBSI daily export are not employees of
-- this mill. Three are BBSI staff accounts and one is the Timenet
-- administrative account for the site. All four are named with a `zSFP-`
-- prefix, a sort trick that pushes them to the bottom of a name-ordered
-- list. Confirmed by Peter Stroble, 2026-09-08.
--
--   amatthews       zSFP - Matthews, April
--   knance          zSFP- Nance, Korrina
--   rweatherford    zSFP- Weatherford, Rachel
--   admin           zSFP-user, zSFP-admin
--
-- WHY THIS MATTERS MORE THAN IT LOOKS. Their hours are in daily_hours and
-- therefore in the OT report's total hours AND its headcount, which is
-- computed as the distinct people in the imported rows. Every weekly
-- report covering those days has been counting them, and so has every
-- Monday manager email already sent.
--
-- They contributed no DOLLARS — none has a rate, and every dollar is
-- computed at report time from employees.wage — so no cost figure moves.
-- Hours and headcount do.
--
-- THE CODE CHANGE CAME FIRST. payroll-lib.NON_EMPLOYEE_NUMBERS now drops
-- these four at parse time, so no NEW rows arrive. This migration is only
-- about the rows already stored.
--
-- ---------------------------------------------------------------------
-- §0  What is there  (READ-ONLY)
-- ---------------------------------------------------------------------
-- Expect four accounts. If one returns nothing, say so before continuing
-- rather than assuming it never worked — a typo'd id would look identical.
select
  employee_number,
  min(first_name || ' ' || last_name) as name_in_file,
  count(*)                            as rows_stored,
  round(sum(total_hours)::numeric, 2) as hours,
  round(sum(ot_hours)::numeric, 2)    as ot_hours,
  min(work_date)                      as first_day,
  max(work_date)                      as last_day,
  count(*) filter (where pay_rate is not null
                      or total_earnings is not null
                      or ot_dollars is not null) as rows_with_money
from daily_hours
where lower(trim(employee_number)) in ('amatthews','knance','rweatherford','admin')
group by employee_number
order by employee_number;

-- Anything ELSE named like a system account that this list does not cover.
-- Expect zero rows. A hit here is a fifth account and must be resolved
-- before §2 — deleting four while a fifth keeps arriving fixes nothing.
select distinct employee_number, first_name, last_name
from daily_hours
where (first_name ilike 'zsfp%' or last_name ilike 'zsfp%')
  and lower(trim(employee_number)) not in ('amatthews','knance','rweatherford','admin')
order by employee_number;

-- ---------------------------------------------------------------------
-- §1  Which weeks change, and by how much  (READ-ONLY)
-- ---------------------------------------------------------------------
-- THE POINT OF THIS SECTION. Deleting the rows changes figures that have
-- already been reported. This is the list of weeks whose OT report and
-- manager email will not match what was sent at the time. Keep the output:
-- it is the only record of what those reports used to say.
with victims as (
  select *
  from daily_hours
  where lower(trim(employee_number)) in ('amatthews','knance','rweatherford','admin')
),
weeks as (
  select
    date_trunc('week', work_date)::date as week_start,
    count(*)                            as rows_removed,
    round(sum(total_hours)::numeric, 2) as hours_removed,
    count(distinct employee_number)     as people_removed
  from victims
  group by 1
)
select
  w.week_start,
  w.rows_removed,
  w.hours_removed,
  w.people_removed,
  -- The week as it stands today, and as it will read afterwards.
  round(t.hours_before::numeric, 2)                      as week_hours_before,
  round((t.hours_before - w.hours_removed)::numeric, 2)  as week_hours_after,
  t.people_before,
  t.people_before - w.people_removed                     as people_after
from weeks w
join lateral (
  select sum(d.total_hours)               as hours_before,
         count(distinct d.employee_number) as people_before
  from daily_hours d
  where date_trunc('week', d.work_date)::date = w.week_start
) t on true
order by w.week_start;

-- ---------------------------------------------------------------------
-- §2  Delete  (WRITES — do not run until §0 and §1 are read)
-- ---------------------------------------------------------------------
-- daily_hours has no foreign key to employees, so this touches nothing
-- else. It is keyed on the same lowercased list the code uses, so the two
-- cannot disagree about who is being removed.
--
-- Deliberately NOT `where last_name ilike 'zsfp%'`. The whole design of
-- the code change is that the name prefix DETECTS and never MATCHES —
-- matching on it would delete a real employee whose surname started that
-- way, silently, with no way to tell afterwards. §0's second query is
-- where a name-based hit gets looked at by a person.
delete from daily_hours
where lower(trim(employee_number)) in ('amatthews','knance','rweatherford','admin');

-- The roster rows, if the old auto-create made any. Separate statement so
-- a zero here is informative rather than hidden inside the count above.
-- employees has cascades (allocations, preapproved_ot), which is correct:
-- a system account has no legitimate allocation.
delete from employees
where lower(trim(employee_number)) in ('amatthews','knance','rweatherford','admin');

-- Their setup tasks, which are now answered: the answer is "not a person".
delete from employee_setup_tasks
where lower(trim(employee_number)) in ('amatthews','knance','rweatherford','admin');

-- ---------------------------------------------------------------------
-- §3  Verify  (READ-ONLY)
-- ---------------------------------------------------------------------
-- Expect 0, 0, 0 on the first query and zero rows on the second.
select
  (select count(*) from daily_hours
    where lower(trim(employee_number)) in ('amatthews','knance','rweatherford','admin')) as hours_left,
  (select count(*) from employees
    where lower(trim(employee_number)) in ('amatthews','knance','rweatherford','admin')) as roster_left,
  (select count(*) from employee_setup_tasks
    where lower(trim(employee_number)) in ('amatthews','knance','rweatherford','admin')) as tasks_left;

-- Nothing named like a system account survives anywhere in the hours.
select distinct employee_number, first_name, last_name
from daily_hours
where first_name ilike 'zsfp%' or last_name ilike 'zsfp%';

-- And the roster count, to compare against what you expect.
select count(*) as roster_total from employees;
