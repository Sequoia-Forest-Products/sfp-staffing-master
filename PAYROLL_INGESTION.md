# Daily Hours, Payroll Email Ingestion, and the OT Report

Everything the mill's OT reporting sits on: a per-day hours table, a way to get data
into it (by hand and automatically), and a weekly report on top.

---

## The short version

```
Payroll system (no-reply@centralservers.com)
   |  daily .xlsx, ~6:04 AM Pacific
   v
info@sequoiafp.com  — shared inbox
   |  Gmail filter applies the label: payroll import   (Skip Inbox, Mark as read)
   v
payroll-email-ingest   — hourly Netlify scheduled function, LABEL-SCOPED IMAP search
   |  processed_emails ledger  ->  parse .xlsx  ->  derive work date  ->  stamp department
   v
daily_hours  (upsert on work_date + employee_number)
   |
   v
OT Report tab   <-  /api/payroll-report   +   the overtime table (pre-approved OT)
```

Manual upload on the **Daily Hours** tab writes to the same table through the same
parser. It is the fallback whenever the pipeline is down, and it is how you back-fill
a day the vendor never sent.

---

## Set-up order — do these in this order

The order matters. `daily_hours` stores a **snapshot** of each employee's department
taken at import time, so rows imported before the back-fill land with a null
department and have to be re-stamped afterwards. Doing the back-fill first avoids
that cleanup entirely.

### 1. Run the migration

In the Supabase SQL editor, run all of `SCHEMA_DAILY_HOURS.sql`. It is idempotent —
every statement is guarded, so re-running it is safe. It creates `daily_hours` and
`processed_emails`, and adds `employees.employee_number` and `employees.department`.

If an older install created `employee_number` as `INTEGER` (the original
`SCHEMA_CHANGES.sql` did), the migration converts it to `TEXT` and restores the
zero-padding the integer type threw away.

### 2. Back-fill `employee_number` and `department`

Employees tab -> **Back-fill payroll fields**. One screen, both fields, every employee.

- `employee_number` is the payroll system's id, zero-padded to four characters
  (`0319`, `0063`, `9290`). Enter it exactly as payroll shows it. Matching normalises
  both sides with `lpad(...,4,'0')`, so an unpadded `319` still matches `0319` — but
  store the padded form.
- `department` is one of **Maintenance, Saw Filing, Shipping, Production**. This is
  deliberately a different column from the existing `dept` (Sawmill / Filing Room /
  Log Yard / SG&A / ...), which uses an older taxonomy. Nothing maps one onto the
  other automatically. `dept` is shown on the back-fill screen as reference only.

**Nothing is inferred here.** Not from `dept`, not from pay rate, not from name or job
title. The roster contains two employees named Smith and several compound surnames
(`Acosta Ruiz`, `Salazar De Leon`, `Sanchez Lopez`); a guess that is right 90% of the
time produces department numbers that are quietly wrong, which is worse than blank.

Verify with query 4a in `SCHEMA_DAILY_HOURS.sql`.

### 3. Import a day by hand and check the numbers

Daily Hours tab -> pick the file, pick the work date, **Preview**. Read the preview
before committing: row count, salaried rows skipped, per-department breakdown,
anything unmatched, any anomalies. Then commit.

Do this for a day or two before turning on the email pipeline. The report works on
manually uploaded data, and proving the data model on a known day is much easier than
debugging it through IMAP.

### 4. Confirm the Gmail filter

Already configured on `info@sequoiafp.com`:

```
Matches:  from:(no-reply@centralservers.com)
          subject:(Your Report Work Summary Payroll is ready)
          has:attachment
Do this:  Skip Inbox, Mark as read, Apply label "payroll import"
```

Confirm real payroll emails are actually landing under the label **before** trusting
the parser. Because "Skip Inbox" is set, these messages live under the label and in
All Mail — they are never in INBOX, and code that looks there finds nothing.

### 5. Set the environment variables

See `.env.example` for the full list with commentary. In Netlify -> Site
configuration -> Environment variables:

| Variable | Value |
|---|---|
| `PAYROLL_IMAP_USER` | `info@sequoiafp.com` |
| `PAYROLL_IMAP_PASSWORD` | a Google app password for `info@` |
| `PAYROLL_IMAP_LABEL` | `payroll import` — note the space |
| `PAYROLL_SENDER` | `no-reply@centralservers.com` |
| `PAYROLL_ALERT_EMAIL` | `peter.stroble@sequoiafp.com` |
| `PAYROLL_TIME_ZONE` | `America/Los_Angeles` |
| `PAYROLL_LOOKBACK_DAYS` | `7` |
| `PAYROLL_TRIGGER_SECRET` | random string, for the manual trigger |
| `PAYROLL_DRY_RUN` | `true` until you have watched a run |

