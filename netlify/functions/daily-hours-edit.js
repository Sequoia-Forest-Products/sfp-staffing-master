// /api/daily-hours-edit — correct one person's hours on one day, by hand.
//
//   POST {workDate, employeeNumber, regularHours, otHours, note?}
//
// The payroll file is the record of hours, but a missed clock-out arrives as a
// 24-hour day — 10 regular and 14 OT, booked to the day the punch opened — and
// the only fix used to be SQL. This lets anyone on the access list put the day
// right from the OT Report.
//
// ONE ROW PER WRITE, named by its natural key (work_date, employee_number). The
// row must already exist: this corrects what the file said, it does not invent
// a day the file never sent.
//
// total_hours is always regular + OT. It is what the report reads first, and
// letting it drift from its parts would make the day disagree with itself.
//
// Every write appends one row to daily_hours_edits with the before and after,
// who and why. A later re-import of the same day overwrites the hand edit —
// that is intended, the file is the record — and the trail still shows it.

const payrollDb = require('./payroll-db');
const { verifySession, getCookies } = require('./session-lib');

// A day cannot hold more than 24 hours. Anything above is a typo, and a typo
// here goes straight into the OT figures and the Monday email.
const MAX_DAY_HOURS = 24;
const MAX_NOTE = 500;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EDIT_FLAG = 'manual_edit';

const round2 = n => Math.round(n * 100) / 100;

function hoursField(value, label) {
  if (value === '' || value === null || value === undefined) return { error: `${label} is required` };
  const n = Number(value);
  if (!Number.isFinite(n)) return { error: `${label} must be a number — got ${JSON.stringify(value)}` };
  if (n < 0) return { error: `${label} cannot be negative` };
  if (n > MAX_DAY_HOURS) return { error: `${label} cannot be more than ${MAX_DAY_HOURS}` };
  return { value: round2(n) };
}

// Returns {error} or the validated edit. Every rejection happens here, before
// anything is read or written.
function validateEdit(body) {
  const workDate = String((body && body.workDate) || '').trim();
  if (!DATE_RE.test(workDate) || Number.isNaN(Date.parse(workDate + 'T00:00:00Z'))) {
    return { error: 'workDate must be a date, YYYY-MM-DD' };
  }
  const employeeNumber = String((body && body.employeeNumber) || '').trim();
  if (!employeeNumber) return { error: 'employeeNumber is required — the row is keyed on the payroll number' };

  const reg = hoursField(body.regularHours, 'Regular hours');
  if (reg.error) return { error: reg.error };
  const ot = hoursField(body.otHours, 'OT hours');
  if (ot.error) return { error: ot.error };
  const total = round2(reg.value + ot.value);
  if (total > MAX_DAY_HOURS) {
    return { error: `Regular + OT is ${total} hours, which is more than a day holds` };
  }

  const note = String((body && body.note) || '').trim().slice(0, MAX_NOTE) || null;
  return { edit: { workDate, employeeNumber, regularHours: reg.value, otHours: ot.value, totalHours: total, note } };
}

const encode = v => encodeURIComponent(String(v));

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const fail = (statusCode, error) => ({ statusCode, headers, body: JSON.stringify({ ok: false, error }) });

  const session = verifySession(getCookies(event).sfp_session || '');
  if (!session) return fail(401, 'Unauthorized');
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return fail(400, 'Body must be JSON'); }

  const { error, edit } = validateEdit(body);
  if (error) return fail(400, error);

  try {
    const key = `work_date=eq.${encode(edit.workDate)}&employee_number=eq.${encode(edit.employeeNumber)}`;
    const { rows: found } = await payrollDb.request('GET',
      `daily_hours?${key}&select=id,first_name,last_name,regular_hours,ot_hours,total_hours,flags`);
    const before = found && found[0];
    if (!before) {
      return fail(404, `No hours on file for #${edit.employeeNumber} on ${edit.workDate} — there is nothing to correct`);
    }

    const flags = Array.isArray(before.flags) ? before.flags.slice() : [];
    if (!flags.includes(EDIT_FLAG)) flags.push(EDIT_FLAG);

    const { rows: updated } = await payrollDb.request('PATCH', `daily_hours?id=eq.${encode(before.id)}`, {
      body: {
        regular_hours: edit.regularHours,
        ot_hours: edit.otHours,
        total_hours: edit.totalHours,
        flags
      },
      headers: { Prefer: 'return=representation' }
    });
    const after = (updated && updated[0]) || null;
    if (!after) return fail(409, 'The row changed or disappeared while saving — reload and try again');

    // The hours are already corrected. A failed audit write must not pretend
    // the edit did not happen, but it must not pass silently either.
    let auditError = null;
    try {
      await payrollDb.request('POST', 'daily_hours_edits', {
        body: [{
          daily_hours_id: before.id,
          work_date: edit.workDate,
          employee_number: edit.employeeNumber,
          employee_name: [before.first_name, before.last_name].filter(Boolean).join(' ') || null,
          previous_regular_hours: before.regular_hours,
          previous_ot_hours: before.ot_hours,
          previous_total_hours: before.total_hours,
          new_regular_hours: edit.regularHours,
          new_ot_hours: edit.otHours,
          new_total_hours: edit.totalHours,
          note: edit.note,
          edited_by: String(session.email || 'unknown')
        }],
        headers: { Prefer: 'return=minimal' }
      });
    } catch (err) {
      auditError = err.message;
      console.error('daily-hours-edit: hours saved but the audit row failed:', err.message);
    }

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        ok: true,
        row: {
          workDate: edit.workDate,
          employeeNumber: edit.employeeNumber,
          regularHours: edit.regularHours,
          otHours: edit.otHours,
          totalHours: edit.totalHours
        },
        previous: {
          regularHours: Number(before.regular_hours),
          otHours: Number(before.ot_hours),
          totalHours: Number(before.total_hours)
        },
        ...(auditError ? { auditError } : {})
      })
    };
  } catch (err) {
    console.error('daily-hours-edit error:', err.message);
    return fail(500, err.message);
  }
};

exports.__test = { validateEdit, MAX_DAY_HOURS, EDIT_FLAG };
