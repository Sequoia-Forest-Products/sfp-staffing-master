# SFP Staffing Master

HR management web app for Sequoia Forest Products. Manages employees across departments: Sawmill, Maintenance, Filing Room, Log Yard, Shipping, and SG&A.

**Live app:** https://seq-staffing.netlify.app

---

## Architecture

| Layer | Technology |
|-------|-----------|
| Frontend | Single-page HTML/JS app (`app.html`) |
| Hosting | Netlify |
| Backend | Netlify Functions (Node.js) |
| Database | Supabase (PostgreSQL) |
| Auth | Google OAuth (restricted to sequoiafp.com domain) |
| File storage | Google Drive Shared Drive |
| SMS notifications | TextBolt (email-to-SMS gateway) |

---

## Features

- **Employees tab** — roster with search, filter, sort, inline edit modals, SMS reachability column, SMS opt-out toggle, Drive folder linking
- **Staffing Economics tab** — position assignment with wage, burdened cost, max wage, and variance
- **Overtime tab** — view/edit for Before Shift, After Shift, and Weekend Pre-Approved OT
- **Points Tracker tab** — attendance points with disciplinary flags, full CRUD
- **Daily Hours tab** — manual `.xlsx` payroll upload with preview-before-commit, imported-day
  history, department re-stamping, and the email pipeline's issue queue
- **OT Report tab** — weekly All / Pre-Approved / Net OT, scheduled vs. weekend split, and a
  department breakdown, on top of `daily_hours`
- **Payroll email ingestion** — hourly scheduled function reads the `payroll import` Gmail
  label on `info@` over IMAP and imports the daily report automatically
- **Birthday notifications** — daily scheduled function sends bilingual TextBolt texts
- **Copy TextBolt list** — derives addresses from phone for all active, opted-in employees

---

## Project Structure

```
sfp-staffing-master/
├── app.html                    # Main protected dashboard
├── index.html                  # Login page
├── icons/
│   └── staffing-and-hr.svg     # Favicon (SVG, referenced by both pages)
├── netlify.toml                # Config, redirects, scheduled functions
├── package.json
├── .env.example                # Environment variable template
├── SCHEMA_DAILY_HOURS.sql      # daily_hours + processed_emails + employee payroll fields
├── SCHEMA_NON_PRODUCTION.sql   # Adds the Non-Production department value to the CHECK
├── SCHEMA_DROP_DEPT.sql        # Step 5 of the department consolidation — gated, not yet run
├── SCHEMA_CHANGES.sql          # Superseded — the original weekly_hours OT report schema
├── SCHEMA_BIRTHDAY.sql         # Birthday data audit queries
├── SCHEMA_SMS_OPTOUT.sql       # sms_opted_out migration
├── PAYROLL_INGESTION.md        # Daily hours, email ingestion and OT report guide
├── tests/
│   ├── helpers/make-xlsx.js    # Builds real .xlsx files for the parser tests
│   ├── birthday.test.js
│   ├── xlsx-lite.test.js
│   ├── payroll.test.js
│   ├── ot-report.test.js
│   └── payroll-email.test.js   # Unit tests (npm test)
└── netlify/
    └── functions/
        ├── auth.js             # Google OAuth flow
        ├── session.js          # Session validation, serves app.html
        ├── logout.js           # Clears session cookie
        ├── data.js             # Supabase CRUD API
        ├── db.js               # Supabase REST helper
        ├── documents.js        # Google Drive folder management
        ├── birthday-lib.js     # Birthday notification logic (shared)
        ├── birthday-notifications.js  # Scheduled birthday notifications
        ├── birthday-test.js    # Manual / dry-run birthday trigger
        ├── xlsx-lite.js        # Dependency-free .xlsx reader (ZIP + XML)
        ├── payroll-lib.js      # Parsing, dollar derivation, department snapshotting
        ├── payroll-db.js       # Supabase helpers for daily_hours / processed_emails
        ├── payroll-import.js   # /api/payroll-import — preview, commit, days, re-stamp
        ├── ot-report-lib.js    # Weekly OT aggregation (pure)
        ├── payroll-report.js   # /api/payroll-report
        ├── payroll-email-lib.js       # IMAP ingestion logic (shared)
        ├── payroll-email-ingest.js    # Hourly scheduled ingestion
        ├── payroll-missed-check.js    # Daily missed-delivery check
        ├── payroll-email-test.js      # Manual / dry-run ingestion trigger
        └── ot-upload.js        # Deprecated — the old weekly_hours upload endpoint
```

