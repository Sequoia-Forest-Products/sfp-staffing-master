// GET /api/employee-history?employeeId=<uuid>
//
// The two histories the profile card shows: every recorded change to a person's
// hourly rate, and every recorded change to their classification.
//
// WHY THIS IS ITS OWN ENDPOINT. Neither wage_history nor position_history is in
// data.js's ALLOWED_TABLES, deliberately — no browser may read or write them
// directly, because an append-only record that the client can query freely is
// one query-string edit away from being a compensation export. This is the
// narrow, single-person read instead: one employee id, two fixed projections,
// nothing else reachable.
//
// WHAT IT DOES NOT CARRY. wage_history holds hourly rates only —
// wage-edit-lib.js refuses to record a rate for a salaried person, because
// their cost is annual_salary / 2080 and a rate row would be a second,
// disagreeing figure. So no salary crosses this wire, at any tier, and this
// endpoint deliberately has no tier gate for that reason rather than by
// omission. Hourly rates are base-tier readable (permissions-lib.js), and
// classification is not compensation at all.
//
// If a salary history is ever wanted, it needs its own table AND its own gate
// on the salaries tier. It must not be folded in here.

const db = require('./db');
const { verifySession, getCookies } = require('./session-lib');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Bounded. A person with a pathological number of rows must not be able to
// return an unbounded payload, and nobody reads past the recent past on a card.
const LIMIT = 50;

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  const session = verifySession(getCookies(event).sfp_session || '');
  if (!session) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const employeeId = String((event.queryStringParameters || {}).employeeId || '').trim();
  // Validated as a UUID before it reaches a query string. Not because db.query
  // interpolates it unescaped — it encodes — but because an id that is not an
  // id can only be a mistake or a probe, and answering it costs a round trip.
  if (!UUID_RE.test(employeeId)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'employeeId must be a uuid' }) };
  }

  const id = encodeURIComponent(employeeId);

  try {
    // Two independent reads. position_history does not exist until
    // SCHEMA_POSITION_HISTORY.sql runs, and the card must still show rate
    // history on a database that has not had it applied yet — so a missing
    // table is an empty list plus a stated reason, never a 500 that blanks
    // both halves.
    const [wage, position] = await Promise.all([
      db.query('wage_history',
        `?employee_id=eq.${id}&select=id,rate,previous_rate,change_pct,effective_date,source,flagged,note,created_at` +
        `&order=effective_date.desc,created_at.desc&limit=${LIMIT}`)
        .catch(err => { console.error('wage_history read failed:', err.message); return null; }),
      db.query('position_history',
        `?employee_id=eq.${id}&select=id,field,previous_value,new_value,changed_by,changed_at,note` +
        `&order=changed_at.desc&limit=${LIMIT}`)
        .catch(err => { console.error('position_history read failed:', err.message); return null; })
    ]);

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        ok: true,
        employeeId,
        wage: wage || [],
        position: position || [],
        // Which half could not be read, so the card says "could not load" rather
        // than "no changes recorded". Those are opposite claims and only one of
        // them is reassuring.
        wageUnavailable: wage === null,
        positionUnavailable: position === null
      })
    };
  } catch (err) {
    console.error('employee-history error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

module.exports.UUID_RE = UUID_RE;
module.exports.LIMIT = LIMIT;
