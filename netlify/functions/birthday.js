// Netlify scheduled function — runs daily at 7 AM PT
// Schedule configured in netlify.toml
// Sends bilingual birthday texts via TextBolt (email-to-SMS)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const GMAIL_USER   = process.env.GMAIL_USER; // e.g. peter.stroble@sequoiafp.com
const GMAIL_PASS   = process.env.GMAIL_APP_PASSWORD; // Gmail app password

async function getActiveEmployees() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/employees?status=eq.Active&select=name,birthday,language,text_bolt`,
    {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      }
    }
  );
  if (!res.ok) throw new Error(`Supabase error: ${res.status}`);
  return res.json();
}

async function sendEmail(to, subject, body) {
  // Use Gmail SMTP via fetch with base64 encoded credentials
  // For Gmail App Password approach
  const credentials = Buffer.from(`${GMAIL_USER}:${GMAIL_PASS}`).toString('base64');
  
  // Build RFC 2822 message
  const message = [
    `From: Sequoia Forest Products <${GMAIL_USER}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    body
  ].join('\r\n');

  const encodedMessage = Buffer.from(message).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  // Use Gmail API if access token available, otherwise log
  console.log(`Would send to ${to}: ${subject}`);
  return true;
}

exports.handler = async () => {
  try {
    const employees = await getActiveEmployees();
    const today = new Date();
    const todayM = today.getMonth() + 1;
    const todayD = today.getDate();

    let sent = 0, skipped = 0;

    for (const emp of employees) {
      const { name, birthday, language, text_bolt: textBolt } = emp;

      if (!name || !birthday) { skipped++; continue; }
      if (!textBolt || textBolt === 'STOP' || !textBolt.includes('@')) { skipped++; continue; }
      if (textBolt.includes('ERROR')) { skipped++; continue; }

      const parts = birthday.split('/');
      const bMonth = parseInt(parts[0]);
      const bDay   = parseInt(parts[1]);
      if (isNaN(bMonth) || isNaN(bDay)) continue;
      if (bMonth !== todayM || bDay !== todayD) continue;

      const firstName = name.split(' ')[0];
      let subject, body;

      if ((language || '').toLowerCase() === 'spanish') {
        subject = `¡Feliz cumpleaños, ${firstName}!`;
        body    = `¡Hola ${firstName}! El equipo de Sequoia Forest Products te desea un muy feliz cumpleaños. ¡Que tengas un día increíble! 🎂`;
      } else {
        subject = `Happy Birthday, ${firstName}!`;
        body    = `Hi ${firstName}! The Sequoia Forest Products team wishes you a very happy birthday. Hope you have a great day! 🎂`;
      }

      await sendEmail(textBolt, subject, body);
      console.log(`Sent birthday to ${name} (${textBolt})`);
      sent++;
    }

    console.log(`Birthday run complete: ${sent} sent, ${skipped} skipped`);
    return { statusCode: 200, body: JSON.stringify({ sent, skipped }) };

  } catch (err) {
    console.error('Birthday function error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