---

## Environment Variables

| Variable | Value |
|----------|-------|
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `SESSION_SECRET` | Random HMAC signing key |
| `ALLOWED_DOMAIN` | `sequoiafp.com` |
| `ALLOWED_USERS` | Comma-separated extra emails |
| `SUPABASE_URL` | `https://zwghbbyzrycpnesuuzgi.supabase.co` |
| `SUPABASE_SERVICE_KEY` | Supabase service role key |
| `DOCS_FOLDER_ID` | `1TMyTQVjpQO8fTrGppx4KchaHRimwIi9Q` |
| `SHARED_DRIVE_ID` | `0AKnhIL1gZ8TmUk9PVA` |
| `GMAIL_USER` | Gmail address for birthday emails |
| `GMAIL_APP_PASSWORD` | Gmail app password |
| `BIRTHDAY_TRIGGER_SECRET` | Shared secret for the manual birthday trigger (optional) |
| `DRY_RUN` | Set to `true` to make the scheduled birthday run log without sending (optional) |
| `PAYROLL_IMAP_USER` | `info@sequoiafp.com` — the shared inbox the payroll report lands in |
| `PAYROLL_IMAP_PASSWORD` | Google app password for `info@`. **Never reuse `GMAIL_APP_PASSWORD`** |
| `PAYROLL_IMAP_LABEL` | `payroll import` — note the space; case-sensitive over IMAP |
| `PAYROLL_IMAP_HOST` | `imap.gmail.com` (optional) |
| `PAYROLL_SENDER` | `no-reply@centralservers.com` — validated in code, not just by the filter |
| `PAYROLL_ALERT_EMAIL` | Where parse failures and missed deliveries are emailed |
| `PAYROLL_TIME_ZONE` | `America/Los_Angeles` — the payroll vendor's zone, not the mill's |
| `PAYROLL_LOOKBACK_DAYS` | Rolling IMAP search window, default `7` |
| `PAYROLL_TRIGGER_SECRET` | Shared secret for the manual ingestion trigger (optional) |
| `PAYROLL_DRY_RUN` | Set to `true` to make the scheduled ingest parse and log without writing |

---

## Database Schema (Supabase)

### employees
`id, name, wage, dept, status, days, clock_in, clock_out, break_1, break_2, birthday, phone, language, email, sms_opted_out, drive_folder_id, employee_number, department`  
`text_bolt` — deprecated, no longer read or written; kept one release as a fallback.

`employee_number` is the payroll system's id, **TEXT and zero-padded** (`0319`). An integer
column destroys the padding, which is why an older install's `INTEGER` column is converted by
`SCHEMA_DAILY_HOURS.sql`. Every comparison normalises both sides with `lpad(...,4,'0')`.

`department` (`Maintenance | Saw Filing | Shipping | Production | Non-Production`) is the one
department field. The first four are production departments; `Non-Production` is where SG&A and
office staff go, and counts as assigned — without it the back-fill could never be finished, and
finishing it is what gates retiring `dept`. Nobody is placed there automatically.
Back-fill it on the Employees tab before importing payroll data — `daily_hours` snapshots the
department at import time.

`dept` is the **retired** predecessor (Sawmill / Filing Room / Log Yard / SG&A / ...). Nothing
reads it functionally any more and nothing writes to it; it survives only as the reference an
operator reads while hand-assigning `department`, and is dropped by `SCHEMA_DROP_DEPT.sql` once
the back-fill is verified complete.

There is **no automatic migration between the two**, and that is expected rather than an omission:
`Maintenance` and `Shipping` do not exist in the old value set at all, so the people now in them
are currently tagged Sawmill or Log Yard and no mapping table can recover the right answer. Every
employee is assigned by hand. `Filing Room` → `Saw Filing` is the single known rename and is
offered on the back-fill screen as a marked suggestion that will not commit itself.

### economics
`id, num, section, position, name, max_wage`

### overtime
`id, name, ot_type (Pre-Shift|Post-Shift|Weekend), hours, description`

