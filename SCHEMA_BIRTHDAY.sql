-- Schema check for birthday notifications
--
-- The employees table already has a `birthday` column (the Employees tab edits
-- it as a free-text field, so it is almost certainly TEXT holding "3/15" or
-- "3/15/1990"). This script is a no-op in that case — it only creates the
-- column if it is genuinely missing.
--
-- The notifier parses month/day out of the string directly and accepts BOTH
-- "YYYY-MM-DD" (a real DATE column) and "M/D" / "M/D/YYYY" (free text), so no
-- type change is required to ship. See netlify/functions/birthday-lib.js.

-- Step 1: confirm what actually exists. Run this first.
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'employees'
  AND column_name IN ('name', 'birthday', 'text_bolt', 'status')
ORDER BY column_name;

-- Step 2: create the column only if it is missing.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS birthday DATE;

-- Step 3: see which active employees would never trigger a notification —
-- either no birthday on file, or a value the parser cannot read.
SELECT name, birthday, text_bolt
FROM employees
WHERE status = 'Active'
  AND (
    birthday IS NULL
    OR btrim(birthday::text) = ''
    OR btrim(birthday::text) !~ '^(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?)$'
  )
ORDER BY name;

-- ---------------------------------------------------------------------------
-- OPTIONAL: converting `birthday` from TEXT to DATE
--
-- Not required — the notifier handles TEXT fine. Only worth doing if you want
-- Postgres to enforce validity. Birth years are unknown for free-text values
-- like "3/15", so this parks them in 1900; only month/day is ever read.
-- Back up the table first, and re-check Step 3 returns nothing beforehand.
-- ---------------------------------------------------------------------------
-- ALTER TABLE employees
--   ALTER COLUMN birthday TYPE DATE
--   USING CASE
--     WHEN btrim(birthday) ~ '^\d{4}-\d{1,2}-\d{1,2}$'      THEN to_date(btrim(birthday), 'YYYY-MM-DD')
--     WHEN btrim(birthday) ~ '^\d{1,2}[/-]\d{1,2}[/-]\d{4}$' THEN to_date(btrim(birthday), 'FMMM/FMDD/YYYY')
--     WHEN btrim(birthday) ~ '^\d{1,2}[/-]\d{1,2}$'          THEN to_date(btrim(birthday) || '/1900', 'FMMM/FMDD/YYYY')
--     ELSE NULL
--   END;
