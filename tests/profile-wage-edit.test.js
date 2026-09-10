// An hourly rate typed on the employee profile card.
//
// THIS COVERAGE MOVED HERE WITH THE FIELD. Every rule below was asserted
// against the Salaries & Wages page until that tab was split: its hourly half
// came to the profile card at the base tier, its salaried half went to
// Overhead → Salaries behind the tier. The rules did not change — a rate cannot
// be cleared, zero is not a rate, no employee number means no edit, a big move
// is flagged and never blocked — so losing them with the page would have been
// the real regression.
//
// WHAT IS NEW is the thing the old page did not have to worry about: the card
// saves every field at once. So the assertions that matter most here are the
// ones about a save that is NOT about pay — that it sends no wage at all, and
// appends no history row — and about a rate this form cannot record being
// REFUSED rather than dropped from the payload.
//
// The client checks are a MIRROR of netlify/functions/wage-edit-lib.js, not a
// second set of rules. The server enforces all of them again; these exist so
// the refusal arrives before the round trip and reads as a sentence.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'src', 'js');
const { __SCRIPT_MODULES } = require('../netlify/functions/session.js');

// Every fixture carries an explicit status, because the page filters on it and
// a fixture that left it out would exercise the blank-reads-as-active fallback
// in every test rather than the ordinary path.
const SALARIED = [
  { id: 's1', name: 'Eduardo Rivera', payType: 'Salaried', wage: '', annualSalary: 105000,
    position: 'Plant Superintendent', department: 'Production', empNum: '0101', status: 'Active' },
  { id: 's2', name: 'Jeff Cook', payType: 'Salaried', wage: '', annualSalary: 250000,
    position: 'CEO', department: 'Corporate', empNum: '', status: 'Active' },
  { id: 's3', name: 'No Salary Yet', payType: 'Salaried', wage: '', annualSalary: null,
    position: 'Controller', department: 'Accounting', empNum: '', status: 'Active' },
  // Inactive, and carrying a real salary — so a test that finds this figure on
  // the page is finding a leak, not an empty row.
  { id: 's4', name: 'Gone Salaried', payType: 'Salaried', wage: '', annualSalary: 90000,
    position: 'Former', department: 'Corporate', empNum: '', status: 'Inactive' }
];
const HOURLY = [
  { id: 'h1', name: 'Ana Reyes', payType: 'Hourly', wage: 22, annualSalary: null,
    position: 'Puller', department: 'Production', empNum: '0201', status: 'Active' },
  { id: 'h2', name: 'No Rate', payType: 'Hourly', wage: '', annualSalary: null,
    position: 'Utility', department: 'Production', empNum: '0202', status: 'Active' },
  { id: 'h3', name: 'Gone Hourly', payType: 'Hourly', wage: '18.00', annualSalary: null,
    position: 'Former', department: 'Production', empNum: '0203', status: 'Inactive' }
];

function fakeEl(id) {
  const el = {
    id, textContent: '', innerHTML: '', value: '', checked: false, hidden: false,
    style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {}, addEventListener() {},
    appendChild() {}, querySelector: () => fakeEl(), querySelectorAll: () => []
  };
  return el;
}

