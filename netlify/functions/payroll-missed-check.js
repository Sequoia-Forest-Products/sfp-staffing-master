// Netlify scheduled function — schedule lives in netlify.toml (once a day,
// after the delivery window has closed).
//
// The hourly ingest can only report on mail that arrived. This is the other
// half: it notices the day nothing arrived at all, and it re-surfaces anything
// the ingest parked in pending_review or error. All logic lives in
// payroll-email-lib.js.
//
// It deliberately escalates only for a missing Mon-Thu scheduled day. Fri/Sat/Sun
// are legitimate work days but not promised ones — no rows usually means nobody
// worked, and alerting on that trains everyone to ignore the alert.

const { runMissedDeliveryCheck } = require('./payroll-email-lib');

const DRY_RUN = String(process.env.PAYROLL_DRY_RUN || '').toLowerCase() === 'true';

exports.handler = async () => {
  try {
    const result = await runMissedDeliveryCheck({ dryRun: DRY_RUN });
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (err) {
    console.error('Payroll missed-delivery check error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