Pre-approved OT. Per-employee (keyed by `name`), but with **no week column and no dollars** — the
Overtime tab replaces the whole table on save, so this is a *standing weekly allowance* applied to
every week, not a per-week entry. The OT Report says so on the page and derives the dollars as
`hours x rate x 1.5`.

Pre-approved OT has a **second component** that does not live in this table: a timeclock grace
allowance of `graceHoursPerEmployee` per active hourly employee per week (default 0.5, editable on
the Settings tab). Employees may clock in 7.5 minutes early and out 7.5 minutes late; that time is
compensable under California law, so it is pre-approved by policy. The report shows the two as
separate lines and combines them only in the summary. See `PAYROLL_INGESTION.md`.

### points
`id, name, points, last_point_date, level_up_eligible, disciplinary, disc_date`

### daily_hours
`id, work_date, employee_number, last_name, first_name, is_salary, pay_rate, regular_hours,
ot_hours, total_hours, total_earnings, ot_dollars, regular_dollars, is_scheduled_day, department,
source, source_subject, email_received_at, file_hash, date_source, flags, upload_batch_id,
created_at`

One row per employee per work day, `unique (work_date, employee_number)` so a re-send is
idempotent. `is_scheduled_day` is generated: Mon-Thu true, Fri-Sun false. `department` is a
**snapshot** taken at import, never a live join. `ot_dollars` is the residual
`total_earnings - regular_hours * pay_rate`, never `ot_hours * rate * 1.5`. See
`PAYROLL_INGESTION.md` for why both of those matter.

### processed_emails
`message_id, processed_at, work_date, status, error, subject, from_address, received_at,
file_hash, upload_batch_id, rows_imported, flags, notified_at`

The ingestion ledger, keyed by RFC822 Message-ID. Processing state lives here and never in the
mailbox's read/unread flags — the Gmail filter marks these messages read on arrival, and `info@`
is a shared inbox that humans work.

### weekly_hours — deprecated
The original OT report's table, superseded by `daily_hours`. Nothing reads or writes it any more;
`netlify/functions/ot-upload.js` is left in place but unreferenced. Drop both together.

---

## Google Drive (Shared Drive)

Employee files live at: **HR Shared Drive → Employee Files → [Employee Name]**

Key IDs:
- Shared Drive: `0AKnhIL1gZ8TmUk9PVA`
- Employee Files folder: `1TMyTQVjpQO8fTrGppx4KchaHRimwIi9Q`

API rules:
- GET: needs `supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=drive&driveId=0AKnhIL1gZ8TmUk9PVA`
- POST/PATCH/DELETE: needs `supportsAllDrives=true`

---

## Birthday Notifications

Announces birthdays to the whole crew — **everyone except the birthday person**
gets one bilingual (EN/ES) text via their TextBolt address.

**Schedule:** `30 13 * * 1-4` (in `netlify.toml`) — Mon–Thu at 13:30 UTC.
Netlify cron is UTC and does not follow DST, so this lands at **7:30 AM Mountain
in summer (MDT) and 6:30 AM in winter (MST)**. Shift the cron hour to `30 14`
over the winter if the earlier send is a problem.

**Look-ahead** (carried over from the old Apps Script, so nobody is missed over a
weekend):

| Run day | Covers |
|---------|--------|
| Mon–Wed | that day only |
| Thursday | that day + 3 (Fri, Sat, Sun) |
| Fri/Sat/Sun | never runs — cron skips it, and the code exits anyway |

**SFP runs a Mon–Thu work week.** Friday is a non-workday, which is why there is
deliberately no Friday run and why "over the upcoming weekend" correctly covers
Friday birthdays — for the mill, the weekend starts Friday. Thursday's 3-day
look-ahead already covers Fri/Sat/Sun, so a Friday run would also announce the
same people twice. The day guard rejects Friday as well as Sat/Sun, so a manual
trigger or a mocked Friday date cannot produce a send either.

All date math is done in `America/Boise`, never the server's UTC clock.

**Who gets a message:** every `Active` employee whose `phone` normalises to 10
digits and who has not opted out, minus the birthday people themselves. A phone
that will not normalise logs a `WARNING:` and is skipped; a blank phone is
ordinary data and is skipped quietly.

**Being named vs. receiving are separate things.** A usable phone number is
required to *receive* the message, never to be *named* in it. An employee with a
birthday but no phone, an unusable phone, or an SMS opt-out is still announced to
everyone else; they just get nothing themselves.

