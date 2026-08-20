// points — the Attendance Points tab: the log, the edit grid and its CRUD.
//
// Shares one global scope with the other files in src/js (see core.js).

function renderPoints(){
  const withDisc=state.points.filter(p=>p.disciplinary).length;
  const high=state.points.filter(p=>p.points>=4).length;
  const clean=state.points.filter(p=>p.points===0&&!p.disciplinary).length;
  const editing=state.ptEditing;
  function dot(pts,disc){if(disc)return'var(--brick)';if(pts>=4)return'#e67e22';if(pts>=2)return'#f1c40f';return'#2ecc71';}
  const allNames=[...new Set(state.employees.filter(e=>e.status==='Active').map(e=>e.name))].sort();
  const sorted=[...state.points].sort((a,b)=>b.points-a.points);

  const stats=`
    <div class="stat-row">
      <div class="stat-card"><div class="stat-label">Tracked</div><div class="stat-value">${state.points.length}</div></div>
      <div class="stat-card"><div class="stat-label">Disciplinary</div><div class="stat-value" style="color:var(--brick)">${withDisc}</div></div>
      <div class="stat-card"><div class="stat-label">High points (4+)</div><div class="stat-value" style="color:#e67e22">${high}</div></div>
      <div class="stat-card"><div class="stat-label">Clean record</div><div class="stat-value" style="color:#2a7a47">${clean}</div></div>
    </div>`;

  if(editing){
    return `
      <datalist id="pt-names">${allNames.map(n=>`<option value="${n}">`).join('')}</datalist>
      ${stats}
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px">
        <div style="font-size:13px;color:var(--orange);font-weight:600">✎ Edit mode</div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-outline btn-sm" onclick="addPoint()">+ Add entry</button>
          <button class="btn btn-outline btn-sm" onclick="state.ptEditing=false;render()">Cancel</button>
          <button class="btn btn-primary btn-sm" onclick="savePoints()">Save changes</button>
        </div>
      </div>
      <div class="section-head" style="margin-top:16px"><span>Attendance points log</span></div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th style="width:20px"></th>
            <th>Employee</th>
            <th style="width:70px">Points</th>
            <th style="width:110px">Last point</th>
            <th style="width:120px">Level-up eligible</th>
            <th style="width:80px">Disc?</th>
            <th style="width:110px">Disc. date</th>
            <th style="width:36px"></th>
          </tr></thead>
          <tbody>
            ${sorted.map((p,i)=>`<tr>
              <td><div class="pt-dot" style="background:${dot(p.points,p.disciplinary)}"></div></td>
              <td><input type="text" value="${p.name}" list="pt-names" style="font-family:var(--font);font-size:12px;border:1px solid var(--border);border-radius:4px;padding:3px 6px;width:100%" onchange="updatePoint(${i},'name',this.value)"></td>
              <td><input type="number" value="${p.points}" min="0" max="20" style="font-family:var(--font);font-size:12px;border:1px solid var(--border);border-radius:4px;padding:3px 6px;width:100%;font-weight:700" onchange="updatePoint(${i},'points',+this.value)"></td>
              <td><input type="text" value="${p.lastDate||''}" placeholder="M/D/YYYY" style="font-family:var(--font);font-size:12px;border:1px solid var(--border);border-radius:4px;padding:3px 6px;width:100%" onchange="updatePoint(${i},'lastDate',this.value)"></td>
              <td><input type="text" value="${p.levelElig||''}" placeholder="M/D/YYYY" style="font-family:var(--font);font-size:12px;border:1px solid var(--border);border-radius:4px;padding:3px 6px;width:100%" onchange="updatePoint(${i},'levelElig',this.value)"></td>
              <td style="text-align:center"><input type="checkbox" ${p.disciplinary?'checked':''} onchange="updatePoint(${i},'disciplinary',this.checked)" style="width:16px;height:16px;cursor:pointer;accent-color:var(--brick)"></td>
              <td><input type="text" value="${p.discDate||''}" placeholder="M/D/YYYY" style="font-family:var(--font);font-size:12px;border:1px solid var(--border);border-radius:4px;padding:3px 6px;width:100%" onchange="updatePoint(${i},'discDate',this.value)"></td>
              <td><button class="btn btn-sm" style="background:none;border:1px solid var(--border);color:var(--muted)" onclick="deletePoint(${i})">✕</button></td>
            </tr>`).join('')}
            ${!state.points.length?'<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:16px">No entries yet</td></tr>':''}
          </tbody>
        </table>
      </div>
      <div style="margin-top:16px;display:flex;gap:8px;justify-content:flex-end">
        <button class="btn btn-outline" onclick="state.ptEditing=false;render()">Cancel</button>
        <button class="btn btn-primary" onclick="savePoints()">Save changes</button>
      </div>`;
  }

  return `
    ${stats}
    <div style="display:flex;justify-content:flex-end;margin-top:8px">
      <button class="btn btn-primary btn-sm" onclick="state.ptEditing=true;render()">✎ Edit points</button>
    </div>
    <div class="section-head" style="margin-top:16px"><span>Attendance points log</span></div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th style="width:20px"></th>
          <th style="width:180px">Employee</th>
          <th style="width:70px">Points</th>
          <th style="width:120px">Last point</th>
          <th style="width:140px">Level-up eligible</th>
          <th>Disciplinary</th>
        </tr></thead>
        <tbody>
          ${sorted.map(p=>`<tr>
            <td><div class="pt-dot" style="background:${dot(p.points,p.disciplinary)}"></div></td>
            <td style="font-weight:600">${p.name}</td>
            <td style="font-weight:800;color:${p.points>=4?'var(--brick)':p.points>=2?'#e67e22':'#2a7a47'}">${p.points}</td>
            <td style="color:var(--muted)">${p.lastDate||'—'}</td>
            <td style="color:var(--muted)">${p.levelElig||'—'}</td>
            <td>${p.disciplinary?'<span class="badge disc">Yes</span>':'<span class="badge active">No</span>'}</td>
          </tr>`).join('')}
          ${!state.points.length?'<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px">No entries yet</td></tr>':''}
        </tbody>
      </table>
    </div>`;
}

