-- ============================================================================
-- Phase B — normalise employees.birthday
--
-- READ SECTION 0 BEFORE RUNNING ANYTHING. Sections 1 and 2 are read-only and
-- safe. Section 3 WRITES.
--
-- ---------------------------------------------------------------------------
-- AUDIT PASSED — 2026-08-21. Section 3 is live below because of this, and for
-- no other reason. If you are reading this file against a DIFFERENT database,
-- section 3 is not authorised: re-run section 1 first.
--
--   1a  69 JS date string, 4 M/D/YYYY, 1 empty string. 74 rows = the whole
--       employees table (67 active + 7 inactive; 1a has no status filter).
--   1b  EMPTY. No value fails every shape the parser understands.
--   1c  EMPTY, implied by 1a reporting no 'M/D (no year)' and no 'M/D/YY'
--       bucket. So every non-empty value converts and there are no deliberate
--       leftovers — which also means section 4 becomes available afterwards.
--   1d  73 rows previewed (74 minus the empty string). Peter verified every
--       conversion independently: month, day and year preserved, zero
--       mismatches.
-- ---------------------------------------------------------------------------
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
-- AND THE DATA CONFIRMS THIS WAS NOT A THEORETICAL RISK. The audit turned up two
-- rows whose offset contradicts its own label: Howard Hoffman and Jaime
-- Canizalez both carry 'GMT-0800 (Pacific Daylight Time)' on April and October
-- dates, which should be -0700. Whatever wrote these stamped a label and an
-- offset that disagree, so any migration that trusted the offset would have been
-- working from values that are wrong about themselves — not merely at risk from
-- a session-zone setting.
--
-- Both are harmless as things stand, and it is worth being precise about why
-- rather than just asserting it:
--
--   * The textual extraction never reads the offset or the label at all, so the
--     migration cannot be affected by either.
--   * The notifier's Date.parse path DOES read the numeric offset, and is still
--     safe, because the error is one hour against a value at local midnight:
--     midnight at -0700 is 07:00 UTC and at -0800 is 08:00 UTC, the same
--     calendar day either way. Verified against both rows' shapes — parseBirthday
--     returns the same {month, day} for the contradictory and the corrected
--     spelling. An offset error could only matter if it crossed midnight, which
--     would take a value not stored at 00:00:00 or an error of 8+ hours.
--
-- Nothing needs fixing in those two rows; after section 3 the offset and the
-- label are both gone anyway.
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
--     incident. Run this FIRST and on its own.
alter table employees add column if not exists birthday_raw_backup text;

update employees set birthday_raw_backup = birthday
where birthday_raw_backup is null and birthday is not null;

-- Expect: 73 rows backed up (74 minus the one empty string, which is not null
-- and so IS backed up as '' — so expect 74 if the empty row is an empty string
-- rather than NULL. 1a said 'empty string', so 74).
select count(*) as backed_up from employees where birthday_raw_backup is not null;


-- 3b. The rewrite. Month/day/year read as TEXT and reassembled — never cast
--     through a timestamp, for the reasons in section 2, one of which is that
--     two rows in this very table carry an offset that contradicts their label.
--
--     Rows with no usable year would be left alone by the else branch; the audit
--     found none, so this touches all 73 non-empty values.
update employees set birthday =
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
          substring(birthday from '[/-](\d{4})$')             || '-' ||
          lpad(substring(birthday from '^(\d{1,2})'), 2, '0') || '-' ||
          lpad(substring(birthday from '^\d{1,2}[/-](\d{1,2})'), 2, '0'),
          'YYYY-MM-DD'),
        'YYYY-MM-DD')
    else birthday
  end
where birthday is not null and btrim(birthday) <> '';


-- 3c. VERIFY. Three queries; all three must give the stated answer.
--
--     The month and day are the ONLY things the notifier reads, so they are what
--     has to be identical before and after. The year is checked too, because a
--     wrong year is a wrong fact in an HR record even if nothing reads it.

