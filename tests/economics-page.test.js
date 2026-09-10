// Staffing Economics, restored in Phase D — read-only and behind the salaries tier.
//
// Phase C deleted this page rather than renaming it, because it rendered each
// seat's occupant next to their hourly rate and a budgeted ceiling, and with no
// permissions system that was readable by every signed-in account. Two things
// had to be true before it could come back, and both are tested here:
//
//   * the figures are refused server-side without the tier (that assertion is
//     in data-api.test.js — /api/data 403s the table before it is queried);
//   * the REPLACE-ALL does not come back with it. Assignment is back, but as a
//     PATCH of one column on one row through /api/economics — the old dropdown
//     saved the whole table, over the only record of these ceilings.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'src', 'js');
const { __SCRIPT_MODULES } = require('../netlify/functions/session.js');

// Millwright 1 holds somebody UNDER the ceiling, Millwright 2 somebody OVER it,
// Utility 1 is vacant, Utility 2 holds a salaried person (who has no hourly
// rate at all), and Utility 3 is UNLINKED — a row the backfill could not match,
// which is what section 4b of SCHEMA_ECONOMICS_EMPLOYEE_ID.sql lists.
//
// Shaped the way /api/economics returns them: employeeId is the fact, `name` is
// the occupant's name as the SERVER resolved it today.
// occupantStatus / occupantSalaried ride along from the server so the page does
// not have to re-derive them. Set here because the endpoint sets them: a
// fixture that omits a field the real response carries tests a shape nothing
// produces, and this one silently turned "salaried" into "not active".
const SEATS = [
  { id: 'e1', num: 1, section: 'Mill', seat: 'Millwright 1', employeeId: 'h1', name: 'Ana Reyes', unlinked: false, occupantStatus: 'Active', occupantSalaried: false, max_wage: 38.50 },
  { id: 'e2', num: 2, section: 'Mill', seat: 'Millwright 2', employeeId: 'h2', name: 'Bo Tran',   unlinked: false, occupantStatus: 'Active', occupantSalaried: false, max_wage: 30.00 },
  { id: 'e3', num: 3, section: 'Yard', seat: 'Utility 1',    employeeId: null, name: null,        unlinked: false, occupantStatus: null,     occupantSalaried: null,  max_wage: 24.00 },
  { id: 'e4', num: 4, section: 'Yard', seat: 'Utility 2',    employeeId: 's1', name: 'Sal Aried', unlinked: false, occupantStatus: 'Active', occupantSalaried: true,  max_wage: 24.00 },
  { id: 'e5', num: 5, section: 'Yard', seat: 'Utility 3',    employeeId: null, name: 'Departed Person', unlinked: true, occupantStatus: null, occupantSalaried: null, max_wage: 24.00 }
];

const ROSTER = [
  { id: 'h1', name: 'Ana Reyes', status: 'Active', payType: 'Hourly', wage: 36.00 },
  { id: 'h2', name: 'Bo Tran',   status: 'Active', payType: 'Hourly', wage: 33.25 },
  { id: 'h3', name: 'Unseated Person', status: 'Active', payType: 'Hourly', wage: 21.00 },
  // A LEFTOVER NUMERIC RATE, on purpose. A blank wage exercises the NaN path and
  // proves nothing about the salaried guard. The interesting case is this one:
  // somebody flipped to Salaried while BBSI's last rate is still in the column,
  // or a row restored from a backup. pay_type is the fact; the leftover number
  // must not be read as their rate.
  { id: 's1', name: 'Sal Aried', status: 'Active', payType: 'Salaried', wage: 29.75 },
  { id: 'x1', name: 'Inactive Person', status: 'Inactive', payType: 'Hourly', wage: 20.00 }
];

function fakeEl(id) {
  return {
    id, textContent: '', innerHTML: '', value: '', checked: false, hidden: false,
    style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {}, addEventListener() {},
    appendChild() {}, querySelector: () => fakeEl(), querySelectorAll: () => []
  };
}

