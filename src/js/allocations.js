// allocations — cost allocation, edited on the employee profile card.
//
// Shares one global scope with the other files in src/js (see core.js).
//
// Some people's COST belongs to more than one department. Jeff Cook is half
// Corporate and half Sales & Marketing; Axeri Ramirez is a third HR, a third
// Corporate, a third Accounting.
//
// THREE THINGS THIS IS NOT, and each one is a decision rather than an omission:
//
//   1. Not a change to HOURS. Axeri works whole hours in one place; it is her
//      cost that splits. Hours stay with her primary department. Splitting them
//      would make cost-per-hour meaningless in every department she touches.
//   2. Not a salaried feature. Axeri is hourly. It is a property of the person.
//   3. Not a replacement for `department`. The primary department stays what it
//      was and the split layers on top — which is why 65 of 67 people need no
//      rows at all. No rows means 100% to the primary.
//
// THE WHOLE SET SAVES AT ONCE, unlike pre-approved OT which saves row by row.
// The 100% rule is a property of the set: turning a 50/50 split into a 60/40 one
// has no order in which the individual edits are valid. So the unit of change is
// one person's whole allocation, and the endpoint puts it through a single
// Postgres function so the deferred check runs once, at commit.

async function loadAllocations(){
  state.allocLoading = true; state.allocError = ''; render();
  try{
    const res = await fetch('/api/allocations');
    if(res.status === 401){ location.href = '/'; return; }
    let json = null;
    try{ json = await res.json(); }catch(e){ json = null; }
    if(!res.ok || !json || json.ok === false) throw new Error((json && json.error) || ('Request failed (' + res.status + ')'));
    state.allocations = json.allocations || [];
    state.allocTableMissing = json.tableMissing === true;
    state.allocNote = json.note || '';
    state.allocLoaded = true;
  }catch(err){
    state.allocations = []; state.allocError = err.message; state.allocLoaded = true;
    toast('Could not load allocations: ' + err.message, 'error');
  }
  state.allocLoading = false; render();
}

function allocationFor(employeeId){
  return (state.allocations || []).find(a => String(a.employeeId) === String(employeeId)) || null;
}

// The draft being edited, per employee, so opening a card does not disturb one
// left half-edited on somebody else.
function allocDraft(employeeId, primaryDepartment){
  if(!state.allocDrafts) state.allocDrafts = {};
  const key = String(employeeId);
  if(!state.allocDrafts[key]){
    const existing = allocationFor(employeeId);
    state.allocDrafts[key] = existing
      ? existing.rows.map(r => ({ department: r.department, percent: r.percent }))
      // Seeded with the primary at 100 rather than empty: it is the state the
      // person is actually in, and it is one edit away from a real split.
      : [{ department: primaryDepartment || '', percent: 100 }];
  }
  return state.allocDrafts[key];
}

function allocDraftTotal(rows){
  // Integer hundredths. 33.34 + 33.33 + 33.33 in floating point is
  // 100.00000000000001, and comparing that to 100 would call the exact split
  // the database stores "wrong".
  const h = (rows || []).reduce((t, r) => t + Math.round((Number(r.percent) || 0) * 100), 0);
  return h / 100;
}

function allocSetDepartment(employeeId, idx, value){
  const rows = state.allocDrafts[String(employeeId)];
  if(rows && rows[idx]) rows[idx].department = value;
  render();
}

function allocSetPercent(employeeId, idx, value){
  const rows = state.allocDrafts[String(employeeId)];
  if(rows && rows[idx]) rows[idx].percent = value === '' ? '' : Number(value);
  render();
}

function allocAddRow(employeeId){
  const rows = state.allocDrafts[String(employeeId)];
  if(rows) rows.push({ department: '', percent: 0 });
  render();
}

function allocRemoveRow(employeeId, idx){
  const rows = state.allocDrafts[String(employeeId)];
  if(rows) rows.splice(idx, 1);
  render();
}

// Splits the remainder evenly and puts the odd hundredth on the FIRST row, which
// the UI keeps as the primary department. Same rule the cost report uses when it
// rounds a split to the cent, so the two cannot disagree about who absorbs it.
function allocSplitEvenly(employeeId){
  const rows = state.allocDrafts[String(employeeId)];
  if(!rows || !rows.length) return;
  const each = Math.floor(10000 / rows.length);
  let left = 10000 - each * rows.length;
  rows.forEach((r, i) => { r.percent = (each + (i === 0 ? left : 0)) / 100; });
  render();
}

async function allocSave(employeeId){
  const rows = (state.allocDrafts || {})[String(employeeId)] || [];
  // A single department at 100% is not an allocation — it is the default written
  // down — so it is sent as a removal. Storing it would put somebody on the
  // exception list who is not an exception.
  const payload = (rows.length === 1 && Math.round((Number(rows[0].percent) || 0) * 100) === 10000)
    ? []
    : rows.filter(r => String(r.department || '').trim() !== '');
  try{
    const res = await fetch('/api/allocations', {
      method: 'PUT', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ employeeId, rows: payload })
    });
    const json = await res.json().catch(() => null);
    if(!res.ok || !json || json.ok === false) throw new Error((json && json.error) || ('Save failed (' + res.status + ')'));
    toast(json.removed ? 'Allocation removed — 100% to the primary department' : 'Allocation saved', 'success');
    delete state.allocDrafts[String(employeeId)];
    await loadAllocations();
    return true;
  }catch(err){
    toast(err.message, 'error');
    return false;
  }
}