function sandbox({ tiers = ['hourly_wages'], grants = null, responder = null } = {}) {
  const calls = [];
  const toasts = [];
  const els = new Map();
  const getEl = (id) => {
    if (!els.has(id)) els.set(id, fakeEl(id));
    return els.get(id);
  };
  const ctx = {
    console,
    window: {},
    document: {
      getElementById: getEl,
      querySelector: (sel) => {
        const m = /data-tab="([^"]+)"/.exec(sel);
        return m ? getEl('tab:' + m[1]) : fakeEl();
      },
      querySelectorAll: () => []
    },
    setTimeout: (fn) => { void fn; return 0; },
    URLSearchParams,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async (url, opts = {}) => {
      const u = String(url);
      const method = opts.method || 'GET';
      calls.push({ url: u, method, body: opts.body ? JSON.parse(opts.body) : null });
      const over = responder ? responder(u, method, calls.length) : null;
      if (over) return { ok: over.status < 400, status: over.status, json: async () => over.body };
      if (u.startsWith('/api/permissions')) {
        return { ok: true, status: 200, json: async () => ({
          ok: true, email: 'me@sequoiafp.com', tiers, grants,
          isAdmin: tiers.includes('admin'), grantableTiers: ['salaries', 'admin'] }) };
      }
      if (u.startsWith('/api/preapproved-ot')) return { ok: true, status: 200, json: async () => ({ ok: true, rows: [], otTypes: [] }) };
      if (u.startsWith('/api/allocations')) return { ok: true, status: 200, json: async () => ({ ok: true, allocations: [] }) };
      return { ok: true, status: 200, json: async () => ({ ok: true, data: [] }) };
    }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const m of __SCRIPT_MODULES) {
    if (m === 'bootstrap.js') continue;   // no top-level calls in a test
    vm.runInContext(fs.readFileSync(path.join(SRC, m), 'utf8'), ctx, { filename: m });
  }
  vm.runInContext('globalThis.state = state;', ctx, { filename: 'expose.js' });
  vm.runInContext('toast = (msg, type) => { globalThis.__toasts.push({ msg, type }); };',
    ctx, { filename: 'stub-toast.js' });
  ctx.__toasts = toasts;
  ctx.__calls = calls;
  ctx.__el = getEl;
  ctx.state.employees = [...SALARIED, ...HOURLY].map(e => ({ ...e }));
  ctx.state.loading = false;
  // Seeded synchronously so the render tests do not each have to await
  // loadPermissions. The tests that are ABOUT loadPermissions call it and let
  // it overwrite this.
  ctx.state.perms.tiers = tiers.slice();
  ctx.state.perms.isAdmin = tiers.includes('admin');
  ctx.state.perms.grants = grants;
  ctx.state.perms.loaded = true;
  return ctx;
}

const withTier = (t) => sandbox({ tiers: ['hourly_wages', t] });
const lastToast = (ctx) => ctx.__toasts[ctx.__toasts.length - 1] || {};
const writes = (ctx) => ctx.__calls.filter(c => c.method !== 'GET');

// By id, never by index. The fixtures grew an inactive person in each section
// and every hardcoded state.employees[3] silently became somebody else.
const person = (ctx, id) => ctx.state.employees.find(e => String(e.id) === id);

// ---------------------------------------------------------------------------
// who is on the page
// ---------------------------------------------------------------------------
// The card, in edit mode, on one person. Returns the rendered HTML.
function editCard(ctx, id) {
  const idx = ctx.state.employees.findIndex(e => String(e.id) === id);
  ctx.state.profile = { idx };
  ctx.startProfileEdit();
  return ctx.renderProfile();
}

// Open the card for editing without rendering, for the save tests.
function openEdit(ctx, id) {
  const idx = ctx.state.employees.findIndex(e => String(e.id) === id);
  ctx.state.profile = { idx };
  ctx.startProfileEdit();
  return ctx.state.editing;
}

const patches = (ctx) => ctx.__calls.filter(c => c.method === 'PATCH');

// ---------------------------------------------------------------------------
// the field, at the BASE tier
// ---------------------------------------------------------------------------

test('an hourly rate is editable with no grant at all', () => {
  // The whole reason the field is here. employees.wage is base tier in both
  // directions and the people who correct a rate are supervisors, not the two
  // accounts holding the salaries grant.
  const ctx = sandbox({ tiers: ['hourly_wages'] });
  const html = editCard(ctx, 'h1');
  assert.match(html, /Hourly wage/);
  assert.match(html, /wageDraftSet\(this\.value\)/);
  assert.match(html, /value="22"/, 'pre-filled with the stored rate');
});

test('a salaried person gets no rate field, and is told why', () => {
  // Rule 2. Their compensation is annual_salary and the costing reports divide
  // it by 2,080, so an hourly rate on them would be counted twice.
  const ctx = sandbox({ tiers: ['hourly_wages', 'salaries'] });
  const html = editCard(ctx, 's1');
  assert.ok(!/wageDraftSet/.test(html));
  assert.match(html, /salaried/i);
  assert.match(html, /Overhead → Salaries/);
  assert.ok(!/105000|105,000/.test(html), 'and no figure, even with the tier');
});

test('somebody with no employee number is told before they type', () => {
  // Rule 5. wage_history.employee_number is NOT NULL, so a rate change for
  // them could not be recorded at all.
  const ctx = sandbox({ tiers: ['hourly_wages'] });
  person(ctx, 'h1').empNum = '';
  const html = editCard(ctx, 'h1');
  assert.match(html, /No employee number yet/);
  assert.match(html, /keyed by it/);
});

// ---------------------------------------------------------------------------
// the note under the field
// ---------------------------------------------------------------------------

