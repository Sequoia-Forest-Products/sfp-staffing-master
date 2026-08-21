// One Edit button, three writes.
//
// The card used to carry three save mechanics: Edit/Save for the employee row, a
// per-category Save for pre-approved OT, and a Save/Revert pair for the cost
// allocation. Nothing on screen said which button committed what.
//
// Unifying them creates a failure mode that did not exist before: two of three
// writes can land. So the thing most worth testing here is not the happy path —
// it is that a partial failure says which part did not commit and never claims
// success, and that the two endpoint shapes did NOT change on the way. Batching
// calls behind one button is a UI change; turning them into a bulk write would
// undo the fixes that made Rey Aispuro's duplicate and Jeff Cook's lost 50/50
// impossible.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'src', 'js');
const { __SCRIPT_MODULES } = require('../netlify/functions/session.js');

const EMP_ID = '11111111-2222-3333-4444-555555555555';

function fakeEl() {
  return {
    textContent: '', innerHTML: '', value: '', checked: false, style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {}, addEventListener() {},
    appendChild() {}, querySelector: () => fakeEl(), querySelectorAll: () => []
  };
}

// `responder(url, opts, call)` may return {status, body} to override. Anything
// else falls through to a generic success.
function sandbox(responder) {
  const calls = [];
  const toasts = [];
  const ctx = {
    console,
    window: {},
    document: {
      getElementById: () => fakeEl(),
      querySelector: () => fakeEl(),
      querySelectorAll: () => []
    },
    setTimeout: (fn) => { void fn; return 0; },
    URLSearchParams,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async (url, opts) => {
      const u = String(url);
      calls.push({ url: u, method: (opts && opts.method) || 'GET', body: opts && opts.body ? JSON.parse(opts.body) : null });
      const over = responder ? responder(u, opts, calls.length) : null;
      if (over) {
        return { ok: over.status < 400, status: over.status, json: async () => over.body };
      }
      if (u.startsWith('/api/preapproved-ot')) return { ok: true, status: 200, json: async () => ({ ok: true, rows: [], otTypes: ['Pre-Shift','Post-Shift','Weekend'] }) };
      if (u.startsWith('/api/allocations')) return { ok: true, status: 200, json: async () => ({ ok: true, allocations: [] }) };
      return { ok: true, status: 200, json: async () => ({ ok: true, data: [{ id: EMP_ID }] }) };
    }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const m of __SCRIPT_MODULES) {
    vm.runInContext(fs.readFileSync(path.join(SRC, m), 'utf8'), ctx, { filename: m });
  }
  vm.runInContext('globalThis.state = state; globalThis.PREAPPROVED_TYPES = PREAPPROVED_TYPES;',
    ctx, { filename: 'expose.js' });
  // Capture what the user is told, which is half of what these tests are about.
  vm.runInContext('toast = (msg, type) => { globalThis.__toasts.push({ msg, type }); };',
    ctx, { filename: 'stub-toast.js' });
  ctx.__toasts = toasts;
  ctx.__calls = calls;
  return ctx;
}

const PERSON = {
  id: EMP_ID, name: 'Ana Reyes', empNum: '0101', status: 'Active', language: 'English',
  department: 'Production', costClass: 'Manufacturing', positionGroup: 'Green Chain',
  position: 'Puller', payType: 'Hourly', wage: '22.00', days: 'MON-THU',
  break1: '1899-12-30T20:45:00.000Z', break2: '12:45 PM', birthday: '1990-03-15',
  phone: '', email: '', smsOptedOut: false
};

function openCard(ctx, { preRows = [], allocations = [] } = {}) {
  ctx.state.employees = [{ ...PERSON }];
  ctx.state.profile = { idx: 0 };
  ctx.state.preRows = preRows;
  ctx.state.preLoaded = true;
  ctx.state.allocations = allocations;
  ctx.state.allocLoaded = true;
  return ctx;
}

