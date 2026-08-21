> **SUPERSEDED.** This document describes the first OT report, which uploaded a
> weekly `Hours-Analysis-Report` into a `weekly_hours` table and priced OT at a flat
> 1.5x. Both are gone. The current system imports one file per day into `daily_hours`,
> derives OT dollars by residual (a flat 1.5x undercounts California's double-time tier
> by ~3%), snapshots department at import, and ingests the file automatically from the
> `payroll import` Gmail label. See **[`PAYROLL_INGESTION.md`](PAYROLL_INGESTION.md)**
> and `SCHEMA_DAILY_HOURS.sql`.
>
> Kept only as a record of what the earlier `weekly_hours` path did. Do not follow the
> set-up steps below.

# OT Report Feature — Setup & Implementation Guide

## Overview

The OT Report feature provides a weekly comparison of:
- **All OT**: Hours reported in payroll uploads (from ADP-style timeclock exports)
- **Pre-Approved OT**: Weekend OT pre-approved by management (from the existing Overtime tab)
- **Net OT**: The difference, shown in hours and dollars, plus as % of total payroll

---

## What Was Built

### 1. Frontend (public/app.html + src/js/ot-report.js)
- **New "OT Report" tab** with summary cards and detail table
- **File upload control** accepting xlsx files (or CSV exported from Excel)
- **File parser** that extracts: Employee Number, Date, Regular Hours, OT Hours, Supervisor Comment
- **Upload preview** showing matched/unmatched employees before confirming
- **Calculations**:
  - Hourly totals by employee with wage lookups
  - OT dollars = OT hours × wage × 1.5
  - Regular dollars = Regular hours × wage
  - Total non-burdened payroll = sum of all dollars
  - Net OT % = Net OT $ / Total payroll × 100
- **Employee detail table** sortable by OT, highlighting unmatched employees
- **Week selector** to view different uploaded batches

### 2. Backend
- **Netlify function** (`netlify/functions/ot-upload.js`) to persist uploaded data to Supabase
- Uses service role key for secure writes

### 3. Database Schema (SQL migrations required)
See `SCHEMA_CHANGES.sql` for exact DDL

#### New Column: `employees.employee_number`
- Type: `INTEGER`, nullable initially, should be unique
- Used to match uploaded payroll records to the employee roster
- Must be backfilled from ADP/timeclock system

#### New Table: `weekly_hours`
```sql
id (UUID, pk)
employee_number (INTEGER)
work_date (DATE)
regular_hours (NUMERIC)
ot_hours (NUMERIC)
supervisor_comment (TEXT, nullable)
upload_batch_id (UUID) — groups rows from same file upload
created_at (TIMESTAMPTZ)
```

---

## Required Setup Steps

### Step 1: Run Database Migrations

In Supabase SQL editor, run the contents of `SCHEMA_CHANGES.sql`:

```sql
ALTER TABLE employees ADD COLUMN employee_number INTEGER UNIQUE;

CREATE TABLE weekly_hours (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_number INTEGER NOT NULL,
  work_date DATE NOT NULL,
  regular_hours NUMERIC(8,4) NOT NULL DEFAULT 0,
  ot_hours NUMERIC(8,4) NOT NULL DEFAULT 0,
  supervisor_comment TEXT,
  upload_batch_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_weekly_hours_batch ON weekly_hours(upload_batch_id);
CREATE INDEX idx_weekly_hours_employee ON weekly_hours(employee_number);
CREATE INDEX idx_weekly_hours_date ON weekly_hours(work_date);
```

### Step 2: Backfill Employee Numbers

Once the column exists, populate `employees.employee_number` for each active employee using their ID from the timeclock/ADP system.

**Future enhancement**: Add a bulk-edit UI in the Employees tab to make this easier (currently can be done via direct Supabase updates or manual inline edits if CRUD is enabled).

### Step 3: Deploy

- Drag & drop the updated files to Netlify (or commit to a git-connected repo)
- Ensure `netlify/functions/ot-upload.js` is deployed
- Function endpoint will be `/api/ot-upload`

---

## How to Use

### Uploading a Payroll Hours Report

1. Go to the **OT Report** tab
2. Click **"↑ Upload new file"**
3. Select your Hours Analysis Report file (xlsx or CSV)
   - Expected columns: Employee Number, Last Name, First Name, Date, Regular Hours, OT Hours, Supervisor Comment
