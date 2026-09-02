# SFP Staffing Master

HR management web app for Sequoia Forest Products. Manages employees across departments: Sawmill, Maintenance, Filing Room, Log Yard, Shipping, and SG&A.

**Live app:** https://seq-staffing.netlify.app

---

## Architecture

| Layer | Technology |
|-------|-----------|
| Frontend | Single-page HTML/JS app (`public/app.html` + `src/js/*.js`, assembled per request) |
| Hosting | Netlify |
| Backend | Netlify Functions (Node.js) |
| Database | Supabase (PostgreSQL) |
| Auth | Google OAuth (restricted to sequoiafp.com domain) |
| File storage | Google Drive Shared Drive |
| SMS notifications | TextBolt (email-to-SMS gateway) |

---

## Features

- **Employees tab** — roster with search, filter, sort, inline edit modals, the employee profile
  card, SMS reachability column, SMS opt-out toggle, Drive folder linking
- **Manufacturing Costs tab** — labour cost for `cost_class = 'Manufacturing'`, aggregated by
  department and position group, with burdened cost and cost per MBF. Replaced Staffing Economics.
  Aggregates only: no individual's pay rate is sent to the browser, and a grouping too small to
  average withholds its money rather than publishing somebody's rate as a bucket average.
- **Overhead tab** — the same report for `Mill Overhead` and `SG&A`, **totals only**. No department
  breakdown: SG&A is 7 people across 5 departments, so nearly every row would have to withhold its
  cost. See *Deferred to Phase D*.
- **Daily Hours tab** — manual `.xlsx` payroll upload with preview-before-commit, imported-day
  history, department re-stamping, and the email pipeline's issue queue
- **Cost allocation** — a person's cost can split across departments (Jeff Cook 50/50 Corporate /
  Sales & Marketing; Axeri Ramirez thirds across HR / Corporate / Accounting). Cost only, never
  hours. Percentages must sum to 100, enforced in the UI, the API and the database. Edited on the
  profile card.
- **Reports tab** — three sub-views: **Pre-Approved Overtime** (Pre-Shift, Post-Shift, Weekend),
  the weekly **OT Report** (All / Pre-Approved / Net OT, scheduled vs. weekend split, department
  breakdown, manager email), and the **Points Tracker** (attendance points, disciplinary flags)
- **Payroll email ingestion** — hourly scheduled function reads the `payroll import` Gmail
  label on `info@` over IMAP and imports the daily report automatically
- **Weekly manager OT email** — Monday scheduled function emails the Mon–Sun week that just
  finished to the manager list. Refuses to send an incomplete week and alerts instead
- **Birthday notifications** — daily scheduled function sends bilingual TextBolt texts
- **Copy TextBolt list** — derives addresses from phone for all active, opted-in employees

---

## Project Structure

