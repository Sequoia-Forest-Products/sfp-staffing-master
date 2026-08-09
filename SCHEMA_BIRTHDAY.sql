-- Birthday data audit
--
-- CONFIRMED against live data: employees.birthday is TEXT, all 64 rows
-- populated, no backfill required. No migration is needed to ship the
-- notifier — this file is here to re-check the data over time.
--
-- The live values are full JS date strings, e.g.
--   Mon Nov 12 1990 00:00:00 GMT-0800 (Pacific Standard Time)
-- Only month and day are ever read. The parser in
-- netlify/functions/birthday-lib.js also accepts "YYYY-MM-DD" and free text
-- like "3/15" or "3/15/1990", so hand-entered rows keep working.

-- Step 1: confirm the columns the notifier depends on.
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'employees'
  AND column_name IN ('name', 'birthday', 'text_bolt', 'status')
ORDER BY column_name;

-- Step 2: active employees with no birthday on file. These are simply never
-- announced — the function skips them quietly, without a warning.
SELECT name, birthday, text_bolt
FROM employees
WHERE status = 'Active'
  AND (birthday IS NULL OR btrim(birthday) = '')
ORDER BY name;

-- Step 3: active employees whose birthday is present but in none of the three
-- accepted shapes. Each of these logs a WARNING on every run — either fix the
-- value in the Employees tab or clear it.
SELECT name, birthday
FROM employees
WHERE status = 'Active'
  AND btrim(birthday) <> ''
  AND btrim(birthday) !~ '^\d{4}-\d{1,2}-\d{1,2}'                          -- ISO / DATE
  AND btrim(birthday) !~ '^\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?$'              -- M/D, M/D/YYYY
  AND btrim(birthday) !~ '^[A-Za-z]{3} [A-Za-z]{3} \d{1,2} \d{4}'          -- JS date string
ORDER BY name;

-- Step 4: who is announced but cannot be texted — no address, or opted out.
-- This is expected and supported; the message names them either way.
SELECT name, birthday, COALESCE(NULLIF(btrim(text_bolt), ''), '(none)') AS address
FROM employees
WHERE status = 'Active'
  AND btrim(COALESCE(birthday, '')) <> ''
  AND (text_bolt IS NULL OR btrim(text_bolt) = '' OR upper(btrim(text_bolt)) = 'STOP')
ORDER BY name;
