// Netlify scheduled function — schedule lives in netlify.toml.
// Sends the bilingual birthday text to every opted-in employee except the
// birthday person(s). All logic lives in birthday-lib.js.
//
// Scheduled functions cannot be invoked over HTTP in production. To test, use
// the Netlify UI "Run now" button, `netlify functions:invoke`, or the
// birthday-test function (see README).

const { runBirthdayNotifications } = require('./birthday-lib');

// Belt and suspenders: DRY_RUN=true composes and logs without sending.
const DRY_RUN = String(process.env.DRY_RUN || '').toLowerCase() === 'true';

exports.handler = async () => {
  try {
    const result = await runBirthdayNotifications({ dryRun: DRY_RUN });

    // A run that reached NOBODY has to leave here as a failure. Netlify alerts
    // on a non-2xx, never on a log line, so returning 200 with sent:0 is how
    // this stayed invisible from 2026-07 onwards: the schedule looked green
    // every Monday to Thursday while nothing was arriving on anyone's phone.
    if (result.deliveryFailed) {
      console.error('Birthday run reached nobody:', JSON.stringify(result));
      return { statusCode: 500, body: JSON.stringify(result) };
    }
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (err) {
    console.error('Birthday notification error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