**Do not reuse `GMAIL_USER` / `GMAIL_APP_PASSWORD`.** Those are the send-only
credentials for the birthday notifier. Separate credentials mean either can be rotated
without breaking the other, and the payroll integration can be revoked on its own.

### 6. Dry-run the ingest, then arm it

```bash
# Always a dry run: connects, finds messages, parses, writes nothing.
curl "https://seq-staffing.netlify.app/api/payroll-email-test" \
  -H "x-payroll-secret: $PAYROLL_TRIGGER_SECRET"

# Actually import what it finds. Note -X POST.
curl -X POST "https://seq-staffing.netlify.app/api/payroll-email-test?send=true" \
  -H "x-payroll-secret: $PAYROLL_TRIGGER_SECRET"

# Run the missed-delivery check instead (dry run; add -X POST and ?send=true to alert for real).
curl "https://seq-staffing.netlify.app/api/payroll-email-test?check=missed" \
  -H "x-payroll-secret: $PAYROLL_TRIGGER_SECRET"
```

A bare call is **always** a dry run; importing requires `?send=true`. You can also
just open `/api/payroll-email-test` in a browser while signed in to the app — a valid
`sfp_session` cookie is accepted instead of the header.

**GET is dry-run only. Anything that writes or sends requires POST**, which is why the
import example above carries `-X POST`. The session cookie is `SameSite=Lax`, so a
cross-site POST carries no cookie while a top-level GET navigation does — without this
split, a plain link or an `<img src>` on any page would fire a live import in a
signed-in browser. The dry run stays on GET so the browser affordance survives.

Once a dry run looks right, set `PAYROLL_DRY_RUN=false`.

### 7. Back-fill history from the label

Messages already sitting under `payroll import` can seed history — the same
received-timestamp rule applies. Raise `PAYROLL_LOOKBACK_DAYS` temporarily and run the
manual trigger with `?send=true`.

Messages that predate the filter may still be in the Inbox rather than under the label,
because "Skip Inbox" only applies going forward. The ingester will not see those; label
them by hand first if you want them. Check how far back usable messages actually go
rather than assuming.

Before trusting a back-filled week, run audit queries 4e and 4f in
`SCHEMA_DAILY_HOURS.sql`: no duplicate file hashes across dates, and no gaps on Mon-Thu.

---

## The shared inbox is the constraint

`info@sequoiafp.com` is a general company inbox holding customer and vendor
correspondence. An app password for it grants read access to **all** of that, not just
payroll. The decision was to use it anyway, with label scoping as the control. That
makes the scoping a hard requirement rather than a convention:

- The ingester opens **only** the mailbox named by `PAYROLL_IMAP_LABEL`. It never
  opens, searches, or lists INBOX or All Mail. This is the only thing limiting what the
  integration can see.
- The mailbox is opened **read-only**. Nothing is marked, flagged, moved, archived, or
  deleted. Humans work this inbox; the parser must be invisible to them.
- Processing state lives in `processed_emails`, never in read/unread flags. The Gmail
  filter marks these messages read on arrival, so read/unread carries no information —
  and if it did, a person opening the email before the hourly poll would make that day
  silently vanish.
- The sender is validated **in code**, not only by the filter. A labelled message from
  anyone other than `PAYROLL_SENDER` is recorded and reported, never parsed.
- The rolling 7-day search means a message that was missed on an earlier run is still
  found. The `unique (work_date, employee_number)` upsert makes re-processing harmless,
  so the pipeline errs toward re-checking rather than skipping.

The label name has a space in it. Gmail exposes labels as IMAP folder paths, so it has
to be quoted, and Gmail label names are case-sensitive over IMAP. The code uses the env
var verbatim — no slugifying, lowercasing, or camel-casing — and if the exact mailbox is
not found it fails loudly with the list of mailboxes that *were* found, because a silent
"no messages found" is the classic way this breaks.

---

## The work date is inferred — and that is the weak point

