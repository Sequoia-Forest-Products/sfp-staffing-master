// Manual trigger for the payroll email ingester.
//
// Netlify does not expose scheduled functions over HTTP, so this separate
// function gives Peter a way to exercise the exact same code path on demand.
//
//   GET /api/payroll-email-test                    → dry run: connect, parse, log, write nothing
//   GET /api/payroll-email-test?send=true          → actually imports (?commit=true works too)
//   GET /api/payroll-email-test?date=2026-08-19    → pin "now" (affects the lookback window
//                                                     and the future-date check)
//   GET /api/payroll-email-test?days=14            → widen the lookback window
//   GET /api/payroll-email-test?check=missed       → run the missed-delivery check instead
//
// Access requires EITHER a valid sfp_session cookie (just open the URL while
// logged into the app) OR an x-payroll-secret header matching
// PAYROLL_TRIGGER_SECRET.
//
// A bare call is ALWAYS a dry run: this function talks to a live shared mailbox
// and writes live payroll, so importing is opt-in every single time.

const { createHmac, timingSafeEqual } = require('crypto');
const { runPayrollIngest, runMissedDeliveryCheck } = require('./payroll-email-lib');

const SESSION_SECRET = process.env.SESSION_SECRET;
const TRIGGER_SECRET = process.env.PAYROLL_TRIGGER_SECRET;

function verifySession(token) {
  try {
    const [b64, sig] = token.split('.');
    const expected   = createHmac('sha256', SESSION_SECRET).update(b64).digest('base64url');
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

function getCookies(event) {
  return Object.fromEntries(
    (event.headers.cookie || '').split(';').map(c => {
      const [k, ...v] = c.trim().split('=');
      return [k, v.join('=')];
    })
  );
}

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

  const params = event.queryStringParameters || {};
  const truthy = v => String(v || '').toLowerCase() === 'true';

  // Writing is opt-in — a bare call is always a dry run.
  const dryRun = !(truthy(params.send) || truthy(params.commit));

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

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ...result, mode, dryRun, logs }, null, 2)
    };
  } catch (err) {
    console.error('Payroll email test error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message, mode, logs }, null, 2) };
  }
};
