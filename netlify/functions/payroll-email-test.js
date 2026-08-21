// Manual trigger for the payroll email ingester.
//
// Netlify does not expose scheduled functions over HTTP, so this separate
// function gives Peter a way to exercise the exact same code path on demand.
//
//   GET  /api/payroll-email-test                    → dry run: connect, parse, log, write nothing
//   GET  /api/payroll-email-test?date=2026-08-19    → pin "now" (affects the lookback window
//                                                      and the future-date check)
//   GET  /api/payroll-email-test?days=14            → widen the lookback window
//   GET  /api/payroll-email-test?check=missed       → dry-run the missed-delivery check
//   POST /api/payroll-email-test?send=true          → actually imports (?commit=true works too)
//   POST /api/payroll-email-test?check=missed&send=true → actually sends the missed-delivery alert
//
// Access requires EITHER a valid sfp_session cookie (just open the URL while
// logged into the app) OR an x-payroll-secret header matching
// PAYROLL_TRIGGER_SECRET.
//
// A bare call is ALWAYS a dry run: this function talks to a live shared mailbox
// and writes live payroll, so importing is opt-in every single time.
//
// GET is dry-run ONLY, and that is a security boundary rather than a style
// choice. The session cookie alone authorises this endpoint, so while
// `?send=true` was reachable over GET, any page anywhere could import live
// payroll or send mail out of a logged-in browser with nothing more than a link
// or an <img src>. sfp_session is SameSite=Lax, which stops the <img> but still
// rides along on a top-level navigation — a link is enough. A cross-site POST
// gets no Lax cookie at all, and the alternative entry (the x-payroll-secret
// header) cannot be set by a cross-site form either. So: reads over GET, writes
// and sends over POST. Parameters may be query string or JSON body on a POST.

const { timingSafeEqual } = require('crypto');
const { runPayrollIngest, runMissedDeliveryCheck } = require('./payroll-email-lib');
const { verifySession, getCookies } = require('./session-lib');

const TRIGGER_SECRET = process.env.PAYROLL_TRIGGER_SECRET;

function secretMatches(provided) {
  if (!TRIGGER_SECRET || !provided) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(TRIGGER_SECRET);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Noon UTC is the same calendar day in Pacific (UTC-7/-8), so a pinned date
// lands on the intended day whichever side of DST we are on.
function mockNow(dateStr) {
  const m = String(dateStr).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  const authorized =
    secretMatches(event.headers['x-payroll-secret']) ||
    !!verifySession(getCookies(event).sfp_session || '');

  if (!authorized) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  // Query string first, JSON body layered on top, so a POST can carry either.
  let params = { ...(event.queryStringParameters || {}) };
  if (event.body) {
    try {
      const parsed = JSON.parse(
        event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body
      );
      if (parsed && typeof parsed === 'object') params = { ...params, ...parsed };
    } catch {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'body must be JSON' }) };
    }
  }

  const truthy = v => String(v || '').toLowerCase() === 'true';

  // Writing is opt-in — a bare call is always a dry run.
  const dryRun = !(truthy(params.send) || truthy(params.commit));

  // Anything that imports payroll or sends mail is a POST. See the header note:
  // this is CSRF protection, not REST tidiness.
  const method = String(event.httpMethod || 'GET').toUpperCase();
  if (!dryRun && method !== 'POST') {
    return {
      statusCode: 405,
      headers: { ...headers, 'Allow': 'GET, POST' },
      body: JSON.stringify({
        error: 'send=true writes payroll and sends email — POST it. GET is dry-run only.'
      })
    };
  }

  let now = new Date();
  if (params.date) {
    const mocked = mockNow(params.date);
    if (!mocked) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'date must be YYYY-MM-DD' }) };
    }
    now = mocked;
  }

  let lookbackDays;
  if (params.days) {
    lookbackDays = parseInt(params.days, 10);
    if (!Number.isFinite(lookbackDays) || lookbackDays < 1 || lookbackDays > 90) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'days must be 1-90' }) };
    }
  }

  // Collect log lines so the response itself shows what the run did — the whole
  // point of the manual trigger is seeing the reasoning, not just the outcome.
  const logs = [];
  const log = (...args) => {
    const line = args.join(' ');
    logs.push(line);
    console.log(line);
  };

  const mode = String(params.check || '').toLowerCase() === 'missed' ? 'missed' : 'ingest';

  try {
    const result = mode === 'missed'
      ? await runMissedDeliveryCheck({ now, dryRun, lookbackDays, log })
      : await runPayrollIngest({ now, dryRun, lookbackDays, log });

    // Same rule as the scheduled handlers: a run that had something to report
    // and could not send it is a failure, and it says so in the status code as
    // well as in the body.
    return {
      statusCode: result.failed ? 500 : 200,
      headers,
      body: JSON.stringify({ ...result, mode, dryRun, logs }, null, 2)
    };
  } catch (err) {
    // err.message is deliberately the only thing echoed, and the lib keeps it
    // safe to echo — the "mailbox not found" error puts the list of every label
    // on the shared info@ inbox in the function log, not in this response.
    console.error('Payroll email test error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message, mode, logs }, null, 2) };
  }
};
