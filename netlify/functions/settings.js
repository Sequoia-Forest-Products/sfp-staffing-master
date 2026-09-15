const db = require('./db');

const { verifySession, getCookies } = require('./session-lib');

// This endpoint had NO session check on either method. GET returned any
// settings row by key, and POST wrote to the settings table with the
// service-role key — so anyone on the internet could overwrite emailSettings,
// which carries the manager email list and graceHoursPerEmployee, the
// pre-approved allowance the OT report measures net OT against.
//
// It is the same hole /api/data had, and it survived that fix precisely BECAUSE
// it is a separate endpoint: the table allowlist added there covers the four
// tables /api/data serves and never saw this file.
//
// verifySession and getCookies now come from session-lib.js. The note that used
// to sit here called this "the fourth copy" — the real count was eleven, and the
// consolidation was done on its own, as this comment said it should be.
// The key went into the PostgREST query string raw, so `?key=x&limit=1` did not
// look up the key "x&limit=1" — it appended a second parameter to the request
// and PostgREST honoured it. Anything acceptable in a filter position could be
// injected the same way. Encoding it makes the value a value.
const settingsFilter = (key) => `?key=eq.${encodeURIComponent(key)}`;

// ------------------------------------------------------------------------
// WRITES ARE ADMIN-ONLY. READS ARE NOT.
// ------------------------------------------------------------------------
//
// The same shape as /api/permissions, and for the same reason: this endpoint
// carries decisions that are nobody's to make casually.
//
//   emailSettings.managers   THE RECIPIENT LIST FOR THE WEEKLY OT REPORT, which
//                            carries per-person dollars. A text field anybody
//                            signed in could type an address into is a
//                            compensation disclosure with a Save button — the
//                            exact thing the Phase D tiers exist to prevent,
//                            reached through a different endpoint. That is how
//                            this file survived the /api/data fix in the first
//                            place: the table allowlist added there covers the
//                            four tables that endpoint serves and never saw
//                            this one.
//
//   graceHoursPerEmployee    At ~54 hourly staff, 0.5 hrs/person/week is ~27
//                            hours of pre-approved OT. Moving it moves the
//                            headline Net OT figure on every report, with
//                            nothing recording that it moved or who moved it.
//
//   otBudgetPercent          Decides what managers are TOLD is over budget.
//
// Reads stay open deliberately. Everybody should be able to see what the
// allowance and the budget currently are — the figures are already visible on
// every report that uses them, and hiding the settings that produce them would
// make the reports less legible without protecting anything. What is gated is
// changing them.
//
// The check sits ABOVE any parsing or database access, so a refused request
// reaches no table — the same ordering /api/permissions uses, and the thing its
// test asserts.

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  const session = verifySession(getCookies(event).sfp_session || '');
  if (!session) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };

  const method = event.httpMethod;
  const params = event.queryStringParameters || {};
  const key = params.key || 'default';

  try {
    // GET /api/settings?key=emailSettings
    if (method === 'GET') {
      try {
        const rows = await db.query('settings', settingsFilter(key));
        if (rows.length > 0) {
          return { statusCode: 200, headers, body: JSON.stringify({ data: rows[0] }) };
        }
        return { statusCode: 404, headers, body: JSON.stringify({ data: null }) };
      } catch (err) {
        // THE READ FAILED, AND SAYING SO IS THE WHOLE POINT OF THIS BRANCH.
        //
        // It used to answer {data: null} with a 200 and a comment reading
        // "Table might not exist yet - return empty". That was written as a
        // deploy-before-migration convenience and it worked exactly as
        // intended — which is the problem. public.settings was never created at
        // all, and for months this branch answered every read with a cheerful
        // 200: the Settings tab rendered its defaults, looked entirely healthy,
        // and nothing anywhere said the table was missing. The only surface
        // that ever complained was the Monday OT email refusing to send, and it
        // took somebody reading that alert to find it.
        //
        // Still a 200 with data: null, because a settings read that fails must
        // not take the page down — the roster and every report are fine without
        // it. What changes is that the answer now distinguishes "no row yet"
        // (data: null, and nothing else) from "the read itself failed"
        // (unavailable: true), so the page can say which. A caller that only
        // reads .data behaves exactly as before.
        console.error('Settings read failed:', err.message);
        return {
          statusCode: 200, headers,
          body: JSON.stringify({ data: null, unavailable: true, reason: err.message })
        };
      }
    }

    // POST /api/settings - save setting.
    //
    // THE ADMIN CHECK IS GONE, 2026-09-15, with the tiers it belonged to. Being
    // signed in is being on the access list — auth.js checks it — and everyone
    // on that list holds the same rights by decision. A second gate here would
    // be a role, and the model has none.
    //
    // What that opens is real and was accepted knowingly: anyone on the list can
    // move the timeclock grace allowance and the OT budget, both of which change
    // what the weekly report says. The list is short and everyone on it is a
    // manager. The recipient list is no longer among the things this endpoint
    // can change at all — it IS the access list now, and it is edited through
    // /api/permissions.
    if (method === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const settingKey = body.key;
      const settingValue = body.value;

      // Must be a non-empty string. A number or an object here would be
      // template-stringified into the filter, which is how "[object Object]"
      // becomes a settings key nobody can find again.
      if (!settingKey || typeof settingKey !== 'string') {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'key required' }) };
      }

      try {
        // Try to check if exists
        const existing = await db.query('settings', settingsFilter(settingKey)).catch(() => []);

        if (existing.length > 0) {
          // Update existing
          const row = await db.update('settings', existing[0].id, {
            value: JSON.stringify(settingValue),
            updated_at: new Date().toISOString()
          });
          return { statusCode: 200, headers, body: JSON.stringify({ data: row }) };
        } else {
          // Insert new
          const row = await db.insert('settings', {
            key: settingKey,
            value: JSON.stringify(settingValue)
          });
          return { statusCode: 200, headers, body: JSON.stringify({ data: row }) };
        }
      } catch (err) {
        console.error('Settings save error:', err.message);
        return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
      }
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  } catch (err) {
    console.error('Settings error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