-- 3c-i. Every row is now ISO, or empty. Expect exactly two shapes:
--       'ISO (YYYY-MM-DD)' 73, and 'empty string' 1.
select
  case
    when birthday is null                 then 'NULL'
    when btrim(birthday) = ''             then 'empty string'
    when birthday ~ '^\d{4}-\d{2}-\d{2}$' then 'ISO (YYYY-MM-DD)'
    else 'SOMETHING ELSE — STOP'
  end as shape,
  count(*) as rows
from employees
group by 1
order by rows desc;

-- 3c-ii. THE ASSERTION. For every migrated row, the month, day and year in the
--        new value must match what the backup said, read textually. Extracting
--        the month NAME through to_date('Mon') is the same conversion the
--        migration used, which is deliberate: this proves the WRITE landed, and
--        3c-iii independently proves the conversion itself.
--
--        Expect ZERO rows. Any row here means roll back with 3d.
select id, name, birthday_raw_backup, birthday
from employees
where birthday_raw_backup is not null
  and btrim(birthday_raw_backup) <> ''
  and birthday is distinct from (
    case
      when birthday_raw_backup ~ '^\d{4}-\d{1,2}-\d{1,2}' then
        to_char(to_date(substring(birthday_raw_backup from '^(\d{4}-\d{1,2}-\d{1,2})'), 'YYYY-MM-DD'), 'YYYY-MM-DD')
      when birthday_raw_backup ~ '^[A-Za-z]{3} [A-Za-z]{3} +\d{1,2} \d{4}' then
        to_char(
          to_date(
            substring(birthday_raw_backup from '^[A-Za-z]{3} [A-Za-z]{3} +\d{1,2} (\d{4})') || '-' ||
            substring(birthday_raw_backup from '^[A-Za-z]{3} ([A-Za-z]{3})')                || '-' ||
            lpad(substring(birthday_raw_backup from '^[A-Za-z]{3} [A-Za-z]{3} +(\d{1,2})'), 2, '0'),
            'YYYY-Mon-DD'),
          'YYYY-MM-DD')
      when birthday_raw_backup ~ '^\d{1,2}[/-]\d{1,2}[/-]\d{4}$' then
        to_char(
          to_date(
            substring(birthday_raw_backup from '[/-](\d{4})$')             || '-' ||
            lpad(substring(birthday_raw_backup from '^(\d{1,2})'), 2, '0') || '-' ||
            lpad(substring(birthday_raw_backup from '^\d{1,2}[/-](\d{1,2})'), 2, '0'),
            'YYYY-MM-DD'),
          'YYYY-MM-DD')
      else birthday_raw_backup
    end
  )
order by name;

-- 3c-iii. An INDEPENDENT check of the day number, not reusing the month-name
--         conversion. The day is the second number in the JS date string and the
--         last field of the ISO value; if the two disagree the reassembly put
--         the pieces in the wrong order. Expect ZERO rows.
select id, name, birthday_raw_backup, birthday
from employees
where birthday_raw_backup ~ '^[A-Za-z]{3} [A-Za-z]{3} +\d{1,2} \d{4}'
  and substring(birthday from '(\d{2})$')
      is distinct from lpad(substring(birthday_raw_backup from '^[A-Za-z]{3} [A-Za-z]{3} +(\d{1,2})'), 2, '0');