function allocReset(employeeId){
  if(state.allocDrafts) delete state.allocDrafts[String(employeeId)];
  render();
}

// The profile card's allocation block.
function profileAllocation(e){
  const id = String(e && e.id || '');
  if(!id){
    return profileGroup('Cost allocation',[
      pf('','<span style="color:var(--muted)">Save this employee first — an allocation is keyed on their record.</span>',{html:true})
    ]);
  }

  if(!state.allocLoaded && !state.allocLoading) setTimeout(() => loadAllocations(), 0);

  if(state.allocTableMissing){
    return profileGroup('Cost allocation',[
      pf('','<span style="color:#b8860b">The allocations table does not exist yet — run SCHEMA_PHASE_C_ALLOCATIONS.sql. Until then everybody is costed 100% to their primary department.</span>',{html:true})
    ]);
  }
  if(state.allocLoading && !state.allocLoaded){
    return profileGroup('Cost allocation',[pf('','<span style="color:var(--muted)">Loading…</span>',{html:true})]);
  }

  const primary = hasDepartment(e.department) ? e.department : '';
  const rows = allocDraft(id, primary);
  const total = allocDraftTotal(rows);
  const stored = allocationFor(id);
  const dirty = JSON.stringify(rows) !== JSON.stringify(
    stored ? stored.rows.map(r => ({ department: r.department, percent: r.percent }))
           : [{ department: primary, percent: 100 }]);

  const isDefault = rows.length === 1 && Math.round((Number(rows[0].percent) || 0) * 100) === 10000;
  const ok = isDefault || Math.round(total * 100) === 10000;

  const options = (selected) => COST_CLASSES.map(cc =>
    `<optgroup label="${esc(cc)}">${DEPARTMENTS_BY_COST_CLASS[cc].map(d =>
      `<option value="${esc(d)}" ${d === selected ? 'selected' : ''}>${esc(d)}</option>`).join('')}</optgroup>`
  ).join('');

  const rowHtml = rows.map((r, i) => `
    <div style="display:grid;grid-template-columns:1fr 84px auto;gap:8px;align-items:center;padding:4px 0">
      <select onchange="allocSetDepartment('${jsStr(id)}',${i},this.value)"
        style="font-family:var(--font);font-size:12px;border:1px solid var(--border);border-radius:4px;padding:4px 8px;background:white">
        <option value="">— pick a department —</option>
        ${options(r.department)}
      </select>
      <input type="number" value="${r.percent}" min="0" max="100" step="0.01"
        onchange="allocSetPercent('${jsStr(id)}',${i},this.value)"
        style="font-family:var(--font);font-size:12px;border:1px solid var(--border);border-radius:4px;padding:4px 8px;width:100%">
      ${rows.length > 1
        ? `<button class="btn btn-outline btn-sm" style="padding:2px 8px" onclick="allocRemoveRow('${jsStr(id)}',${i})">✕</button>`
        : '<span style="width:26px"></span>'}
    </div>`).join('');

  return `<div class="pf-group">
    <div class="pf-group-title">Cost allocation</div>
    <div style="font-size:11px;color:var(--muted);line-height:1.5;margin-bottom:8px">
      Splits this person's <strong>cost</strong> across departments. Their hours are not split — they
      work whole hours in one place, and hours stay with ${primary ? esc(primary) : 'their primary department'}.
      One department at 100% means no allocation at all, which is what most of the roster has.
      ${primary ? 'Rounding to the cent puts any remainder on ' + esc(primary) + ', the primary.' : ''}
    </div>
    ${rowHtml}
    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;font-size:11.5px">
      <div>
        <button class="btn btn-outline btn-sm" style="padding:2px 9px" onclick="allocAddRow('${jsStr(id)}')">+ Department</button>
        <button class="btn btn-outline btn-sm" style="padding:2px 9px" onclick="allocSplitEvenly('${jsStr(id)}')">Split evenly</button>
      </div>
      <div style="font-weight:800;color:${ok ? '#2a7a47' : 'var(--brick)'}">
        ${total.toFixed(2)}%${ok ? '' : ' — must be 100%'}
      </div>
    </div>
    ${!ok ? `<div style="font-size:11px;color:var(--brick);line-height:1.5;margin-top:6px">
      ${total < 100
        ? esc((100 - total).toFixed(2)) + '% of this person\'s cost would land nowhere, and every department total would be quietly short.'
        : esc((total - 100).toFixed(2)) + '% of this person\'s cost would be counted twice.'}
      The database refuses a partial allocation, so this will not save.</div>` : ''}
    ${isDefault && !stored ? `<div style="font-size:11px;color:var(--muted);margin-top:6px">
      No allocation: 100% of this person's cost goes to their primary department.</div>` : ''}
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">
      ${dirty ? `<button class="btn btn-outline btn-sm" onclick="allocReset('${jsStr(id)}')">Revert</button>` : ''}
      <button class="btn btn-primary btn-sm" ${ok ? '' : 'disabled'} onclick="allocSave('${jsStr(id)}')">
        ${isDefault && stored ? 'Remove allocation' : 'Save allocation'}</button>
    </div>
  </div>`;
}