test('a move past the threshold is warned about before the click, not blocked', () => {
  // A typo and a real raise are indistinguishable in the data; the difference
  // is that one of them should be looked at. Blocking would stop a legitimate
  // raise on a Friday afternoon.
  const ctx = sandbox({ tiers: ['hourly_wages'] });
  openEdit(ctx, 'h1');
  ctx.state.editing.wage = '2200';          // 22 -> 2200, the classic mistyped decimal
  const note = ctx.profileWageNote(person(ctx, 'h1'));
  assert.match(note, /9900%/);
  assert.match(note, /flagged for review/);
  // Warned, not refused: the note is a warning and Save still works.
  assert.ok(!/cannot/.test(note));
});

test('an ordinary raise shows its size and no warning', () => {
  const ctx = sandbox({ tiers: ['hourly_wages'] });
  openEdit(ctx, 'h1');
  ctx.state.editing.wage = '23.10';          // +5%
  const note = ctx.profileWageNote(person(ctx, 'h1'));
  assert.match(note, /\+5%/);
  assert.ok(!/flagged/.test(note));
});

test('a first rate says so rather than showing a percentage of nothing', () => {
  const ctx = sandbox({ tiers: ['hourly_wages'] });
  openEdit(ctx, 'h2');                       // 'No Rate', wage ''
  ctx.state.editing.wage = '19.00';
  const note = ctx.profileWageNote(person(ctx, 'h2'));
  assert.match(note, /First rate on file/);
  assert.ok(!/%/.test(note));
});

test('an unchanged draft says no history row will be written', () => {
  const ctx = sandbox({ tiers: ['hourly_wages'] });
  openEdit(ctx, 'h1');
  ctx.state.editing.wage = '22.00';
  assert.match(ctx.profileWageNote(person(ctx, 'h1')), /Unchanged/);
});

// ---------------------------------------------------------------------------
// what the save sends — the part the old page did not have to think about
// ---------------------------------------------------------------------------

test('a save that does not touch pay sends NO wage at all', async () => {
  // The objection that kept this field off the card for a whole phase: a bulk
  // save appending a wage_history row for a change nobody made. Answered by
  // omitting the key, and again by the server, which deletes an unchanged wage
  // from the body before writing.
  const ctx = sandbox({ tiers: ['hourly_wages'] });
  openEdit(ctx, 'h1');
  ctx.state.editing.phone = '555-0100';
  await ctx.saveEdit();

  const w = patches(ctx).filter(c => /table=employees/.test(c.url));
  assert.strictEqual(w.length, 1);
  assert.ok(!('wage' in w[0].body), 'no wage key in a save about a phone number');
  assert.strictEqual(w[0].body.phone, '555-0100');
});

test('retyping the same rate in a different format sends no wage either', async () => {
  const ctx = sandbox({ tiers: ['hourly_wages'] });
  openEdit(ctx, 'h1');
  ctx.state.editing.wage = '$22.00';
  await ctx.saveEdit();
  const w = patches(ctx).filter(c => /table=employees/.test(c.url));
  assert.ok(!('wage' in w[0].body), "'22.00' over a stored 22 is not a change");
});

test('a real change sends the wage, canonicalised', async () => {
  const ctx = sandbox({ tiers: ['hourly_wages'] });
  openEdit(ctx, 'h1');
  ctx.state.editing.wage = '23.5';
  await ctx.saveEdit();

  const w = patches(ctx).filter(c => /table=employees/.test(c.url));
  assert.strictEqual(w[0].body.wage, '23.50', 'fixed-2, so what is stored is what was shown');
  // And the local copy carries the canonical value, not the draft string, so
  // the card does not show a rate the database does not hold.
  assert.strictEqual(person(ctx, 'h1').wage, '23.50');
});

test('a salaried person never sends a wage, even with one left in the draft', async () => {
  // Somebody flips the pay type to Salaried with a rate still typed in the
  // field. That is a field that no longer applies, not an error — so it is
  // dropped rather than refused, and nothing overwrites employees.wage.
  const ctx = sandbox({ tiers: ['hourly_wages', 'salaries'] });
  openEdit(ctx, 'h1');
  ctx.setPayType('Salaried');
  ctx.state.editing.wage = '99.00';
  await ctx.saveEdit();

  const w = patches(ctx).filter(c => /table=employees/.test(c.url));
  assert.ok(!('wage' in w[0].body));
  assert.strictEqual(w[0].body.pay_type, 'Salaried');
  assert.strictEqual(person(ctx, 'h1').wage, 22, 'the stored rate is untouched');
});

