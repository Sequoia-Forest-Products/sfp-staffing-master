-- =====================================================================
-- APPLIED 2026-09-09 against the STAFFING project (zwghbbyzrycpnesuuzgi).
--
-- WHAT §1 SAID. Two rows. The keeper, created 2026-07-08, is SALARIED —
-- $128,000, Production Manager, Mill Overhead — and had no employee
-- number at all. The import's row, created 2026-09-08, held number 1058
-- and nothing else: no wage, no department, no allocations, no
-- pre-approved OT, no wage history, no economics seat, one setup task.
-- One day of hours under 1058: 10.00 on 2026-09-07, no OT.
--
-- WHICH MADE THE OUTCOME BETTER THAN THE HEADER ASSUMED. He is salaried,
-- so isSalaried() is true and ot-report-lib.js:779 skips him. With 1058
-- on his real record his hours match a person and are excluded from OT
-- costing outright, rather than being costed at $0 by accident.
--
-- §4 verified: one Coburn, holding 1058, salary and classification
-- intact, hours matched, no duplicate employee_number anywhere on the
-- roster. The setup task went with the deleted row by cascade, so §3
-- matched nothing.
--
-- Kept for the record. §2 will refuse to re-run: the ids no longer
-- describe what its guards require.
--
-- Walk it one section at a time. §1 is READ-ONLY and decides what §2
-- and §3 are given. Do not run §2 until you have looked at §1 and
-- filled in the two ids it hands you.
-- =====================================================================
-- SFP Staffing — the duplicate Cyle Coburn
--
-- WHAT HAPPENED. The daily import used to create a roster row for any
-- employee_number it did not recognise. Cyle Coburn's number in the BBSI
-- file did not match his existing record, so the import made a second,
-- empty Coburn: no rate, no department, no history. His hours have been
-- landing on that empty row ever since.
--
-- WHY THAT COST SOMETHING. Every dollar in both reports is computed at
-- report time from employees.wage. An empty row has no wage, so his
-- hours have been costing $0 — present in the hours and headcount,
-- absent from the money.
--
-- THE AUTO-CREATE IS ALREADY GONE. payroll-db.createEmployee was deleted
-- and the applier's create branch with it, so no new duplicate can
-- appear. This migration is only about the row already there.
--
-- THE ORDERING IS NOT A PREFERENCE. employees.employee_number carries a
-- partial unique index (SCHEMA_DAILY_HOURS.sql:47). The number cannot be
-- on two rows at once, so it has to be released by the delete before the
-- real record can take it. Delete, then assign — never the reverse, and
-- never in two separate runs, which is why §2 is one transaction.
--
-- WHAT DELETING ALONE WOULD DO. daily_hours has no foreign key to
-- employees; it is joined by employee_number as text. Delete the row
-- holding the number and every stored hour under that number stops
-- matching anybody: still counted in hours and headcount, still costed
-- at $0, and now flagged unmatched on every future import as well. The
-- delete is half the fix. §3 is the other half.
-- =====================================================================


-- ---------------------------------------------------------------------
-- §0  Right project?  (READ-ONLY — run this first, every time)
-- ---------------------------------------------------------------------
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


-- ---------------------------------------------------------------------
-- §1  Which Coburn is which  (READ-ONLY)
-- ---------------------------------------------------------------------
-- Expect two rows. Tell them apart by what is filled in, not by the
-- order they come back: the real record has a wage, a department and a
-- hire date; the import's row is empty apart from a name and a number.
--
-- If only ONE row comes back, stop — either it was already cleaned up,
-- or the name is spelled differently on one of them and this query is
-- not seeing both. Deleting on a partial picture is how the wrong
-- Coburn goes.
select
  id,
  name,
  employee_number,
  wage,
  annual_salary,
  pay_type,
  department,
  cost_class,
  position,
  position_group,
  status,
  birthday,
  created_at
from employees
where name ilike '%coburn%'
order by created_at;

-- What is attached to each of them. The row you delete takes its
-- allocations, pre-approved OT and setup tasks WITH it (cascade), and
-- blanks the link on its wage history and economics seats (set null).
--
-- On the import's empty row these should all be 0, or a setup task at
-- most. A non-zero allocation or pre-approved OT means that row is not
-- the empty one and this should stop.
select
  e.id,
  e.name,
  e.employee_number,
  (select count(*) from employee_allocations a where a.employee_id = e.id) as allocations,
  (select count(*) from preapproved_ot p       where p.employee_id = e.id) as preapproved_ot,
  (select count(*) from employee_setup_tasks t where t.employee_id = e.id) as setup_tasks,
  (select count(*) from wage_history w         where w.employee_id = e.id) as wage_history,
  (select count(*) from economics ec           where ec.employee_id = e.id) as economics_seats
