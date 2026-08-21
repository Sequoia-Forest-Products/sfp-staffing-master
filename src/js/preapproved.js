// preapproved — the Pre-Approved OT report, over /api/preapproved-ot.
//
// Shares one global scope with the other files in src/js (see core.js).
//
// WHAT CHANGED IN PHASE C, and why this file was rewritten rather than edited:
//
// The old Pre-Approved Overtime tab was an editable grid over the `overtime`
// table, and it had three problems that were not cosmetic.
//
//   1. It matched employees BY NAME, typed into a free-text box with a datalist.
//      The roster has two people named Smith. A name key silently picks the
//      first, so one person's allowance could attach to another's record.
//   2. It saved by REPLACING THE WHOLE TABLE. That is how a byte-identical
//      duplicate got in — Rey Aispuro's 6-hour Weekend allowance, counted as 12
//      for months — and it meant a partial save could wipe rows nobody touched.
//   3. Its labels said "Hours/Day" and "Friday Pre-Approved". The report has
//      always applied these figures as a standing WEEKLY allowance, and the
//      third category is Weekend, not Friday. A label that disagrees with the
//      arithmetic is worse than no label.
//
// So: assignment moved to the employee profile, where it is keyed on that
// employee's id and saves one row at a time. This view is now a REPORT — by
// category, by department, and per employee against the OT they actually worked,
// which is what makes an allowance arguable.

const PREAPPROVED_TYPES = ['Pre-Shift', 'Post-Shift', 'Weekend'];

// What each category means, spelled out because "Pre-Shift" alone does not say
// whether it is per day or per week, and the answer has always been per week.
const PREAPPROVED_TYPE_NOTE = {
  'Pre-Shift':  'before the shift starts',
  'Post-Shift': 'after the shift ends',
  'Weekend':    'Friday to Sunday'
};

async function loadPreApproved(){
  state.preLoading = true; state.preError = ''; render();
  try{
    const res = await fetch('/api/preapproved-ot');
    if(res.status === 401){ location.href = '/'; return; }
    let json = null;
    try{ json = await res.json(); }catch(e){ json = null; }
    if(!res.ok || !json || json.ok === false) throw new Error((json && json.error) || ('Request failed (' + res.status + ')'));
    state.preRows = json.rows || [];
    state.preTableMissing = json.tableMissing === true;
    state.preNote = json.note || '';
    state.preLoaded = true;
  }catch(err){
    state.preRows = []; state.preError = err.message; state.preLoaded = true;
    toast('Could not load pre-approved OT: ' + err.message, 'error');
  }
  state.preLoading = false; render();
}

// One row, upserted. The employee id and the category ARE the key, so saving the
// same pair twice updates instead of adding — which is the whole difference from
// the old save.
async function savePreApproved(employeeId, otType, hours, description){
  try{
    const res = await fetch('/api/preapproved-ot', {
      method: 'PUT', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ employeeId, otType, hours, description })
    });
    const json = await res.json().catch(() => null);
    if(!res.ok || !json || json.ok === false) throw new Error((json && json.error) || ('Save failed (' + res.status + ')'));
    toast('Pre-approved OT saved', 'success');
    await loadPreApproved();
    return true;
  }catch(err){
    toast(err.message, 'error');
    return false;
  }
}

async function deletePreApproved(employeeId, otType, label){
  if(!confirm('Remove the ' + otType + ' allowance for ' + (label || 'this employee') + '?')) return false;
  try{
    const qs = 'employeeId=' + encodeURIComponent(employeeId) + '&otType=' + encodeURIComponent(otType);
    const res = await fetch('/api/preapproved-ot?' + qs, { method: 'DELETE' });
    const json = await res.json().catch(() => null);
    if(!res.ok || !json || json.ok === false) throw new Error((json && json.error) || ('Delete failed (' + res.status + ')'));
    toast('Allowance removed', 'success');
    await loadPreApproved();
    return true;
  }catch(err){
    toast(err.message, 'error');
    return false;
  }
}

