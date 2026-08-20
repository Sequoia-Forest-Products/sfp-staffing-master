// Run with: npm test
//
// netlify.toml sets publish = ".", which means the DEFAULT for every file in
// this repo is "served to the public internet, with no session check". Four
// separate things have been found open that way in turn — src/js/*.js, the
// .sql files, app.html.backup, and the whole tests/ tree — each time after the
// fact. This test exists so there is no fifth time.
//
// It is a guard, not a scan: it cannot see production. What it does is hold the
// publish tree and the redirect table against each other, so adding a file
// without deciding whether it is public fails here instead of quietly shipping.
//
// If this test fails because you added a file, do one of two things:
//   - it is meant to be public   -> add it to PUBLIC
//   - it is not (almost always)  -> add a 404 rule to netlify.toml
//
// Do not "fix" it by widening a pattern. See NETLIFY MATCHING below.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// NETLIFY MATCHING
//
// Netlify's `*` is a TRAILING SPLAT — it stands for the rest of the path — and
// its `:name` placeholders match one path segment. It is NOT a glob: there is
// no extension matching and no mid-segment wildcard.
//
// This repo learned that the expensive way. `from = "/*.sql"` sat in
// netlify.toml looking like protection while all eleven .sql files were served,
// because the pattern matched no request at all. So this file models only the
// two shapes that are known to work, and treats anything else as covering
// NOTHING rather than assuming it works.
// ---------------------------------------------------------------------------

function ruleShape(from) {
  if (typeof from !== 'string' || !from.startsWith('/')) return 'invalid';
  const star = from.indexOf('*');
  if (star === -1) return from.includes(':') ? 'placeholder' : 'exact';
  // A splat is only meaningful as the whole final segment: "/prefix/*" or "/*".
  if (star === from.length - 1 && (from === '/*' || from.endsWith('/*'))) return 'splat';
  return 'invalid';
}

function matches(from, urlPath) {
  switch (ruleShape(from)) {
    case 'exact': return from === urlPath;
    case 'splat': {
      if (from === '/*') return true;
      const prefix = from.slice(0, -1);           // keep the trailing slash
      return urlPath.startsWith(prefix);
    }
    default: return false;                         // covers nothing
  }
}

// ---------------------------------------------------------------------------
// What Netlify actually serves out of the publish directory.
//
// Verified against production rather than assumed: dotfiles (.env.example,
// .gitignore) and netlify.toml itself came back 404 on the live site, so they
// are not part of the deploy. Everything else in the git tree was reachable.
// ---------------------------------------------------------------------------

function servedPaths() {
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map(s => s.trim()).filter(Boolean);

  return tracked
    .filter(f => !path.basename(f).startsWith('.'))   // dotfiles are not deployed
    .filter(f => !f.split('/').some(seg => seg.startsWith('.')))
    .filter(f => f !== 'netlify.toml')                // consumed by Netlify, not published
    .map(f => '/' + f);
}

// Deliberately tiny, and it should stay that way. Anything added here is
// readable by anyone on the internet with no session.
const PUBLIC = new Set([
  '/index.html',                    // the login page
  '/icons/staffing-and-hr.svg',     // referenced by it
  '/app.html'                       // forced to the session function, gated by cookie
]);

function redirects() {
  // Parsed with a narrow reader rather than a TOML dependency: this repo has no
  // dev dependencies and adding one to read its own config would be silly.
  const toml = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');
  const out = [];
  const blocks = toml.split(/^\[\[redirects\]\]\s*$/m).slice(1);
  for (const block of blocks) {
    const body = block.split(/^\[\[/m)[0].split(/^\[(?!\[)/m)[0];
    const from = (body.match(/^\s*from\s*=\s*"([^"]*)"/m) || [])[1];
    const status = (body.match(/^\s*status\s*=\s*(\d+)/m) || [])[1];
    const force = /^\s*force\s*=\s*true/m.test(body);
    if (from) out.push({ from, status: status ? Number(status) : 200, force });
  }
  return out;
}

const blockers = () => redirects().filter(r => r.status === 404);

test('every redirect rule uses a shape Netlify actually matches', () => {
  // The /*.sql regression, caught structurally. An unsupported pattern is not a
  // style problem — it is a rule that protects nothing while looking like it does.
  for (const r of redirects()) {
    assert.notStrictEqual(ruleShape(r.from), 'invalid',
      `netlify.toml: from = "${r.from}" is not a shape Netlify matches. ` +
      `Use an exact path, or a prefix ending in /*. ` +
      `A pattern like "/*.sql" matches nothing at all.`);
  }
});

test('every 404 rule is forced, or the file it names shadows it', () => {
  // Netlify does not apply a redirect whose `from` matches a real file in the
  // publish directory unless force = true. An unforced 404 over an existing
  // file is another rule that reads as protection and is not — this is how
  // /app.html was served statically while a rule said otherwise.
  for (const r of blockers()) {
    assert.strictEqual(r.force, true,
      `netlify.toml: the 404 for "${r.from}" needs force = true, or the real ` +
      `file in the publish directory will be served instead of the rule.`);
  }
});

test('no file in the publish tree is publicly reachable by accident', () => {
  const rules = blockers();
  const exposed = servedPaths()
    .filter(p => !PUBLIC.has(p))
    .filter(p => !rules.some(r => matches(r.from, p)));

  assert.deepStrictEqual(exposed, [],
    exposed.length
      ? `publish = "." serves these to the public internet with no session ` +
        `check and nothing in netlify.toml blocks them:\n` +
        exposed.map(p => '  ' + p).join('\n') +
        `\n\nAdd a 404 rule to netlify.toml, or add the path to PUBLIC in this ` +
        `test if it is genuinely meant to be world-readable.`
      : undefined);
});

test('the server source is blocked as a directory, not file by file', () => {
  // 23 functions today and more later; an exact rule per file would rot. The
  // invocation path is /.netlify/functions/* — leading dot, different path — so
  // blocking /netlify/* cannot break the /api/* rewrite.
  const rules = blockers();
  assert.ok(rules.some(r => r.from === '/netlify/*'),
    'netlify.toml must 404 /netlify/* — publish = "." serves the function source verbatim');

  for (const f of ['/netlify/functions/db.js', '/netlify/functions/session.js',
                   '/netlify/functions/auth.js', '/netlify/functions/payroll-lib.js']) {
    assert.ok(rules.some(r => matches(r.from, f)), `${f} must not be publicly readable`);
  }
  // and the rule must not reach the invocation path
  assert.ok(!rules.some(r => matches(r.from, '/.netlify/functions/session')),
    'a blocker rule must never match /.netlify/functions/* — that would break every API call');
});

test('the test tree and the vendor fixture are blocked', () => {
  const rules = blockers();
  for (const f of ['/tests/payroll.test.js', '/tests/helpers/make-xlsx.js',
                   '/tests/fixtures/bbsi-work-summary-payroll.xlsx']) {
    assert.ok(rules.some(r => matches(r.from, f)), `${f} must not be publicly readable`);
  }
});

test('PUBLIC stays small, and everything in it really exists', () => {
  // A stale entry here is a hole that outlives the file it was added for.
  for (const p of PUBLIC) {
    assert.ok(fs.existsSync(path.join(ROOT, p.slice(1))), `PUBLIC lists ${p}, which does not exist`);
  }
  assert.ok(PUBLIC.size <= 5,
    `PUBLIC has grown to ${PUBLIC.size} entries. Each one is world-readable with ` +
    `no session — confirm that is intended before raising this bound.`);
});