-- 3d. ROLLBACK — commented, because after a good migration running it would undo
--     it. Uncomment only if 3c found rows.
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
-- 5. The acceptance test
-- ----------------------------------------------------------------------------
--
-- There is NO BIRTHDAY_TRIGGER_SECRET in Netlify. birthday-test.js accepts a
-- valid sfp_session cookie as well, so the endpoint is reachable from a browser
-- that is already signed in. That is how this is run: paste URLs, read the JSON.
--
-- WHAT EACH HALF OF THE CHECK ACTUALLY COVERS — worth being straight about,
-- because it is easy to overclaim for the clicking half:
--
--   3c-ii and 3c-iii are the COMPLETE check. They compare every one of the 73
--   migrated rows against its own backup, per row, and 3c-iii checks the day
--   number without reusing the month-name conversion. Nothing is sampled.
--
--   This section is a SYSTEMIC check, and it is a spot check by nature. What it
--   catches that SQL cannot is the pipeline breaking as a whole — the parser no
--   longer matching the stored format, the query no longer selecting the column,
--   the function erroring. Every one of those failures is ALL-OR-NOTHING: if
--   ISO stopped parsing, every date would come back empty. So a handful of dates
--   that currently return somebody is enough to detect it, and clicking all ~55
--   anchor dates twice would buy almost nothing over clicking eight.
--
-- Do not read this as "the migration is verified because five dates matched".
-- Per-row correctness is 3c's job; this proves the thing still runs.
--
-- THE WINDOW. buildTargetDates() returns NULL for Friday, Saturday and Sunday —
-- it short-circuits before looking at anybody, so a weekend date proves nothing
-- whatever the data says. Monday to Wednesday cover one day. THURSDAY COVERS
-- FOUR (itself plus three, which is how Fri/Sat/Sun birthdays get announced).
-- So every usable URL is a Mon-Thu date, and Thursdays are worth four times as
-- much per click.
--
-- 5a. Emits the URLs to use, best first. Every birthday is mapped onto the
--     Mon-Thu date whose window would surface it: itself if it already falls
--     Mon-Thu, otherwise the Thursday before it. Ordered by how many people each
--     one covers, so the first few URLs reach the most of the roster.
--
--     Run this BEFORE the migration and AFTER, and the URL list must be
--     identical both times — if an anchor date changes, a month or day moved.
with bdays as (
  select id, name,
         -- Month and day only; the year is irrelevant and 2026 is just a frame
         -- to do weekday arithmetic in.
         make_date(2026,
           coalesce(
             nullif(substring(birthday from '^\d{4}-(\d{1,2})-'), '')::int,
             nullif(substring(birthday from '^(\d{1,2})[/-]'), '')::int,
             (select extract(month from to_date(substring(birthday from '^[A-Za-z]{3} ([A-Za-z]{3})'), 'Mon'))::int)
           ),
           coalesce(
             nullif(substring(birthday from '^\d{4}-\d{1,2}-(\d{1,2})'), '')::int,
             nullif(substring(birthday from '^\d{1,2}[/-](\d{1,2})'), '')::int,
             nullif(substring(birthday from '^[A-Za-z]{3} [A-Za-z]{3} +(\d{1,2})'), '')::int
           )
         ) as bday_2026
  from employees
  where status = 'Active'
    and birthday is not null and btrim(birthday) <> ''
), anchored as (
  select name, bday_2026,
         -- isodow: 1=Mon .. 7=Sun. Mon-Thu anchor to themselves; Fri/Sat/Sun
         -- anchor to the Thursday whose 3-day look-ahead reaches them.
         case extract(isodow from bday_2026)
           when 5 then bday_2026 - 1
           when 6 then bday_2026 - 2
           when 7 then bday_2026 - 3
           else bday_2026
         end as anchor
  from bdays
)
select to_char(anchor, 'YYYY-MM-DD')                as run_this_date,
       to_char(anchor, 'Dy')                        as weekday,
       count(*)                                     as people_covered,
       string_agg(name, ', ' order by name)         as who,
       'https://seq-staffing.netlify.app/api/birthday-test?date='
         || to_char(anchor, 'YYYY-MM-DD')           as url
from anchored
group by anchor
order by people_covered desc, anchor;

-- 5b. Reduce each snapshot to just the names, so before and after can be
--     compared by eye. In the browser the response is JSON; the field to read is
--     `people`, and each entry has a `name`.
--
--     Same names, per date, before and after. Any difference and roll back
--     with 3d.
