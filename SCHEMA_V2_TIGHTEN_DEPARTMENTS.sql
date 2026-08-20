-- ============================================================================
-- Architecture v2 — step two of the department constraint
--
-- Cuts the department CHECK from the transitional fourteen values down to the
-- real twelve, by removing 'SG&A' and 'Non-Production'.
--
-- RUN THIS ONLY when no employee row holds either retired value. Audit query
-- 8c in SCHEMA_V2_MODEL.sql tells you, and the guard below refuses rather than
-- letting Postgres fail with a message that does not say what is wrong.
--
-- Why two steps: the rows holding a retired value cannot be reassigned until
-- the constraint permits the new values, and the constraint cannot exclude the
-- retired values while rows still hold them. SCHEMA_V2_MODEL.sql breaks the
-- deadlock by allowing both sets at once; this file closes it again.
-- ============================================================================

do $$
declare
  stragglers text;
  n integer;
begin
  select count(*), coalesce(string_agg(name || ' (' || department || ')', ', ' order by name), '')
    into n, stragglers
  from employees
  where department in ('SG&A', 'Non-Production');

  if n > 0 then
    raise exception
      'Cannot tighten the constraint: % employee row(s) still hold a retired department value — %. Reassign them first (audit query 8a in SCHEMA_V2_MODEL.sql lists the worklist), then re-run this file.',
      n, stragglers;
  end if;

  raise notice 'No rows hold a retired department value. Tightening the constraint to twelve.';
end $$;

begin;

alter table employees drop constraint if exists employees_department_check;

alter table employees add constraint employees_department_check
  check (department in (
    -- Manufacturing
    'Log Yard', 'Clean-up', 'Shipping', 'Maintenance', 'Production', 'Saw Filing',
    -- Mill Overhead
    'Mill Overhead',
    -- SG&A
    'Sales & Marketing', 'Procurement', 'Accounting', 'HR', 'Corporate'
  ));

commit;

-- Confirm.
-- select pg_get_constraintdef(oid) from pg_constraint
-- where conname = 'employees_department_check' and conrelid = 'employees'::regclass;
