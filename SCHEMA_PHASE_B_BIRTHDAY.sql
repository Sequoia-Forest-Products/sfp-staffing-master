-- ============================================================================
-- Phase B — normalise employees.birthday
--
-- READ SECTION 0 BEFORE RUNNING ANYTHING. Sections 1 and 2 are read-only and
-- safe. Section 3 WRITES and is commented out on purpose: do not uncomment it
-- until section 1 has been run and its output read.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 0. Why this is gated
-- ----------------------------------------------------------------------------
--
-- The birthday notifier is LIVE. It sends to 66 recipients, and it decides who
-- to announce by parsing this column. If a migration writes a value the parser
-- cannot read, that person silently stops being announced and NOTHING reports
-- it — not the function log, not an alert, nothing. There is no downstream
-- check that would catch it. That exact failure mode has already cost time on
-- this project.
--
-- So the order is: audit, then decide, then migrate, then prove the same people
-- are announced. Not audit-and-migrate in one pass.
--
-- WHAT IS ALREADY DONE: nothing needs to change in the parser.
-- netlify/functions/birthday-lib.js parseBirthday() already accepts all three
-- shapes — YYYY-MM-DD first, then M/D and M/D/YYYY, then the full JS date
-- string via Date.parse. It reads MONTH AND DAY ONLY; the year is never used by
-- anything. So the parser tolerates un-migrated and migrated rows
-- simultaneously, which is what makes a mid-deploy state safe.
--
-- The edit surface already writes the new format: the form now uses
-- <input type="date">, which produces YYYY-MM-DD natively. A stored value the
-- picker cannot represent falls back to a TEXT field with a warning rather than
-- rendering an empty picker — an empty picker would have written the blank over
-- a real birthday on the next save.


-- ----------------------------------------------------------------------------
-- 1. AUDIT — run this first. Read-only.
-- ----------------------------------------------------------------------------

-- 1a. Every distinct shape in the column, with counts. This is the list that has
--     to be known before anything is written.
select
  case
    when birthday is null                                    then 'NULL'
    when btrim(birthday) = ''                                then 'empty string'
    when upper(birthday) like '%ERROR%'                      then 'ERROR text'
    when birthday ~ '^\d{4}-\d{2}-\d{2}$'                    then 'already ISO (YYYY-MM-DD)'
    when birthday ~ '^\d{4}-\d{1,2}-\d{1,2}'                 then 'ISO-ish, loose digits'
    when birthday ~ '^[A-Za-z]{3} [A-Za-z]{3} +\d{1,2} \d{4}' then 'JS date string'
    when birthday ~ '^\d{1,2}[/-]\d{1,2}[/-]\d{4}$'          then 'M/D/YYYY'
    when birthday ~ '^\d{1,2}[/-]\d{1,2}[/-]\d{2}$'          then 'M/D/YY'
    when birthday ~ '^\d{1,2}[/-]\d{1,2}$'                   then 'M/D (no year)'
    else                                                          'UNRECOGNISED'
  end as shape,
  count(*) as rows
from employees
group by 1
order by rows desc;

-- 1b. THE IMPORTANT ONE. Every row whose value matches none of the shapes the
--     parser understands. Each of these is a person who is either already not
--     being announced, or would stop being announced by a careless migration.
--
--     This must come back EMPTY before section 3 runs. If it does not, read the
--     rows and decide what each one should be — do not pattern-match a fix.
select id, name, status, quote_literal(birthday) as birthday_literal
from employees
where birthday is not null
  and btrim(birthday) <> ''
  and upper(birthday) not like '%ERROR%'
  and birthday !~ '^\d{4}-\d{1,2}-\d{1,2}'
  and birthday !~ '^[A-Za-z]{3} [A-Za-z]{3} +\d{1,2} \d{4}'
  and birthday !~ '^\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?$'
order by name;

-- 1c. Rows the migration will NOT touch, and why, so the leftovers are a
--     deliberate list rather than a surprise. 'M/D (no year)' and 'M/D/YY' are
--     here: the notifier reads them correctly (month and day is all it wants),
--     but there is no year to build a date from, and INVENTING one writes a
--     false fact into an HR record. They stay as they are and the edit form
--     shows them as text.
select id, name, birthday
from employees
where birthday ~ '^\d{1,2}[/-]\d{1,2}([/-]\d{2})?$'
order by name;

