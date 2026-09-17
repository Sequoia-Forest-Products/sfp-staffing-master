// Pairing an employee with their HR folder in Drive.
//
// THE BUG THESE EXIST FOR. Adding an employee fired a lookup at
// /api/documents and threw the response away:
//
//     if(isNew && e.name){
//       fetch('/api/documents?employee='+encodeURIComponent(e.name)).catch(()=>{});
//     }
//
// Nothing read `folderId`, so drive_folder_id was never written, and the card
// went on saying there was no folder. The comment above it called this
// "Auto-create Drive folder", which had been untrue since 2026-09-15, when a
// GET stopped creating anything — reads find, uploads create. The card's own
// copy then promised the same thing the code was not doing: "one is created for
// a new employee automatically". HR created three folders by hand in Drive,
// named exactly right, and waited a day for a pairing nothing was performing.
//
// So: the lookup result must be SAVED, the copy must not promise otherwise, and
// when the automatic path finds nothing there has to be a manual way in — which
// is what HR asked for and what did not exist.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'src', 'js');
const { __SCRIPT_MODULES } = require('../netlify/functions/session.js');

const EMP_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const FOLDER = '1_sq6buvn1-lnFrZERe_mzKcSTsvU5J1j';

function fakeEl() {
  return {
    textContent: '', innerHTML: '', value: '', checked: false, style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {}, addEventListener() {},
    appendChild() {}, querySelector: () => fakeEl(), querySelectorAll: () => []
  };
}

// A DOM with STABLE elements by id, unlike the other suites' throwaway stubs:
// these functions write into #driveLinkArea and read back #driveAttachInput, so
// a fresh object per lookup would hide whether anything was actually rendered.
function sandbox({ documentsReply = { folderId: FOLDER, folderLink: 'https://drive.google.com/drive/folders/' + FOLDER, files: [] } } = {}) {
  const calls = [];
  const els = {};
  const el = (id) => (els[id] || (els[id] = fakeEl()));

  const ctx = {
    console,
    window: {},
    document: {
      getElementById: (id) => el(id),
      querySelector: () => fakeEl(),
      querySelectorAll: () => []
    },
    setTimeout: (fn) => { void fn; return 0; },
    URLSearchParams,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async (url, opts) => {
      const u = String(url);
      const method = (opts && opts.method) || 'GET';
      calls.push({ url: u, method, body: opts && opts.body ? JSON.parse(opts.body) : null });
      if (u.startsWith('/api/documents')) return { ok: true, status: 200, json: async () => documentsReply };
      if (u.startsWith('/api/preapproved-ot')) return { ok: true, status: 200, json: async () => ({ ok: true, rows: [], otTypes: [] }) };
      if (u.startsWith('/api/allocations')) return { ok: true, status: 200, json: async () => ({ ok: true, allocations: [] }) };
      if (method === 'GET') return { ok: true, status: 200, json: async () => ({ ok: true, data: [] }) };
      return { ok: true, status: 200, json: async () => ({ ok: true, data: [{ id: EMP_ID }] }) };
    }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const m of __SCRIPT_MODULES) {
    vm.runInContext(fs.readFileSync(path.join(SRC, m), 'utf8'), ctx, { filename: m });
  }
  vm.runInContext('globalThis.state = state;', ctx, { filename: 'expose.js' });
  vm.runInContext('toast = () => {}; render = () => {};', ctx, { filename: 'stubs.js' });
  ctx.__calls = calls;
  ctx.__el = el;
  return ctx;
}

// bootstrap.js fires loadPermissions/loadEmailSettings/loadData the moment the
// modules evaluate, and loadData REASSIGNS state.employees when it resolves. Any
// test that seeds the roster and then awaits would have its rows replaced by the
// stub's empty payload mid-test. So the boot settles first, then the test seeds.
async function fresh(opts) {
  const ctx = sandbox(opts);
  await new Promise(r => setTimeout(r, 0));
  ctx.__calls.length = 0;
  return ctx;
}

// The pairing is fire-and-forget by design — it is a cache fill, not something
// the person pressed Save for — so the assertions wait a turn for it.
const settle = () => new Promise(r => setTimeout(r, 0));

const patches = (ctx) => ctx.__calls.filter(
  c => c.method === 'PATCH' && c.url.includes('table=employees'));

// ---------------------------------------------------------------------------
// what somebody copies out of Drive
// ---------------------------------------------------------------------------

