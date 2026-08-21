-- =====================================================================
-- SFP Staffing — Phase C Task 5: cost allocations
-- Run in the STAFFING project (zwghbbyzrycpnesuuzgi) ONLY.
-- Confirm the project name in the top-left before running anything.
--
-- Some people's COST belongs to more than one department. Jeff Cook is
-- half Corporate and half Sales & Marketing. Axeri Ramirez is a third
-- HR, a third Corporate, a third Accounting.
--
-- THREE THINGS THIS IS NOT:
--
--   1. Not a change to hours. Axeri works whole hours in one place; it is
--      her cost that splits. Hours stay with her primary department, so a
--      department's hours are the hours of the people whose primary it
--      is. Splitting hours would make cost-per-hour meaningless in every
--      department she touches.
--   2. Not a salaried feature. Axeri is hourly. It is a property of the
--      person, not of their pay type.
--   3. Not a replacement for `department`. A person's primary department
--      stays exactly what it was — Accounting for Axeri — and the split
--      layers on top. Somebody with no allocation rows is 100% to their
--      primary, which is why the majority of the roster needs no rows.
-- =====================================================================


-- =====================================================================
-- §1  The table
--
-- The EXCEPTION LIST, not a per-person record: no rows means no split.
-- That is what keeps 65 of 67 people out of it entirely.
-- =====================================================================

create table if not exists employee_allocations (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id) on delete cascade,
  department  text not null,
  -- Four decimal places so a third can be written as 33.3333 if somebody
  -- wants to, but the SUM still has to be exactly 100 — see §2.
  percent     numeric(7,4) not null check (percent > 0 and percent <= 100),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (employee_id, department)
);

create index if not exists employee_allocations_employee_idx
  on employee_allocations (employee_id);

comment on table employee_allocations is
  'Cost allocation exceptions: the departments a person''s COST splits across. '
  'No rows means 100% to employees.department. Applies to cost only, never to hours.';


-- =====================================================================
-- §2  THE 100% RULE, enforced by the database
--
-- A 90% allocation silently loses 10% of a person's cost. Nothing on any
-- screen would show it: every department figure would look plausible and
-- the total would just be quietly short, which is the exact class of
-- silent shortfall this project keeps finding after the fact.
--
-- A CHECK constraint cannot express this — it spans ROWS, not columns —
-- so it is a constraint TRIGGER, deferred to the end of the transaction.
-- Deferring is what makes an edit possible at all: replacing a 50/50
-- split with a 60/40 one passes through intermediate states that do not
-- sum to 100, and an immediate check would reject the edit halfway.
--
-- Zero rows is VALID and means "no allocation, 100% to the primary
-- department". So the rule is: for any employee, the allocation
-- percentages either sum to exactly 100 or there are none at all.
-- =====================================================================

create or replace function check_allocation_total() returns trigger
language plpgsql as $$
declare
  target uuid;
  total  numeric;
  rows_n integer;
begin
  -- On DELETE the row is in OLD; on INSERT/UPDATE it is in NEW. An UPDATE
  -- that moves a row between employees has to check both.
  for target in
    select distinct x from unnest(array[
      case when tg_op <> 'INSERT' then old.employee_id end,
      case when tg_op <> 'DELETE' then new.employee_id end
    ]) as t(x) where x is not null
  loop
    select coalesce(sum(percent), 0), count(*)
      into total, rows_n
      from employee_allocations where employee_id = target;

    if rows_n > 0 and total <> 100 then
      raise exception
        'Allocation for employee % sums to %%%, not 100%%. A partial allocation '
        'silently loses that share of their cost. Delete every row for this '
        'employee to return them to 100%% of their primary department.',
        target, total
        using errcode = 'check_violation';
    end if;
  end loop;
  return null;
end $$;

drop trigger if exists employee_allocations_total on employee_allocations;
create constraint trigger employee_allocations_total
  after insert or update or delete on employee_allocations
  deferrable initially deferred
  for each row execute function check_allocation_total();


-- =====================================================================
-- §3  Atomic replacement of one employee's split
--
-- PostgREST runs each HTTP request in its OWN transaction, so "delete the
-- old rows, insert the new ones" over two calls is two transactions — and
-- the deferred check above fires at the end of each. Delete-then-insert
-- happens to survive that (zero rows is valid in between), but it leaves
-- a window where the person reads as unallocated, and insert-then-delete
-- would fail outright on a sum over 100.
--
-- One function, one transaction, one check at commit. The API calls this
-- rather than assembling the write itself.
--
-- Passing an empty array is how an allocation is REMOVED: every row for
-- that employee is deleted and they go back to 100% primary. That is a
-- real operation, not an edge case, so it is not an error.
-- =====================================================================

