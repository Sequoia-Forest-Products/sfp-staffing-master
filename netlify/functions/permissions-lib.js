// WHO MAY USE THIS SYSTEM.
//
// ONE LIST. You are on it or you are not, and being on it means everything:
// sign in, read every column, write every column, edit the list itself, change
// the settings, and receive the weekly OT email.
//
// ------------------------------------------------------------------------
// WHY IT COLLAPSED, 2026-09-15
// ------------------------------------------------------------------------
//
// Phase D built three tiers — hourly_wages (base, implicit), salaries, admin —
// to protect `annual_salary` from the rest of a company-wide sign-in. Every
// signed-in sequoiafp.com account got the base tier automatically, so the tiers
// were the ONLY thing standing between a hundred mailboxes and the payroll.
//
// That premise is gone. The mill is a handful of people who all need the same
// screens, and access is now an explicit list rather than a domain. Once you
// have to be named to get in at all, a second mechanism deciding what you may
// see once you are in is answering a question nobody asked: the list already
// said yes.
//
// ------------------------------------------------------------------------
// WHAT THIS COSTS, STATED PLAINLY
// ------------------------------------------------------------------------
//
// Eduardo Rivera is salaried in Manufacturing and his annual_salary IS held —
// Staffing Economics prices his seat from it. Everyone on the list can now see
// and edit it. That is the accepted trade, made knowingly on 2026-09-15: the
// list is short, everyone on it is a manager, and the alternative was a tier
// system whose whole job was to hide one number from five people.
//
// Everyone on the list can also add and remove anyone, including themselves.
// There is no admin. The ONE guard is that the last entry cannot be removed —
// see accessRefusal below. That is not a role creeping back in; it applies to
// everybody equally and exists because an empty list is not a mistake anybody
// can fix from inside the app.
//
// ------------------------------------------------------------------------
// FAILING CLOSED, AND THE ONE PLACE IT MUST NOT
// ------------------------------------------------------------------------
//
// A permissions read that fails means NO ACCESS everywhere except sign-in. At
// sign-in an unreachable table would lock out the whole company with no way in
// — so auth.js falls back to the email domain there, and only there. See the
// note above bootstrapAllows().

// The table, and the one column that matters. `tier` survives as a column so
// the migration is additive and the old rows stay readable; nothing reads it.
const ACCESS_TABLE = 'user_permissions';

// ------------------------------------------------------------------------
// COLUMNS — one list each way now, not a base plus tiers
// ------------------------------------------------------------------------
//
// Still TWO lists, read and write, and still not one. Readable and writable are
// different questions, and conflating them is how `wage` once ended up writable
// by everyone while being carefully projected on the way out. `id`, `created_at`
// and `updated_at` are absent from the write list because nothing should set
// them through this path.
//
// DENY BY DEFAULT survives the collapse: a column added to `employees` reaches
// nobody until it is named here. That was the right default when it protected
// pay from the company and it is still the right default now that it protects
// the app from a column somebody added without thinking about it.
const EMPLOYEE_READ_COLUMNS = [
  'id', 'name', 'wage', 'annual_salary', 'dept', 'status', 'days',
  'clock_in', 'clock_out', 'break_1', 'break_2',
  'birthday', 'phone', 'language', 'email',
  'sms_opted_out', 'text_bolt', 'drive_folder_id',
  'employee_number', 'department', 'pay_type', 'cost_class', 'position_group',
  'position', 'address_street', 'address_city', 'address_state', 'address_postal_code',
  'hire_date'
];

const EMPLOYEE_WRITE_COLUMNS = [
  'name', 'status', 'days', 'break_1', 'break_2',
  'birthday', 'phone', 'language', 'email', 'sms_opted_out', 'drive_folder_id',
  'employee_number', 'department', 'pay_type', 'cost_class', 'position_group',
  'position', 'address_street', 'address_city', 'address_state', 'address_postal_code',
  'hire_date', 'wage', 'annual_salary',
  // Retained columns nothing writes today but which the roster has always been
  // able to carry. Listed so a write of one is a decision, not an accident.
  'dept', 'clock_in', 'clock_out', 'text_bolt'
];

// ------------------------------------------------------------------------
// resolution — pure, so it is testable without a database
// ------------------------------------------------------------------------

