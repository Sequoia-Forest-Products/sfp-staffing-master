// Who may see and write which columns.
//
// THE ONE PLACE THAT DECIDES. Every gate in the app resolves through this file,
// so "what does this tier unlock" has a single answer that can be read in one
// sitting and tested without a database.
//
// ------------------------------------------------------------------------
// WHY THIS EXISTS, and what it found on arrival
// ------------------------------------------------------------------------
//
// Before Phase D, compensation was protected by exactly one mechanism: the
// explicit `select=` list in data.js, plus a response-side filter against the
// same list. That protected READS of one column, in one file.
//
// It did not protect writes at all. `PATCH /api/data?table=employees&id=...`
// forwarded the request body straight to PostgREST with no column filter, so
// any signed-in sequoiafp.com account could set anybody's annual_salary — the
// column the read path deliberately hides — or overwrite their hourly wage.
// Verified against the handler before this file was written.
//
// That is the shape of failure this phase exists to prevent: a gate on one
// direction reads as protection while the other direction is open. So both
// directions resolve here, from the same registry, and a column added to one
// list without the other shows up as a test failure rather than as an
// asymmetry nobody notices.
//
// ------------------------------------------------------------------------
// THE MODEL
// ------------------------------------------------------------------------
//
//   hourly_wages   BASE. Everyone signed in has it. Not stored as a row —
//                  storing it would invite the reading that a missing row
//                  means no access at all, when it means exactly the base.
//   salaries       Salaried compensation: annual_salary, read and write.
//   admin          May grant and revoke the other two.
//
// DENY BY DEFAULT, in the strong sense: a column is invisible unless a list
// names it. Adding a column to `employees` exposes it to nobody until somebody
// edits this file, which is the right default for a table holding pay.

const TIER_HOURLY_WAGES = 'hourly_wages';
const TIER_SALARIES     = 'salaries';
const TIER_ADMIN        = 'admin';

// The base tier is implicit and is never stored. Only these are grantable, and
// the API refuses to store anything else.
const GRANTABLE_TIERS = [TIER_SALARIES, TIER_ADMIN];
const ALL_TIERS = [TIER_HOURLY_WAGES, ...GRANTABLE_TIERS];

// ------------------------------------------------------------------------
// READ: the employees projection, by tier
// ------------------------------------------------------------------------
//
// Everything anybody may read. `wage` is here deliberately: hourly rates are
// the base tier by decision, visible to every signed-in user, which is the
// state Peter accepted in the interim and Phase D did not change.
const EMPLOYEE_COLUMNS_BASE = [
  'id', 'name', 'wage', 'dept', 'status', 'days',
  'clock_in', 'clock_out', 'break_1', 'break_2',
  'birthday', 'phone', 'language', 'email',
  'sms_opted_out', 'text_bolt', 'drive_folder_id',
  'employee_number', 'department', 'pay_type', 'cost_class', 'position_group',
  'position', 'address_street', 'address_city', 'address_state', 'address_postal_code',
  'hire_date'
];

// What each grantable tier ADDS to the base projection.
const EMPLOYEE_COLUMNS_BY_TIER = {
  [TIER_SALARIES]: ['annual_salary'],
  [TIER_ADMIN]: []      // admin grants access; it does not itself read pay
};

// ------------------------------------------------------------------------
// WRITE: what may be written, by tier
// ------------------------------------------------------------------------
//
// A SEPARATE list from the read projection, on purpose. Readable and writable
// are different questions and conflating them is how `wage` ended up writable
// by everyone while being carefully projected on the way out.
//
// `wage` IS here, at the base tier, and that is a reversal.
//
// It was excluded because BBSI overwrote it every morning: a value typed in the
// app would have been silently replaced overnight, so the field was removed
// rather than left decorative. That is no longer true. The rate in the daily
// file was a human transcription from BBSI's payroll system into Timenet, kept
// alive only so the feed could exist, and nobody maintains it there any more.
// The import stopped reading it on 2026-08-22 and employees.wage is now the
// record of truth for every dollar this system computes.
//
// Base tier, not `salaries`, by decision: hourly rates are already readable by
// every signed-in user, and the people who need to correct one are supervisors,
// not the two accounts holding the salaries grant. `annual_salary` is
// untouched and stays behind `salaries` in both directions.
//
// `id`, `created_at` and `updated_at` are absent because nothing should set
// them through this path.
const EMPLOYEE_WRITABLE_BASE = [
  'name', 'status', 'days', 'break_1', 'break_2',
  'birthday', 'phone', 'language', 'email', 'sms_opted_out', 'drive_folder_id',
  'employee_number', 'department', 'pay_type', 'cost_class', 'position_group',
  'position', 'address_street', 'address_city', 'address_state', 'address_postal_code',
  'hire_date', 'wage',
  // Retained columns nothing writes today but which the roster has always been
  // able to carry. Listed so a write of one is a decision, not an accident.
  'dept', 'clock_in', 'clock_out', 'text_bolt'
];

const EMPLOYEE_WRITABLE_BY_TIER = {
  [TIER_SALARIES]: ['annual_salary'],
  [TIER_ADMIN]: []
};