test('a Drive folder id is read out of anything somebody would paste', () => {
  const ctx = sandbox();
  const f = ctx.driveFolderIdFromInput;

  assert.strictEqual(f('https://drive.google.com/drive/folders/' + FOLDER), FOLDER, 'address bar');
  assert.strictEqual(f('https://drive.google.com/drive/u/0/folders/' + FOLDER), FOLDER, 'the /u/0/ form');
  assert.strictEqual(f('https://drive.google.com/drive/folders/' + FOLDER + '?usp=drive_link'), FOLDER, 'Copy link');
  assert.strictEqual(f('https://drive.google.com/open?id=' + FOLDER), FOLDER, 'the old open?id= form');
  assert.strictEqual(f('  ' + FOLDER + '  '), FOLDER, 'a bare id, trimmed');
});

test('a FILE link is refused rather than stored as a folder', () => {
  // Storing it would render a link that opens one document and calls it the
  // person's HR file. A refusal is recoverable; a wrong link is not noticed.
  const ctx = sandbox();
  assert.strictEqual(ctx.driveFolderIdFromInput('https://drive.google.com/file/d/' + FOLDER + '/view'), '');
  assert.strictEqual(ctx.driveFolderIdFromInput('not a link'), '');
  assert.strictEqual(ctx.driveFolderIdFromInput(''), '');
  assert.strictEqual(ctx.driveFolderIdFromInput(null), '');
});

// ---------------------------------------------------------------------------
// adding an employee — the regression
// ---------------------------------------------------------------------------

test('adding an employee SAVES the folder the lookup finds', async () => {
  const ctx = await fresh();
  ctx.state.employees = [];
  ctx.state.profile = null;
  ctx.state.editing = { name: 'Miguel Cervantes', status: 'Active', payType: 'Hourly', _isNew: true };

  await ctx.saveEdit();
  await settle();

  const lookup = ctx.__calls.find(c => c.url.startsWith('/api/documents'));
  assert.ok(lookup, 'the new employee was looked up in Drive');
  assert.match(lookup.url, /employee=Miguel(\+|%20)Cervantes/);

  const write = patches(ctx).find(c => c.body && 'drive_folder_id' in c.body);
  assert.ok(write, 'the folder the lookup found was never written — this is the bug');
  assert.strictEqual(write.body.drive_folder_id, FOLDER);
  assert.strictEqual(ctx.state.employees[0].driveFolderId, FOLDER, 'and the roster row carries it');
});

test('adding an employee with no folder in Drive writes nothing and does not throw', async () => {
  // A read does not create, so this is an ordinary state rather than a failure:
  // the folder gets made later, by hand or by the first upload.
  const ctx = await fresh({ documentsReply: { folderId: null, folderLink: null, files: [], reason: 'No folder named "Ana Reyes"…' } });
  ctx.state.employees = [];
  ctx.state.profile = null;
  ctx.state.editing = { name: 'Ana Reyes', status: 'Active', payType: 'Hourly', _isNew: true };

  await ctx.saveEdit();
  await settle();

  assert.strictEqual(patches(ctx).filter(c => c.body && 'drive_folder_id' in c.body).length, 0);
  assert.ok(!ctx.state.employees[0].driveFolderId);
});

// ---------------------------------------------------------------------------
// the card, when there is no folder
// ---------------------------------------------------------------------------

test('the card never promises a folder will appear by itself', () => {
  const ctx = sandbox();
  const html = ctx.driveAttachBlock('Ori Harig', EMP_ID, null);

  assert.ok(!/automatic/i.test(html),
    'the old copy promised automatic creation and somebody waited a day on it');
  assert.match(html, /No folder yet/);
  assert.match(html, /named exactly &quot;Ori Harig&quot;/, 'and says what it looked for');
});