function sandbox({ tiers = ['hourly_wages', 'salaries'], econStatus = 200, seats: seatsIn = SEATS,
                   assignable = true, patchStatus = 200, patchSeat = null } = {}) {
  // DEEP-COPIED PER SANDBOX. The page assigns the returned row over the one in
  // state, so handing every test the same objects let one test's assignment
  // show up in the next. That is not a hypothetical: it made the duplicate-seat
  // test fail against a fixture two earlier tests had already rewritten.
  const seats = seatsIn.map(x => ({ ...x }));
  const calls = [];
  const toasts = [];
  const els = new Map();
  const getEl = (id) => { if (!els.has(id)) els.set(id, fakeEl(id)); return els.get(id); };
  const ctx = {
    console, window: {},
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
      calls.push({ url: u, method: (opts.method || 'GET'), body: opts.body ? JSON.parse(opts.body) : null });
      if (u.startsWith('/api/economics')) {
        if ((opts.method || 'GET') === 'PATCH') {
          const body = JSON.parse(opts.body);
          const seat = seats.find(x => x.id === body.id);
          if (patchStatus !== 200) {
            return { ok: false, status: patchStatus, json: async () => ({
              ok: false, error: 'boom' }) };
          }
          // The position rate is its own operation on the server — one column
          // per request — so it is its own branch here too.
          if (Object.prototype.hasOwnProperty.call(body, 'maxWage')) {
            if (patchSeat) return { ok: true, status: 200, json: async () => patchSeat(body) };
            const raw = String(body.maxWage === '' || body.maxWage == null ? '' : body.maxWage);
            const next = raw === '' ? null : Math.round(Number(raw) * 100) / 100;
            const previousMaxWage = seat.max_wage == null ? null : Number(seat.max_wage);
            const updated = { ...seat, max_wage: next };
            Object.assign(seat, updated);
            return { ok: true, status: 200,
                     json: async () => ({ ok: true, seat: updated, previousMaxWage }) };
          }
          // The server resolves the id against the roster and returns the row it
          // STORED, which is the whole reason the page reads the response rather
          // than the picked value.
          const match = ROSTER.find(r => r.id === body.employeeId
                                      && r.status === 'Active' && r.payType !== 'Salaried');
          if (body.employeeId && !match) {
            return { ok: false, status: 400, json: async () => ({
              ok: false, error: 'cannot be seated',
              detail: 'Only an active employee can fill a seat.' }) };
          }
          const alsoIn = match
            ? seats.filter(x => x.id !== body.id && x.employeeId === match.id).map(x => x.seat)
            : [];
          const updated = { ...seat, employeeId: match ? match.id : null,
                            name: match ? match.name : null, unlinked: false };
          Object.assign(seat, updated);
          return { ok: true, status: 200, json: async () => ({ ok: true, seat: updated, alsoIn }) };
        }
        if (econStatus !== 200) {
          return { ok: false, status: econStatus, json: async () => ({
            ok: false, error: 'Not permitted to read the staffing plan',
            detail: 'This needs the salaries tier. An administrator can grant it under Settings → Access.' }) };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true, seats, assignable }) };
      }
      if (u.startsWith('/api/permissions')) {
        return { ok: true, status: 200, json: async () => ({
          ok: true, email: 'me@sequoiafp.com', tiers, isAdmin: tiers.includes('admin'), grants: null }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, data: [] }) };
    }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const m of __SCRIPT_MODULES) {
    if (m === 'bootstrap.js') continue;
    vm.runInContext(fs.readFileSync(path.join(SRC, m), 'utf8'), ctx, { filename: m });
  }
  vm.runInContext('globalThis.state = state;', ctx, { filename: 'expose.js' });
  vm.runInContext('toast = (msg, type) => { globalThis.__toasts.push({ msg, type }); };',
    ctx, { filename: 'stub-toast.js' });
  ctx.__toasts = toasts;
  ctx.__calls = calls;
  ctx.__el = getEl;
  ctx.state.employees = ROSTER.map(e => ({ ...e }));
  ctx.state.loading = false;
  ctx.state.perms.tiers = tiers.slice();
  ctx.state.perms.loaded = true;
  ctx.state.burden = 0.44;
  ctx.state.mhr = 15;
  return ctx;
}

async function loaded(opts) {
  const ctx = sandbox(opts);
  await ctx.loadEconomics();
  return ctx;
}

// ---------------------------------------------------------------------------
// the gate
// ---------------------------------------------------------------------------

