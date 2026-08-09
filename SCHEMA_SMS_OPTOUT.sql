-- Move the SMS opt-out off text_bolt and onto its own boolean column.
--
-- BACKGROUND
-- The Employees tab opt-out toggle used to overwrite text_bolt with the literal
-- string 'STOP', which destroyed the employee's TextBolt address. Opting back in
-- had nothing to restore, and the modal had no field to re-enter it. At least
-- one number (Nolan O'Kelly) was lost this way.
--
-- After this migration the address and the opt-out are independent: opting out
-- preserves text_bolt, and opting back in resumes texting with no re-entry.
--
-- NOTE: this migration cannot recover numbers already overwritten with 'STOP' —
-- that data is gone. Those employees keep sms_opted_out = true and a NULL
-- address; re-enter their numbers in the Employees tab when you have them.
-- Step 4 lists exactly who is affected.
--
-- Run steps 1-3 in order. Back up the employees table first.

-- Step 1: add the column. Idempotent.
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS sms_opted_out BOOLEAN NOT NULL DEFAULT FALSE;

-- Step 2: preview what step 3 will change. Expect one row per 'STOP' employee.
SELECT id, name, text_bolt
FROM employees
WHERE upper(btrim(text_bolt)) = 'STOP'
ORDER BY name;

-- Step 3: carry the opt-out over to the new column and clear the sentinel.
UPDATE employees
SET sms_opted_out = TRUE,
    text_bolt     = NULL
WHERE upper(btrim(text_bolt)) = 'STOP';

-- Step 4: employees who are opted out but have no address on file. These are the
-- numbers destroyed by the old toggle — they must be re-entered by hand.
SELECT name, phone, sms_opted_out
FROM employees
WHERE sms_opted_out = TRUE
  AND (text_bolt IS NULL OR btrim(text_bolt) = '')
ORDER BY name;

-- Step 5: verify no 'STOP' sentinels survive anywhere. Should return zero rows.
SELECT id, name, text_bolt
FROM employees
WHERE upper(btrim(text_bolt)) = 'STOP';

-- Step 6: normalise blank addresses to NULL so "no address" has one
-- representation instead of two.
UPDATE employees
SET text_bolt = NULL
WHERE text_bolt IS NOT NULL AND btrim(text_bolt) = '';
