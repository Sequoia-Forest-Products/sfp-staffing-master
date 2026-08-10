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
├── SCHEMA_CHANGES.sql          # OT report schema
├── SCHEMA_BIRTHDAY.sql         # Birthday data audit queries
├── SCHEMA_SMS_OPTOUT.sql       # sms_opted_out migration
├── tests/
│   └── birthday.test.js        # Unit tests (npm test)
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
        └── birthday-test.js    # Manual / dry-run birthday trigger
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

---

## Database Schema (Supabase)

### employees
`id, name, wage, dept, status, days, clock_in, clock_out, break_1, break_2, birthday, phone, language, email, sms_opted_out, drive_folder_id, employee_number`  
`text_bolt` — deprecated, no longer read or written; kept one release as a fallback.

### economics
`id, num, section, position, name, max_wage`

### overtime
`id, name, ot_type (Pre-Shift|Post-Shift|Weekend), hours, description`

### points
`id, name, points, last_point_date, level_up_eligible, disciplinary, disc_date`

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