4. Click **"Parse and preview"**
5. Review the preview:
   - Total rows, employees, date range
   - ⚠️ Any unmatched employee numbers (if not found in roster)
6. Click **"Confirm and upload"** to save to Supabase

### Viewing the Report

- **Summary cards** show All OT, Pre-Approved OT, Net OT, Non-burdened Payroll, and Net OT %
- **Employee detail table** lists all employees with hours in the upload, sorted by OT descending
- Unmatched employees are highlighted in yellow with a warning note
- **Week selector** allows switching between uploaded batches

### Interpreting the Numbers

- **All OT (hours/dollars)**: From the uploaded payroll file
- **Pre-Approved OT**: Weekend OT entries from the Overtime tab only (not Before/After Shift)
- **Net OT**: The OT that was NOT pre-approved — flagged for review
- **Net OT as % of payroll**: Shows the cost impact; high percentages may indicate scheduling or forecasting issues

---

## File Format

The upload expects a CSV or XLSX with these columns (order doesn't matter):

```
Employee Number | Last Name | First Name | Date       | Regular Hours | OT Hours | Supervisor Comment
319              | Acevedo   | Miguel     | 07/17/2026 | 0.000         | 5.867    | Changed meal...
7268             | Bonato    | Jared      | 07/17/2026 | 10.000        | 2.083    | clock error...
```

- **Employee Number**: Must be numeric and match `employees.employee_number`
- **Date**: Any format Python/JS can parse (MM/DD/YYYY, YYYY-MM-DD, etc.)
- **Hours**: Decimal format (0.000, 5.867, etc.)

---

## Current Limitations & Future Enhancements

### Current:
- File parser handles CSV/TSV; pure XLSX parsing requires adding SheetJS library
- Pre-Approved OT only includes Weekend entries (not Before/After Shift)
- No ability to delete or re-upload within a batch (each upload is new)
- Employee number field cannot be edited from Employees tab UI yet

### Future Enhancements:
1. **Employee number bulk editor** in Employees tab for easier backfill
2. **Batch management** — delete/re-upload a batch, mark batches as "approved"
3. **XLSX native parsing** — add SheetJS library for direct .xlsx support without CSV conversion
4. **Schedule analysis** — flag employees with excessive OT, trends over time
5. **Export report** — download summary as PDF or Excel
6. **Role-based access** — restrict uploads to supervisors/admin
7. **Audit trail** — log who uploaded what and when
8. **Real-time sync** — pull directly from ADP API instead of manual export

---

## Troubleshooting

### "Could not find Employee Number or Date columns"
- Verify your export includes these exact columns (or similar names like "Emp #", "Work Date")
- Ensure first row is the header row
- Try exporting as CSV from Excel instead of XLSX

### "Unmatched employee numbers" warning
- Employee number in the file doesn't exist in the roster
- Options:
  - Verify the number is correct (check timeclock system)
  - Add the missing employee to the Employees tab first
  - Check if the employee number format is numeric (no leading zeros, etc.)

### Upload fails with "Upload failed: error message"
- Check browser console (F12 → Console) for detailed error
- Verify Supabase connection is working (can you edit other tabs?)
- Ensure `netlify/functions/ot-upload.js` is deployed and accessible at `/api/ot-upload`

### "No data found in file"
- File is empty or header row is not recognized
- Try re-exporting from the timeclock system
- Ensure the file actually contains data rows (not just headers)

---

## Architecture Notes

### Data Flow
```
File Upload
    ↓
parseCSVText() / parseExcelBuffer()
    ↓
showOTFilePreview() — user review & confirm
    ↓
confirmOTUpload() — sends to /api/ot-upload
    ↓
ot-upload Netlify function
    ↓
Supabase REST API → weekly_hours table
    ↓
loadData() reloads state.weeklyHours
    ↓
renderOTReport() recalculates & displays
```

### Wage Lookup
- Employee matched via `employee_number` → `employees.id`
- Wage sourced from `employees.wage` field (parsed as numeric)
- OT multiplier is fixed at 1.5×

### Pre-Approved OT
- Filtered from `state.ot.weekend` (only Weekend OT type)
- Matched by name to calculate dollars using same wage lookup
- Before Shift & After Shift OT are not counted as pre-approved in this report

---

## Support & Questions

For issues or feature requests, check the console logs and refer to the README.md for general app architecture.
