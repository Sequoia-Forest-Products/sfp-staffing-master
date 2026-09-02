// Netlify scheduled function — schedule lives in netlify.toml (Monday morning,
// after Sunday's hours have landed). All logic lives in ot-weekly-email-lib.js;
// this file only wires it up and reports.
//
// This replaces the auto-send that used to hang off commitDailyImport() in
// src/js/daily-hours.js. That hook fired in the BROWSER, after a manual upload
// on the Daily Hours tab — which stopped being how hours arrive when
// payroll-email-ingest took over. Nothing was broken and nothing said so; the
// checkbox stayed on and the email simply never went out again. A schedule the
// data path cannot walk away from is the fix.
//
// Scheduled functions cannot be invoked over HTTP in production. To test, use
// the Netlify UI "Run now" button or `netlify functions:invoke ot-weekly-email`.

const { runWeeklyOtEmail } = require('./ot-weekly-email-lib');

// Belt and suspenders: OT_WEEKLY_DRY_RUN=true builds the week and composes the
// email without sending it.
const DRY_RUN = String(process.env.OT_WEEKLY_DRY_RUN || '').toLowerCase() === 'true';

exports.handler = async () => {
  try {
    const result = await runWeeklyOtEmail({ dryRun: DRY_RUN });

    // Skipping is a correct outcome, not an error — an incomplete week is meant
    // not to go out. What is an error is skipping or half-sending WITHOUT
    // anybody being told, because Netlify alerts on a function error and not on
    // a log line. A 200 for an undeliverable alert is a green scheduled run
    // that proves nothing.
    if (result.deliveryFailed) {
      console.error('Weekly OT email did not complete:', JSON.stringify({
        skipped: result.skipped,
        reasons: result.reasons,
        failed: result.failed,
        alertError: result.alertError
      }));
      return { statusCode: 500, body: JSON.stringify(result) };
    }

    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (err) {
    console.error('Weekly OT email error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
