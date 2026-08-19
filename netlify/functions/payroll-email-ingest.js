// Netlify scheduled function — schedule lives in netlify.toml (hourly).
//
// Reads the "payroll import" Gmail label on info@ over IMAP, read-only, and
// imports any daily payroll workbook it has not seen before. All logic lives in
// payroll-email-lib.js; this file only wires it up and reports.
//
// Hourly rather than daily on purpose: the vendor sends at ~6:04 AM Pacific but
// has been late before, and the ingest is idempotent (processed_emails keys off
// the RFC822 Message-ID), so re-running costs nothing.
//
// Scheduled functions cannot be invoked over HTTP in production. To test, use
// the Netlify UI "Run now" button, `netlify functions:invoke`, or the
// payroll-email-test function.

const { runPayrollIngest } = require('./payroll-email-lib');

// Belt and suspenders: PAYROLL_DRY_RUN=true parses and logs without writing.
// payroll-email-lib reads the same variable; passing it explicitly keeps the
// intent visible in the logs of a scheduled run.
const DRY_RUN = String(process.env.PAYROLL_DRY_RUN || '').toLowerCase() === 'true';

exports.handler = async () => {
  try {
    const result = await runPayrollIngest({ dryRun: DRY_RUN });
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (err) {
    // A thrown error here is an infrastructure failure (IMAP down, missing
    // label, bad credentials), not a bad message — those are captured per
    // message in the result and alerted from the lib.
    console.error('Payroll email ingest error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