-- 1d. What the migration WOULD write, computed but not applied. Eyeball this
--     against 1a's counts before uncommenting section 3. month_name and day are
--     pulled out textually — see section 2 for why that matters.
with parsed as (
  select
    id, name, birthday,
    case
      when birthday ~ '^\d{4}-\d{1,2}-\d{1,2}' then
        to_char(to_date(substring(birthday from '^(\d{4}-\d{1,2}-\d{1,2})'), 'YYYY-MM-DD'), 'YYYY-MM-DD')
      when birthday ~ '^[A-Za-z]{3} [A-Za-z]{3} +\d{1,2} \d{4}' then
        to_char(
          to_date(
            substring(birthday from '^[A-Za-z]{3} [A-Za-z]{3} +\d{1,2} (\d{4})') || '-' ||
            substring(birthday from '^[A-Za-z]{3} ([A-Za-z]{3})')                || '-' ||
            lpad(substring(birthday from '^[A-Za-z]{3} [A-Za-z]{3} +(\d{1,2})'), 2, '0'),
            'YYYY-Mon-DD'),
          'YYYY-MM-DD')
      when birthday ~ '^\d{1,2}[/-]\d{1,2}[/-]\d{4}$' then
        to_char(
          to_date(
            substring(birthday from '[/-](\d{4})$')          || '-' ||
            lpad(substring(birthday from '^(\d{1,2})'), 2, '0') || '-' ||
            lpad(substring(birthday from '^\d{1,2}[/-](\d{1,2})'), 2, '0'),
            'YYYY-MM-DD'),
          'YYYY-MM-DD')
      else null
    end as new_value
  from employees
  where birthday is not null and btrim(birthday) <> ''
)
select id, name, birthday as old_value, new_value,
       -- The only thing the notifier reads. If this changes for anybody, the
       -- migration is wrong.
       to_char(to_date(new_value, 'YYYY-MM-DD'), 'Mon DD') as month_day_after
from parsed
where new_value is not null
order by name;


-- ----------------------------------------------------------------------------
-- 2. The decision, and why
-- ----------------------------------------------------------------------------
--
-- TEXT, normalised to YYYY-MM-DD. Not a `date` column — at least not yet.
--
-- Reasoning:
--
--   * The parser already accepts YYYY-MM-DD, so the target format needs no code
--     change at all. A `date` column serialises through PostgREST as
--     YYYY-MM-DD too, so both land in the same place — which means the format
--     is the part that matters and the TYPE can be decided separately, later,
--     with no rush.
--
--   * The "simpler notification query" a date type would buy is not collected
--     today: birthday-lib.js fetches every active employee
--     (?status=eq.Active&select=name,birthday,...) and does the month/day
--     comparison in JS. Nothing filters on birthday in SQL, so a date type
--     changes no query that exists.
--
--   * Changing a column's TYPE in place on a live system is the risky half. If
--     one value fails to cast the whole statement fails; worse, an `alter table
--     ... type date using birthday::date` would apply Postgres's own parsing to
--     the JS date strings, which is not the parsing the notifier uses.
--
--   * Rewriting values is reversible in a way a type change is not: the old
--     value is recoverable from the audit output above, and section 3 keeps a
--     backup column.
--
-- TIMEZONE — the trap this file exists to avoid.
--
-- Do NOT migrate by casting through a timestamp. The stored strings carry an
-- offset ('GMT-0800'), so `birthday::timestamptz::date` converts to the SESSION
-- time zone before taking the date. Midnight Pacific is 08:00 UTC the same day,
-- which is fine for any session zone from UTC-8 eastward — but a session in,
-- say, Pacific/Midway (UTC-11) would take the date as the DAY BEFORE, moving
-- everybody's birthday back one day. Silently, and only for whoever ran it.
--
-- Section 1d and section 3 both extract the month name, day and year as TEXT and
-- rebuild the date from those. No instant, no zone, no conversion.
--
-- Once every row is YYYY-MM-DD, converting the column to `date` becomes a
-- one-liner with nothing left to go wrong. Section 4 has it, commented, for
-- whenever that is wanted.


-- ----------------------------------------------------------------------------
-- 3. MIGRATE — commented out. Requires 1b to be empty first.
-- ----------------------------------------------------------------------------
--
-- Before uncommenting:
--   1. Run section 1. Confirm 1b returns no rows.
--   2. Record the "before" snapshot — see section 5.
--
-- After running:
--   3. Run section 3c and confirm it returns no rows.
--   4. Record the "after" snapshot and compare. Same people, or stop.

-- 3a. Keep the old values. Cheap, and the difference between a mistake and an
--     incident.
-- alter table employees add column if not exists birthday_raw_backup text;
-- update employees set birthday_raw_backup = birthday
--   where birthday_raw_backup is null and birthday is not null;

