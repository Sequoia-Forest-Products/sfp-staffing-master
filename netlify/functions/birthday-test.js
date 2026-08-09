// Manual trigger for the birthday notifier.
//
// Netlify does not expose scheduled functions over HTTP, so this separate
// function gives Peter a way to exercise the exact same code path on demand.
//
//   GET /api/birthday-test                       → dry run for today
//   GET /api/birthday-test?date=2026-03-15       → dry run pretending it is Mar 15
//   GET /api/birthday-test?send=true             → actually sends
//
// Access requires EITHER a valid sfp_session cookie (just open the URL while
// logged into the app) OR an x-birthday-secret header matching
// BIRTHDAY_TRIGGER_SECRET.

const { createHmac, timingSafeEqual } = require('crypto');
const { runBirthdayNotifications } = require('./birthday-lib');

const SESSION_SECRET = process.env.SESSION_SECRET;
const TRIGGER_SECRET = process.env.BIRTHDAY_TRIGGER_SECRET;

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

// Noon UTC is the same calendar day in Mountain Time (UTC-6/-7), so this lands
// on the intended date whichever side of DST we are on.
function mockNow(dateStr) {
  const m = String(dateStr).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  const authorized =
    secretMatches(event.headers['x-birthday-secret']) ||
    !!verifySession(getCookies(event).sfp_session || '');

  if (!authorized) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const params = event.queryStringParameters || {};

  // Sending is opt-in — a bare call is always a dry run.
  const dryRun = String(params.send || '').toLowerCase() !== 'true';

  let now = new Date();
  if (params.date) {
    const mocked = mockNow(params.date);
    if (!mocked) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'date must be YYYY-MM-DD' }) };
    }
    now = mocked;
  }

  // Collect log lines so the response itself shows the composed message.
  const logs = [];
  const log = (...args) => {
    const line = args.join(' ');
    logs.push(line);
    console.log(line);
  };

  try {
    const result = await runBirthdayNotifications({ now, dryRun, log });
    return { statusCode: 200, headers, body: JSON.stringify({ ...result, dryRun, logs }, null, 2) };
  } catch (err) {
    console.error('Birthday test error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message, logs }) };
  }
};