**Address derivation:** `phone` is the single source of truth for SMS. The
TextBolt address is built at send time and never stored:

```
phone "(509) 555-0123"  ->  strip to digits  ->  5095550123
                        ->  +15095550123@sendemailtotext.com
```

`phone` is a free-text column, so anything goes in — parens, dashes, dots,
spaces. A leading US country code is tolerated (`1-509-555-0123` works). Anything
that does not land on exactly 10 digits is skipped with a warning.

**Opt-out:** `employees.sms_opted_out` (BOOLEAN). The Employees tab toggle flips
this flag and never touches the phone number, so opting out and back in is fully
reversible with nothing to re-enter.

> **`text_bolt` is deprecated.** It used to hold the address, and the opt-out
> toggle used to overwrite it with the literal string `STOP`, destroying it.
> Nothing derives an address from it any more and nothing writes to it, so that
> damage no longer matters — the number still lives in `phone`. The column stays
> for one release as a fallback, and its `STOP` sentinel is still read by
> `isOptedOut()` so a database that has not yet run `SCHEMA_SMS_OPTOUT.sql`
> cannot start texting people who opted out. Drop the column and that fallback
> together.
>
> Before trusting the derivation, run **step 6 of `SCHEMA_SMS_OPTOUT.sql`** — it
> lists any employee whose stored `text_bolt` disagrees with the address derived
> from their `phone`. Zero rows means nobody's texts change destination.

**Birthday format:** `birthday` is TEXT and only month/day is ever read (year
ignored). Three shapes are accepted:

| Shape | Example |
|-------|---------|
| Full JS date string (what the live data holds) | `Mon Nov 12 1990 00:00:00 GMT-0800 (Pacific Standard Time)` |
| ISO / Postgres `DATE` | `1990-11-12` |
| Hand-entered free text | `3/15`, `3/15/1990` |

The first two shapes are parsed straight out of the string so no timezone can
shift the day. JS date strings go through `Date.parse`, which reads the numeric
offset and ignores the parenthesised label — the label is mislabelled on some
rows (`GMT-0800 (Pacific Daylight Time)`) and that is harmless. Every value is
midnight Pacific, i.e. 08:00 UTC the same calendar day, so reading month/day in
UTC never rolls the date.

Anything that matches none of the three logs a `WARNING:` line naming the
employee and the offending value. A blank birthday is normal data and is skipped
without a warning. `SCHEMA_BIRTHDAY.sql` has queries to audit both cases.

TextBolt format: `+1XXXXXXXXXX@sendemailtotext.com`

### Files

| File | Purpose |
|------|---------|
| `netlify/functions/birthday-lib.js` | All logic — dates, roster, message, sending |
| `netlify/functions/birthday-notifications.js` | The scheduled function |
| `netlify/functions/birthday-test.js` | Manual / dry-run trigger |
| `tests/birthday.test.js` | Unit tests (`npm test`) |

### Testing

Netlify **does not expose scheduled functions over HTTP**, which is why the
manual trigger is a separate function.

```bash
# Unit tests — no network, no credentials needed
npm test

# Dry run for today: composes the message, logs it, sends nothing
curl https://seq-staffing.netlify.app/api/birthday-test \
  -H "x-birthday-secret: $BIRTHDAY_TRIGGER_SECRET"

# Dry run pretending it is a given date (weekday logic included)
curl "https://seq-staffing.netlify.app/api/birthday-test?date=2026-03-13" \
  -H "x-birthday-secret: $BIRTHDAY_TRIGGER_SECRET"

# Actually send
curl "https://seq-staffing.netlify.app/api/birthday-test?send=true" \
  -H "x-birthday-secret: $BIRTHDAY_TRIGGER_SECRET"
```

A bare call is **always a dry run** — sending requires `?send=true`. The response
includes the composed subject, body, and full recipient list.

Instead of the header you can just open `/api/birthday-test` in a browser while
logged into the app; a valid `sfp_session` cookie is accepted too.

The real scheduled function can also be fired from the Netlify UI → Functions →
`birthday-notifications` → **Run now**, or with
`netlify functions:invoke birthday-notifications`. Set `DRY_RUN=true` in the
Netlify env vars to make even the scheduled run compose-and-log only.

---

## Daily Hours, Payroll Ingestion and the OT Report