-- 3b. The rewrite. Month/day/year read as text and reassembled — never cast
--     through a timestamp. Rows with no usable year are deliberately untouched
--     (see 1c).
-- update employees set birthday =
--   case
--     when birthday ~ '^\d{4}-\d{1,2}-\d{1,2}' then
--       to_char(to_date(substring(birthday from '^(\d{4}-\d{1,2}-\d{1,2})'), 'YYYY-MM-DD'), 'YYYY-MM-DD')
--     when birthday ~ '^[A-Za-z]{3} [A-Za-z]{3} +\d{1,2} \d{4}' then
--       to_char(
--         to_date(
--           substring(birthday from '^[A-Za-z]{3} [A-Za-z]{3} +\d{1,2} (\d{4})') || '-' ||
--           substring(birthday from '^[A-Za-z]{3} ([A-Za-z]{3})')                || '-' ||
--           lpad(substring(birthday from '^[A-Za-z]{3} [A-Za-z]{3} +(\d{1,2})'), 2, '0'),
--           'YYYY-Mon-DD'),
--         'YYYY-MM-DD')
--     when birthday ~ '^\d{1,2}[/-]\d{1,2}[/-]\d{4}$' then
--       to_char(
--         to_date(
--           substring(birthday from '[/-](\d{4})$')             || '-' ||
--           lpad(substring(birthday from '^(\d{1,2})'), 2, '0') || '-' ||
--           lpad(substring(birthday from '^\d{1,2}[/-](\d{1,2})'), 2, '0'),
--           'YYYY-MM-DD'),
--         'YYYY-MM-DD')
--     else birthday
--   end
-- where birthday is not null and btrim(birthday) <> '';

-- 3c. VERIFY: the month and day must be identical before and after, for every
--     row. This is the assertion that matters — the year is never read by
--     anything, the month and day decide who gets announced. Expect ZERO rows.
-- select id, name, birthday_raw_backup, birthday
-- from employees
-- where birthday_raw_backup is not null
--   and birthday_raw_backup ~ '^[A-Za-z]{3} [A-Za-z]{3} +\d{1,2} \d{4}'
--   and (
--     substring(birthday from '-(\d{2})-')  is distinct from
--       lpad((select to_char(to_date(substring(birthday_raw_backup from '^[A-Za-z]{3} ([A-Za-z]{3})'), 'Mon'), 'MM')), 2, '0')
--     or
--     substring(birthday from '-(\d{2})$')  is distinct from
--       lpad(substring(birthday_raw_backup from '^[A-Za-z]{3} [A-Za-z]{3} +(\d{1,2})'), 2, '0')
--   );

-- 3d. Rollback, if 3c finds anything.
-- update employees set birthday = birthday_raw_backup
--   where birthday_raw_backup is not null;


-- ----------------------------------------------------------------------------
-- 4. LATER, and only once every row is ISO. Commented, not scheduled.
-- ----------------------------------------------------------------------------
--
-- Do not run this in the same session as section 3. Run section 1a again first
-- and confirm every row is 'already ISO (YYYY-MM-DD)', 'NULL' or 'empty string'
-- — and note that the 'M/D (no year)' rows from 1c will still be there, so this
-- CANNOT run until those have been given a year by hand.
--
-- alter table employees alter column birthday type date using nullif(btrim(birthday), '')::date;


-- ----------------------------------------------------------------------------
-- 5. The acceptance test — the part that actually proves it worked
-- ----------------------------------------------------------------------------
--
-- Column contents matching is necessary and not sufficient. What matters is that
-- the same people are announced. Run this from a shell, BEFORE and AFTER, and
-- diff the two.
--
--   for d in 2026-08-11 2026-09-03 2026-11-12 2026-12-25 2026-02-29; do
--     echo "== $d"
--     curl -s "https://seq-staffing.netlify.app/api/birthday-test?date=$d" \
--       -H "x-birthday-secret: $BIRTHDAY_TRIGGER_SECRET" \
--       | python3 -c 'import sys,json; d=json.load(sys.stdin); print(sorted(p["name"] for p in d.get("people",[])))'
--   done
--
-- Pick dates that currently RETURN SOMEBODY — a spread of empty days proves
-- nothing. Rollin Tolle on 2026-08-11 is a known-good case verified earlier in
-- this project, so 2026-08-11 must be in the list.
--
-- The dry-run endpoint composes and logs without sending; it does not need
-- ?send=true and must not be given it.
--
-- Same names before and after, for every date, or roll back with 3d.