**Nothing in the email or the attachment says which day it covers.** Not the subject
(`Your Report Work Summary Payroll is ready`, static), not the body ("Your report is
ready."), not the filename, not a column in the sheet, not the document properties.

So:

```
work_date = (received timestamp converted to America/Los_Angeles) - 1 day
```

The conversion to Pacific happens **before** the calendar date is taken. The 6:04 AM
Pacific arrival is 13:04 UTC, so today the UTC date and the Pacific date agree — but any
drift in send time toward midnight would silently shift the date by a day, so the zone is
explicit in the code rather than incidental.

Because this is inference, five guardrails back it up:

1. **Content hash.** Every attachment is SHA-256'd. If a file's hash was already imported
   under a different date, it is a re-send or a vendor error and is **not** imported under
   the new date — it is flagged and reported. Identical payroll data for two different
   days is essentially impossible, which makes this the one true cross-check available.
2. **Arrival-time sanity.** Well outside the normal window, the previous-day assumption is
   suspect. The batch still imports but is flagged `late_arrival` and reported.
3. **Duplicate-day detection.** Two messages resolving to the same work date are both
   parked for review rather than one silently overwriting the other.
4. **The raw received timestamp is stored** on every row alongside the subject and hash,
   so a misdated batch can be found and re-stamped later.
5. **The UI says so.** Any day whose date came from an email arrival is labelled
   "inferred from email arrival" on the Daily Hours tab, and the **Correct date** action
   moves a batch to the right day without a re-upload.

If the date cannot be established with confidence, nothing is inserted: the message is
parked in `pending_review` and Peter is emailed. A silently wrong date corrupts a week's
totals in a way that is very hard to spot afterwards.

> **Worth asking the vendor:** can Central Servers put the reporting date in the subject
> line, the body, or the file itself? Many report schedulers support a date token in the
> report name. If so, that removes this entire class of risk and should replace the
> inference above. Low effort to ask, high payoff.

---

## What the file contains, and what we do with it

`Work Summary Payroll.xlsx`, one sheet of the same name, header row 1, one row per
employee, **one day per file**, ~6.6 KB.

| Column | Notes |
|---|---|
| `Emp #` | **TEXT, zero-padded**: `0319`. Stored as text; an integer column destroys the padding |
| `Last Name`, `First Name` | |
| `Is Salary` | `Yes` / `No` |
| `Pay Rate` | hourly base rate; `0` for every salaried employee |
| `Regular`, `OT`, `Total Hours` | hours |
| `Total Earnings` | **blended regular + OT dollars in one column** |

### Salaried employees are excluded

Every salaried row in the source arrives as zeros — no rate, no hours, no earnings — so
they contribute nothing. Rows with `Is Salary = Yes` are skipped at import, and the
skipped count is shown in the upload preview so the exclusion is visible rather than
silent.

The safety valve: a salaried row that ever arrives with **non-zero** hours or earnings is
**not** dropped. It is imported, flagged `salaried_with_hours`, and reported — that would
mean the payroll system's behaviour changed and this assumption no longer holds.

Because salaried staff are excluded by design, every dollar figure in this system is
**hourly payroll**, and the UI says so everywhere. Without that label the Net OT
percentage reads as company-wide, and it is not.

### Dollars are derived by residual, not by a flat multiplier

`Total Earnings` is one blended number, so OT dollars have to be backed out:

```
regular_dollars = Regular x Pay Rate
ot_dollars      = Total Earnings - regular_dollars      <- residual
```

Validated against a real day's file: the residual method totals **$1,026.03** of OT;
`OT x rate x 1.5` totals **$995.22**, undercounting by ~3% because it misses the
double-time tier. California 4x10 pays base to 10 hours, 1.5x from 10-12, and **2.0x
above 12** — three employees crossed 12 hours in that one sample. The residual is exact
by construction and needs no assumption about tier boundaries, so it stays correct if the
pay rules ever change.

Guardrails: residuals between `-$1.00` and `0` are penny-rounding in the payroll system
and clamp to zero. Anything more negative keeps its real value and is flagged
`negative_residual` for review rather than being silently zeroed.

`total_earnings` is **never** recomputed or overwritten. The payroll system's figure is
the source of truth for payroll dollars.

### Department is snapshotted, not joined

The payroll file has no department column. Department comes from `employees.department`,
matched on `employee_number`, and is **copied onto each `daily_hours` row at import**.
Reports read that snapshot and never join live to `employees`.

This is the difference between a report you can trust and one you cannot. Employees
transfer between departments. If reports joined live, the day someone moved from
Production to Maintenance, *every historical report would silently rewrite itself* — last
quarter's Maintenance weekend costs would change retroactively, with nothing to indicate
it happened. Snapshotting freezes each day's hours to the department the employee was
actually in when they worked. Cheap to do at import; effectively impossible to
reconstruct later.

When an `employee_number` matches nobody, or the matched employee has no department, the
row stores a null department and shows as **Unassigned** in the preview and on the
report. It is never bucketed into a real department to make the numbers foot — that hides
the gap instead of showing it.

After back-filling a previously-missing employee, use **Re-stamp departments** on the
Daily Hours tab over an explicit date range. It is deliberately manual and scoped; it
never runs on its own.

### Matching is by employee number only

Never by name. The roster has two employees named Smith and several compound surnames
that do not survive a round trip between systems. Both sides of every comparison are
normalised with a four-character zero pad, so `319` and `0319` match either way round.

---

## The work week

Monday-Thursday is the scheduled 4x10 block. **Friday, Saturday and Sunday are
non-scheduled** — and maintenance crews work them, so those days carry real, legitimate
data. Nothing rejects or warns on a Fri/Sat/Sun date; `is_scheduled_day` simply
classifies it.

The reporting week runs **Monday through Sunday**, so weekend maintenance work lands in
the same week as the shift that preceded it.

On a non-scheduled day essentially *all* hours are exceptional — nobody is scheduled, so
a Saturday shift is entirely incremental labour regardless of how payroll splits it
between regular and OT. The report therefore shows two weekend numbers and does not
conflate them:

- **Non-Scheduled OT $** — the OT portion only, comparable against pre-approved OT
- **Total Non-Scheduled Labor $** — all Fri-Sun earnings, the true cost of weekend work

The second is usually the one that matters, because much of a weekend shift is paid at
regular rate and would be invisible in an OT-only view.

---

## Pre-approved OT: what the `overtime` table actually is

Read this before interpreting Net OT.

The existing `overtime` table is `id, name, ot_type ('Pre-Shift' | 'Post-Shift' |
'Weekend'), hours, description`. Which means:

- **It is per-employee**, keyed by `name`. So department-level Net OT *is* computable:
  resolve `name` -> `employees` -> `employee_number` -> the department snapshot on that
  employee's `daily_hours` rows for the week.
- **It has no week dimension.** There is no date column and the Overtime tab replaces the
  whole table on save. It is a **standing weekly allowance**, applied identically to every
  week — not a per-week entry. The OT Report says so on the page, because the number is
  otherwise easy to misread as "pre-approved OT for this specific week".
- **It has no dollars.** Pre-approved OT dollars are **derived**: `hours x rate x 1.5`,
  where the rate is the employee's `pay_rate` observed in `daily_hours` that week, falling
  back to `employees.wage`. Where neither exists, the dollars are zero and the name is
  listed under `rateMissing` rather than being quietly dropped.

All three `ot_type` values count toward pre-approved OT, with a per-type breakdown on the
report. The older report counted only `Weekend` and added a hardcoded half-hour-per-head
allowance; both of those are gone.

Pre-approved OT belonging to someone with **no hours that week** — approved but not
worked — has no `daily_hours` row to inherit a department from. It falls back to the
employee's current `employees.department` and is listed separately. It is never dropped;
approved-but-unworked OT is itself worth seeing.

**Department rows must sum to the mill-wide totals.** The report computes that comparison
and shows the delta when it does not balance, rather than quietly reconciling it.

> **To confirm with Peter:** the Monday-Sunday week boundary, and whether a standing
> allowance is the right reading of the Overtime tab — if pre-approved OT is really meant
> per week, that table needs a week column and the Overtime tab needs a week selector.

---

## "No data" is not "nobody worked"

A Saturday with zero rows because no email arrived looks exactly like a Saturday nobody
worked. With an automated pipeline, a missed email is the more likely of the two. The
report tracks expected-versus-received days explicitly and renders three distinct states:

| State | Meaning |
|---|---|
| **data** | rows imported for that day |
| **missing** | a scheduled Mon-Thu day with no rows — a probable missed delivery, shown as a problem |
| **no data** | a Fri-Sun day with no rows — nobody worked, *or* no report arrived. Unknown, and shown as unknown |

The daily missed-delivery check is the other half of this. Nobody forwards these emails
by hand, so nobody would notice if they stopped arriving. Once a day it checks whether the
expected prior work day landed and emails Peter if a **Mon-Thu** day is missing. A quiet
Fri/Sat/Sun is reported but does not alert, because nobody may have worked. An alert
saying "no payroll data for Tuesday" the next morning is worth more than any amount of
parser robustness.

### Reading the scheduled runs

A **red** run of `payroll-email-ingest` or `payroll-missed-check` does not mean a message
was bad. It means the alerting itself failed, or Supabase could not be read — that the
watchdog is blind. A bad message is a **green** run carrying `status: "attention"`,
because the alert about it went out as intended.

That inversion is the point. Netlify's function-error alerting fires on a non-2xx, so the
condition it surfaces is the only one nobody else would catch: an ingest that quietly
stopped being able to tell you anything. Everything the pipeline *can* tell you arrives by
email or shows up in the Daily Hours tab's ingestion-issues panel.

A pending item is reported at most once a day and its wording ages ("unresolved since ...")
rather than repeating verbatim, and marking it handled closes it for good. Repeating an
alert nobody can close is how people learn to ignore the one that matters.

A run that hit the message cap reports itself as incomplete and alerts on that alone, even
when every message it did read was fine. A bounded pass must never look like a complete one.

---

## Files

| File | Purpose |
|---|---|
| `SCHEMA_DAILY_HOURS.sql` | Migration + audit queries. Idempotent |
| `netlify/functions/xlsx-lite.js` | Dependency-free .xlsx reader (ZIP + XML) |
| `netlify/functions/payroll-lib.js` | Parsing, dollar derivation, department stamping, validation |
| `netlify/functions/payroll-db.js` | Supabase REST helpers for `daily_hours` / `processed_emails` |
| `netlify/functions/payroll-import.js` | `/api/payroll-import` — preview, commit, days, re-stamp, correct date |
| `netlify/functions/ot-report-lib.js` | Weekly aggregation, all of it pure |
| `netlify/functions/payroll-report.js` | `/api/payroll-report` |
| `netlify/functions/payroll-email-lib.js` | IMAP ingestion logic, injectable for tests |
| `netlify/functions/payroll-email-ingest.js` | Hourly scheduled function |
| `netlify/functions/payroll-missed-check.js` | Daily missed-delivery check |
| `netlify/functions/payroll-email-test.js` | Manual / dry-run trigger |
| `tests/xlsx-lite.test.js`, `tests/payroll.test.js`, `tests/ot-report.test.js`, `tests/payroll-email.test.js` | `npm test` |

Schedules live in `netlify.toml`. Netlify cron is UTC and does not follow DST, exactly as
noted for the birthday notifier: the ingest runs at `15 * * * *` (hourly, off the top of
the hour), and the missed-delivery check at `0 19 * * *` — 12:00 PM Pacific in summer,
11:00 AM in winter, well after the delivery window has closed so that a merely late
report is not reported as a missing one. To trim invocations, `15 12-20 * * *` covers
5:15 AM to 1:15 PM Pacific, which is the realistic arrival window.

---

## Troubleshooting

**"No messages found" but the emails are clearly there.**
Almost always the label path. The filter sets "Skip Inbox", so these messages are *not*
in INBOX. Check `PAYROLL_IMAP_LABEL` matches the Gmail label exactly, including the space
and the capitalisation. The manual trigger's dry run reports the mailboxes it actually
found — compare that list against what you configured.

**A day imported under the wrong date.**
Daily Hours tab -> the day's row -> **Correct date**. That moves the whole batch and marks
the date as manually set rather than inferred. If the same file also imported under the
right date, delete the wrong day.

**A whole department reads as Unassigned.**
Those employees are missing `department` (or `employee_number`) on the roster. Back-fill
them on the Employees tab, then **Re-stamp departments** over the affected date range.
Audit queries 4b and 4c in `SCHEMA_DAILY_HOURS.sql` list exactly who.

**Department rows do not sum to the mill totals.**
The report shows the delta rather than hiding it. It normally means rows carrying a null
department are in the Unassigned bucket and something is filtering it out — start with
audit query 4c.

**OT dollars look too low.**
Check whether something is applying a flat 1.5x. The residual method is the correct one;
see the derivation section above.

**Nothing arrived at all this morning.**
The missed-delivery check emails on a missing Mon-Thu day. Confirm the vendor still sends
to `info@`, that the Gmail filter still matches (vendors change subject lines), and that
the app password has not been revoked. The Daily Hours tab's **Ingestion issues** panel
lists every message the pipeline could not process and why.
