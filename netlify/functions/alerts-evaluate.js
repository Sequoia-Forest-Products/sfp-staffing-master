// Netlify scheduled function — hourly (netlify.toml). Re-evaluates every alert
// condition. The missing-file alerts need this: "no daily file by 9:00 AM
// Pacific" is a fact about the clock, and nothing else runs when a file does
// NOT arrive. A UTC cron cannot follow daylight saving, so it runs every hour
// and alerts-lib decides whether 9:00 / Monday 11:00 Pacific has passed.

const { runAlertEvaluation } = require('./alerts-engine');

exports.handler = async () => {
  try {
    const result = await runAlertEvaluation({ log: (...a) => console.log(...a) });
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (err) {
    // A 500, so Netlify's function-error alerting sees an evaluator that
    // cannot run — the alerts tab going quiet must never look like all clear.
    console.error('alerts-evaluate failed:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