test('without the tier the page refuses, and no ceiling or rate is in the HTML', () => {
  const ctx = sandbox({ tiers: ['hourly_wages'] });
  const html = ctx.renderEconomics();
  assert.match(html, /needs the salaries tier/i);
  for (const figure of ['38.50', '30.00', '36.00', '33.25', 'Millwright']) {
    assert.ok(!html.includes(figure), `${figure} must not be rendered`);
  }
});

test('the admin tier alone does not open it', () => {
  const ctx = sandbox({ tiers: ['hourly_wages', 'admin'] });
  assert.match(ctx.renderEconomics(), /needs the salaries tier/i);
});

test("a 403 from the endpoint is stated in words, not as a status code", async () => {
  const ctx = await loaded({ econStatus: 403 });
  const html = ctx.renderEconomics();
  assert.match(html, /needs the salaries tier/i);
  assert.ok(!html.includes('403'));
  assert.strictEqual(ctx.state.economics.length, 0);
});

// ---------------------------------------------------------------------------
// the numbers the page exists for
// ---------------------------------------------------------------------------

test('max_wage and the variance column are back, signed and coloured', async () => {
  const ctx = await loaded();
  const html = ctx.renderEconomics();

  assert.match(html, /Millwright 1/);
  // The ceiling is an editable field now, so it carries the bare figure — a
  // '$' inside an input is something somebody would have to type around.
  assert.match(html, /class="econ-max" value="38\.50"/, "the seat's position rate");
  // Ana is 36.00 against a 38.50 ceiling: 2.50 under.
  assert.match(html, /var-under[^>]*>-\$2\.50/);
  // Bo is 33.25 against 30.00: 3.25 over, and over is the one worth seeing.
  assert.match(html, /var-over[^>]*>\+\$3\.25/);
  // The sign goes outside the currency symbol; '$-2.50' reads as a typo.
  assert.ok(!html.includes('$-2.50'));
});

test('over-ceiling occupants are counted and named at the top', async () => {
  const ctx = await loaded();
  const html = ctx.renderEconomics();
  const card = html.slice(html.indexOf('Over the ceiling'));
  assert.match(card, /Bo Tran/);
  assert.ok(!card.slice(0, 400).includes('Ana Reyes'), 'Ana is under it');
});

test('a vacant seat is a real row, not a gap', async () => {
  const ctx = await loaded();
  const html = ctx.renderEconomics();
  assert.match(html, /Utility 1/);
  assert.match(html, /— vacant —/);
  assert.match(html, /1 vacant/);
});

test('a salaried occupant contributes no rate, even with a stale one in the column', async () => {
  const ctx = await loaded();
  // Sal Aried sits in Utility 2 and still carries 29.75 in employees.wage. That
  // is not their rate: pay_type is the fact, and a salaried person has no hourly
  // rate to contribute. Reading the leftover would put 29.75 into the wage pool
  // and print a +5.75 variance against Utility 2's 24.00 ceiling — both
  // inventions, and both of the kind nobody would question on a printed page.
  assert.strictEqual(ctx.econWageFor('Sal Aried'), null);
  const html = ctx.renderEconomics();
  // Priced seats: Ana and Bo only. Three of five are unpriced.
  assert.match(html, /2 of 5 seats priced/);
  // 36.00 + 33.25, with no 29.75 anywhere near it.
  assert.match(html, /\$69\.25/);
  assert.ok(!html.includes('29.75'), 'the stale rate is nowhere on the page');
  assert.ok(!html.includes('5.75'), 'nor the variance it would have produced');
});

test('somebody in two seats is flagged, and the overstatement is said out loud', async () => {
  const seats = SEATS.map(s => s.seat === 'Utility 1'
    ? { ...s, employeeId: 'h1', name: 'Ana Reyes' } : s);
  const ctx = await loaded({ seats });
  const html = ctx.renderEconomics();
  assert.match(html, /in two seats/);
  assert.match(html, /assigned to more than one seat/);
  assert.match(html, /overstated/, 'the wage pool counts them twice and says so');
});

test('a seat the backfill could not link is flagged separately', async () => {
  const ctx = await loaded();
  const html = ctx.renderEconomics();
  assert.match(html, /not linked to anybody on the roster/);
  assert.match(html, /Utility 3 → Departed Person/);
});

