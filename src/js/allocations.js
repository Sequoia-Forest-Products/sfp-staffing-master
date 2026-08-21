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

// Commits one employee's allocation and RETURNS A RESULT rather than toasting.
// The profile card's single Save composes this with two other writes and has to
// be able to say which part failed.
//
// STILL ONE TRANSACTION. The endpoint is unchanged: it calls
// set_employee_allocations, which deletes and re-inserts inside a single
// transaction with the deferred sum-to-100 check firing once at commit. That is
// what made Jeff Cook's 50/50 survive a rejected 90% write, and batching the
// card's saves behind one button does not touch it.
// The comparable form of an allocation: departments sorted, percentages to the
// cent. Two allocations are the same allocation if this matches, whatever order
// the rows happen to be in.
function allocFingerprint(rows){
  return (rows||[])
    .filter(r=>String(r.department||'').trim()!=='')
    .map(r=>String(r.department).trim()+':'+Math.round((Number(r.percent)||0)*100))
    .sort()
    .join('|');
}

async function allocCommit(employeeId){
  const key=String(employeeId);
  const rows=(state.allocDrafts||{})[key];
  if(!rows) return {ok:true, skipped:true};

  // AN UNCHANGED DRAFT IS NOT A WRITE. startProfileEdit seeds this draft the
  // moment Edit is pressed, so without this check every profile save sent an
  // allocation write: a pointless one for somebody with a split (moving
  // updated_at on a record nobody touched), and a removal of a non-existent
  // allocation for the 65 people who have none.
  const stored=allocationFor(employeeId);
  const storedPrint=allocFingerprint(stored?stored.rows:[]);
  const draftPrint=allocFingerprint(
    // A lone department at 100% is the default written down, i.e. no allocation,
    // so it compares equal to having no rows at all.
    (rows.length===1&&Math.round((Number(rows[0].percent)||0)*100)===10000)?[]:rows);
  if(storedPrint===draftPrint) return {ok:true, skipped:true};

  // A single department at 100% is not an allocation — it is the default written
  // down — so it is sent as a removal. Storing it would put somebody on the
  // exception list who is not an exception.
  const payload=(rows.length===1 && Math.round((Number(rows[0].percent)||0)*100)===10000)
    ? []
    : rows.filter(r => String(r.department||'').trim()!=='');

  try{
    const res=await fetch('/api/allocations',{
      method:'PUT', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({employeeId, rows:payload})
    });
    const json=await res.json().catch(()=>null);
    if(!res.ok||!json||json.ok===false) throw new Error((json&&json.error)||('status '+res.status));
    delete state.allocDrafts[key];
    return {ok:true, removed:json.removed===true};
  }catch(err){
    return {ok:false, error:err.message};
  }
}

// Whether this employee's draft is committable. The card's Save is disabled
// while it is not — the database would refuse it anyway, and letting somebody
// press Save to find that out is worse than not offering it.
function allocDraftValid(employeeId){
  const rows=(state.allocDrafts||{})[String(employeeId)];
  if(!rows) return true;                       // untouched
  if(!rows.length) return true;                // removal
  if(rows.some(r=>String(r.department||'').trim()==='')) return false;
  return Math.round(allocDraftTotal(rows)*100)===10000;
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
  const stored = allocationFor(id);
  const editing = profileEditing(e);

  // READ MODE: the stored split, or a plain statement that there is none. No
  // editor, no inputs, nothing to press — the card has one Edit button now.
  if(!editing){
    if(!stored){
      return profileGroup('Cost allocation',[
        pf('', '<span style="color:var(--muted)">No allocation — 100% of this person\'s cost goes to '
           + (primary ? esc(primary) : 'their primary department') + '.</span>', {html:true})
      ]);
    }
    return `<div class="pf-group">
      <div class="pf-group-title">Cost allocation</div>
      ${stored.rows.map(r => `<div style="display:flex;justify-content:space-between;font-size:12px;padding:4px 0;border-bottom:1px solid var(--border)">
        <span>${esc(r.department)}${r.department===primary?'<span style="color:var(--muted);font-size:10px"> · primary</span>':''}</span>
        <span style="font-weight:600;font-variant-numeric:tabular-nums">${Number(r.percent).toFixed(2)}%</span>
      </div>`).join('')}
      <div style="display:flex;justify-content:space-between;font-size:12px;font-weight:800;padding-top:6px">
        <span>Total</span><span>${Number(stored.total).toFixed(2)}%</span>
      </div>
      <div style="font-size:11px;color:var(--muted);line-height:1.5;margin-top:6px">
        Cost only — this person's HOURS are not split and stay with
        ${primary ? esc(primary) : 'their primary department'}.
        ${stored.sumsTo100 ? '' : '<strong style="color:var(--brick)">This does not sum to 100%, which the database should have made impossible — report it.</strong>'}
      </div>
    </div>`;
  }

  const rows = allocDraft(id, primary);
  const total = allocDraftTotal(rows);

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
    ${isDefault ? `<div style="font-size:11px;color:var(--muted);margin-top:6px">
      One department at 100% means no allocation${stored ? ' — saving this removes the existing split' : ''}.</div>` : ''}
  </div>`;
}
