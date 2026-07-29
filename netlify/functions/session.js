const { createHmac } = require('crypto');
const fs = require('fs');
const path = require('path');

const SESSION_SECRET = process.env.SESSION_SECRET;

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

exports.handler = async (event) => {
  const cookies = Object.fromEntries(
    (event.headers.cookie || '').split(';').map(c => {
      const [k, ...v] = c.trim().split('=');
      return [k, v.join('=')];
    })
  );

  const session = verifySession(cookies.sfp_session || '');
  if (!session) {
    return { statusCode: 302, headers: { Location: '/?error=unauthorized' }, body: '' };
  }

  const html = fs.readFileSync(path.join(__dirname, '../../app.html'), 'utf8');
  const injected = html.replace(
    '<!--SESSION_DATA-->',
    `<script>window.__SFP_USER__ = ${JSON.stringify({
      email:   session.email,
      name:    session.name,
      picture: session.picture
    })};</script>`
  );

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' },
    body: injected
  };
};
