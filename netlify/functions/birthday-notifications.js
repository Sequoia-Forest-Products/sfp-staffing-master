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
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (err) {
    console.error('Birthday notification error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
