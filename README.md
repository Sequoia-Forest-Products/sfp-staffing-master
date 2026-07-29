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
        └── birthday.js         # Scheduled birthday notifications
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

Runs daily at 7 AM Pacific via Netlify scheduled function.
- Queries Supabase for active employees
- Sends bilingual email to TextBolt address on birthday match
- Skips STOP, missing, or #ERROR! TextBolt values

TextBolt format: `+1XXXXXXXXXX@sendemailtotext.com`

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
