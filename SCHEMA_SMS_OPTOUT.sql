-- Make phone the single source of truth for SMS, and move the opt-out onto its
-- own boolean column.
--
-- BACKGROUND
-- The Employees tab opt-out toggle used to overwrite text_bolt with the literal
-- string 'STOP', destroying the stored TextBolt address. That no longer affects
-- delivery: the address is now derived from the phone column at send time as
--   '+1' || <phone stripped to 10 digits> || '@sendemailtotext.com'
-- so anyone whose phone is on file becomes reachable again the moment they opt
-- back in — including employees whose text_bolt was overwritten. Nolan O'Kelly's
-- number is recoverable from phone; only the derived copy was ever lost.
-- Step 4 lists anyone whose phone will NOT normalise, the only group that now
-- needs data entry.
--
-- text_bolt is deliberately NOT dropped. It stays for one release as a fallback,
-- and its 'STOP' sentinel is what keeps an un-migrated deploy from texting
-- people who opted out. Nothing derives an address from it any more.
--
-- Run steps 1-3 in order. Back up the employees table first.

-- Step 1: add the column. Idempotent.
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS sms_opted_out BOOLEAN NOT NULL DEFAULT FALSE;

-- Step 2: preview what step 3 will change. Expect one row per 'STOP' employee.
SELECT id, name, phone, text_bolt
FROM employees
WHERE upper(btrim(text_bolt)) = 'STOP'
ORDER BY name;

-- Step 3: carry the opt-out over to the new column.
-- text_bolt is left as-is on purpose, per the note above.
UPDATE employees
SET sms_opted_out = TRUE
WHERE upper(btrim(text_bolt)) = 'STOP';

-- Step 4: ACTION REQUIRED — active employees whose phone will not normalise to
-- 10 digits. These people can never be texted, opted in or not, because there is
-- no number to derive an address from. Fill in the phone column for each.
SELECT
  name,
  phone,
  sms_opted_out,
  length(regexp_replace(COALESCE(phone, ''), '\D', '', 'g')) AS digit_count
FROM employees
WHERE status = 'Active'
  AND length(regexp_replace(COALESCE(phone, ''), '\D', '', 'g')) NOT IN (10, 11)
ORDER BY name;

-- Step 5: verify every 'STOP' row is now flagged. Should return zero rows.
SELECT id, name, text_bolt, sms_opted_out
FROM employees
WHERE upper(btrim(text_bolt)) = 'STOP'
  AND sms_opted_out IS NOT TRUE;

-- ---------------------------------------------------------------------------
-- Step 6: RECONCILIATION — run this before trusting the refactor.
--
-- The refactor assumes text_bolt was always just the phone number in TextBolt
-- form. This query tests that against the live data: it lists every active
-- employee whose stored text_bolt disagrees with the address now derived from
-- phone. Rows where text_bolt is 'STOP' or empty are excluded as expected.
--
-- Zero rows  = the assumption holds; nobody's texts change destination.
-- Any rows   = those employees' texts will now go to a DIFFERENT number than
--              before. Decide which value is correct before the next send.
-- ---------------------------------------------------------------------------
SELECT
  name,
  phone,
  text_bolt AS stored_address,
  '+1' || regexp_replace(
            regexp_replace(COALESCE(phone, ''), '\D', '', 'g'),
            '^1(\d{10})$', '\1'
          ) || '@sendemailtotext.com' AS derived_address
FROM employees
WHERE status = 'Active'
  AND text_bolt IS NOT NULL
  AND btrim(text_bolt) <> ''
  AND upper(btrim(text_bolt)) <> 'STOP'
  AND length(regexp_replace(COALESCE(phone, ''), '\D', '', 'g')) IN (10, 11)
  AND lower(btrim(text_bolt)) <> lower(
        '+1' || regexp_replace(
                  regexp_replace(COALESCE(phone, ''), '\D', '', 'g'),
                  '^1(\d{10})$', '\1'
                ) || '@sendemailtotext.com'
      )
ORDER BY name;
