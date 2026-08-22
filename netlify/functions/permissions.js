// /api/permissions — who holds which tier, and the admin surface for changing it.
//
//   GET                      the CALLER's own tiers, always. Plus the whole
//                            grant list, but only if the caller is an admin.
//   POST   {email, tier}     grant. Admin only.
//   DELETE ?email=&tier=     revoke. Admin only.
//
// MEMBERSHIP IS DATA — that is the point of this endpoint existing. Before it,
// adding somebody to the salaries tier meant somebody opening the Supabase SQL
// editor, which is a thing exactly one person does and nobody else can audit.
//
// WHAT THIS ENDPOINT IS NOT. It is not the gate. /api/data enforces the column
// rules on every read and write of `employees`, from the same registry, and it
// does so whether or not anybody asked this endpoint anything. What GET returns
// is what the UI needs in order to stop OFFERING a control that would be
// refused — a courtesy, not a control. A caller who lies to themselves about
// their tiers gets exactly the same 403 from /api/data.
//
// THE ADMIN CHECK IS ON THE WRITE PATHS, NOT ON THE READ. Anyone signed in may
// ask what they themselves hold; that is not a disclosure, they could find out
// by trying. Reading OTHER people's grants is admin-only, because the grant list
// is a list of who can see salaries.

const db = require('./db');
const perms = require('./permissions-lib');
const { verifySession, getCookies } = require('./session-lib');

const TABLE = 'user_permissions';

const MIGRATION_HINT =
  'The user_permissions table does not exist yet — run SCHEMA_PHASE_D_PERMISSIONS.sql. ' +
  'Until it does, everybody resolves to the base tier and no salary is visible to anyone, ' +
  'which is the same behaviour as before Phase D.';

function isMissingTableError(err) {
  return /\b404\b|PGRST205|could not find the table|does not exist/i.test(
    String((err && err.message) || ''));
}

// The database refuses the last admin's removal with a plpgsql exception. It is
// a good message and it is written for a person, so it is passed through rather
// than replaced with a generic 409 — but it arrives wrapped in PostgREST's
// envelope, so the readable part is dug out.
function isLastAdminError(err) {
  return /last administrator/i.test(String((err && err.message) || ''));
}

function readableDbError(err) {
  const raw = String((err && err.message) || '');
  const m = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
  if (!m) return raw;
  try { return JSON.parse('"' + m[1] + '"'); } catch { return m[1]; }
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const fail = (statusCode, error, extra) =>
    ({ statusCode, headers, body: JSON.stringify(Object.assign({ ok: false, error }, extra || {})) });

  const session = verifySession(getCookies(event).sfp_session || '');
  if (!session) return fail(401, 'Unauthorized');

  const callerEmail = perms.normalizeEmail(session.email);
  const method = event.httpMethod;

  try {
    // Resolved through the same fetchTiers every other gate uses, so an admin
    // here is an admin there. Fails closed to the base tier, which means a
    // broken permissions read costs an admin the ability to grant — correct,
    // and the reason the recovery path in the migration is plain SQL.
    const tiers = await perms.fetchTiers(callerEmail, db);
    const isAdmin = perms.has(tiers, perms.TIER_ADMIN);

    if (method === 'GET') {
      let grants = null;
      if (isAdmin) {
        try {
          const rows = await db.query(TABLE, '?select=id,email,tier,granted_by,granted_at,note&order=email.asc,tier.asc');
          grants = rows || [];
        } catch (err) {
          if (!isMissingTableError(err)) throw err;
          grants = [];
        }
      }
      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          ok: true,
          email: callerEmail,
          tiers: Array.from(tiers),
          grantableTiers: perms.GRANTABLE_TIERS,
          // null, not []. An admin with no grants to show and a non-admin who
          // may not see them are different answers and the page renders them
          // differently — an empty table versus no table at all.
          grants,
          isAdmin
        })
      };
    }

    if (method !== 'POST' && method !== 'DELETE') {
      return fail(405, 'Method not allowed');
    }

    // ---- everything below is a write, and writes are admin-only ----
    if (!isAdmin) {
      return fail(403, 'Only an administrator may grant or revoke access.');
    }

    const params = event.queryStringParameters || {};
    const body = method === 'POST' ? JSON.parse(event.body || '{}') : {};
    const email = perms.normalizeEmail(method === 'POST' ? body.email : params.email);
    const tier  = String((method === 'POST' ? body.tier : params.tier) || '').trim().toLowerCase();

    if (!email) return fail(400, 'An email address is required.');
    // Checked here as well as by the CHECK constraint, because the database's
    // answer is a constraint violation and this one says what to do about it.
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) {
      return fail(400, `"${email}" is not an email address.`);
    }
    if (!perms.GRANTABLE_TIERS.includes(tier)) {
      return fail(400,
        `"${tier}" is not a grantable tier. Choose one of: ${perms.GRANTABLE_TIERS.join(', ')}.`,
        // Named explicitly, because "hourly_wages" is the guess somebody will
        // make and the reason it is refused is not obvious from the list.
        { detail: tier === perms.TIER_HOURLY_WAGES
            ? 'Hourly wages are the base tier. Everybody signed in already has it, and it is ' +
              'deliberately not stored — a row saying so would make having one and not having ' +
              'one mean the same thing.'
            : undefined });
    }

    if (method === 'POST') {
      try {
        const rows = await db.query(TABLE,
          `?select=id&email=eq.${encodeURIComponent(email)}&tier=eq.${encodeURIComponent(tier)}`);
        if (rows && rows.length) {
          // Not an error. Granting a tier somebody already holds is a no-op and
          // saying "already granted" is more use than a 409 the page has to
          // interpret.
          return { statusCode: 200, headers,
                   body: JSON.stringify({ ok: true, email, tier, alreadyHeld: true }) };
        }
        const inserted = await db.insert(TABLE, {
          email, tier, granted_by: callerEmail, note: 'granted in the app'
        });
        return { statusCode: 200, headers,
                 body: JSON.stringify({ ok: true, email, tier, granted: inserted }) };
      } catch (err) {
        if (isMissingTableError(err)) return fail(503, MIGRATION_HINT);
        throw err;
      }
    }

    // ---- DELETE ----
    try {
      const rows = await db.query(TABLE,
        `?select=id&email=eq.${encodeURIComponent(email)}&tier=eq.${encodeURIComponent(tier)}`);
      if (!rows || !rows.length) {
        return { statusCode: 200, headers,
                 body: JSON.stringify({ ok: true, email, tier, notHeld: true }) };
      }
      await db.remove(TABLE, rows[0].id);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, email, tier, revoked: true }) };
    } catch (err) {
      if (isMissingTableError(err)) return fail(503, MIGRATION_HINT);
      // The last-admin trigger. Its message is written for a person and says
      // what to do — grant somebody else first — so it is surfaced rather than
      // flattened into "conflict".
      if (isLastAdminError(err)) return fail(409, readableDbError(err));
      throw err;
    }

  } catch (err) {
    console.error('permissions error:', err.message);
    return fail(500, err.message);
  }
};
