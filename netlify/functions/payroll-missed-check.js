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

    // The watchdog's own watchdog. This function is the only thing that notices
    // the payroll data stopped arriving, so "it ran and told nobody" has to be
    // an error, not a success: an undeliverable alert (SMTP down, rotated
    // GMAIL_APP_PASSWORD) or a Supabase read it could not complete both mean
    // the pipeline is unverified. Netlify alerts on function errors, not on log
    // lines — a 200 here is a green scheduled run that proves nothing.
    if (result.failed) {
      console.error('Payroll missed-delivery check did not complete:',
        JSON.stringify({
          alertError: result.alertError,
          dataError: result.dataError,
          ledgerError: result.ledgerError
        }));
      return { statusCode: 500, body: JSON.stringify(result) };
    }

    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (err) {
    console.error('Payroll missed-delivery check error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