Full guide: **[`PAYROLL_INGESTION.md`](PAYROLL_INGESTION.md)**. The short version:

The payroll system emails `Work Summary Payroll.xlsx` to `info@sequoiafp.com` every morning at
~6:04 AM Pacific. A Gmail filter labels it `payroll import` and skips the inbox. An hourly
scheduled function searches **only that label** over IMAP, parses the attachment, and upserts one
`daily_hours` row per employee. The OT Report tab reads that table; the Daily Hours tab is the
manual upload path and the permanent fallback.

Four things about it are load-bearing and easy to undo by accident:

1. **The work date is inferred from the email's arrival time**, because nothing in the message or
   the attachment states it. `work_date = received timestamp in America/Los_Angeles, minus one
   day`. Content hashing, arrival-time checks, duplicate-day detection and a manual correction
   action all exist to catch when that inference is wrong.
2. **Department is snapshotted onto every row at import**, never joined live. Employees transfer;
   a live join would silently rewrite historical reports the day somebody moves.
3. **OT dollars are the residual** `Total Earnings - Regular x Pay Rate`, not
   `OT x rate x 1.5`. California 4x10 pays 2.0x above 12 hours, and the flat multiplier
   undercounts by ~3%.
4. **Salaried employees are excluded at import**, so every dollar figure here is *hourly*
   payroll. The UI labels it that way; without the label the Net OT percentage reads as
   company-wide and is not.

Set-up order matters: run `SCHEMA_DAILY_HOURS.sql`, back-fill `employee_number` and `department`
on the Employees tab, import a day by hand, *then* turn on the email pipeline.

### Testing

```bash
npm test   # all suites: birthday, xlsx parser, payroll import, OT report, email ingestion

# Dry run of the ingestion — connects, parses, writes nothing
curl "https://seq-staffing.netlify.app/api/payroll-email-test" \
  -H "x-payroll-secret: $PAYROLL_TRIGGER_SECRET"

# Actually import what it finds — note -X POST
curl -X POST "https://seq-staffing.netlify.app/api/payroll-email-test?send=true" \
  -H "x-payroll-secret: $PAYROLL_TRIGGER_SECRET"

# Run the missed-delivery check instead (dry; add -X POST and ?send=true to alert for real)
curl "https://seq-staffing.netlify.app/api/payroll-email-test?check=missed" \
  -H "x-payroll-secret: $PAYROLL_TRIGGER_SECRET"
```

A bare call is always a dry run; importing requires `?send=true`. A valid `sfp_session` cookie is
accepted instead of the header, so you can just open the URL while signed in.

**GET is dry-run only; anything that writes or sends needs POST.** That is deliberate. The session
cookie is `SameSite=Lax`, which means a cross-site POST carries no cookie at all while a top-level
GET navigation does — so before this, a plain link or an `<img src>` on any page was enough to make
a signed-in browser import live payroll. Keeping the dry run on GET preserves the useful "just open
it in a browser" affordance without that exposure.

**What a red scheduled run means.** `payroll-email-ingest` and `payroll-missed-check` return a 5xx
only when the *alerting itself* failed, or Supabase could not be read — not when a message was bad.
A bad message is a green run with `status: "attention"`, because the alert about it went out. So a
function error in Netlify means the watchdog is blind, which is the one condition nobody would
otherwise notice. Netlify's function-error alerting keys on exactly that.

---

## Auth Flow

Google OAuth restricted to `sequoiafp.com`. Non-domain users can be added via `ALLOWED_USERS` env var. Session cookie is HMAC-signed, httpOnly, 8-hour TTL.

---

## Adding New Users

1. Add email to `ALLOWED_USERS` in Netlify env vars (if not @sequoiafp.com)
2. Share **SFP Staffing DB** Google Sheet with them (keeps birthday script working)

---

## Key IDs

| Resource | ID |
|----------|-----|
| Netlify site | seq-staffing |
| Supabase project | zwghbbyzrycpnesuuzgi |
| HR Shared Drive | 0AKnhIL1gZ8TmUk9PVA |
| Employee Files folder | 1TMyTQVjpQO8fTrGppx4KchaHRimwIi9Q |
| Google Cloud project | sfp-staffing-app |
| SFP Staffing DB sheet | 1_WJ8MuOz3kUfeCEl9Uq-FLvby8ggxnb5MLnz5yALzM4 |