// The draft the profile card edits: one entry per category, always all three,
// seeded from whatever is stored. Blank hours means "no allowance" and is what a
// removal looks like — see preApprovedCommit.
function preApprovedDraft(employeeId){
  const mine=preApprovedFor(employeeId);
  const draft={};
  for(const type of PREAPPROVED_TYPES){
    const row=mine[type]||null;
    draft[type]={
      hours: row ? String(row.hours) : '',
      description: row ? (row.description||'') : '',
      existed: !!row
    };
  }
  return draft;
}

// Commits one employee's whole draft, and RETURNS A RESULT rather than toasting.
// The profile card's single Save composes this with two other writes and has to
// be able to say which part failed, so nothing here talks to the user.
//
// STILL ONE ROW PER CALL. The endpoint's shape is unchanged — upsert one,
// delete one — because that is what made Rey Aispuro's duplicated allowance
// impossible. What changed is only that the calls are batched behind one button
// instead of three.
//
// Blank hours removes the row. Zero does NOT: zero is a real setting that
// switches an allowance off while keeping the record and its description, and
// the API accepts it for exactly that reason.
async function preApprovedCommit(employeeId, draft){
  const failures=[];
  let wrote=0, removed=0;

  for(const type of PREAPPROVED_TYPES){
    const d=(draft||{})[type];
    if(!d) continue;
    const raw=String(d.hours==null?'':d.hours).trim();
    const stored=preApprovedFor(employeeId)[type]||null;

    try{
      if(raw===''){
        // Nothing to do unless there is a row to remove.
        if(stored){
          const qs='employeeId='+encodeURIComponent(employeeId)+'&otType='+encodeURIComponent(type);
          const res=await fetch('/api/preapproved-ot?'+qs,{method:'DELETE'});
          const json=await res.json().catch(()=>null);
          if(!res.ok||!json||json.ok===false) throw new Error((json&&json.error)||('status '+res.status));
          removed++;
        }
        continue;
      }

      // Unchanged rows are not rewritten. Saving a profile should not touch an
      // allowance nobody edited — updated_at is the audit trail for who changed
      // what and when.
      if(stored
         && Number(stored.hours)===Number(raw)
         && String(stored.description||'')===String(d.description||'')) continue;

      const res=await fetch('/api/preapproved-ot',{
        method:'PUT', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({employeeId, otType:type, hours:raw, description:d.description||''})
      });
      const json=await res.json().catch(()=>null);
      if(!res.ok||!json||json.ok===false) throw new Error((json&&json.error)||('status '+res.status));
      wrote++;
    }catch(err){
      failures.push(type+': '+err.message);
    }
  }

  return {ok:failures.length===0, wrote, removed, failures};
}

// Rows for one employee, by category. Used by the profile card and here.
function preApprovedFor(employeeId){
  const out = {};
  for(const r of (state.preRows || [])){
    if(String(r.employeeId) === String(employeeId)) out[r.otType] = r;
  }
  return out;
}

function preTotalHours(rows){
  return (rows || []).reduce((t, r) => t + (Number(r.hours) || 0), 0);
}

