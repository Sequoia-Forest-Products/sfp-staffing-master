// /api/permissions — the access list.
//
//   GET                  the whole list, plus whether the caller is on it.
//   POST   {email}       add.
//   DELETE ?email=       remove.
//
// ONE LIST, NO ROLES. Being on it means everything: sign in, every column, the
// settings, this endpoint, and the weekly OT email. Anyone on it may add or
// remove anyone, including themselves. That is the model chosen on 2026-09-15 —
// see the note at the top of permissions-lib.js for what it replaced and what
// it costs.
//
// THE ONE REFUSAL is the last entry. It is not a role sneaking back in: it
// applies to everybody equally, and it exists because an empty list locks every
// account out of the app and nothing inside the app could put one back.
//
// WHAT THIS ENDPOINT IS NOT. It is not the gate. auth.js checks the list at
// SIGN-IN, and it does so whether or not anybody asked this endpoint anything.
// A caller who lies to themselves about being on the list still cannot get a
// session.
//
// THE LIST IS ALSO THE EMAIL RECIPIENT LIST. send-ot-email.js reads it directly
// rather than keeping a second list beside it — two lists meaning "the managers"
// is one list and one thing that drifts out of date. Adding somebody here
// subscribes them to the Monday report; that is stated on the Settings tab
// rather than left to be discovered.

const db = require('./db');
const perms = require('./permissions-lib');
const { verifySession, getCookies } = require('./session-lib');

const MIGRATION_HINT =
  'The user_permissions table does not exist yet — run SCHEMA_ACCESS_LIST.sql. ' +
  'Until it does, sign-in falls back to the email domain and this list cannot be edited.';

function readableDbError(err) {
  const raw = String((err && err.message) || '');
  const m = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
  if (!m) return raw;
  try { return JSON.parse('"' + m[1] + '"'); } catch { return m[1]; }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const fail = (statusCode, error, extra) =>
    ({ statusCode, headers, body: JSON.stringify(Object.assign({ ok: false, error }, extra || {})) });

  const session = verifySession(getCookies(event).sfp_session || '');
  if (!session) return fail(401, 'Unauthorized');

  const method = event.httpMethod;
  const params = event.queryStringParameters || {};
  const caller = perms.normalizeEmail(session.email);

  // The current list, read once and shared by every branch below. Every branch
  // needs it: GET returns it, POST checks for a duplicate, DELETE counts what
  // would be left.
  let list;
  try {
    list = await perms.fetchAccessList(db);
  } catch (err) {
    if (perms.isMissingTable(err)) {
      return method === 'GET'
        ? { statusCode: 200, headers, body: JSON.stringify({
            ok: true, list: [], hasAccess: false, unavailable: true, detail: MIGRATION_HINT }) }
        : fail(503, MIGRATION_HINT);
    }
    return fail(500, 'The access list could not be read.', { detail: readableDbError(err) });
  }

  if (method === 'GET') {
    return { statusCode: 200, headers, body: JSON.stringify({
      ok: true, list, hasAccess: list.includes(caller), caller
    }) };
  }

  // WRITES. A valid session already proves the caller was on the list when they
  // signed in — that is what auth.js checks — and there are no roles above it,
  // so there is nothing further to test here. Somebody removed mid-session keeps
  // their session until it expires, within 8 hours; see the note in data.js.

  if (method === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return fail(400, 'Body must be JSON.'); }

    const email = perms.normalizeEmail(body.email);
    if (!email) return fail(400, 'An email address is required.');
    if (!EMAIL_RE.test(email)) {
      return fail(400, `"${email}" is not an email address.`);
    }
    // Not an error. Asking for a state the system is already in has been
    // honoured, and answering 409 would make the Settings tab report a failure
    // for a list that says exactly what the caller wanted it to say.
    if (list.includes(email)) {
      return { statusCode: 200, headers, body: JSON.stringify({
        ok: true, list, added: false, detail: `${email} already has access.` }) };
    }

    try {
      // `tier` is still NOT NULL on the table — the migration is additive and
      // the old rows stay readable — so a value is written and nothing reads it.
      await db.insert(perms.ACCESS_TABLE,
        { email, tier: 'access', granted_by: caller });
    } catch (err) {
      return fail(500, 'The access could not be granted.', { detail: readableDbError(err) });
    }
    return { statusCode: 200, headers, body: JSON.stringify({
      ok: true, list: [...list, email].sort(), added: true }) };
  }

  if (method === 'DELETE') {
    const email = perms.normalizeEmail(params.email);
    if (!email) return fail(400, 'An email address is required.');
    if (!list.includes(email)) {
      return { statusCode: 200, headers, body: JSON.stringify({
        ok: true, list, removed: false, detail: `${email} is not on the list.` }) };
    }
    // THE ONE REFUSAL. Counted against the list as read a moment ago rather
    // than trusted from the client, so two people removing the last two entries
    // at once cannot both be told they were the second-to-last.
    if (list.length <= 1) {
      return fail(409, perms.LAST_ENTRY_REFUSAL.error, { detail: perms.LAST_ENTRY_REFUSAL.detail });
    }

    try {
      // EVERY row for this address, not the first. The old tier model let one
      // person hold two rows (salaries and admin) and the migration leaves them
      // in place, so removing one id would leave the other behind and the
      // person still on the list — access that looks revoked and is not.
      const rows = await db.query(perms.ACCESS_TABLE,
        '?select=id&email=eq.' + encodeURIComponent(email));
      for (const row of rows || []) await db.remove(perms.ACCESS_TABLE, row.id);
    } catch (err) {
      return fail(500, 'The access could not be revoked.', { detail: readableDbError(err) });
    }
    return { statusCode: 200, headers, body: JSON.stringify({
      ok: true, list: list.filter(e => e !== email), removed: true,
      self: email === caller }) };
  }

  return fail(405, `Method ${method} is not supported here.`);
};
