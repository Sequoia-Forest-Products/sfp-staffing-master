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

- **Employees tab** — roster with search, filter, sort, inline edit modals, SMS opt-out toggle, Drive folder linking
- **Staffing Economics tab** — position assignment with wage, burdened cost, max wage, and variance
- **Overtime tab** — view/edit for Before Shift, After Shift, and Weekend Pre-Approved OT
- **Points Tracker tab** — attendance points with disciplinary flags, full CRUD
- **Birthday notifications** — daily scheduled function sends bilingual TextBolt texts
- **Copy TextBolt list** — copies all active opted-in addresses for manual bulk texts

---

## Project Structure

```
sfp-staffing-master/
├── app.html                    # Main protected dashboard
├── index.html                  # Login page
├── netlify.toml                # Config, redirects, scheduled functions
├── package.json
├── .env.example                # Environment variable template
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
`id, name, wage, dept, status, days, clock_in, clock_out, break_1, break_2, birthday, phone, language, email, text_bolt, drive_folder_id`

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

**Schedule:** `30 13 * * 1-5` (in `netlify.toml`) — weekdays at 13:30 UTC.
Netlify cron is UTC and does not follow DST, so this lands at **7:30 AM Mountain
in summer (MDT) and 6:30 AM in winter (MST)**. Shift the cron hour to `30 14`
over the winter if the earlier send is a problem.

**Look-ahead** (carried over from the old Apps Script, so nobody is missed over a
weekend):

| Run day | Covers |
|---------|--------|
| Mon–Wed | that day only |
| Thursday | that day + 3 (Fri, Sat, Sun) |
| Friday | that day + 2 (Sat, Sun) |
| Sat/Sun | never runs — cron skips it, and the code exits anyway |

All date math is done in `America/Boise`, never the server's UTC clock.

**Who gets a message:** every `Active` employee with a usable `text_bolt`
address, minus the birthday people themselves. `STOP`, `#ERROR!`, blank, and
non-address values are skipped.

**Opt-out:** there is no separate opt-out column — the SMS opt-out toggle on the
Employees tab writes the literal string `STOP` into `text_bolt`. An opted-out
employee receives nothing, but is still **named** in the message when it is their
birthday.

**Birthday format:** `birthday` is read as month/day only (year ignored). Both
`YYYY-MM-DD` and free text like `3/15` or `3/15/1990` are accepted, parsed from
the string directly so no timezone can shift the day. See `SCHEMA_BIRTHDAY.sql`
to audit for unparseable values.

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