function renderPreApproved(){
  const rows = state.preRows || [];
  const active = rows.filter(r => r.onRoster && (r.status || 'Active') === 'Active');
  const inactive = rows.filter(r => r.onRoster && (r.status || 'Active') !== 'Active');
  const orphaned = rows.filter(r => !r.onRoster);

  const grace = graceHrs();
  const activeHourly = (state.employees || []).filter(e => e.status === 'Active' && !isSalaried(e));

  const style = `<style>
    .pre-note{font-size:11.5px;line-height:1.5;background:var(--surface2);border:1px solid var(--border);border-left:3px solid var(--rust);border-radius:6px;padding:9px 12px;margin:10px 0}
    .pre-warn{border-left-color:#e67e22;background:#fffbf5}
    .pre-bad{border-left-color:#e74c3c;background:#fff6f5}
    .pre-panel{background:var(--surface);border:1px solid var(--border);border-radius:8px;margin-bottom:14px;overflow:hidden}
    .pre-row{display:grid;grid-template-columns:1fr 92px 78px 1fr 96px;gap:10px;align-items:center;padding:6px 12px;font-size:11.5px;border-bottom:1px solid var(--border)}
    .pre-row:last-child{border-bottom:none}
    .pre-row.pre-hdr{font-size:10px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.3px}
    .pre-row.pre-tot{font-weight:800;background:var(--surface2)}
    .pre-num{text-align:right;font-variant-numeric:tabular-nums}
    .pre-name{font-weight:600}
    .pre-desc{color:var(--muted)}
    .pre-sect{font-size:13px;font-weight:800;margin:18px 0 6px}
    .pre-tag{font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;margin-left:6px}
  </style>`;

  if(state.preLoading && !state.preLoaded) return style + '<div class="loading-state">Loading pre-approved OT…</div>';

  const migrationBanner = state.preTableMissing
    ? `<div class="pre-note pre-warn"><strong>The per-employee table does not exist yet.</strong>
        ${esc(state.preNote || '')} Nothing is lost — the OT report is still reading the old table, so the
        allowance is still being applied. It is just still matched by name, so an inactive employee still
        carries one and a name variant still reports as unmatched.</div>`
    : '';

  const errorBanner = state.preError
    ? `<div class="pre-note pre-bad"><strong>Could not load.</strong> ${esc(state.preError)}
        <button class="btn btn-outline btn-sm" style="margin-left:8px" onclick="loadPreApproved()">Try again</button></div>`
    : '';

  // Categories
  const byType = PREAPPROVED_TYPES.map(t => {
    const rs = active.filter(r => r.otType === t);
    return { type: t, rows: rs, hours: preTotalHours(rs), people: rs.length };
  });

  // Departments
  const deptMap = new Map();
  for(const r of active){
    const d = r.department || 'Unassigned';
    const cur = deptMap.get(d) || { department: d, hours: 0, people: new Set() };
    cur.hours += Number(r.hours) || 0;
    cur.people.add(r.employeeId);
    deptMap.set(d, cur);
  }
  const byDept = [...deptMap.values()]
    .map(d => ({ department: d.department, hours: Math.round(d.hours * 100) / 100, people: d.people.size }))
    .sort((a, b) => b.hours - a.hours || a.department.localeCompare(b.department));

  const standingTotal = preTotalHours(active);

  const cards = `<div class="stat-row">
    ${byType.map(t => `<div class="stat-card">
      <div class="stat-label">${esc(t.type)}</div>
      <div class="stat-value">${fmtHrs(t.hours)}<span style="font-size:13px"> hrs</span></div>
      <div class="stat-sub">${t.people} ${t.people === 1 ? 'person' : 'people'} · ${esc(PREAPPROVED_TYPE_NOTE[t.type] || '')}</div>
    </div>`).join('')}
    <div class="stat-card"><div class="stat-label">Standing total</div>
      <div class="stat-value">${fmtHrs(standingTotal)}<span style="font-size:13px"> hrs/wk</span></div>
      <div class="stat-sub">${new Set(active.map(r => r.employeeId)).size} people with an allowance</div></div>
    <div class="stat-card"><div class="stat-label">Timeclock grace</div>
      <div class="stat-value">${fmtHrs(grace * activeHourly.length)}<span style="font-size:13px"> hrs/wk</span></div>
      <div class="stat-sub">${fmtHrs(grace)} × ${activeHourly.length} active hourly · separate line item</div></div>
  </div>`;

  const standingNote = `<div class="pre-note"><strong>This is a standing WEEKLY allowance.</strong>
    There is no week column: the same figure applies to every week, and Net OT is the OT actually worked
    minus this plus the timeclock grace. The three categories say <em>when</em> the overtime happens; the
    description says <em>what the work is</em>, which is the part a manager can argue with.
    <br><br>Allowances are assigned per employee on the <button class="btn btn-outline btn-sm"
      style="padding:1px 8px" onclick="goToTab('employees')">Employees</button> tab — open somebody's
    profile card. They are keyed on the employee, not on a typed name, so the two people named Smith
    cannot be confused for one another.</div>`;

  const typeTable = (t) => {
    const rs = t.rows.slice().sort((a, b) => (Number(b.hours) || 0) - (Number(a.hours) || 0)
      || String(a.name || '').localeCompare(String(b.name || '')));
    return `<div class="pre-sect">${esc(t.type)} — ${fmtHrs(t.hours)} hrs/wk
      <span style="font-weight:400;font-size:11px;color:var(--muted)">(${esc(PREAPPROVED_TYPE_NOTE[t.type] || '')})</span></div>
      <div class="pre-panel">
        <div class="pre-row pre-hdr">
          <div>Employee</div><div>Department</div><div class="pre-num">Hrs/wk</div><div>What for</div><div></div>
        </div>
        ${rs.length ? rs.map(r => `<div class="pre-row">
          <div class="pre-name">${esc(r.name || '—')}</div>
          <div>${esc(r.department || 'Unassigned')}</div>
          <div class="pre-num">${fmtHrs(r.hours)}</div>
          <div class="pre-desc">${r.description ? esc(r.description) : '<em>no description</em>'}</div>
          <div style="text-align:right"><button class="btn btn-outline btn-sm" style="padding:1px 8px"
            onclick="goToEmployeeProfile('${jsStr(r.employeeId)}')">Edit</button></div>
        </div>`).join('')
        : '<div class="pre-row" style="color:var(--muted)"><div>Nobody has a ' + esc(t.type) + ' allowance.</div></div>'}
      </div>`;
  };

  const deptTable = `<div class="pre-sect">By department</div>
    <div class="pre-panel">
      <div class="pre-row pre-hdr" style="grid-template-columns:1fr 92px 78px">
        <div>Department</div><div class="pre-num">People</div><div class="pre-num">Hrs/wk</div>
      </div>
      ${byDept.length ? byDept.map(d => `<div class="pre-row" style="grid-template-columns:1fr 92px 78px">
        <div class="pre-name">${esc(d.department)}</div>
        <div class="pre-num">${d.people}</div>
        <div class="pre-num">${fmtHrs(d.hours)}</div>
      </div>`).join('') : '<div class="pre-row" style="color:var(--muted)"><div>No allowances yet.</div></div>'}
      <div class="pre-row pre-tot" style="grid-template-columns:1fr 92px 78px">
        <div>Total</div>
        <div class="pre-num">${new Set(active.map(r => r.employeeId)).size}</div>
        <div class="pre-num">${fmtHrs(standingTotal)}</div>
      </div>
    </div>`;

  // Allowances that exist but count for nothing. Both cases were invisible
  // before: an inactive employee matched the roster by name so nothing flagged
  // them, and an orphaned row had no name to report.
  const excluded = (inactive.length || orphaned.length)
    ? `<div class="pre-note pre-warn"><strong>${inactive.length + orphaned.length}
        ${(inactive.length + orphaned.length) === 1 ? 'allowance' : 'allowances'} counted nowhere.</strong>
        An allowance is permission to work overtime, so somebody who has left cannot use it — crediting them
        would understate Net OT every week. These rows are listed so they can be deleted rather than ignored.</div>
      <div class="pre-panel">
        ${inactive.map(r => `<div class="pre-row">
          <div class="pre-name">${esc(r.name || '—')}<span class="pre-tag" style="color:#e67e22">inactive</span></div>
          <div>${esc(r.department || '—')}</div>
          <div class="pre-num">${fmtHrs(r.hours)}</div>
          <div class="pre-desc">${esc(r.otType)}${r.description ? ' · ' + esc(r.description) : ''}</div>
          <div style="text-align:right"><button class="btn btn-outline btn-sm" style="padding:1px 8px"
            onclick="deletePreApproved('${jsStr(r.employeeId)}','${jsStr(r.otType)}','${jsStr(r.name || '')}')">Remove</button></div>
        </div>`).join('')}
        ${orphaned.map(r => `<div class="pre-row">
          <div class="pre-name">(deleted employee)<span class="pre-tag" style="color:var(--brick)">no roster row</span></div>
          <div>—</div>
          <div class="pre-num">${fmtHrs(r.hours)}</div>
          <div class="pre-desc">${esc(r.otType)}${r.description ? ' · ' + esc(r.description) : ''}</div>
          <div style="text-align:right"><button class="btn btn-outline btn-sm" style="padding:1px 8px"
            onclick="deletePreApproved('${jsStr(r.employeeId)}','${jsStr(r.otType)}','this deleted employee')">Remove</button></div>
        </div>`).join('')}
      </div>`
    : '';

  // Standing approval against the OT actually worked. Only available when the OT
  // report has been loaded — it is the only thing that knows what was worked —
  // so this offers to load it rather than rendering a table of blanks.
  const vsActual = state.otReport
    ? renderPreApprovedVsActual()
    : `<div class="pre-note">Load the <button class="btn btn-outline btn-sm" style="padding:1px 8px"
        onclick="switchReportView('otreport')">OT Report</button> to see each allowance against the overtime
        actually worked. That comparison needs a week's payroll data, which this view does not fetch.</div>`;

  return style
    + migrationBanner
    + errorBanner
    + cards
    + standingNote
    + `<div style="display:flex;justify-content:flex-end;gap:8px">
         <button class="btn btn-outline btn-sm" onclick="loadPreApproved()">Refresh</button>
       </div>`
    + byType.map(typeTable).join('')
    + deptTable
    + excluded
    + vsActual;
}

