-- Schema changes for OT Report feature

-- Step 1: Add employee_number column to employees table (as TEXT to preserve format)
ALTER TABLE employees ADD COLUMN employee_number TEXT UNIQUE;

-- Step 2: Create weekly_hours table
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

-- Create index for faster lookups
CREATE INDEX idx_weekly_hours_batch ON weekly_hours(upload_batch_id);
CREATE INDEX idx_weekly_hours_employee ON weekly_hours(employee_number);
CREATE INDEX idx_weekly_hours_date ON weekly_hours(work_date);
