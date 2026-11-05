# Backfill readiness: re-sending timeclock data from 9/10/2026

**Status: ready.** Steps 1–5 of the timeclock reconciliation brief are merged
and deployed ([#60](https://github.com/Sequoia-Forest-Products/sfp-staffing-master/pull/60)–[#63](https://github.com/Sequoia-Forest-Products/sfp-staffing-master/pull/63), production deploy of
2026-11-05 08:30 PT). Re-importing a day now replaces it in one transaction.
It never appends, and the tests and a live rolled-back check against the
database both prove it.

## What to ask BBSI for

**Send the backfill as a dated file: one row per employee per day, with a
date column.** Use the same format as the new Monday weekly file. One file
covering 9/10 to the present is fine, and so is one file per week.

That matters because **the daily "Work Summary Payroll" file has no date in
it anywhere.** The Staffing Master dates a daily file as "the day before it
arrived". A batch of old daily files re-sent today would all claim to be
yesterday. The importer refuses that: a second, different file for a day it
already has is parked for review, not imported. That makes the re-send safe
but useless. Each day would then have to be uploaded by hand on Settings →
Daily Hours, with its date picked: about 55 uploads.

A dated file, by contrast, imports automatically, with no one touching it:

- every day it covers is replaced, with corrected punches and the new hires
  included;
- those days are marked **reconciled**;
- a variance summary is stored. You can see it on the Alerts tab, and from the
  reconciled week on Daily Hours, the OT Report and Manufacturing Costs;
- a **Weekly variance** alert is raised if the cost moved by more than 2% or
  $1,000. It will, by design: this backfill is meant to recover roughly
  $37,600.

Whichever format arrives, the file must cover **all Active TimeNet employees**.
BBSI is already changing the daily report to do that. Salaried staff and BBSI
staff in the file are stored and never counted.

## What will happen to the new hires

Gibb, Harig, Jordatan Ramirez, Cervantes and Valdovinos have never been in the
feed. When they arrive, each employee number is checked against the roster:

- **The number matches the roster:** the hours count straight away.
- **The number doesn't match** (Gibb's did not; the roster had him as
  M79172, and TimeNet uses 3380): the rows are held, not counted, and a **New
  employee** alert names the number. Correct the employee number on the
  roster, and the held hours move in automatically on the next hourly check.
  No re-import is needed.

Gibb's number was corrected to 3380 on 11/5. The other four are still on the
roster under 5668 (Harig), 5342 (J. Ramirez), 5159 (Cervantes) and 5467
(Valdovinos). If TimeNet uses different numbers for them, the alerts will
say so.

## Verify after the backfill

Hours for the five, and the recovered labor for 9/28–10/25. Overtime is priced
at 1.5× for hours 10–12 and 2.0× above 12, the same rule as Manufacturing
Costs. Expect roughly **$15,300**.

```sql
with d as (
  select e.name, e.employee_number, replace(e.wage,'$','')::numeric w,
         dh.regular_hours r, dh.ot_hours o,
         least(dh.ot_hours, greatest(0, dh.regular_hours + dh.ot_hours - 12)) dt
  from employees e
  join daily_hours dh on dh.employee_number = e.employee_number
  where e.name in ('Auzlo Gibb','Ori Harig','Jordatan Ramirez','Miguel Cervantes','Alberto Valdovinos')
    and dh.work_date between '2026-09-28' and '2026-10-25')
select name, employee_number, round(sum(r + o), 2) hours,
       round(sum(r*w + (o-dt)*1.5*w + dt*2*w), 2) labor
from d group by rollup((name, employee_number)) order by name nulls last;
```

Anything still held (numbers not yet matched to the roster):

```sql
select employee_number, first_name, last_name, count(*) days, sum(total_hours) hours
from daily_hours_held where reason = 'unknown' group by 1,2,3 order by 1;
```

Days in the window that are still provisional (should be none once the
backfill covers them):

```sql
select work_date from hours_days
where work_date between '2026-09-10' and current_date - 1 and status <> 'reconciled'
order by 1;
```

## One thing the backfill will not fix

Ori Harig's BBSI clock number is 0319, which is Miguel Acevedo's employee
number, so BBSI pays him Acevedo's hours on top of his own. That is a payroll
setup error in BBSI. The Staffing Master has the two under different numbers
and is unaffected. Axeri reports that BBSI is arranging repayment. The
duplication continues each payroll until BBSI corrects the clock number.