// Per-employee: what is approved, what was worked, and the difference. This is
// the table the whole restructure exists to make possible — the old view could
// not draw it, because it did not know which roster row an allowance belonged to.
function renderPreApprovedVsActual(){
  const r = state.otReport;
  const people = (r.employees || []).filter(e =>
    (Number(e.preApprovedHours) || 0) > 0 || (Number(e.otHours) || 0) > 0);
  people.sort((a, b) => (Number(b.netOtHours) || 0) - (Number(a.netOtHours) || 0));

  return `<div class="pre-sect">Standing approval vs. overtime worked
      <span style="font-weight:400;font-size:11px;color:var(--muted)">
        (week of ${esc(fmtDate(r.weekStart))})</span></div>
    <div class="pre-note">Net OT is <strong>OT worked − (standing allowance + timeclock grace)</strong>.
      The grace column is everybody's ${fmtHrs(graceHrs())} hrs, not this person's approval, and it is shown
      separately for that reason. A negative Net OT means less overtime was worked than was approved; it is
      shown as it lands rather than floored at zero, because the carried allowance is the finding.</div>
    <div class="pre-panel">
      <div class="pre-row pre-hdr" style="grid-template-columns:1fr 110px 78px 78px 78px 82px">
        <div>Employee</div><div>Department</div><div class="pre-num">Approved</div>
        <div class="pre-num">Grace</div><div class="pre-num">OT worked</div><div class="pre-num">Net OT</div>
      </div>
      ${people.length ? people.map(e => {
        const net = Number(e.netOtHours) || 0;
        const colour = net > 0 ? 'var(--brick)' : net < 0 ? '#2a7a47' : 'var(--muted)';
        return `<div class="pre-row" style="grid-template-columns:1fr 110px 78px 78px 78px 82px">
          <div class="pre-name">${esc(e.name || ('#' + (e.employeeNumber || '?')))}</div>
          <div>${esc(e.department || 'Unassigned')}</div>
          <div class="pre-num">${fmtHrs(e.preApprovedHours)}</div>
          <div class="pre-num" style="color:var(--muted)">${fmtHrs(e.graceHours)}</div>
          <div class="pre-num">${fmtHrs(e.otHours)}</div>
          <div class="pre-num" style="color:${colour};font-weight:700">${fmtHrs(net)}</div>
        </div>`;
      }).join('') : '<div class="pre-row" style="color:var(--muted)"><div>No overtime and no allowances this week.</div></div>'}
    </div>`;
}