test('active hourly people in no seat are listed; inactive and salaried are not', async () => {
  const ctx = await loaded();
  const html = ctx.renderEconomics();
  const tail = html.slice(html.indexOf('Not in any seat'));
  assert.match(tail, /Unseated Person/);
  assert.ok(!tail.includes('Inactive Person'), 'inactive people are not unbudgeted headcount');
  assert.ok(!tail.includes('Sal Aried'), 'the plan is a plan for hourly seats');
});

// ---------------------------------------------------------------------------
// read-only
// ---------------------------------------------------------------------------

test('two things are editable per seat: the assignment and the position rate', async () => {
  const ctx = await loaded();
  const html = ctx.renderEconomics();
  // The occupant, and what the seat is budgeted at. The ceiling used to be
  // read-only here; see 'the position rate' section below for why that changed.
  assert.match(html, /econAssign\('e1'/);
  assert.match(html, /econSaveMax\('e1'/);
  assert.ok(!/saveEconomics/.test(html), 'no whole-table save');
  // The SHAPE of the plan is still not editable here: no input bound to a
  // seat's number, section or title. Adding or retitling a seat changes what
  // the plan is rather than what it budgets.
  assert.ok(!/\.seat\s*=|\.section\s*=|\.num\s*=/.test(html));
  assert.match(html, /number, section and title are set in the database/);
  // The two number boxes at the top are display assumptions, and say so.
  assert.match(html, /not stored/);
});

test('loading and refreshing only ever GET', async () => {
  const ctx = await loaded();
  await ctx.loadEconomics();
  const econCalls = ctx.__calls.filter(c => c.url.startsWith('/api/economics'));
  assert.ok(econCalls.length >= 2);
  for (const c of econCalls) assert.strictEqual(c.method, 'GET');
});

test('it is not fetched on boot — that would 403 for most of the roster', () => {
  const ctx = sandbox();
  const hits = () => ctx.__calls.filter(c => c.url.startsWith('/api/economics')).length;
  assert.strictEqual(hits(), 0);
  // It is the 'staff' view of Manufacturing Costs now, not a tab. Selecting the
  // view is what loads it.
  ctx.switchCostsView('staff');
  assert.strictEqual(hits(), 1, 'loaded on first open of its own sub-view');
});

test('opening the parent tab on the staff view still loads it', () => {
  // The hook that stops firing when a tab becomes a sub-view. Somebody who was
  // last on 'staff', navigates away and comes back, opens the tab with that
  // view already selected — and switchTab has to fire its load or the view
  // renders its shell over nothing.
  const ctx = sandbox();
  ctx.state.costsView = 'staff';
  const hits = () => ctx.__calls.filter(c => c.url.startsWith('/api/economics')).length;
  assert.strictEqual(hits(), 0);
  ctx.switchTab('costs', null);
  assert.strictEqual(hits(), 1);
});

test('the staff view is not offered at all without the tier', () => {
  const ctx = sandbox({ tiers: ['hourly_wages'] });
  const html = ctx.renderCostsTab();
  // Filtered out of the sub-nav rather than disabled in it: a greyed-out button
  // still announces the page exists.
  assert.ok(!/switchCostsView\('staff'\)/.test(html), 'no button for a view they cannot open');
  // With one view left there is no sub-nav either — a single-button nav is
  // furniture that explains nothing.
  assert.ok(!/doc-tab/.test(html), 'no sub-nav for a single view');
  // And the parent tab still renders its own report, because it is not gated.
  assert.match(html, /cost-bar/);
});

test('losing the tier resolves the staff view away, and hides Overhead', () => {
  const ctx = sandbox({ tiers: ['hourly_wages'] });
  ctx.state.costsView = 'staff';
  ctx.state.tab = 'overhead';
  ctx.applyTabVisibility();
  // The gated TAB bounces, as it always did.
  assert.strictEqual(ctx.state.tab, 'employees');
  assert.strictEqual(ctx.__el('tab:overhead').hidden, true);
  // And the gated SUB-VIEW resolves to the first one they can read, so a
  // revocation in another window does not leave them sitting on it.
  assert.strictEqual(ctx.state.costsView, 'deptgroup');
});

test('a deep link to the staff view still lands on a sentence', () => {
  // The sub-nav omitting the button is a courtesy. renderEconomics itself has
  // to refuse, because state.costsView is reachable from the console.
  const ctx = sandbox({ tiers: ['hourly_wages'] });
  assert.match(ctx.renderEconomics(), /needs the salaries tier/i);
});

// ---------------------------------------------------------------------------
// assignment
// ---------------------------------------------------------------------------

const patches = (ctx) => ctx.__calls.filter(c => c.method === 'PATCH');

// The seat selects, in render order — which is SEATS order, because the page
// groups by section and the fixture's sections are already contiguous.
const selects = (html) => html.match(/<select[\s\S]*?<\/select>/g) || [];

test('assigning sends one PATCH naming one seat and one person, by id', async () => {
  const ctx = await loaded();
  await ctx.econAssign('e3', 'h3');

  const p = patches(ctx);
  assert.strictEqual(p.length, 1);
  assert.strictEqual(p[0].url, '/api/economics');
  assert.deepStrictEqual(Object.keys(p[0].body).sort(), ['employeeId', 'id'],
    'nothing but the seat and the person rides along');
  assert.strictEqual(p[0].body.id, 'e3');
  assert.strictEqual(p[0].body.employeeId, 'h3', 'an id, never a name');
  // Only the seat named is touched; there is no replace-all anywhere near this.
  assert.strictEqual(ctx.state.economics.find(s => s.id === 'e3').employeeId, 'h3');
  assert.strictEqual(ctx.state.economics.find(s => s.id === 'e1').employeeId, 'h1');
});

test('unassigning sends an empty id and empties the seat', async () => {
  const ctx = await loaded();
  await ctx.econAssign('e1', '');
  assert.strictEqual(patches(ctx)[0].body.employeeId, '');
  const seat = ctx.state.economics.find(s => s.id === 'e1');
  assert.strictEqual(seat.employeeId, null);
  assert.strictEqual(seat.name, null);
});

test('the row is replaced from what the SERVER returned, not from what was picked', async () => {
  // The page sends an id and gets back the name the server resolved. That is
  // the whole point of the key: the name is derived, so it cannot drift from
  // the person — which is how 'Tim Green' and 'Timothy Green' became two people
  // earlier in this project.
  const ctx = await loaded();
  await ctx.econAssign('e3', 'h3');
  const seat = ctx.state.economics.find(s => s.id === 'e3');
  assert.strictEqual(seat.name, 'Unseated Person', 'resolved by the server from the id');
  assert.strictEqual(seat.unlinked, false);
});

test('a rename does not orphan the seat — the page resolves by id', async () => {
  // Ana is renamed on the roster. Her seat still points at h1, so it follows
  // her: the new name renders, the seat is not flagged, and her rate still
  // counts towards the pool. Under the old free-text scheme this seat read as
  // 'not on the roster' and her 36.00 dropped out of the totals, with nothing
  // anywhere saying a rename had done it.
  const ctx = sandbox();
  ctx.state.employees = ctx.state.employees.map(
    e => e.id === 'h1' ? { ...e, name: 'Ana Reyes-Marquez' } : e);
  await ctx.loadEconomics();
  const html = ctx.renderEconomics();

  assert.match(html, /Ana Reyes-Marquez/);
  const millwright1 = html.slice(html.indexOf('Millwright 1'), html.indexOf('Millwright 2'));
  assert.ok(!/not linked to anybody/.test(millwright1), 'the seat must not look orphaned');
  // Her rate is still in the pool: 36.00 + 33.25.
  assert.match(html, /\$69\.25/);
});

test('a refused assignment leaves the row exactly as the database has it', async () => {
  const ctx = await loaded();
  const before = ctx.state.economics.find(s => s.id === 'e1').name;
  await ctx.econAssign('e1', 'Somebody Who Left');
  assert.strictEqual(ctx.state.economics.find(s => s.id === 'e1').name, before,
    'the screen must never show an assignment that did not happen');
});

test('putting somebody in a second seat goes through AND says so', async () => {
  // Refusing would make a straight swap impossible without unassigning first.
  // A mid-swap state that resolves on the next click is not worth blocking, but
  // it is worth saying immediately rather than leaving to a banner.
  const ctx = await loaded();
  await ctx.econAssign('e3', 'h1');
  assert.strictEqual(ctx.state.economics.find(s => s.id === 'e3').employeeId, 'h1');
  assert.strictEqual(ctx.state.economics.find(s => s.id === 'e1').employeeId, 'h1');

  const html = ctx.renderEconomics();
  assert.match(html, /assigned to more than one seat/);
  assert.match(html, /overstated/);
});

test('a second click while one is in flight is dropped', async () => {
  const ctx = await loaded();
  ctx.state.econBusy = 'e1';
  await ctx.econAssign('e3', 'Unseated Person');
  assert.deepStrictEqual(patches(ctx), [], 'nothing sent');
});

test('the select offers the roster by id, and keeps an unlinked occupant visible', async () => {
  const ctx = await loaded();
  const html = ctx.renderEconomics();
  // Options carry employee ids, not names. That is the contract the endpoint
  // now enforces, and a name value would be refused with a 403.
  assert.match(html, /<option value="h3"/);
  assert.ok(!/<option value="Unseated Person"/.test(html), 'no name-valued options anywhere');
  // Utility 3's recorded occupant has to stay visible, or opening the select
  // would silently show it as vacant. Its value is empty, because there is no
  // id to send.
  assert.match(html, /<option value="" selected>Departed Person — not linked to anybody on the roster<\/option>/);
  // Salaried and inactive people are not offerable.
  assert.ok(!html.includes('>Sal Aried</option>'));
  assert.ok(!html.includes('>Inactive Person</option>'));
});

test('before the migration the dropdowns are inert and the page says why', async () => {
  const ctx = await loaded({ assignable: false });
  const html = ctx.renderEconomics();
  assert.match(html, /<select[^>]*disabled/);
  // And a click cannot slip through the disabled attribute.
  await ctx.econAssign('e3', 'h3');
  assert.deepStrictEqual(patches(ctx), [], 'nothing sent');
});

test('a salaried occupant stays visible and SELECTED, not silently shown as vacant', async () => {
  // THE REAL CASE, from the live plan: Eduardo Rivera is salaried and sits in
  // Production Lead. The select offers active hourly people only, so without an
  // option of his own the browser finds nothing selected and falls back to the
  // first one — the seat renders as "— vacant —" when it is not, and one stray
  // change clears somebody who is actually in the job.
  //
  // Found by §2c of SCHEMA_ECONOMICS_EMPLOYEE_ID.sql, which exists to list
  // exactly these rows.
  const ctx = await loaded();
  // Indexed by position rather than sliced by seat title. The page groups by
  // section, so the selects come out in SEATS order — and slicing on a title
  // silently produced an empty string when the order was not what I assumed,
  // which passes some assertions and fails others for the wrong reason.
  const sel = selects(ctx.renderEconomics())[3];   // Utility 2, Sal Aried, salaried

  assert.match(sel, /<option value="s1" selected>Sal Aried — salaried, cannot be reassigned here<\/option>/);
  assert.ok(!/<option value="" selected>— vacant —<\/option>/.test(sel),
    'the seat is not vacant and must not render as though it were');
});

test('a genuinely vacant seat still selects the vacant option', async () => {
  const ctx = await loaded();
  assert.match(selects(ctx.renderEconomics())[2], /<option value="" selected>— vacant —<\/option>/);
});

test('an unlinked seat does not also select the vacant option', async () => {
  // Two markers competing for `selected` on one select renders as whichever
  // came last. Utility 3 is the unlinked row.
  const ctx = await loaded();
  const sel = selects(ctx.renderEconomics())[4];
  const selected = sel.match(/<option[^>]*\sselected[^>]*>/g) || [];
  assert.strictEqual(selected.length, 1, 'exactly one option is selected: ' + selected.join(' '));
  assert.match(sel, /<option value="" selected>Departed Person — not linked to anybody on the roster<\/option>/);
});

test('every seat has exactly one selected option, whatever its state', async () => {
  // The general form of the bug above, and the one that would catch a fourth
  // state nobody has thought of yet. A select with none selected silently shows
  // its first option, which on this page means "vacant".
  const ctx = await loaded();
  const all = selects(ctx.renderEconomics());
  assert.strictEqual(all.length, 5, 'one per seat');
  all.forEach((sel, i) => {
    const selected = sel.match(/<option[^>]*\sselected[^>]*>/g) || [];
    assert.strictEqual(selected.length, 1,
      `seat ${i} has ${selected.length} selected options, must have exactly 1`);
  });
});

// ---------------------------------------------------------------------------
// the position rate
// ---------------------------------------------------------------------------
//
// `max_wage` was read-only on this page for a phase, on the argument that
// moving a ceiling is a budgeting decision rather than a staffing one. What it
// produced was a figure nobody could move: the number the whole Variance column
// is measured against was editable only by writing SQL against a live table.
//
// The gate did not change with it. The endpoint already needs the salaries tier
// to READ a ceiling, so the people who can now set one are exactly the people
// who could already see one.

const maxInputs = (html) => html.match(/<input[^>]*class="econ-max"[^>]*>/g) || [];

test('the columns are named Current Rate and Position Rate', async () => {
  const ctx = await loaded();
  const html = ctx.renderEconomics();
  assert.match(html, /Current Rate/);
  assert.match(html, /Position Rate/);
  // The old headings are gone, not merely joined. 'Rate' on its own said
  // nothing about whose, and 'Max' read as a cap on the person.
  assert.ok(!/>Rate</.test(html), "the bare 'Rate' heading is gone");
  assert.ok(!/>Max</.test(html), "the bare 'Max' heading is gone");
});

test('every seat has an editable position rate, pre-filled', async () => {
  const ctx = await loaded();
  const inputs = maxInputs(ctx.renderEconomics());
  assert.strictEqual(inputs.length, 5, 'one per seat, including the vacant ones');
  assert.match(ctx.renderEconomics(), /class="econ-max" value="38\.50"/);
});

test('a seat with no ceiling gets an empty field, not a zero', async () => {
  // A null max_wage is a real state the read has always tolerated. Showing 0.00
  // for it would assert a ceiling of nothing, which is a different claim.
  const ctx = await loaded({ seats: SEATS.map(x =>
    x.id === 'e3' ? { ...x, max_wage: null } : x) });
  const html = ctx.renderEconomics();
  assert.match(html, /class="econ-max" value=""\s+placeholder="none"/);
  assert.ok(!/value="0\.00"/.test(html));
});

test('setting a rate sends one PATCH naming one seat and one column', async () => {
  const ctx = await loaded();
  await ctx.econSaveMax('e1', '40.00');

  const w = patches(ctx);
  assert.strictEqual(w.length, 1);
  assert.deepStrictEqual(w[0].body, { id: 'e1', maxWage: 40 });
  // employeeId is NOT in the body: who is in the seat and what it is budgeted
  // at are separate facts, and the endpoint refuses a body naming both.
  assert.ok(!('employeeId' in w[0].body));
});

test('the local row advances from what the SERVER returned', async () => {
  // Not from what was typed. The response is canonical, so a value the server
  // rounded or rejected cannot linger on screen as though it had been stored.
  const ctx = await loaded({ patchSeat: (body) => ({ ok: true,
    seat: { id: 'e1', num: 1, section: 'Mill', seat: 'Millwright 1', employeeId: 'h1',
            name: 'Ana Reyes', unlinked: false, occupantStatus: 'Active',
            occupantSalaried: false, max_wage: 40 },
    previousMaxWage: 38.5 }) });
  await ctx.econSaveMax('e1', '40');
  const seat = ctx.state.economics.find(s => s.id === 'e1');
  assert.strictEqual(seat.max_wage, 40);
  // And the move is reported with both figures — a ceiling has no history
  // table, so this toast is the only place the previous value is stated.
  const t = ctx.__toasts[ctx.__toasts.length - 1];
  assert.match(t.msg, /\$38\.50/);
  assert.match(t.msg, /\$40\.00/);
  assert.strictEqual(t.type, 'success');
});

test('the variance recomputes against the new ceiling', async () => {
  // Ana is 36.00. Against 38.50 she is 2.50 under; move the ceiling to 30 and
  // she is 6.00 over. This is the assertion that the column follows the field.
  const ctx = await loaded({ patchSeat: () => ({ ok: true,
    seat: { id: 'e1', num: 1, section: 'Mill', seat: 'Millwright 1', employeeId: 'h1',
            name: 'Ana Reyes', unlinked: false, occupantStatus: 'Active',
            occupantSalaried: false, max_wage: 30 },
    previousMaxWage: 38.5 }) });
  assert.match(ctx.renderEconomics(), /var-under[^>]*>-\$2\.50/);
  await ctx.econSaveMax('e1', '30');
  assert.match(ctx.renderEconomics(), /var-over[^>]*>\+\$6\.00/);
});

test('clearing a position rate is allowed — a seat with no ceiling is a real state', async () => {
  // Unlike an hourly rate, which wage_history cannot record as having gone
  // away. The page has always tolerated a null max_wage and drawn a dash.
  const ctx = await loaded();
  await ctx.econSaveMax('e1', '');
  assert.deepStrictEqual(patches(ctx)[0].body, { id: 'e1', maxWage: '' });
  assert.match(ctx.__toasts[ctx.__toasts.length - 1].msg, /no position rate/);
});

test('an unchanged rate writes nothing', async () => {
  // Re-saving 38.50 over a stored 38.5 must not stamp updated_at or read as a
  // change in any audit of the row. Blur fires on every tab-through, so this is
  // the ordinary case, not the edge one.
  const ctx = await loaded();
  await ctx.econSaveMax('e1', '38.50');
  assert.deepStrictEqual(patches(ctx), []);
  await ctx.econSaveMax('e1', '$38.50');
  assert.deepStrictEqual(patches(ctx), [], 'nor in a different format');
});

test('a non-numeric rate is refused before the round trip, and the field reverts', async () => {
  const ctx = await loaded();
  await ctx.econSaveMax('e1', 'forty');
  assert.deepStrictEqual(patches(ctx), []);
  assert.match(ctx.__toasts[ctx.__toasts.length - 1].msg, /not a position rate/);
  // Reverted to what the database still holds, so the screen never shows a
  // ceiling that was not saved.
  assert.match(ctx.renderEconomics(), /class="econ-max" value="38\.50"/);
});

test('an annual figure in the hourly field is refused, not stored', async () => {
  // The realistic accident, and the one that would do real damage quietly: a
  // ceiling of 95000 makes the variance column meaningless for that seat rather
  // than look wrong.
  const ctx = await loaded();
  await ctx.econSaveMax('e1', '95000');
  assert.deepStrictEqual(patches(ctx), []);
  assert.match(ctx.__toasts[ctx.__toasts.length - 1].msg, /too high/);
});

test('a negative rate is refused', async () => {
  const ctx = await loaded();
  await ctx.econSaveMax('e1', '-5');
  assert.deepStrictEqual(patches(ctx), []);
  assert.match(ctx.__toasts[ctx.__toasts.length - 1].msg, /not a position rate/);
});

test('a failed save reverts the field and never reports success', async () => {
  const ctx = await loaded({ patchStatus: 500 });
  await ctx.econSaveMax('e1', '41.00');
  assert.ok(!ctx.__toasts.some(t => t.type === 'success'));
  const seat = ctx.state.economics.find(s => s.id === 'e1');
  assert.strictEqual(seat.max_wage, 38.5, 'the stored ceiling is untouched');
  assert.match(ctx.renderEconomics(), /class="econ-max" value="38\.50"/);
});

test('one save moves one seat, and cannot reach a second', async () => {
  const ctx = await loaded();
  await ctx.econSaveMax('e1', '41.00');
  assert.strictEqual(patches(ctx).length, 1);
  assert.match(patches(ctx)[0].url, /economics/);
  assert.strictEqual(ctx.state.economics.find(s => s.id === 'e2').max_wage, 30,
    'nobody else moved');
});

test('a draft survives a re-render mid-edit', async () => {
  // Every row is editable at once here, so the drafts are keyed by seat. A
  // render triggered by anything else must not swallow what was typed.
  const ctx = await loaded();
  ctx.econMaxSet('e1', '39.7');
  assert.match(ctx.renderEconomics(), /class="econ-max" value="39\.7"/);
  // And a different seat is undisturbed by it.
  assert.match(ctx.renderEconomics(), /class="econ-max" value="30\.00"/);
});