// ------------------------------------------------------------------------
// resolution — pure, so it is testable without a database
// ------------------------------------------------------------------------

// Emails are compared lowercased and trimmed. Google hands back a canonical
// address, but a grant typed by hand on the admin page will not be canonical,
// and a grant that fails to match because of a capital letter is a grant that
// looks made and is not.
function normalizeEmail(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

// The tiers this email holds, given the grant rows. Always includes the base.
function resolveTiers(email, grantRows) {
  const tiers = new Set([TIER_HOURLY_WAGES]);
  const wanted = normalizeEmail(email);
  if (!wanted) return tiers;                 // no identity, base only
  for (const row of grantRows || []) {
    if (normalizeEmail(row && row.email) !== wanted) continue;
    const tier = String((row && row.tier) || '').trim().toLowerCase();
    // An unrecognised tier in the table grants nothing. A typo must not
    // accidentally match, and must not throw either — the row is data somebody
    // typed, and the read path has to survive it.
    if (GRANTABLE_TIERS.includes(tier)) tiers.add(tier);
  }
  return tiers;
}

function has(tiers, tier) {
  return tiers instanceof Set ? tiers.has(tier) : (tiers || []).includes(tier);
}

// Base plus whatever the held tiers add, in a stable order with no duplicates.
function columnsFor(tiers, base, byTier) {
  const out = [...base];
  for (const tier of GRANTABLE_TIERS) {
    if (!has(tiers, tier)) continue;
    for (const col of (byTier[tier] || [])) if (!out.includes(col)) out.push(col);
  }
  return out;
}

const employeeReadColumns  = (tiers) => columnsFor(tiers, EMPLOYEE_COLUMNS_BASE, EMPLOYEE_COLUMNS_BY_TIER);
const employeeWriteColumns = (tiers) => columnsFor(tiers, EMPLOYEE_WRITABLE_BASE, EMPLOYEE_WRITABLE_BY_TIER);

// Splits a write body into what this caller may write and what they may not.
//
// REJECTED, NOT DROPPED. Silently discarding a column the caller is not allowed
// to set returns 200 and reports success for a write that did not happen, which
// is how somebody comes to believe a salary was recorded. The caller gets a 403
// naming the columns instead.
function partitionWrite(body, tiers) {
  const allowed = employeeWriteColumns(tiers);
  const permitted = {};
  const refused = [];
  for (const key of Object.keys(body || {})) {
    if (allowed.includes(key)) permitted[key] = body[key];
    else refused.push(key);
  }
  return { permitted, refused };
}

// Every column this file knows about, in either direction. Used by the tests to
// assert that nothing gated in one direction was forgotten in the other.
function gatedColumns() {
  const out = new Set();
  for (const tier of GRANTABLE_TIERS) {
    for (const c of (EMPLOYEE_COLUMNS_BY_TIER[tier] || [])) out.add(c);
    for (const c of (EMPLOYEE_WRITABLE_BY_TIER[tier] || [])) out.add(c);
  }
  return out;
}

// ------------------------------------------------------------------------
// the grant table
// ------------------------------------------------------------------------

// Reads the grants for one email and resolves them to tiers.
//
// FAILS CLOSED, in every failure mode:
//
//   table missing   -> base tier only. Lets the code deploy before the
//                      migration runs, in which case annual_salary stays
//                      hidden from everyone — exactly today's behaviour.
//   read error      -> base tier only. A database that cannot be reached must
//                      not be an open door. It costs an admin their admin
//                      until it recovers, which is the correct trade and is
//                      why the recovery path in the migration is plain SQL.
//   no rows         -> base tier only. This is the ordinary case for most of
//                      the roster and is not an error.
//
// The db handle is injected so the tests drive the real resolution logic
// without a network.
async function fetchTiers(email, db) {
  const wanted = normalizeEmail(email);
  if (!wanted) return new Set([TIER_HOURLY_WAGES]);
  try {
    const rows = await db.query('user_permissions',
      '?select=email,tier&email=eq.' + encodeURIComponent(wanted));
    return resolveTiers(wanted, rows || []);
  } catch (err) {
    const message = String((err && err.message) || '');
    if (!/\b404\b|PGRST205|could not find the table|does not exist/i.test(message)) {
      // Logged, not thrown. A permissions read that fails should degrade the
      // caller to the base tier, not take the roster down with it.
      console.error('permissions read failed, falling back to the base tier:', message);
    }
    return new Set([TIER_HOURLY_WAGES]);
  }
}

module.exports = {
  fetchTiers,
  TIER_HOURLY_WAGES, TIER_SALARIES, TIER_ADMIN,
  GRANTABLE_TIERS, ALL_TIERS,
  EMPLOYEE_COLUMNS_BASE, EMPLOYEE_COLUMNS_BY_TIER,
  EMPLOYEE_WRITABLE_BASE, EMPLOYEE_WRITABLE_BY_TIER,
  normalizeEmail, resolveTiers, has,
  employeeReadColumns, employeeWriteColumns,
  partitionWrite, gatedColumns
};