```
sfp-staffing-master/
├── public/                     # THE PUBLISH DIRECTORY — everything in here is
│   │                           # world-readable with no session check, and
│   │                           # nothing outside it is served at all.
│   ├── app.html                # Main protected dashboard (served only by
│   │                           # session.js, via a forced redirect)
│   ├── index.html              # Login page
│   └── icons/
│       └── staffing-and-hr.svg # Favicon (SVG, referenced by both pages)
├── src/js/                     # App modules — assembled into app.html at
│                               # request time by session.js. Deliberately
│                               # OUTSIDE public/ so they cannot be fetched
│                               # one by one.
├── netlify.toml                # Config, redirects, scheduled functions
├── package.json
├── .env.example                # Environment variable template
├── SCHEMA_DAILY_HOURS.sql      # daily_hours + processed_emails + employee payroll fields
├── SCHEMA_DEPARTMENT_VALUES.sql # Sets the six allowed department values on the CHECK
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
        ├── session.js          # Session validation, assembles public/app.html
        ├── logout.js           # Clears session cookie
        ├── session-lib.js      # THE session verifier and signer — was eleven copies
        ├── data.js             # Supabase CRUD API
        ├── db.js               # Supabase REST helper
        ├── cost-lib.js         # Cost aggregation by cost class (pure), with
        │                       # small-bucket suppression
        ├── cost-report.js      # /api/cost-report — Manufacturing Costs + Overhead
        ├── preapproved-ot.js   # /api/preapproved-ot — standing OT allowance,
        │                       # one row per write, never replace-all
        ├── allocations.js      # /api/allocations — cost splits, sum-to-100
        ├── week-index-lib.js   # The week picker and bounded window scan, shared
        │                       # by /api/payroll-report and /api/cost-report
        ├── documents.js        # Google Drive folder management
        ├── birthday-lib.js     # Birthday notification logic (shared)
        ├── birthday-notifications.js  # Scheduled birthday notifications
        ├── birthday-test.js    # Manual / dry-run birthday trigger
        ├── xlsx-lite.js        # Dependency-free .xlsx reader (ZIP + XML)
        ├── payroll-lib.js      # Parsing, dollar derivation, department snapshotting
        ├── payroll-db.js       # Supabase helpers for daily_hours / processed_emails
        ├── payroll-import.js   # /api/payroll-import — preview, commit, days, re-stamp
        ├── ot-report-lib.js    # Weekly OT aggregation (pure)
        ├── payroll-report.js   # /api/payroll-report + the shared week builders
        ├── ot-weekly-email-lib.js     # Monday manager email logic (shared)
        ├── ot-weekly-email.js         # Monday scheduled manager email
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
| `OT_WEEKLY_DRY_RUN` | Set to `true` to make the Monday manager email compose and log without sending |
| `OT_REPORT_LINK` | Override the "Open OT Report" link in the manager email (optional) |

---

## Database Schema (Supabase)

### employees
`id, name, wage, dept, status, days, clock_in, clock_out, break_1, break_2, birthday, phone, language, email, sms_opted_out, drive_folder_id, employee_number, department, hire_date`  
Plus the four axes below, and `annual_salary`.  
`text_bolt` — deprecated, no longer read or written; kept one release as a fallback.

`wage` is an **hourly rate and nothing else**, and it is **ours** — the record of truth behind
every dollar this system computes. It is NULL for salaried people; the literal `'Salary'` sentinel
was retired 2026-08-22. It is typed on the **Salaries & Wages** page by any signed-in user
(`permissions-lib.js` allows it at the base tier), and every change is recorded in `wage_history`,
which is append-only — the server writes the history row **before** the rate, so a failure between
the two leaves a record with no change rather than a change with no record.

It belonged to BBSI until 2026-08-22: the daily file carried a Pay Rate column and
`payroll-db.updateEmployeeWage` rewrote this column every morning. That rate was never a source of
truth — BBSI keyed it by hand out of their payroll system into Timenet so the feed could exist, and
nobody maintains it there any more. The import stopped reading it; see **daily_hours** below and
`SCHEMA_RATE_OWNED_BY_APP.sql`.

The client writers do not send `wage`, and that is now load-bearing rather than belt-and-braces:
the server would accept it. A roster Save carrying the browser's stale copy would overwrite a rate
and append a `wage_history` row saying it moved when nobody touched it. Rates are set one row at a
time, on one page.

`syncToSheet()` — a loop that PATCHed **every** roster row — was deleted for this reason. Its
button had been gone since `531018b` and it had been unreachable (and would have thrown on its
first line) ever since, but a dormant whole-roster writer against the compensation table is not
worth keeping now that the column is writable. If a bulk roster write is ever wanted again it needs
a design, not that function restored.

`hire_date` (DATE) exists and is **empty**. Added by `SCHEMA_PHASE_D_PERMISSIONS.sql` §4 with no
backfill: a guessed start date reads as a fact. BBSI likely has the real ones.

`employee_number` is the payroll system's id, **TEXT and zero-padded** (`0319`). An integer
column destroys the padding, which is why an older install's `INTEGER` column is converted by
`SCHEMA_DAILY_HOURS.sql`. Every comparison normalises both sides with `lpad(...,4,'0')`.

### The four axes

Architecture v2 separates four independent facts about a person. None is derived from another,
and each answers only its own question:

| Column | Question | Values |
|---|---|---|
| `pay_type` | Do daily hours flow in? | `Hourly`, `Salaried` |
| `cost_class` | Which accounting bucket, which tab? | `Manufacturing`, `Mill Overhead`, `SG&A` |
| `department` | Which line within that bucket? | twelve values, below |
| `position_group` | Where in the mill do they work? | nine values, planning only |

`department` — **Manufacturing:** `Log Yard`, `Clean-up`, `Shipping`, `Maintenance`, `Production`,
`Saw Filing` · **Mill Overhead:** `Mill Overhead` · **SG&A:** `Sales & Marketing`, `Procurement`,
`Accounting`, `HR`, `Corporate`.

`position_group` — `Supervisors`, `Maintenance`, `Saw Filing`, `Log Yard`, `Sawmill Operators`,
`Bakerville`, `Green Chain`, `Extras`, `Shipping`.

**Department is never derived from position group, for anyone.** Four names appear in both lists
and the match is not a mapping: `Supervisors` spans departments, so a supervisor's department is
set independently of where they stand in the mill. `Extras` is a real position group — floor staff
who move where they are needed — and is *not* the bullpen; the bullpen is the separate condition of
having no classification at all.

`pay_type` replaces the old convention of storing the literal string `Salary` in `wage`. That made
one column both the wage and the pay-type flag, and the two disagreed: a lowercase `salary`
rendered as `$NaN` on the roster while being correctly excluded from the costing report. `wage` now
holds an hourly rate or nothing; salaried compensation lives in `annual_salary`.
Set it before importing payroll data — `daily_hours` snapshots the department at import time, so
a row imported for an employee with no department lands as Unassigned.

`dept` is the **retired** predecessor (Sawmill / Filing Room / Log Yard / SG&A / ...). Nothing
reads it functionally and nothing writes to it; it is dropped by `SCHEMA_DROP_DEPT.sql`.

There was **no automatic migration between the two** — the value sets do not correspond, so every
employee was assigned by hand. The one-off bulk back-fill screen that existed for that migration
has been removed now that it is done; departments are set per employee in the edit modal.

### user_permissions
`id, email, tier, granted_by, granted_at, note` — `SCHEMA_PHASE_D_PERMISSIONS.sql`

Who holds which permission tier. **Membership is data**: granting access is an INSERT, not a
deploy. What a tier *means* — which columns it unlocks — is in `netlify/functions/permissions-lib.js`,
because that is a decision about the shape of the app and belongs where it can be tested.

| tier | stored? | unlocks |
|---|---|---|
| `hourly_wages` | **never** | the base. Every signed-in user holds it. `wage` is readable **and writable** by everyone by decision — see `employees` above. |
| `salaries` | yes | `annual_salary`, read and write |
| `admin` | yes | may grant and revoke the other two, and change everything on Settings. Does not by itself unlock compensation. |

### READ THIS BEFORE GRANTING ANYBODY ACCESS

**Adding someone to this app gives them the ability to change anyone's pay rate.**

That is a real change in what app access means, made deliberately on 2026-08-22, and it is
stated here rather than left to be discovered. Since the daily file stopped carrying a rate,
`employees.wage` is the record of truth behind every dollar the system computes, and it is
writable at the base tier — no grant, no tier, nothing to configure. A new user's first login
gives them a field on Salaries & Wages next to every hourly employee in the company.

What that is bounded by:

- **Nothing is silent.** Every change writes a `wage_history` row carrying the previous rate,
  the new one, the percentage move, and the email of whoever typed it. The table is append-only,
  enforced by a trigger the service key cannot bypass, so the record cannot be edited away.
- **A large move is flagged**, not blocked — `WAGE_CHANGE_ALERT_PCT`, default 20%.
- **The blast radius is one row at a time.** There is no bulk rate writer in the app; the one
  that existed was deleted for exactly this reason.
- **`annual_salary` is not included.** That stays behind the `salaries` tier in both directions.

The alternative was gating rates behind a tier, which would have meant the two accounts holding
`salaries` doing every rate correction for the whole mill. That was rejected knowingly. If the
roster of app users ever widens beyond people who should see and set pay, this is the decision
to revisit first.

A missing row means the base tier, **not no access** — which is why `hourly_wages` is refused by a
CHECK rather than merely ignored by the code. A row asserting it would make presence and absence
mean the same thing. `email` is stored lowercased and trimmed, enforced by a CHECK, and unique per
(email, tier); Ryley and Peter each hold two tiers, so two rows.

RLS is enabled with **no policies** — that is the intended state, not a gap: with none defined, RLS
denies everything to every role subject to it. The Netlify functions reach Supabase with the service
key, which bypasses RLS; no browser talks to PostgREST directly.

**The last admin cannot be revoked.** A statement-level trigger refuses it, and refuses `TRUNCATE`
separately, because a delete trigger does not fire on TRUNCATE. Handing over means grant first, then
revoke — each statement is judged on its own. `DROP TABLE` is the one case no trigger can cover, and
§7 of the migration documents the recovery: one INSERT in the Supabase SQL editor. There is
deliberately **no hardcoded fallback admin** in the code, because a permanent grant no revoke can
reach is a worse failure than the one it prevents.

Resolution **fails closed** in every mode — no grant row, no table, or a read that errors all give
the base tier. That costs an admin their admin until it recovers, which is the correct trade.

### economics
`id, num, section, seat, name, max_wage, created_at, updated_at`

**`seat`, not `position`.** The two are different concepts that shared a name until they were
separated:

| | |
|---|---|
| `employees.position` | a person's **job title** — `Millwright`, `Debarker` |
| `economics.seat` | a numbered **slot in the staffing plan** — `Millwright 1`, `Utility 1`–`7` |

The row is the seat, not the person: `name` is whoever is assigned to it and is nullable, because
an unfilled seat is a real and useful row. `max_wage` is the rate ceiling for **that seat**, and
`section` groups seats for reporting. Merging the two columns would lose the unfilled seats and the
per-seat ceiling. Renamed by `SCHEMA_ECONOMICS_SEAT.sql`.

The staffing plan behind the **Staffing Economics** tab: 55 numbered seats, each with the employee
assigned to it and a maximum hourly rate to compare against. `seat` here is NOT a job title —
`employees.position` is, loaded from the classification worksheet.

**Phase C deleted the tab; Phase D brought it back, read-only and gated.** It was deleted because it
rendered every seat's holder next to their hourly rate and a ceiling, and with no permissions system
that was readable by every signed-in account. Manufacturing Costs answered the costing question in
aggregate but not this one — "is the person in this seat inside the ceiling budgeted for it" — and
`max_wage` and the variance column had no replacement anywhere.

**The table has one owner: `/api/economics`.** It is off the `/api/data` allowlist entirely — not
"read-only there", not reachable there. It briefly was allowlisted behind a read-only exception,
but the moment seat assignment had to be editable that stopped being the right shape: a generic
table endpoint with per-table exceptions is one edit away from re-exposing the write path that got
the table removed in the first place.

| | |
|---|---|
| `GET /api/economics` | every seat, in `num` order. Needs the **salaries tier**, all-or-nothing — unlike the employees projection, which narrows a row, every column here is part of the same compensation view. |
| `PATCH /api/economics` `{id, name}` | assign or unassign **one** seat. Needs the salaries tier. |

**Only `name` is writable.** `num`, `section`, `seat` and `max_wage` are the plan; moving a ceiling
is a budgeting decision rather than a staffing one, and a body naming any of them is **refused, not
filtered** — a 200 that silently dropped `max_wage` would report a ceiling change that did not
happen. There is no create and no delete: adding or removing a seat changes the size of the plan.

**No replace-all, ever.** The old page saved the whole table with `PUT` → `db.replaceAll`, which
DELETEs every row and re-inserts, over the only record of a per-seat rate ceiling, with no screen
that would have shown it had been emptied. The unit of change is one seat, and nothing here can
touch a row the caller did not name.

**A seat points at a person, not at a string.** `economics.employee_id` is a foreign key to
`employees(id)` and is the only thing that decides who is in a seat; the occupant's name is resolved
through it on every read. Renaming somebody on the Employees tab moves their seat with them.

It used to be the text column `economics.name`, which is how `Tim Green` and `Timothy Green` became
two people earlier in this project. Validating the incoming name against the roster stopped a bad
name going **in** and could do nothing about a good one going **stale** afterwards — the seat
silently read as "not on the roster", their rate dropped out of the wage pool, and nothing reported
that a rename had done it. `SCHEMA_ECONOMICS_EMPLOYEE_ID.sql` added the key.

`ON DELETE SET NULL`, and both alternatives are wrong: `RESTRICT` would make removing a leaver
depend on the staffing plan, and `CASCADE` would delete the **seat**, taking `max_wage` — the one
figure here with no other copy — with it. A seat outlives its occupant.

No unique constraint on `employee_id`: somebody in two seats is allowed and reported, because
refusing would make a straight swap impossible without unassigning first. The page flags it, and the
check is by id, so it catches what a name comparison could not — the same person in two seats under
two spellings.

`name` is retained and **no longer read**. It holds the only record of the occupant for any row the
backfill could not match, and the endpoint writes it alongside the key purely as a last-known
spelling. Dropping it is a later, deliberate change — see §5 of the migration.

**Works either side of the migration**, so there is no deploy order to get right. The read asks for
`employee_id` and falls back a rung on 42703, resolving from the stored name as before; the write
requires the column and answers 503 naming the file, because an assignment landing in the text
column would be a write no build that reads the key would ever show.

### preapproved_ot
`id, employee_id -> employees(id), ot_type (Pre-Shift|Post-Shift|Weekend), hours, description, created_at, updated_at`
`unique (employee_id, ot_type)`

The standing weekly pre-approved OT allowance. **No week column** — the same figure applies to every
week. Assigned per employee on the profile card, one row at a time, through `/api/preapproved-ot`;
the unique constraint makes a duplicate impossible, which is what the old table could not do.

An **inactive** employee's allowance counts nowhere. An allowance is permission to work overtime, so
somebody who has left cannot use it; crediting them understates Net OT every week. The report lists
those rows under `preApproved.inactiveSkipped` so they can be deleted rather than silently ignored.

Created and migrated by `SCHEMA_PHASE_C_PREAPPROVED_OT.sql`.

### employee_allocations
`id, employee_id -> employees(id), department, percent, created_at, updated_at`
`unique (employee_id, department)`

Cost allocation **exceptions**: no rows means 100% to `employees.department`, which is why 65 of 67
people are not in this table. Applies to **cost only, never to hours** — Axeri Ramirez works whole
hours in Accounting and it is her cost that splits three ways.

The percentages for one employee must sum to **exactly 100**, enforced by a deferred constraint
trigger (a `CHECK` cannot span rows). Zero rows is valid and means no allocation. Writes go through
`set_employee_allocations(uuid, jsonb)` so the whole set changes in one transaction — PostgREST gives
each HTTP request its own, and an insert-then-delete would trip the check at over 100%.

Created by `SCHEMA_PHASE_C_ALLOCATIONS.sql`.

### overtime (superseded)
`id, name, ot_type (Pre-Shift|Post-Shift|Weekend), hours, description`

**Replaced by `preapproved_ot` in Phase C. Kept, not dropped:** it is the only record of the
pre-migration state, and the migration's verification queries reconcile against it. Nothing in the
app reads it except as a fallback while `preapproved_ot` does not exist.

It matched employees by **name**, typed into a free-text box. The roster has two people called Smith,
so a name key silently picks the first — which is how one person became two phantom entries, the
hours on one and the allowance on the other, reported as "approved but never worked". It also saved
by replacing the whole table, which is how a byte-identical duplicate row got in and was counted for
months. Dollars are still derived as `hours x rate x 1.5`; they were never stored.

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
**snapshot** taken at import, never a live join.

**THE FEED IS HOURS-ONLY SINCE 2026-08-22.** `pay_rate`, `total_earnings`, `ot_dollars` and
`regular_dollars` are **NULL on every row imported since**, and hold real vendor figures on every
row before it. That discontinuity is deliberate: what is in the old rows is the only record of what
BBSI said the money was, so it is kept rather than rewritten. Nothing in the app reads any of the
four — every dollar is computed from `employees.wage` × these hours. `SCHEMA_RATE_OWNED_BY_APP.sql`
makes them nullable and drops their zero defaults, so a column nobody names cannot become `$0.00`.
**It must be applied before the hours-only importer deploys**, or the morning import fails on the
NOT NULL constraint.

`regular_hours`, `ot_hours` and `total_hours` are the file's and are unchanged. The file decides
**how many** hours are overtime; `netlify/functions/pay-rules-lib.js` decides what each is paid at —
1.5× for hours 10–12 in a day, 2.0× above 12, which is what California's 4×10 alternative workweek
pays and what the old `ot_dollars` residual inherited for free. See `PAYROLL_INGESTION.md`.

### settings
`key, value, updated_at` — one row per key; the app uses `emailSettings`.

`/api/settings` **reads for everyone, writes for admins only.** The write gate resolves through
the same `fetchTiers` as every other gate and sits above the body parse and above any database
access, so a refused POST reaches no table. It was added on 2026-08-22, when this endpoint was
still session-only: three of the values it holds are not casual.

- `managers` — **the recipient list for the weekly OT report, which carries per-person dollars.**
  A text field any signed-in user could type an address into is a compensation disclosure with a
  Save button, reached through a different endpoint than the one Phase D gated. (The allowlist on
  `/api/send-ot-email` bounds this — a tampered list cannot send off-domain — but everybody who
  could add an address is in-domain.)
- `graceHoursPerEmployee` — the timeclock grace allowance. At ~54 hourly staff, 0.5 hrs/person/week
  is ~27 hours of pre-approved OT, so moving it moves the headline Net OT figure on every report.
- `otBudgetPercent` — decides what managers are **told** is over budget.
- `autoSend` — the on/off switch for the Monday manager email. Absent counts as **on**: every row
  written since the checkbox shipped carries an explicit boolean, so a missing value means a row
  that predates it or one that got mangled, and defaulting a damaged setting to silence is the
  failure nobody notices.

Reads stay open deliberately: the figures are already visible on every report that uses them, and
hiding the settings that produce them would make those reports less legible while protecting
nothing. The page renders read-only values for a non-admin rather than fields that would 403.

### wage_history
`id, employee_id, employee_number, employee_name, rate, previous_rate, change_pct, effective_date,
source, flagged, note, created_at` — `SCHEMA_V2_MODEL.sql` §6

Every observed change to an hourly rate, and the only way to answer "what was this person making in
March". **Append-only, enforced by a trigger** rather than merely intended: the service key bypasses
row-level security but not triggers, so this holds for the app and for a person in the SQL editor
alike. A correction is a new row. To make a genuine repair, disable the trigger, fix the row,
re-enable it, and record why — see the comment in the migration.

Keyed by `employee_number` as well as `employee_id`, and the number is NOT NULL: the daily file
identifies people by number, and a rate cannot be recorded for somebody who has none. That is why
the Salaries & Wages page shows no input for such a person rather than a box that fails on save.

`source` is `'bbsi'` for a rate observed in the daily file — historical, nothing writes it now — or
`'manual'` for one typed in the app. `flagged` marks a move beyond `WAGE_CHANGE_ALERT_PCT`
(default 20%). **Flagged, never blocked**: a typo and a real raise are indistinguishable in the data
and the difference is that one of them should be looked at, while blocking would stall a legitimate
raise on a Friday afternoon.

`effective_date` is the day the change takes effect, and it is required rather than defaulted: for
an import it is the day the file describes (a late file must not land on the day it was processed),
and for a typed rate it is today in the mill's zone.

The table is **not** in `data.js`'s `ALLOWED_TABLES`, so no browser can read or write it directly.
The only writer is the wage edit in `/api/data`, which inserts here before it updates
`employees.wage`.

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

BBSI emails `Work Summary Payroll.xlsx` to `info@sequoiafp.com` every morning at ~6:04 AM
Pacific. (**BBSI and Central Servers are one vendor** — BBSI is the PEO, Central Servers is
their reporting platform and the actual sender, `no-reply@centralservers.com`. Not two
systems.) A Gmail filter labels it `payroll import` and skips the inbox. An hourly
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
3. **The premium tiers are modelled, not flattened.** OT dollars used to be the residual
   `Total Earnings - Regular x Pay Rate`, which inherited them for free; the file's money is
   no longer imported, so `pay-rules-lib.js` prices 1.5x from 10-12 hours and 2.0x above 12
   explicitly. A flat `OT x rate x 1.5` undercounts by ~3% on a real day's file. The
   seventh-consecutive-day rule is a known gap — see `PAYROLL_INGESTION.md`.
4. **Salaried employees are excluded at import** — unconditionally, whatever the file
   carries for them — so every dollar figure here is *hourly* payroll. The UI labels it that
   way; without the label the Net OT percentage reads as company-wide and is not. A salaried
   row that arrives carrying hours is still *reported* as an anomaly, because that means the
   file changed shape.

Set-up order matters: run `SCHEMA_DAILY_HOURS.sql`, make sure every employee has an
`employee_number` and a `department` on the Employees tab, import a day by hand, *then* turn on
the email pipeline.

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

### The Monday manager email

`ot-weekly-email` (schedule in `netlify.toml`, logic in `ot-weekly-email-lib.js`) emails the
Mon–Sun week **that just finished** to everyone on `settings.emailSettings.managers`.

**Why 17:00 UTC Monday.** Sunday's hours do not exist until Monday: BBSI sends the daily file at
~6:04 AM Pacific and `payroll-email-ingest` collects it on the next `:15`. 17:00 UTC is 10:00 AM
Pacific in summer and 9:00 AM in winter — three to four hours and three to four ingest attempts
after the file is due. Anything earlier risks a six-day week wearing a seven-day label. Anything
before ~08:00 UTC is worse than late: Pacific has not reached Monday yet, so `todayInZone` still
says Sunday and the job would send *the week before last* with nothing looking wrong about it.
`tests/ot-weekly-email.test.js` pins both ends of that.

**The week is derived from the date, not from the schedule**, so a manual Netlify → **Run now** on
a Wednesday sends exactly what Monday's run would have.

**It refuses to send an incomplete week.** If any day of the week has no rows, or the week's own
rows came back short of what the week index says exist, nothing goes out and `PAYROLL_ALERT_EMAIL`
is told why. BBSI sends seven days a week, so an empty day is a failed delivery and never a quiet
Sunday — the same premise `payroll-missed-check` runs on. A week short a day understates every
figure in the email, and managers act on those figures. The manual **Email managers** button has no
such rule on purpose: a person looking at the truncation banner on screen can decide to send a
partial week; a cron cannot.

**It shares the report assembly with the tab.** `payroll-report.js` exports `loadWeekWindow` and
`buildWeekReport`, and both `/api/payroll-report` and this job go through them — same window, same
fetch, same grace allowance, same standing allowance, same pure `buildReport`. The email payload is
the one thing with two implementations (`buildOtEmailPayload` server-side,
`otEmailPayload()` in `src/js/ot-report.js` behind the button), and a test runs both over one
report and demands they are byte-identical.

**What replaced what.** The automatic send used to be a hook in `commitDailyImport()` in
`src/js/daily-hours.js` — in the *browser*, after a manual upload on the Daily Hours tab. When
hours moved to the hourly email ingest, that hook stopped being reachable: nothing about a cron
opens a browser. The checkbox stayed on and the email silently never went out again. It is removed
rather than kept alongside the schedule, because two automatic senders covering different weeks is
worse than one.

**What a red scheduled run means.** `payroll-email-ingest`, `payroll-missed-check` and
`ot-weekly-email` return a 5xx only when the *alerting itself* failed, or Supabase could not be
read — not when a message was bad and not when a week was deliberately withheld. A bad message is a
green run with `status: "attention"`, because the alert about it went out; a withheld week is a
green run with `skipped: "incomplete-week"`, for the same reason. So a function error in Netlify
means the watchdog is blind, which is the one condition nobody would otherwise notice. Netlify's
function-error alerting keys on exactly that.

---

## Auth Flow

Google OAuth restricted to `sequoiafp.com`. Non-domain users can be added via `ALLOWED_USERS` env var. Session cookie is HMAC-signed, httpOnly, 8-hour TTL.

---

## Adding New Users

1. Add email to `ALLOWED_USERS` in Netlify env vars (if not @sequoiafp.com)
2. Share **SFP Staffing DB** Google Sheet with them (keeps birthday script working)

---

## Deferred to Phase D

Recorded here rather than in a comment nobody will find, because each one is a decision that was
taken deliberately and each one has a visible consequence today.

**~~Permissions~~ — DONE.** `user_permissions` exists and is seeded
(`SCHEMA_PHASE_D_PERMISSIONS.sql`), `netlify/functions/permissions-lib.js` gates both reads and
writes of `employees`, and the Salaries & Wages page and the admin grant surface are shipped.

One thing about that page changed afterwards and is worth reading as part of it: the tab is
**no longer behind the salaries tier**. Its Hourly section is where every pay rate in the company
is typed, and `employees.wage` is writable at the base tier, so the tab opens for everybody and the
**salaried section** is what the tier gates. Bouncing somebody off the page for lacking the tier
would take the rate editor away along with the salaries they cannot see. Staffing Economics is
still gated as a whole tab.

**~~Staffing Economics comes back, gated~~ — DONE.** The page is back behind the salaries tier with
`max_wage` and the wage-vs-max variance column, and seat assignment works from the app again — as a
PATCH of one column on one row through `/api/economics`, not the whole-table `PUT` that made the old
one unsafe. See the `economics` schema section above for what that endpoint will and will not do.

**~~Seeing what an allocation does~~ — DONE for the salaries tier.** Allocations are enforced and
applied, and their effect is a department-level figure. With the salaries tier the suppression floor
is 1, so the Overhead breakdown shows every destination Axeri's split reaches. Without it the
small-bucket rule still withholds those costs (Corporate 1 person, HR 0), which is unchanged and
correct — the split reconciles either way, it is simply not itemised for a reader who may not see
the underlying figures.

**Dropping the `overtime` table.** Only after `preapproved_ot` has reconciled for a few weeks, and
never in the same change as the migration.

**~~The SG&A department breakdown~~ — DONE, gated.** The Overhead tab is totals only at the base
tier, for the reason it always was: SG&A is 7 active people across 5 departments — Corporate 1,
Procurement 1, Accounting 2, Sales & Marketing 3 — so at a defensible suppression threshold nearly
every row would withhold its cost, and a table of dashes is worse than no table.

With the **salaries tier** the breakdown is shown, because the suppression floor drops to 1 for
that tier. Not a favour: suppression protects a figure the reader may not see, and that reader can
open Salaries & Wages and read every annual_salary by name. `/api/cost-report` decides this
server-side from the caller's own tiers and reports the posture it applied in `disclosure`; the
page only declines to draw a table it would otherwise fill with dashes. The lift applies to every
cost class rather than only Overhead — the argument does not stop at a class boundary, since a
one-person Manufacturing bucket leaks the same salary/2080 to the same reader.

**A salaried person is costed into every week you can pick.** `hire_date` now EXISTS
(`SCHEMA_PHASE_D_PERMISSIONS.sql` §4) but is deliberately empty — no backfill, because a guessed
start date reads as a fact. So this is unchanged in behaviour and now blocked only on the data.
`employees` has no populated start or end date,
and a salaried person's cost is `annual_salary / 2080 x standard hours`, which does not consult the
payroll file. So selecting a week before somebody was hired, or a week in the future, shows their
cost. This is a consequence of the roster having no employment dates, not of the arithmetic — the
fix is a `hire_date` (and eventually a termination date), not a change to the cost basis.
`tests/cost-report-api.test.js` pins the current behaviour explicitly as pinned-not-endorsed.

**~~`employees.wage` still holds the literal string `'Salary'`~~ — DONE, 2026-08-22.** Cleared on
all **11** salaried people (10 active) by `SCHEMA_PHASE_D_PERMISSIONS.sql` §5, which is STEP 2 of
`SCHEMA_V2_HOTFIX_SENTINEL.sql` finally run. The count in the original note said 10; it was 11,
because it was written before `SCHEMA_V2_ROSTER_CLEANUP.sql` activated the salaried staff.

The tolerant fallback stays in all three `isSalaried()` implementations and is still tested — a
restored backup would carry the marker — but no live row does. `parseFloat(wage)` on a salaried
person is still `NaN` rather than a number, because the column is now NULL for them, so the rule
is unchanged: no code may read `wage` for a salaried person.

**~~Two edit surfaces~~ — collapsed, 2026-08-22.** The roster's Edit now opens the profile card in
edit mode; the modal survives for **Add alone**, because a person who does not exist yet has no card
to open (the card reads `state.employees` by index) and the three sections it carries beyond the
roster row — pre-approved OT, cost allocation, the HR file link — all need a saved employee id.

Nothing was lost, and that was checked rather than assumed: the card is a strict superset. It has
everything the modal had, plus break times, the four address fields and the HR file link, and it
offers the schedule as a select where the modal had a free-text box. A test compares the two
RENDERED surfaces field by field and fails if anything is bound on the modal alone.

**One `verifySession`, and it compares with `!==`.** The eleven copies are consolidated into
`netlify/functions/session-lib.js`. The signature comparison was deliberately left as `!==` rather
than `timingSafeEqual` so that the consolidation preserved behaviour exactly; switching it is a
one-line change that belongs in its own commit.

## Key IDs

| Resource | ID |
|----------|-----|
| Netlify site | seq-staffing |
| Supabase project | zwghbbyzrycpnesuuzgi |
| HR Shared Drive | 0AKnhIL1gZ8TmUk9PVA |
| Employee Files folder | 1TMyTQVjpQO8fTrGppx4KchaHRimwIi9Q |
| Google Cloud project | sfp-staffing-app |
| SFP Staffing DB sheet | 1_WJ8MuOz3kUfeCEl9Uq-FLvby8ggxnb5MLnz5yALzM4 |