test('a missing folder offers both ways out', () => {
  const ctx = sandbox();
  const html = ctx.driveAttachBlock('Ori Harig', EMP_ID, null);

  assert.match(html, /retryDriveLookup\(/, 'search by name again');
  assert.match(html, /showDriveAttachInput\(/, 'or attach one by hand');
});

test('the paste box is NOT rendered into the card', () => {
  // Read mode on the profile card renders no inputs at all and carries exactly
  // one primary button, which is Edit. A box sitting there would read as another
  // field to fill in. It is injected when somebody asks for it.
  const ctx = sandbox();
  const html = ctx.driveAttachBlock('Ori Harig', EMP_ID, null);
  assert.ok(!html.includes('<input'), 'no input in the rendered card');
  assert.ok(!html.includes('btn-primary'), 'and no second primary button');

  ctx.showDriveAttachInput('Ori Harig', EMP_ID);
  assert.match(ctx.__el('driveLinkArea').innerHTML, /id="driveAttachInput"/, 'asked for, it appears');
});

test('an unsaved employee gets the explanation but no controls', () => {
  // Nothing to attach a folder TO until the row has an id.
  const ctx = sandbox();
  const html = ctx.driveAttachBlock('Ori Harig', '', null);
  assert.match(html, /No folder yet/);
  assert.ok(!/showDriveAttachInput\(/.test(html));
});

// ---------------------------------------------------------------------------
// attaching one by hand
// ---------------------------------------------------------------------------

test('attaching a folder writes the id and shows the link', async () => {
  const ctx = await fresh();
  ctx.state.employees = [{ id: EMP_ID, name: 'Ori Harig', driveFolderId: '' }];
  ctx.__el('driveAttachInput').value = 'https://drive.google.com/drive/folders/' + FOLDER + '?usp=drive_link';

  ctx.attachDriveFolder(EMP_ID);
  await settle();

  const [write] = patches(ctx);
  assert.ok(write, 'the attach was saved');
  assert.deepStrictEqual(write.body, { drive_folder_id: FOLDER });
  assert.strictEqual(ctx.state.employees[0].driveFolderId, FOLDER);
});

test('a refused paste writes nothing and says why', async () => {
  const ctx = await fresh();
  ctx.state.employees = [{ id: EMP_ID, name: 'Ori Harig', driveFolderId: '' }];
  ctx.__el('driveAttachInput').value = 'https://drive.google.com/file/d/' + FOLDER + '/view';

  ctx.attachDriveFolder(EMP_ID);
  await settle();

  assert.strictEqual(patches(ctx).length, 0, 'nothing was written');
  assert.match(ctx.__el('driveAttachMsg').textContent, /FOLDER link/);
  assert.strictEqual(ctx.state.employees[0].driveFolderId, '');
});

test('a save the server refuses does not leave the row claiming a folder', async () => {
  const ctx = await fresh();
  ctx.state.employees = [{ id: EMP_ID, name: 'Ori Harig', driveFolderId: '' }];
  ctx.fetch = async (url, opts) => {
    ctx.__calls.push({ url: String(url), method: (opts && opts.method) || 'GET', body: opts && opts.body ? JSON.parse(opts.body) : null });
    return { ok: false, status: 403, json: async () => ({ error: 'Not permitted.' }) };
  };
  ctx.__el('driveAttachInput').value = FOLDER;

  ctx.attachDriveFolder(EMP_ID);
  await settle();

  assert.strictEqual(ctx.state.employees[0].driveFolderId, '', 'the row must not claim what did not save');
  assert.match(ctx.__el('driveAttachMsg').textContent, /NOT attached/);
});

// ---------------------------------------------------------------------------
// the lookup on an open profile
// ---------------------------------------------------------------------------

test('a lookup that finds the folder saves it, so it is the last lookup', async () => {
  const ctx = await fresh();
  ctx.state.employees = [{ id: EMP_ID, name: 'Miguel Cervantes', driveFolderId: '' }];

  ctx.loadDriveLink('Miguel Cervantes', EMP_ID);
  await settle();

  const write = patches(ctx).find(c => c.body && 'drive_folder_id' in c.body);
  assert.ok(write, 'the found folder is cached onto the row');
  assert.strictEqual(write.body.drive_folder_id, FOLDER);
  assert.match(ctx.__el('driveLinkArea').innerHTML, /Open HR File in Drive/);
});

test('a lookup that finds nothing leaves the controls on screen', async () => {
  // It used to render the reason ALONE, which left the reader with nothing to
  // press — the state HR was stuck in.
  const ctx = await fresh({ documentsReply: { folderId: null, folderLink: null, files: [], reason: 'No folder named "Ori Harig" inside the Employee Files folder.' } });
  ctx.state.employees = [{ id: EMP_ID, name: 'Ori Harig', driveFolderId: '' }];

  ctx.loadDriveLink('Ori Harig', EMP_ID);
  await settle();

  const html = ctx.__el('driveLinkArea').innerHTML;
  assert.match(html, /No folder named/, 'the reason is kept');
  assert.match(html, /showDriveAttachInput\(/, 'and so is the way out');
  assert.strictEqual(patches(ctx).length, 0, 'a miss writes nothing');
});