// Emails are compared lowercased and trimmed. Google hands back a canonical
// address, but an entry typed by hand on the Settings tab will not be
// canonical, and an entry that fails to match because of a capital letter is
// access that looks granted and is not.
function normalizeEmail(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

// The access list, from the rows, deduplicated and sorted. Sorted because this
// IS the email recipient list now, and a recipient list that reorders itself
// between reads is a diff nobody can review.
function resolveAccessList(rows) {
  const out = new Set();
  for (const row of rows || []) {
    const email = normalizeEmail(row && row.email);
    if (email) out.add(email);
  }
  return [...out].sort();
}

function hasAccess(email, rows) {
  const wanted = normalizeEmail(email);
  if (!wanted) return false;
  return resolveAccessList(rows).includes(wanted);
}

// Splits a write body into what may be written and what may not.
//
// REJECTED, NOT DROPPED. Silently discarding a column returns 200 and reports
// success for a write that did not happen, which is how somebody comes to
// believe a change was recorded. The caller gets a 403 naming the columns.
//
// Everyone on the list holds the same rights, so this no longer varies by
// caller — but it still exists, because the question "is this column writable
// through this endpoint at all" is a real one and the answer is not "any column
// PostgREST will accept".
function partitionWrite(body) {
  const permitted = {};
  const refused = [];
  for (const key of Object.keys(body || {})) {
    if (EMPLOYEE_WRITE_COLUMNS.includes(key)) permitted[key] = body[key];
    else refused.push(key);
  }
  return { permitted, refused };
}

// ------------------------------------------------------------------------
// the access table
// ------------------------------------------------------------------------

// Reads the whole list. Small by construction — it is the set of people who use
// the app — so there is no per-email query and no cache to go stale.
//
// THROWS on a real failure rather than returning an empty list. An empty list
// and an unreachable table mean opposite things at sign-in, and a function that
// returns [] for both makes it impossible to tell them apart. Callers decide:
// every endpoint treats a throw as no access; auth.js alone falls back to the
// domain, because locking the whole company out of its own app is worse than
// the day of domain-wide access it would replace.
async function fetchAccessList(db) {
  return resolveAccessList(await fetchAccessRows(db));
}

// The rows, with their tier. Only one thing reads `tier` and it is
// migrationPending() below — the app does not care what somebody's tier says,
// it cares whether the migration that made tiers meaningless has run.
async function fetchAccessRows(db) {
  return (await db.query(ACCESS_TABLE, '?select=email,tier')) || [];
}

// HAS SCHEMA_ACCESS_LIST.sql RUN?
//
// It matters because the table is migrated in two ways that fail differently.
// The CHECK on `tier` still allows only ('salaries','admin') until §2 widens it,
// so an INSERT of tier='access' is refused — but a DELETE is not. Deployed
// without the migration, the app can REMOVE people and cannot ADD them, and the
// list shrinks with no way to grow it. That happened: Ryley Stanley was removed
// on 2026-09-15 and could not be put back.
//
// THE SIGNAL is the seed. §3 writes tier='access' for every person, so after
// the migration at least one such row always exists — the last entry cannot be
// removed, so they cannot all go. Rows that exist and none of them saying
// 'access' therefore means the migration has not run.
//
// An EMPTY table is deliberately NOT pending: it is the pre-seed state, sign-in
// is on the domain fallback, and the first add has to be allowed to work.
function migrationPending(rows) {
  const all = rows || [];
  if (!all.length) return false;
  return !all.some(r => String((r && r.tier) || '').trim().toLowerCase() === 'access');
}

// The other half of the same signal, for the write that actually hits it. The
// CHECK refuses tier='access' with a 23514, and a raw constraint name is not
// something anybody can act on.
function isTierCheckViolation(err) {
  const m = String((err && err.message) || '');
  return /user_permissions_tier_check/.test(m) || /\b23514\b/.test(m);
}

const MIGRATION_REFUSAL = {
  error: 'The access list migration has not been run yet.',
  detail:
    'Run SCHEMA_ACCESS_LIST.sql in the Supabase SQL editor. Until it does, the tier CHECK on ' +
    'user_permissions still refuses the rows this list writes, so nobody can be added — and ' +
    'because a DELETE is not refused the same way, the list could otherwise be emptied with no ' +
    'way to refill it. Both adding and removing are held until the migration runs.'
};

// True when the table does not exist yet — the code deployed before the
// migration ran. Distinguished from a read error because it is expected once,
// on the way in, and means "nobody has set the list up", not "the database is
// broken".
function isMissingTable(err) {
  const message = String((err && err.message) || '');
  return /\b404\b|PGRST205|could not find the table|does not exist/i.test(message);
}

// SIGN-IN ONLY, and the one place this file does not fail closed.
//
// Returns true when the access list cannot answer — the table is missing, or
// unreachable — in which case auth.js falls back to the email domain. Anywhere
// else that would be a hole; here the alternative is nobody can sign in to fix
// it, including the person who would fix it, and the app has no other door.
//
// An EMPTY list is not this case. An empty table is a real answer and it means
// nobody has access — except that the last entry can never be removed, so an
// empty list can only happen before the migration seeds it.
function bootstrapAllows(err) {
  return isMissingTable(err) || !!err;
}

// The refusal, as a sentence somebody can act on.
const LAST_ENTRY_REFUSAL = {
  error: 'The last person cannot be removed from the access list.',
  detail:
    'Everyone on this list can add and remove anyone, including themselves — there are no roles. ' +
    'That only works while somebody is still on it: an empty list locks every account out of the ' +
    'app, and nothing inside the app could put one back. Add the replacement first, then remove ' +
    'this entry.'
};

module.exports = {
  ACCESS_TABLE,
  EMPLOYEE_READ_COLUMNS, EMPLOYEE_WRITE_COLUMNS,
  normalizeEmail, resolveAccessList, hasAccess,
  partitionWrite,
  fetchAccessList, fetchAccessRows, isMissingTable, bootstrapAllows,
  migrationPending, isTierCheckViolation,
  LAST_ENTRY_REFUSAL, MIGRATION_REFUSAL
};