// ---------------------------------------------------------------------------
// REFUSED, NOT DROPPED
// ---------------------------------------------------------------------------
//
// A rate this form cannot record aborts the WHOLE save with a sentence naming
// the remedy. Saving the other fields and quietly discarding the number
// somebody typed into a pay field would report success for a write that did not
// happen — which is how somebody comes to believe a rate was changed.

test('clearing a rate is refused, because it could not be recorded', async () => {
  // Rule 4. wage_history.rate is NOT NULL, so a cleared rate cannot be
  // recorded, and an unrecorded disappearance of somebody's pay is the thing
  // the history exists to prevent. A rate can be corrected; it cannot be
  // deleted.
  const ctx = sandbox({ tiers: ['hourly_wages'] });
  openEdit(ctx, 'h1');
  ctx.state.editing.wage = '';
  await ctx.saveEdit();

  assert.deepStrictEqual(patches(ctx), [], 'nothing was written');
  assert.match(lastToast(ctx).msg, /cannot be cleared, only corrected/);
  assert.match(lastToast(ctx).msg, /Nothing was saved/);
  assert.strictEqual(person(ctx, 'h1').wage, 22);
});

test('a blank field on somebody with no rate is not a clear', async () => {
  // The ordinary state of a person nobody has priced yet. It must not be
  // refused, or their card cannot be saved at all.
  const ctx = sandbox({ tiers: ['hourly_wages'] });
  openEdit(ctx, 'h2');                       // wage ''
  ctx.state.editing.phone = '555-0199';
  await ctx.saveEdit();

  const w = patches(ctx).filter(c => /table=employees/.test(c.url));
  assert.strictEqual(w.length, 1, 'the save went through');
  assert.ok(!('wage' in w[0].body));
});

test('zero, negative and unparseable rates are each refused', async () => {
  // Rule 3. A rate of zero prices a day's work at nothing and looks exactly
  // like a correctly-computed figure downstream.
  for (const bad of ['0', '-5', 'abc', '24.50.1']) {
    const ctx = sandbox({ tiers: ['hourly_wages'] });
    openEdit(ctx, 'h1');
    ctx.state.editing.wage = bad;
    await ctx.saveEdit();

    assert.deepStrictEqual(patches(ctx), [], `${bad} must not be written`);
    assert.match(lastToast(ctx).msg, /is not an hourly rate/, bad);
    assert.match(lastToast(ctx).msg, /nothing was saved/i, bad);
  }
});

test('no employee number refuses the save and names the field to fix', async () => {
  // Rule 5, checked here rather than left to the server because the employee
  // number is edited in this same form — so the remedy is one field away.
  const ctx = sandbox({ tiers: ['hourly_wages'] });
  openEdit(ctx, 'h1');
  ctx.state.editing.empNum = '';
  ctx.state.editing.wage = '24.00';
  await ctx.saveEdit();

  assert.deepStrictEqual(patches(ctx), []);
  assert.match(lastToast(ctx).msg, /no employee number/);
  assert.match(lastToast(ctx).msg, /Emp #/);
});

test('a refusal NEVER says saved', async () => {
  const ctx = sandbox({ tiers: ['hourly_wages'] });
  openEdit(ctx, 'h1');
  ctx.state.editing.wage = '0';
  await ctx.saveEdit();
  assert.ok(!ctx.__toasts.some(t => /^Saved$/.test(t.msg)));
  assert.strictEqual(lastToast(ctx).type, 'error');
});

// ---------------------------------------------------------------------------
// one person at a time
// ---------------------------------------------------------------------------

test('one save moves one person, and cannot reach a second', async () => {
  // The card is one person by construction, which is what makes the bulk save
  // acceptable here at all: the failure the old page had — one Save committing
  // three people's drafts — is not reachable from a screen about one person.
  const ctx = sandbox({ tiers: ['hourly_wages'] });
  openEdit(ctx, 'h1');
  ctx.state.editing.wage = '25.00';
  await ctx.saveEdit();

  const w = patches(ctx).filter(c => /table=employees/.test(c.url));
  assert.strictEqual(w.length, 1);
  assert.match(w[0].url, /id=h1/);
  assert.strictEqual(person(ctx, 'h2').wage, '', 'nobody else moved');
});