// ============================================================
// POINTS CRUD
// ============================================================
function addPoint(){
  state.points.push({name:'',points:0,lastDate:'',levelElig:'',disciplinary:false,discDate:''});
  state.dirty=true; render();
}

function updatePoint(idx,field,val){
  // Find the actual index in the sorted array — we need to map back
  const sorted=[...state.points].sort((a,b)=>b.points-a.points);
  const orig=sorted[idx];
  const realIdx=state.points.indexOf(orig);
  if(realIdx===-1) return;
  state.points[realIdx][field]=val;
  state.dirty=true;
}

function deletePoint(idx){
  if(!confirm('Delete this points entry?')) return;
  const sorted=[...state.points].sort((a,b)=>b.points-a.points);
  const orig=sorted[idx];
  const realIdx=state.points.indexOf(orig);
  if(realIdx!==-1) state.points.splice(realIdx,1);
  state.dirty=true; render();
}

async function savePoints(){
  const rows=state.points.filter(p=>p.name).map(p=>({
    name:p.name, points:p.points||0, last_point_date:p.lastDate||'',
    level_up_eligible:p.levelElig||'', disciplinary:p.disciplinary||false,
    disc_date:p.discDate||''
  }));
  try{
    const res=await fetch('/api/data?table=points',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({rows})});
    if(!res.ok) throw new Error();
    toast('Points saved','success'); state.dirty=false;
    // Reload
    const fresh=await fetch('/api/data?table=points');
    const d=await fresh.json();
    state.points=(d.data||[]).map(r=>({
      id:r.id,name:r.name,points:r.points||0,lastDate:r.last_point_date||'',
      levelElig:r.level_up_eligible||'',disciplinary:r.disciplinary||false,discDate:r.disc_date||''
    }));
    state.ptEditing=false; render();
  }catch(e){ toast('Save failed: '+e.message,'error'); }
}