const preRow = (otType, hours, description) => ({
  id: 'p-' + otType, employeeId: EMP_ID, name: 'Ana Reyes', employeeNumber: '0101',
  department: 'Production', status: 'Active', onRoster: true,
  otType, hours, description: description || '', updatedAt: null
});

// ---------------------------------------------------------------------------
// one Edit button
// ---------------------------------------------------------------------------

test('read mode has no inputs and no save in either section', () => {
  const ctx = openCard(sandbox(), { preRows: [preRow('Weekend', 6, 'Clean-up')] });
  const html = ctx.renderProfile();
  assert.match(html, /Pre-approved OT/);
  assert.match(html, /Cost allocation/);
  assert.ok(!html.includes('<input'), 'read mode must render no inputs at all');
  assert.match(html, /onclick="startProfileEdit\(\)"/);
  // Exactly one primary button on the card, and it is Edit.
  assert.strictEqual((html.match(/btn btn-primary/g) || []).length, 1);
});

test('Edit makes all three areas editable behind one Save', () => {
  const ctx = openCard(sandbox(), { preRows: [preRow('Weekend', 6, 'Clean-up')] });
  ctx.startProfileEdit();
  const html = ctx.renderProfile();

  assert.match(html, /onclick="saveEdit\(\)"/);
  assert.match(html, /onclick="cancelProfileEdit\(\)"/);
  // The employee fields, the allowance and the allocation are all now inputs.
  assert.match(html, /state\.editing\.name=this\.value/);
  assert.match(html, /preDraftSet\('Weekend','hours'/);
  assert.match(html, /allocSetPercent/);
  // And still only one primary button.
  assert.strictEqual((html.match(/btn btn-primary/g) || []).length, 1);
});

test('Edit seeds both drafts and Cancel discards both', () => {
  const ctx = openCard(sandbox(), { preRows: [preRow('Weekend', 6, 'Clean-up')] });
  ctx.startProfileEdit();

  assert.deepStrictEqual(
    { hours: ctx.state.editing._pre.Weekend.hours, description: ctx.state.editing._pre.Weekend.description },
    { hours: '6', description: 'Clean-up' });
  assert.ok(ctx.state.allocDrafts[EMP_ID], 'the allocation draft is seeded too');

  ctx.state.editing._pre.Weekend.hours = '99';
  ctx.state.allocDrafts[EMP_ID][0].percent = 40;

  ctx.cancelProfileEdit();
  assert.strictEqual(ctx.state.editing, null);
  assert.strictEqual(ctx.state.allocDrafts[EMP_ID], undefined,
    'a kept allocation draft would reappear on the next Save');
});

// ---------------------------------------------------------------------------
// the endpoint shapes did NOT change
// ---------------------------------------------------------------------------

test('pre-approved OT is still ONE ROW PER CALL, never a bulk write', async () => {
  const ctx = openCard(sandbox(), { preRows: [] });
  ctx.startProfileEdit();
  ctx.preDraftSet('Pre-Shift', 'hours', '0.25');
  ctx.preDraftSet('Pre-Shift', 'description', 'Machine Warm-up');
  ctx.preDraftSet('Weekend', 'hours', '6');
  ctx.preDraftSet('Weekend', 'description', 'Clean-up');
  await ctx.saveEdit();

  const writes = ctx.__calls.filter(c => c.url === '/api/preapproved-ot' && c.method === 'PUT');
  assert.strictEqual(writes.length, 2, 'two edited categories, two calls');
  for (const w of writes) {
    assert.ok(w.body.otType, 'each call names exactly one category');
    assert.ok(!Array.isArray(w.body), 'never an array of rows');
    assert.ok(!('rows' in w.body), 'never a rows payload — that is replace-all');
  }
  assert.deepStrictEqual(writes.map(w => w.body.otType).sort(), ['Pre-Shift', 'Weekend']);
});

test('allocations still go through ONE transaction', async () => {
  const ctx = openCard(sandbox());
  ctx.startProfileEdit();
  ctx.state.allocDrafts[EMP_ID] = [
    { department: 'Production', percent: 60 }, { department: 'Maintenance', percent: 40 }
  ];
  await ctx.saveEdit();

  const writes = ctx.__calls.filter(c => c.url === '/api/allocations' && c.method === 'PUT');
  assert.strictEqual(writes.length, 1, 'one call — the endpoint wraps delete+insert in one transaction');
  assert.strictEqual(writes[0].body.rows.length, 2);
  assert.ok(!ctx.__calls.some(c => c.url.startsWith('/api/allocations') && c.method === 'DELETE'),
    'the client must not assemble its own delete-then-insert');
});

test('an untouched allowance is not rewritten', async () => {
  // Saving a profile should not move updated_at on an allowance nobody edited —
  // that column is the record of who changed what and when.
  const ctx = openCard(sandbox(), { preRows: [preRow('Weekend', 6, 'Clean-up')] });
  ctx.startProfileEdit();
  ctx.state.editing.phone = '555-0100';         // edit something else entirely
  await ctx.saveEdit();
  assert.strictEqual(ctx.__calls.filter(c => c.url === '/api/preapproved-ot' && c.method === 'PUT').length, 0);
  assert.strictEqual(ctx.__calls.filter(c => c.url.startsWith('/api/allocations') && c.method === 'PUT').length, 0);
});

test('blank hours removes an allowance; zero keeps it and switches it off', async () => {
  const ctx = openCard(sandbox(), { preRows: [preRow('Weekend', 6, 'Clean-up'), preRow('Pre-Shift', 1, 'Warm-up')] });
  ctx.startProfileEdit();
  ctx.preDraftSet('Weekend', 'hours', '');      // remove
  ctx.preDraftSet('Pre-Shift', 'hours', '0');   // switch off, keep the record
  await ctx.saveEdit();

  const dels = ctx.__calls.filter(c => c.url.startsWith('/api/preapproved-ot') && c.method === 'DELETE');
  assert.strictEqual(dels.length, 1);
  assert.match(dels[0].url, /otType=Weekend/);
  assert.match(dels[0].url, new RegExp('employeeId=' + EMP_ID));

  const puts = ctx.__calls.filter(c => c.url === '/api/preapproved-ot' && c.method === 'PUT');
  assert.strictEqual(puts.length, 1);
  assert.strictEqual(puts[0].body.otType, 'Pre-Shift');
  assert.strictEqual(puts[0].body.hours, '0');
});

test('a blank category with nothing stored writes nothing at all', async () => {
  const ctx = openCard(sandbox(), { preRows: [] });
  ctx.startProfileEdit();
  await ctx.saveEdit();
  assert.strictEqual(ctx.__calls.filter(c => c.url.startsWith('/api/preapproved-ot') && c.method !== 'GET').length, 0);
});

// ---------------------------------------------------------------------------
// order, and partial failure
// ---------------------------------------------------------------------------

test('the employee row is written first, and its failure aborts the rest', async () => {
  const ctx = openCard(sandbox((url) =>
    url.startsWith('/api/data?table=employees') ? { status: 500, body: { error: 'nope' } } : null));
  ctx.startProfileEdit();
  ctx.preDraftSet('Weekend', 'hours', '6');
  ctx.state.allocDrafts[EMP_ID] = [
    { department: 'Production', percent: 60 }, { department: 'Maintenance', percent: 40 }
  ];
  await ctx.saveEdit();

  assert.ok(!ctx.__calls.some(c => c.url.startsWith('/api/preapproved-ot') && c.method !== 'GET'),
    'nothing else may be attempted once the employee row failed');
  assert.ok(!ctx.__calls.some(c => c.url.startsWith('/api/allocations') && c.method === 'PUT'));
  assert.match(ctx.__toasts.at(-1).msg, /Save failed/);
  assert.strictEqual(ctx.__toasts.at(-1).type, 'error');
  assert.notStrictEqual(ctx.state.editing, null, 'the card stays open so the edit is not lost');
});

test('a failed allowance write names that part and does NOT claim success', async () => {
  // The failure mode one button creates. Two of three writes landing and the
  // card saying "Saved" is how somebody walks away believing an allowance was
  // recorded.
  const ctx = openCard(sandbox((url, opts) =>
    (url === '/api/preapproved-ot' && opts && opts.method === 'PUT')
      ? { status: 400, body: { ok: false, error: 'hours must be 40 or fewer' } } : null));
  ctx.startProfileEdit();
  ctx.preDraftSet('Weekend', 'hours', '6');
  await ctx.saveEdit();

  const last = ctx.__toasts.at(-1);
  assert.strictEqual(last.type, 'error');
  assert.match(last.msg, /Employee details saved/, 'the part that DID commit is stated');
  assert.match(last.msg, /NOT saved: Pre-approved OT/, 'and the part that did not is named');
  assert.match(last.msg, /hours must be 40 or fewer/, 'with the reason from the server');
  assert.ok(!/^Saved$/.test(last.msg));
  assert.notStrictEqual(ctx.state.editing, null, 'the card stays open');
});

test('a failed allocation write names that part specifically', async () => {
  const ctx = openCard(sandbox((url, opts) =>
    (url === '/api/allocations' && opts && opts.method === 'PUT')
      ? { status: 409, body: { ok: false, error: 'the database rejected this allocation' } } : null));
  ctx.startProfileEdit();
  ctx.state.allocDrafts[EMP_ID] = [
    { department: 'Production', percent: 60 }, { department: 'Maintenance', percent: 40 }
  ];
  await ctx.saveEdit();

  const last = ctx.__toasts.at(-1);
  assert.strictEqual(last.type, 'error');
  assert.match(last.msg, /NOT saved: Cost allocation/);
  assert.match(last.msg, /the database rejected this allocation/);
  assert.ok(!last.msg.includes('Pre-approved OT'), 'the part that succeeded is not blamed');
});

test('both failing are both reported, not just the first', async () => {
  const ctx = openCard(sandbox((url, opts) => {
    const m = opts && opts.method;
    if (url === '/api/preapproved-ot' && m === 'PUT') return { status: 400, body: { ok: false, error: 'pre boom' } };
    if (url === '/api/allocations' && m === 'PUT') return { status: 400, body: { ok: false, error: 'alloc boom' } };
    return null;
  }));
  ctx.startProfileEdit();
  ctx.preDraftSet('Weekend', 'hours', '6');
  ctx.state.allocDrafts[EMP_ID] = [
    { department: 'Production', percent: 60 }, { department: 'Maintenance', percent: 40 }
  ];
  await ctx.saveEdit();

  const last = ctx.__toasts.at(-1);
  assert.match(last.msg, /pre boom/);
  assert.match(last.msg, /alloc boom/);
});

test('one failing category does not stop the others being written', async () => {
  // A per-category failure is reported per category. Abandoning the remaining
  // writes would make the outcome depend on the order the categories happen to
  // be in.
  const ctx = openCard(sandbox((url, opts) =>
    (url === '/api/preapproved-ot' && opts && JSON.parse(opts.body).otType === 'Pre-Shift')
      ? { status: 400, body: { ok: false, error: 'bad pre-shift' } } : null));
  ctx.startProfileEdit();
  ctx.preDraftSet('Pre-Shift', 'hours', '1');
  ctx.preDraftSet('Weekend', 'hours', '6');
  await ctx.saveEdit();

  const puts = ctx.__calls.filter(c => c.url === '/api/preapproved-ot' && c.method === 'PUT');
  assert.deepStrictEqual(puts.map(p => p.body.otType).sort(), ['Pre-Shift', 'Weekend']);
  const last = ctx.__toasts.at(-1);
  assert.match(last.msg, /Pre-Shift: bad pre-shift/);
  assert.ok(!last.msg.includes('Weekend:'), 'the category that saved is not reported as failed');
});

test('a clean save says Saved, closes edit mode and drops the drafts', async () => {
  const ctx = openCard(sandbox(), { preRows: [] });
  ctx.startProfileEdit();
  ctx.preDraftSet('Weekend', 'hours', '6');
  ctx.state.allocDrafts[EMP_ID] = [
    { department: 'Production', percent: 60 }, { department: 'Maintenance', percent: 40 }
  ];
  await ctx.saveEdit();

  assert.strictEqual(ctx.__toasts.at(-1).msg, 'Saved');
  assert.strictEqual(ctx.__toasts.at(-1).type, 'success');
  assert.strictEqual(ctx.state.editing, null);
  assert.strictEqual(ctx.state.allocDrafts[EMP_ID], undefined);
});

test('both tables are re-read after a save, including after a failure', async () => {
  // The card must show what the database now holds, not what the draft hoped
  // for — especially when something failed and the two have diverged.
  for (const responder of [null, (url, opts) =>
      (url === '/api/preapproved-ot' && opts && opts.method === 'PUT')
        ? { status: 400, body: { ok: false, error: 'boom' } } : null]) {
    const ctx = openCard(sandbox(responder), { preRows: [] });
    ctx.startProfileEdit();
    ctx.preDraftSet('Weekend', 'hours', '6');
    await ctx.saveEdit();
    assert.ok(ctx.__calls.some(c => c.url === '/api/preapproved-ot' && c.method === 'GET'), 'allowances re-read');
    assert.ok(ctx.__calls.some(c => c.url === '/api/allocations' && c.method === 'GET'), 'allocations re-read');
  }
});

test('the roster modal saves the employee row only, touching neither other table', async () => {
  // saveEdit serves both surfaces. The modal renders neither section, so it must
  // not write to them — a draft left over from a previous card must not ride
  // along on a modal save.
  const ctx = sandbox();
  ctx.state.employees = [{ ...PERSON }];
  ctx.state.profile = null;
  ctx.state.editing = { ...PERSON, _idx: 0, _isNew: false };
  await ctx.saveEdit();

  assert.ok(!ctx.__calls.some(c => c.url.startsWith('/api/preapproved-ot')));
  assert.ok(!ctx.__calls.some(c => c.url.startsWith('/api/allocations')));
  assert.strictEqual(ctx.__toasts.at(-1).msg, 'Saved');
});

// ---------------------------------------------------------------------------
// two bugs the tests above found, pinned so they cannot come back
// ---------------------------------------------------------------------------

test('both Phase C sections render in edit mode as well as read mode', () => {
  // They were appended to profileReadBody only, so pressing Edit made the
  // pre-approved OT and cost allocation sections vanish from the card entirely.
  // They are appended in renderProfile now, once, for exactly this reason.
  const ctx = openCard(sandbox(), { preRows: [preRow('Weekend', 6, 'Clean-up')] });
  for (const mode of ['read', 'edit']) {
    if (mode === 'edit') ctx.startProfileEdit();
    const html = ctx.renderProfile();
    assert.match(html, /Pre-approved OT/, mode);
    assert.match(html, /Cost allocation/, mode);
  }
});

test('an untouched allocation draft is not written, even though Edit seeds one', async () => {
  // startProfileEdit seeds the allocation draft the moment Edit is pressed.
  // Without a comparison against what is stored, every profile save sent an
  // allocation write — and for the 65 people with no split, that write was a
  // removal of an allocation that never existed.
  const ctx = openCard(sandbox());
  ctx.startProfileEdit();
  ctx.state.editing.phone = '555-0100';
  await ctx.saveEdit();
  assert.strictEqual(ctx.__calls.filter(c => c.url === '/api/allocations' && c.method === 'PUT').length, 0);
});

test('an unchanged stored split is not rewritten either', async () => {
  const stored = {
    employeeId: EMP_ID, name: 'Ana Reyes', primaryDepartment: 'Production',
    onRoster: true, status: 'Active', total: 100, sumsTo100: true, includesPrimary: true,
    rows: [{ department: 'Production', percent: 60 }, { department: 'Maintenance', percent: 40 }]
  };
  const ctx = openCard(sandbox(), { allocations: [stored] });
  ctx.startProfileEdit();
  await ctx.saveEdit();
  assert.strictEqual(ctx.__calls.filter(c => c.url === '/api/allocations' && c.method === 'PUT').length, 0,
    'saving a profile must not move updated_at on a split nobody touched');
});

test('row order does not make an unchanged split look changed', async () => {
  const stored = {
    employeeId: EMP_ID, name: 'Ana Reyes', primaryDepartment: 'Production',
    onRoster: true, status: 'Active', total: 100, sumsTo100: true, includesPrimary: true,
    rows: [{ department: 'Production', percent: 60 }, { department: 'Maintenance', percent: 40 }]
  };
  const ctx = openCard(sandbox(), { allocations: [stored] });
  ctx.startProfileEdit();
  // Same allocation, rows the other way round.
  ctx.state.allocDrafts[EMP_ID] = [
    { department: 'Maintenance', percent: 40 }, { department: 'Production', percent: 60 }
  ];
  await ctx.saveEdit();
  assert.strictEqual(ctx.__calls.filter(c => c.url === '/api/allocations' && c.method === 'PUT').length, 0);
});

test('a real change IS written', async () => {
  const stored = {
    employeeId: EMP_ID, name: 'Ana Reyes', primaryDepartment: 'Production',
    onRoster: true, status: 'Active', total: 100, sumsTo100: true, includesPrimary: true,
    rows: [{ department: 'Production', percent: 60 }, { department: 'Maintenance', percent: 40 }]
  };
  const ctx = openCard(sandbox(), { allocations: [stored] });
  ctx.startProfileEdit();
  ctx.state.allocDrafts[EMP_ID] = [
    { department: 'Production', percent: 70 }, { department: 'Maintenance', percent: 30 }
  ];
  await ctx.saveEdit();
  const puts = ctx.__calls.filter(c => c.url === '/api/allocations' && c.method === 'PUT');
  assert.strictEqual(puts.length, 1);
  assert.strictEqual(puts[0].body.rows.find(r => r.department === 'Production').percent, 70);
});

test('removing an existing split IS written, as an empty array', async () => {
  const stored = {
    employeeId: EMP_ID, name: 'Ana Reyes', primaryDepartment: 'Production',
    onRoster: true, status: 'Active', total: 100, sumsTo100: true, includesPrimary: true,
    rows: [{ department: 'Production', percent: 60 }, { department: 'Maintenance', percent: 40 }]
  };
  const ctx = openCard(sandbox(), { allocations: [stored] });
  ctx.startProfileEdit();
  // One department at 100% is the default written down — i.e. no allocation.
  ctx.state.allocDrafts[EMP_ID] = [{ department: 'Production', percent: 100 }];
  await ctx.saveEdit();
  const puts = ctx.__calls.filter(c => c.url === '/api/allocations' && c.method === 'PUT');
  assert.strictEqual(puts.length, 1);
  assert.deepStrictEqual(puts[0].body.rows, []);
});

// ---------------------------------------------------------------------------
// break times on the card
// ---------------------------------------------------------------------------

test('the card formats break times instead of showing the stored string', () => {
  const ctx = openCard(sandbox());
  const html = ctx.renderProfile();
  assert.match(html, /8:45 PM/, 'the 1899 serialisation must render as a time');
  assert.match(html, /12:45 PM/);
  assert.ok(!html.includes('1899-12-30T20:45'), 'the raw stored value must not reach the screen');
});

test('an unreadable break time is called out, not shown blank or raw', () => {
  const ctx = sandbox();
  ctx.state.employees = [{ ...PERSON, break1: 'after the whistle', break2: '' }];
  ctx.state.profile = { idx: 0 };
  ctx.state.preLoaded = true; ctx.state.allocLoaded = true;
  const html = ctx.renderProfile();
  assert.match(html, /Unreadable — after the whistle/);
  assert.match(html, /not set/, 'and an absent one reads as not set, which is a different thing');
});

test('edit mode gives a time picker for a readable value and text for an unreadable one', () => {
  const ctx = sandbox();
  ctx.state.employees = [{ ...PERSON, break1: '1899-12-30T20:45:00.000Z', break2: 'after the whistle' }];
  ctx.state.profile = { idx: 0 };
  ctx.state.preLoaded = true; ctx.state.allocLoaded = true;
  ctx.startProfileEdit();
  const html = ctx.renderProfile();

  assert.match(html, /type="time" value="20:45"/, 'a readable value gets a picker, pre-filled');
  // The blanking trap: a time input given a value it cannot represent renders
  // empty, and the next save writes that emptiness back as fact.
  assert.match(html, /type="text" value="after the whistle"/);
  assert.match(html, /left as text rather than blanked/);
  assert.ok(!/type="time" value=""/.test(html), 'never an empty picker over a real value');
});

test('schedule days is editable, with the roster values suggested but not enforced', () => {
  const ctx = sandbox();
  ctx.state.employees = [{ ...PERSON, days: 'WHENEVER NEEDED' }];
  ctx.state.profile = { idx: 0 };
  ctx.state.preLoaded = true; ctx.state.allocLoaded = true;
  ctx.startProfileEdit();
  const html = ctx.renderProfile();

  assert.match(html, /state\.editing\.days=this\.value/);
  assert.match(html, /<datalist id="sched-days">/);
  assert.match(html, /<option value="MON-THU">/);
  // A select would silently drop this value and rewrite the person's schedule on
  // the first save. It is kept as typed and flagged instead.
  assert.match(html, /value="WHENEVER NEEDED"/);
  assert.match(html, /Not one of the values already on the roster/);
});

test('a save never fabricates a break time for somebody who has none', async () => {
  // `break_1: e.break1 || '7:00 AM'` sat in two writers. The other one re-writes
  // every row on the roster, so one Sync gave a fabricated break to everyone who
  // had none on file.
  const ctx = sandbox();
  ctx.state.employees = [{ ...PERSON, break1: '', break2: null }];
  ctx.state.profile = { idx: 0 };
  ctx.state.preLoaded = true; ctx.state.allocLoaded = true;
  ctx.startProfileEdit();
  await ctx.saveEdit();

  const write = ctx.__calls.find(c => c.url.startsWith('/api/data?table=employees') && c.method === 'PATCH');
  assert.strictEqual(write.body.break_1, null);
  assert.strictEqual(write.body.break_2, null);
  assert.ok(!JSON.stringify(write.body).includes('7:00 AM'));
});

test('a save normalizes a readable break time and preserves an unreadable one', async () => {
  const ctx = sandbox();
  ctx.state.employees = [{ ...PERSON, break1: '1899-12-30T20:45:00.000Z', break2: 'after the whistle' }];
  ctx.state.profile = { idx: 0 };
  ctx.state.preLoaded = true; ctx.state.allocLoaded = true;
  ctx.startProfileEdit();
  await ctx.saveEdit();

  const write = ctx.__calls.find(c => c.url.startsWith('/api/data?table=employees') && c.method === 'PATCH');
  assert.strictEqual(write.body.break_1, '20:45', 'readable values are stored as 24-hour HH:MM');
  assert.strictEqual(write.body.break_2, 'after the whistle',
    'an unreadable value is kept — nulling it destroys the only copy');
});
