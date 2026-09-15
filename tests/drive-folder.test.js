// The HR Drive link.
//
// On 2026-09-15 every profile said "No folder found". employees.drive_folder_id
// was NULL for all 75 rows — nothing had ever written it — so every link on the
// page was produced live, by searching Drive for a folder whose NAME matched the
// employee's, inside a folder found by searching for the NAME 'Employee Files'.
// Three name matches in front of a link that is the same link every time.
//
// What this pins:
//   the parent is an ID, so a rename in Drive cannot empty the page
//   a READ does not create a folder — the page always said the upload does
//   a miss says WHY, because "not found" reads as "there isn't one"

const test = require('node:test');
const assert = require('node:assert');
const { createHmac } = require('node:crypto');

process.env.SESSION_SECRET = 'test-session-secret';
process.env.EMPLOYEE_FILES_FOLDER_ID = 'PARENT_FOLDER_ID';

const docs = require('../netlify/functions/documents');

function cookie(email = 'peter.stroble@sequoiafp.com') {
  const b64 = Buffer.from(JSON.stringify({
    email, access_token: 'test-token', exp: Date.now() + 3600000
  })).toString('base64url');
  return `sfp_session=${b64}.${createHmac('sha256', process.env.SESSION_SECRET).update(b64).digest('base64url')}`;
}

// A fake Drive. `folders` is what exists, keyed 'parentId/name'.
function stubDrive({ folders = {} } = {}) {
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const u = decodeURIComponent(String(url));
    const method = opts.method || 'GET';
    calls.push({ url: u, method, body: opts.body || null });

    // A folder SEARCH names the folder it is looking for. listFiles() also
    // queries with q= but names no folder — it lists a parent's children — so
    // the two are told apart by that, not by the method.
    const named = /name='([^']+)'/.exec(u);
    if (method === 'GET' && u.includes('q=') && named) {
      const parent = /'([^']+)' in parents/.exec(u)[1];
      const hit = folders[`${parent}/${named[1]}`];
      return { ok: true, status: 200, json: async () => ({ files: hit ? [hit] : [] }) };
    }
    if (method === 'GET' && u.includes('q=')) {
      return { ok: true, status: 200, json: async () => ({ files: [] }) };   // listFiles
    }
    // createFolder posts JSON; uploadFile posts multipart with the metadata as
    // its first part. Both are POSTs to a files endpoint.
    if (method === 'POST') {
      let meta = {};
      try { meta = JSON.parse(opts.body); }
      catch { meta = JSON.parse(/(\{[\s\S]*?\})\r?\n/.exec(opts.body)[1]); }
      return { ok: true, status: 200,
               json: async () => ({ id: 'created-' + meta.name, webViewLink: 'https://drive/created' }) };
    }
    return { ok: true, status: 200, json: async () => ({ files: [] }) };
  };
  return calls;
}

const get = (employee) => docs.handler({
  httpMethod: 'GET', headers: { cookie: cookie() },
  queryStringParameters: { employee }
});

const json = (res) => JSON.parse(res.body);

test('a folder that exists is found under the parent ID, not by searching for a name', async () => {
  const calls = stubDrive({
    folders: { 'PARENT_FOLDER_ID/Ana Reyes': { id: 'ana-folder', webViewLink: 'https://drive/ana' } }
  });
  const d = json(await get('Ana Reyes'));

  assert.strictEqual(d.folderId, 'ana-folder');
  assert.strictEqual(d.folderLink, 'https://drive/ana');

  // ONE folder search, straight into the parent. The old code searched the
  // shared drive's root for 'Employee Files' first, every time. (listFiles also
  // queries, so a search is the one that NAMES a folder.)
  const searches = calls.filter(c => /name='/.test(c.url));
  assert.strictEqual(searches.length, 1);
  assert.ok(!searches[0].url.includes('Employee Files'),
    'the parent is an id now — its name is never matched');
  assert.match(searches[0].url, /'PARENT_FOLDER_ID' in parents/);
});

test('A READ NEVER CREATES', async () => {
  // Opening a profile used to create the folder as a side effect, while the page
  // said it would be created on the first upload. Both cannot be true.
  const calls = stubDrive({ folders: {} });
  const d = json(await get('New Hire'));

  assert.strictEqual(d.folderId, null);
  assert.strictEqual(calls.filter(c => c.method === 'POST').length, 0,
    'a profile view created a folder in Drive');
});

test('a miss says WHY, and names the exact-match rule', async () => {
  // "No folder found" reads as "there isn't one", which sends somebody to make
  // a folder that already exists under a slightly different name.
  stubDrive({ folders: {} });
  const d = json(await get('Ana Reyes'));

  assert.match(d.reason, /No folder named "Ana Reyes"/);
  assert.match(d.reason, /EXACTLY/);
  assert.strictEqual(d.searchedIn, 'PARENT_FOLDER_ID', 'and where it looked');
});

test('the upload DOES create, which is what the page always claimed', async () => {
  const calls = stubDrive({ folders: {} });
  const res = await docs.handler({
    httpMethod: 'POST', headers: { cookie: cookie() }, queryStringParameters: {},
    body: JSON.stringify({ employeeName: 'New Hire', fileName: 'w4.pdf',
                           mimeType: 'application/pdf', base64Data: 'eA==' })
  });

  assert.strictEqual(res.statusCode, 200, res.body);
  const meta = (body) => {
    try { return JSON.parse(body); }
    catch { return JSON.parse(/(\{[\s\S]*?\})\r?\n/.exec(body)[1]); }
  };
  const created = calls.filter(c => c.method === 'POST' && /files/.test(c.url));
  assert.ok(created.some(c => meta(c.body).name === 'New Hire'),
    'the folder is created for the upload');
  assert.ok(created.some(c => meta(c.body).parents?.[0] === 'PARENT_FOLDER_ID'),
    'and created under the parent ID');
});

test('the folder id the recorded config had wrong is the one the code now defaults to', () => {
  // README.md and .env.example both recorded ...jpQO8fTr... with an EIGHT. The
  // real folder is ...jpQOBfTr... with a B. DOCS_FOLDER_ID was read by no code,
  // so the typo broke nothing and sat there being wrong in the two places
  // somebody would go to look it up.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'netlify', 'functions', 'documents.js'), 'utf8');
  const env = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');

  assert.match(src, /1TMyTQVjpQOBfTrGppx4KchaHRimwIi9Q/, 'the default is the real folder');
  assert.ok(!/1TMyTQVjpQO8fTrGppx4KchaHRimwIi9Q/.test(src + env), 'the typo is back');
});

test('an unauthenticated caller is refused before Drive is touched', async () => {
  const calls = stubDrive({ folders: {} });
  const res = await docs.handler({
    httpMethod: 'GET', headers: {}, queryStringParameters: { employee: 'Ana Reyes' }
  });
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(calls.length, 0);
});