from employees e
where e.name ilike '%coburn%'
order by e.created_at;

-- Which numbers his hours are actually stored under, and how many.
-- This is the number that has to end up on the surviving record — the
-- one the FILE uses. If two numbers appear here, both carry real hours
-- and this needs a decision before §2, not after.
select
  employee_number,
  min(first_name || ' ' || last_name) as name_in_file,
  count(*)                            as rows_stored,
  round(sum(total_hours)::numeric, 2) as hours,
  round(sum(ot_hours)::numeric, 2)    as ot_hours,
  min(work_date)                      as first_day,
  max(work_date)                      as last_day
from daily_hours
where first_name ilike '%cyle%' or last_name ilike '%coburn%'
group by employee_number
order by employee_number;


-- ---------------------------------------------------------------------
-- §2  Delete the import's row and move the number  (WRITES)
-- ---------------------------------------------------------------------
-- Fill in the two ids from §1 before running. Both statements are in
-- one transaction on purpose: if the update fails the delete rolls back,
-- rather than leaving the number belonging to nobody.
--
--   duplicate_id  the import's empty row — the one being deleted
--   keeper_id     his real record — the one taking the number
--
-- The ids are literals, not a name match. A write that re-derives which
-- Coburn is which is a write that can pick the other one.
begin;

  -- Sanity: refuse to run on ids that are not what §1 described.
  do $$
  declare
    duplicate_id constant uuid := '00000000-0000-0000-0000-000000000000';  -- <<< paste from §1
    keeper_id    constant uuid := '00000000-0000-0000-0000-000000000000';  -- <<< paste from §1
    dup_wage     numeric;
    dup_number   text;
    keeper_name  text;
  begin
    if duplicate_id = keeper_id then
      raise exception 'duplicate_id and keeper_id are the same row.';
    end if;

    select wage, employee_number into dup_wage, dup_number
      from employees where id = duplicate_id;
    if not found then
      raise exception 'duplicate_id matches no row. Re-read §1.';
    end if;
    if dup_number is null then
      raise exception
        'The row marked duplicate has no employee_number. That is not the import''s row — re-read §1.';
    end if;
    if dup_wage is not null and dup_wage > 0 then
      raise exception
        'The row marked duplicate has a wage of %. The import''s row has none. Re-read §1.', dup_wage;
    end if;

    select name into keeper_name from employees where id = keeper_id;
    if not found then
      raise exception 'keeper_id matches no row. Re-read §1.';
    end if;

    raise notice 'Deleting the empty Coburn and giving number % to %.', dup_number, keeper_name;

    -- Release the number, then take it. Order forced by the unique index.
    delete from employees where id = duplicate_id;
    update employees set employee_number = dup_number where id = keeper_id;
  end $$;

commit;


-- ---------------------------------------------------------------------
-- §3  Close the setup task, if the import left one  (WRITES)
-- ---------------------------------------------------------------------
-- wage-sync raises a setup task for a number it does not recognise. The
-- number is recognised now, so the task is answered. Resolve rather than
-- delete: the arrivals queue is a record of what arrived.
update employee_setup_tasks
   set resolved_at = now(),
       resolved_by = 'SCHEMA_FIX_DUPLICATE_COBURN.sql',
       note = coalesce(note || ' | ', '') ||
              'Number reassigned to his existing record; the duplicate was removed.'
 where resolved_at is null
   and employee_number in (
     select employee_number from employees where name ilike '%coburn%'
   );


-- ---------------------------------------------------------------------
-- §4  Verify  (READ-ONLY)
-- ---------------------------------------------------------------------
-- Expect exactly one Coburn, carrying the number his hours are stored
-- under, with his real wage and department intact.
select id, name, employee_number, wage, department, cost_class, position, status
from employees
where name ilike '%coburn%';

-- His hours now match a record with a rate, so they cost something.
-- Expect matched = true and a non-null wage.
select
  d.employee_number,
  count(*)                            as rows_stored,
  round(sum(d.total_hours)::numeric, 2) as hours,
  (e.id is not null)                  as matched,
  e.wage
from daily_hours d
left join employees e
  on e.employee_number = d.employee_number
where d.first_name ilike '%cyle%' or d.last_name ilike '%coburn%'
group by d.employee_number, e.id, e.wage
order by d.employee_number;

-- Nothing on the roster is left holding a duplicate number.
select employee_number, count(*)
from employees
where employee_number is not null
group by employee_number
having count(*) > 1;