create or replace function set_employee_allocations(
  p_employee_id uuid,
  p_rows        jsonb
) returns setof employee_allocations
language plpgsql as $$
declare
  n integer;
begin
  if not exists (select 1 from employees where id = p_employee_id) then
    raise exception 'No employee with id %', p_employee_id
      using errcode = 'foreign_key_violation';
  end if;

  delete from employee_allocations where employee_id = p_employee_id;

  if p_rows is null or jsonb_array_length(p_rows) = 0 then
    return;   -- no rows: 100% to the primary department
  end if;

  insert into employee_allocations (employee_id, department, percent)
  select p_employee_id,
         btrim(r->>'department'),
         (r->>'percent')::numeric
  from jsonb_array_elements(p_rows) as r;

  -- A single department at 100% is not an allocation, it is the default
  -- written down. Allowed rather than rejected: it is harmless, it is what
  -- somebody halfway through an edit has, and rejecting it would make the
  -- UI unable to hold an intermediate state.
  select count(*) into n from employee_allocations where employee_id = p_employee_id;
  if n = 0 then
    raise exception 'Allocation rows were supplied but none were inserted';
  end if;

  return query select * from employee_allocations where employee_id = p_employee_id
               order by percent desc, department;
end $$;


-- =====================================================================
-- §4  BEFORE SEEDING — confirm the two people and their primaries
--
-- Expected: Jeff Cook, Active, SG&A, department Sales & Marketing.
--           Axeri Ramirez, Active, SG&A, department Accounting.
-- =====================================================================

select id, name, status, department, cost_class, pay_type
from employees
where name ilike '%jeff%cook%' or name ilike '%axeri%'
order by name;


-- =====================================================================
-- §5  SEED the two known allocations
--
-- ON THE THIRDS. 100/3 is not representable to two decimal places, and
-- the sum must be exactly 100 — a tolerance would let real shortfalls
-- through, which is the thing §2 exists to stop. So one department
-- carries the extra hundredth, and it is the PRIMARY one, which is the
-- same rule the cost report uses when it rounds a split to the cent.
-- Axeri's primary is Accounting, so Accounting takes 33.34.
--
-- Run §4 first. These use the name lookup rather than a pasted uuid so
-- there is nothing to transcribe wrongly.
-- =====================================================================

-- Jeff Cook — 50 / 50.
-- select set_employee_allocations(
--   (select id from employees where name ilike '%jeff%cook%' and status = 'Active'),
--   '[{"department":"Corporate","percent":50},
--     {"department":"Sales & Marketing","percent":50}]'::jsonb);

-- Axeri Ramirez — thirds, with the odd hundredth on her primary.
-- select set_employee_allocations(
--   (select id from employees where name ilike '%axeri%' and status = 'Active'),
--   '[{"department":"Accounting","percent":33.34},
--     {"department":"Corporate","percent":33.33},
--     {"department":"HR","percent":33.33}]'::jsonb);


-- =====================================================================
-- §6  VERIFY
-- =====================================================================

-- 6a. The two allocations, and their sums. Expected: 5 rows, both
--     employees summing to exactly 100.
select e.name, a.department, a.percent,
       sum(a.percent) over (partition by a.employee_id) as employee_total
from employee_allocations a
join employees e on e.id = a.employee_id
order by e.name, a.percent desc, a.department;

-- 6b. Anybody whose allocation does not sum to 100. Expected: 0 rows.
--     The trigger makes this impossible; the query is here so the
--     constraint is seen to be doing its job rather than trusted.
select e.name, sum(a.percent) as total
from employee_allocations a join employees e on e.id = a.employee_id
group by e.name having sum(a.percent) <> 100;

-- 6c. Prove the trigger rejects a partial allocation. This SHOULD FAIL
--     with 'sums to 90%, not 100%'. If it succeeds, the trigger is not
--     installed and every figure the Overhead tab shows is suspect.
-- select set_employee_allocations(
--   (select id from employees where name ilike '%jeff%cook%' and status = 'Active'),
--   '[{"department":"Corporate","percent":90}]'::jsonb);

-- 6d. Prove an empty array removes the allocation cleanly (back to 100%
--     primary), then re-run §5 for whoever you tested with.
-- select set_employee_allocations(
--   (select id from employees where name ilike '%jeff%cook%' and status = 'Active'),
--   '[]'::jsonb);

-- 6e. Departments named in an allocation that no employee sits in. Not an
--     error — HR is a real cost destination with nobody whose primary it
--     is — but worth seeing, because a typo looks exactly like this.
select distinct a.department
from employee_allocations a
where not exists (select 1 from employees e where e.department = a.department)
order by 1;
