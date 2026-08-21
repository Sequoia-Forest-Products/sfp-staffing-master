const { createHmac } = require('crypto');
const fs = require('fs');
const path = require('path');

const SESSION_SECRET = process.env.SESSION_SECRET;

// The app's script, in load order. These are classic scripts sharing ONE global
// scope, not ES modules: app.html's inline on* handlers call them by bare name,
// and module scope would break every one of those handlers. So the order here is
// the order the concatenated script body has:
//   core first        — `state`, the constants and the helpers everything reads
//   feature files     — one per tab, in nav order; function declarations hoist,
//                       so the order among these does not matter to the browser,
//                       but it is the reading order and it is kept stable
//   bootstrap last    — the only top-level calls, so nothing runs early
const SCRIPT_MODULES = [
  'core.js',
  'data.js',
  'employees.js',
  'economics.js',
  'overtime.js',
  'points.js',
  'ot-report.js',
  'daily-hours.js',
  'settings-tab.js',
  'bootstrap.js'
];

const APP_HTML     = path.join(__dirname, '../../public/app.html');
const MODULE_DIR   = path.join(__dirname, '../../src/js');
// src/js is deliberately NOT under public/. The modules reach a browser only
// assembled by this function, behind the session check; keeping them outside the
// publish directory is what makes that true by construction rather than by a
// redirect rule that has to be remembered.
const SCRIPT_START = '/* APP_MODULES_START';
const SCRIPT_END   = '/* APP_MODULES_END */';

// Read once per cold start, not once per request.
let cachedShell = null;

// A page missing a module is worse than no page: it would load, render part of
// itself and fail at the first handler that needed the missing file. So a
// missing module names itself and nothing is served.
function buildShell() {
  const parts = SCRIPT_MODULES.map(name => {
    const file = path.join(MODULE_DIR, name);
    let source;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch (err) {
      throw new Error('app script module missing or unreadable: src/js/' + name + ' (' + err.code + ')');
    }
    return source;
  });

  const html  = fs.readFileSync(APP_HTML, 'utf8');
  const start = html.indexOf(SCRIPT_START);
  const end   = html.indexOf(SCRIPT_END);
  if (start < 0 || end < 0 || end < start) {
    throw new Error('app.html has no ' + SCRIPT_START + ' … ' + SCRIPT_END + ' block to fill');
  }

  return html.slice(0, start) + parts.join('\n') + html.slice(end + SCRIPT_END.length);
}

function buildPage(session) {
  if (!cachedShell) cachedShell = buildShell();
  return cachedShell.replace(
    '<!--SESSION_DATA-->',
    `<script>window.__SFP_USER__ = ${JSON.stringify({
      email:   session.email,
      name:    session.name,
      picture: session.picture
    })};</script>`
  );
}

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

  let injected;
  try {
    injected = buildPage(session);
  } catch (err) {
    console.error('session: could not assemble app.html —', err.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' },
      body: 'The app could not be assembled: ' + err.message
    };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' },
    body: injected
  };
};

// The assembly is exported so it can be exercised directly — the assembled
// script body is what the browser actually runs, so that is what gets checked.
exports.__buildPage = buildPage;
exports.__SCRIPT_MODULES = SCRIPT_MODULES;
