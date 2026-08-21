// Run with: npm test
//
// This test used to hold a list of 404 redirect rules against a list of 69
// tracked files, because publish = "." served the repo root and every file was
// public by default. That was a guard against instances while the root cause
// stayed: four things were found open in turn, each fixed by adding a rule, and
// one of the rules (`from = "/*.sql"`) never matched anything in the first place.
//
// publish now points at public/, so the default inverted. src/, tests/,
// netlify/, the .sql files, the docs and package.json are not in the deploy at
// all — not blocked by a rule that has to be remembered, just absent. What is
// left to defend is much smaller, and that is the point:
//
//   1. publish must keep pointing at a subdirectory, never back at the root.
//   2. only deliberately-public files may sit in that subdirectory.
//   3. the two things the app reads off disk at runtime must still be where
//      the session function looks for them.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const toml = () => fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');

const publishDir = () => {
  const m = toml().match(/^\s*publish\s*=\s*"([^"]*)"/m);
  assert.ok(m, 'netlify.toml has no publish setting');
  return m[1];
};

// Everything the deploy will contain, relative to the publish directory.
function publishedFiles() {
  const dir = path.join(ROOT, publishDir());
  const out = [];
  (function walk(d, prefix) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(d, entry.name), rel);
      else out.push(rel);
    }
  })(dir, '');
  return out.sort();
}

// The complete public surface. Three files. Anything added here is readable by
// anyone on the internet with no session, so adding one should feel deliberate.
const EXPECTED_PUBLIC = [
  'app.html',                  // forced to the session function, cookie-gated
  'icons/staffing-and-hr.svg',
  'index.html'                 // the login page
];

test('publish points at a subdirectory, not at the repo root', () => {
  const dir = publishDir();
  assert.notStrictEqual(dir, '.',
    'publish = "." serves the whole repo tree. That is how src/js, the .sql ' +
    'files, app.html.backup, the tests/ tree and every netlify/functions/*.js ' +
    'each came to be world-readable in turn. Keep it pointed at public/.');
  assert.ok(dir && !dir.startsWith('/') && !dir.startsWith('..'),
    `publish = "${dir}" must be a subdirectory of the repo`);
  assert.ok(fs.existsSync(path.join(ROOT, dir)), `the publish directory ${dir}/ does not exist`);
});

test('the publish directory holds exactly the intended public files', () => {
  // Deliberately an equality check, not a subset check. A new file appearing in
  // public/ is the one thing that silently widens the public surface now, so it
  // has to fail here rather than ship.
  assert.deepStrictEqual(publishedFiles(), EXPECTED_PUBLIC);
});

test('nothing sensitive is inside the publish directory', () => {
  const dir = publishDir();
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map(s => s.trim()).filter(Boolean);

  // The four categories that were each found open under publish = ".", asserted
  // by where they live rather than by whether a rule happens to cover them.
  const mustBeOutside = tracked.filter(f =>
    f.startsWith('src/') || f.startsWith('tests/') || f.startsWith('netlify/') ||
    f.endsWith('.sql') || f.endsWith('.md') || f.startsWith('package'));

  const leaked = mustBeOutside.filter(f => f.startsWith(dir + '/'));
  assert.deepStrictEqual(leaked, [],
    `these are inside the publish directory and would be served:\n` +
    leaked.map(f => '  ' + f).join('\n'));

  // and the sensitive trees must still exist where they are expected to be
  for (const d of ['src/js', 'tests', 'netlify/functions']) {
    assert.ok(fs.existsSync(path.join(ROOT, d)), `${d} is missing`);
    assert.ok(!d.startsWith(dir + '/'), `${d} must not be under ${dir}/`);
  }
});

test('the session function can still find what it assembles at runtime', () => {
  // Moving app.html without moving these two together is the way this change
  // breaks: the function bundle would be missing the file it reads, and /app.html
  // would 500 for everyone rather than fail in a test.
  const session = fs.readFileSync(path.join(ROOT, 'netlify/functions/session.js'), 'utf8');

  const appHtml = session.match(/APP_HTML\s*=\s*path\.join\(__dirname,\s*'([^']+)'\)/);
  assert.ok(appHtml, 'session.js no longer has an APP_HTML path to check');
  const resolved = path.join(ROOT, 'netlify/functions', appHtml[1]);
  assert.ok(fs.existsSync(resolved), `session.js reads ${appHtml[1]}, which does not exist`);
  assert.strictEqual(path.relative(ROOT, resolved), path.join(publishDir(), 'app.html'),
    'APP_HTML must point at the app.html inside the publish directory');

  const moduleDir = session.match(/MODULE_DIR\s*=\s*path\.join\(__dirname,\s*'([^']+)'\)/);
  assert.ok(moduleDir, 'session.js no longer has a MODULE_DIR path to check');
  const modules = path.join(ROOT, 'netlify/functions', moduleDir[1]);
  assert.ok(fs.existsSync(modules), `session.js reads ${moduleDir[1]}, which does not exist`);
  assert.ok(!path.relative(ROOT, modules).startsWith(publishDir() + path.sep),
    'src/js must stay OUTSIDE the publish directory — that is what keeps the ' +
    'modules behind the session check by construction rather than by a redirect');
});

test('included_files lists what the session bundle actually reads', () => {
  // included_files is built from a manifest rather than literal requires, so a
  // path that moves without this line moving too fails only at runtime.
  const m = toml().match(/included_files\s*=\s*\[([^\]]*)\]/);
  assert.ok(m, 'netlify.toml has no included_files for the session function');
  const listed = m[1].split(',').map(s => s.trim().replace(/^"|"$/g, '')).filter(Boolean);

  assert.ok(listed.includes(path.posix.join(publishDir(), 'app.html')),
    `included_files must carry ${publishDir()}/app.html, got ${JSON.stringify(listed)}`);
  assert.ok(listed.some(f => f.startsWith('src/js')),
    `included_files must carry the src/js modules, got ${JSON.stringify(listed)}`);
});

test('the app.html rules are still forced', () => {
  // app.html is the one sensitive-ish file that MUST be in the publish directory,
  // so it is the one place the old shadowing hazard still applies: an unforced
  // rule loses to the real file and the page bypasses the session function.
  const blocks = toml().split(/^\[\[redirects\]\]\s*$/m).slice(1);
  const appRules = blocks
    .map(b => b.split(/^\[/m)[0])
    .filter(b => /^\s*from\s*=\s*"\/app\.html"/m.test(b));

  assert.strictEqual(appRules.length, 2, 'expected the cookie-gated rule and the fallback');
  for (const r of appRules) {
    assert.match(r, /^\s*force\s*=\s*true/m,
      'both /app.html rules need force = true, or Netlify serves the static file ' +
      'and the page never reaches the session check');
  }
});
