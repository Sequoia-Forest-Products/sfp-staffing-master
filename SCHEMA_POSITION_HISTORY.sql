-- =====================================================================
-- NOT YET APPLIED. Run in the STAFFING project (zwghbbyzrycpnesuuzgi) ONLY.
--
-- Walk it one section at a time and verify each before the next.
-- =====================================================================
-- SFP Staffing — record what a person's classification WAS
--
-- WHY. wage_history has recorded every rate change since the v2 model.
-- Nothing has ever recorded a change to department, position,
-- position_group or cost_class. Those four decide which cost centre a
-- person's hours land in, which line of the Manufacturing Costs report
-- they appear on, and whether they show up in the Bullpen — and the row
-- has simply been overwritten each time, in place, with no trace.
--
-- THE PAST IS NOT RECOVERABLE. This table starts empty and starts today.
-- Whatever anybody's department was before this migration ran cannot be
-- reconstructed from `employees`, because the old value is gone. The only
-- surviving trace anywhere is daily_hours.department, which is a snapshot
-- taken at import — and it covers only the days a person actually worked,
-- only since the daily feed began, and only for hourly staff.
--
-- The profile card says so out loud rather than implying the list covers a
-- whole tenure. A history that silently begins mid-story is worse than no
-- history: it invites "he was always in Production" from a list that only
-- proves "he was in Production since September".
--
-- WHY A TABLE AND NOT A TRIGGER. wage_history is written by the
-- application, before the employees row is updated, so a failure between
-- the two leaves a record with no change rather than a change with no
-- record. This follows that ordering for the same reason. A row-level
-- trigger would also fire for the department re-stamp and for any future
-- bulk correction, which are not decisions anybody made about a person.

-- ---------------------------------------------------------------------
-- §1  The table
-- ---------------------------------------------------------------------
create table if not exists position_history (
  id              uuid primary key default gen_random_uuid(),

  -- Keyed on id, not employee_number. Unlike a rate — which the daily file
  -- identifies by number and which therefore cannot be recorded for
  -- somebody without one — a classification belongs to the roster row and
  -- every roster row has an id. Office staff have no employee number and
  -- their department changes matter just as much.
  employee_id     uuid not null references employees(id) on delete cascade,

  -- Denormalised so the history survives the person being deleted from the
  -- roster, the same reason wage_history carries employee_name. The FK
  -- cascade above will take the rows with it; the name is here so a row
  -- read before that still says who it was about.
  employee_name   text,
  employee_number text,

  -- Which of the four moved. One row per FIELD per save, not one row per
  -- save: a transfer that changes department and cost_class together is two
  -- facts, and querying "when did he leave Production" should not require
  -- unpacking a blob.
  field           text not null
                  check (field in ('department', 'position', 'position_group', 'cost_class')),

  -- NULL is a real value on all four and is preserved as NULL rather than
  -- as ''. "Had no position group" and "had an empty position group" are
  -- the same thing here, but only one of them reads as an answer.
  previous_value  text,
  new_value       text,

  changed_by      text,          -- the session email that saved the profile
  changed_at      timestamptz not null default now(),
  note            text
);

create index if not exists position_history_employee_idx
  on position_history (employee_id, changed_at desc);
create index if not exists position_history_field_idx
  on position_history (field, changed_at desc);

-- ---------------------------------------------------------------------
-- §2  Append-only, enforced
-- ---------------------------------------------------------------------
--
-- Same posture as wage_history, and for the same reason: the service key
-- bypasses row-level security but NOT triggers, so this holds for the
-- application and for a person in the SQL editor alike. A correction is a
-- new row with a note, never an edit to an old one.
--
-- To make a genuine repair: alter table position_history disable trigger
-- position_history_append_only; fix; re-enable; and record why in a note
-- row. Doing it any other way leaves no evidence it happened.
create or replace function position_history_no_change() returns trigger as $$
begin
  raise exception
    'position_history is append-only. A correction is a new row, not an edit. '
    'To repair a genuine mistake, disable trigger position_history_append_only, '
    'make the change, re-enable it, and add a row explaining why.';
end;
$$ language plpgsql;

drop trigger if exists position_history_append_only on position_history;
create trigger position_history_append_only
  before update or delete on position_history
  for each row execute function position_history_no_change();

-- ---------------------------------------------------------------------
-- §3  Verify
-- ---------------------------------------------------------------------
-- Expect: the table exists, is empty, and refuses an update.
select count(*) as rows_now from position_history;

select tgname, tgenabled
from pg_trigger
where tgrelid = 'position_history'::regclass and not tgisinternal;

-- This must ERROR. If it succeeds, §2 did not take and the table is not
-- append-only — stop and say so rather than proceeding.
--   insert into position_history (employee_id, field, new_value)
--     select id, 'department', 'test' from employees limit 1;
--   update position_history set new_value = 'tampered';
