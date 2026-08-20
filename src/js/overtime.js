// overtime — the Pre-Approved Overtime tab: the view, the edit grid and its CRUD.
//
// Shares one global scope with the other files in src/js (see core.js).

function renderOT(){
  const all=[...state.ot.pre,...state.ot.post,...state.ot.weekend];
  const tPr=state.ot.pre.reduce((s,r)=>s+r.hours,0);
  const tP=state.ot.post.reduce((s,r)=>s+r.hours,0);
  const tW=state.ot.weekend.reduce((s,r)=>s+r.hours,0);
  const uniq=new Set(all.map(r=>r.name)).size;
  const editing=state.otEditing;
  const allNames=[...new Set(state.employees.filter(e=>e.status==='Active').map(e=>e.name))].sort();

  function viewSection(title,recs,total){
    if(!recs.length)return'';
    // Group by description, sort groups by hours ascending
    const groups={};
    recs.forEach(r=>{
      const key=(r.desc||'Other').trim();
      if(!groups[key]) groups[key]={desc:key,hours:r.hours,names:[]};
      groups[key].names.push(r.name);
    });
    const sorted=Object.values(groups).sort((a,b)=>a.hours-b.hours);
    const chip=n=>`<span style="font-size:11px;background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:2px 8px;color:var(--text)">${n}</span>`;
    return `
      <div style="margin-top:24px">
        <div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.8px;color:var(--rust);margin-bottom:10px;padding-bottom:6px;border-bottom:2px solid var(--rust)">${title}</div>
        <div style="font-size:11px;color:var(--muted);margin-bottom:10px">${recs.length} employees · ${total.toFixed(2)} hrs</div>
        <div class="ot-grid">
          ${sorted.map(g=>`<div class="ot-card" style="flex-direction:column;align-items:flex-start;gap:6px">
            <div style="display:flex;justify-content:space-between;width:100%;align-items:center">
              <div style="font-weight:700;color:var(--text);font-size:12px">${g.desc}</div>
              <div class="ot-hrs">${g.hours.toFixed(2)}h</div>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:4px">${g.names.map(chip).join('')}</div>
          </div>`).join('')}
        </div>
      </div>`;
  }

  function editSection(title,recs,type){
    return `<div class="section-head" style="margin-top:16px">
      <span>${title}</span>
      <button class="btn btn-outline btn-sm" onclick="addOT('${type}')">+ Add</button>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Employee</th><th style="width:80px">Hours</th><th>Description</th><th style="width:40px"></th></tr></thead>
      <tbody>
        ${recs.map((r,i)=>`<tr>
          <td><input type="text" value="${r.name}" list="ot-names" style="font-family:var(--font);font-size:12px;border:1px solid var(--border);border-radius:4px;padding:4px 8px;width:100%" onchange="updateOT('${type}',${i},'name',this.value)"></td>
          <td><input type="number" value="${r.hours}" step="0.25" min="0" style="font-family:var(--font);font-size:12px;border:1px solid var(--border);border-radius:4px;padding:4px 8px;width:100%" onchange="updateOT('${type}',${i},'hours',+this.value)"></td>
          <td><input type="text" value="${r.desc||''}" style="font-family:var(--font);font-size:12px;border:1px solid var(--border);border-radius:4px;padding:4px 8px;width:100%" onchange="updateOT('${type}',${i},'desc',this.value)"></td>
          <td><button class="btn btn-sm" style="background:none;border:1px solid var(--border);color:var(--muted)" onclick="deleteOT('${type}',${i})">✕</button></td>
        </tr>`).join('')}
        ${!recs.length?`<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:12px">No entries</td></tr>`:''}
      </tbody>
    </table></div>`;
  }

  return `
    <datalist id="ot-names">${allNames.map(n=>`<option value="${n}">`).join('')}</datalist>
    <div class="stat-row">
      <div class="stat-card"><div class="stat-label">Before Shift OT</div><div class="stat-value">${state.ot.pre.length}</div><div class="stat-sub">${tPr.toFixed(2)} hrs · Hours/Day</div></div>
      <div class="stat-card"><div class="stat-label">After Shift OT</div><div class="stat-value">${state.ot.post.length}</div><div class="stat-sub">${tP.toFixed(2)} hrs · Hours/Day</div></div>
      <div class="stat-card"><div class="stat-label">Friday Pre-Approved</div><div class="stat-value">${state.ot.weekend.length}</div><div class="stat-sub">${tW.toFixed(2)} hrs · Hours/Day</div></div>
      <div class="stat-card"><div class="stat-label">Employee base allowance</div><div class="stat-value">${allNames.length}</div><div class="stat-sub">0.5 hrs · Hours/Week</div></div>
    </div>

    ${editing ? `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px">
        <div style="font-size:13px;color:var(--orange);font-weight:600">✎ Edit mode</div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-outline btn-sm" onclick="state.otEditing=false;render()">Cancel</button>
          <button class="btn btn-primary btn-sm" onclick="saveOT()">Save changes</button>
        </div>
      </div>
      ${editSection('Before Shift Pre-Approved OT (Hours/Day)',state.ot.pre,'pre')}
      ${editSection('After Shift Pre-Approved OT (Hours/Day)',state.ot.post,'post')}
      ${editSection('Friday Pre-Approved (Hours/Day)',state.ot.weekend,'weekend')}
      <div style="margin-top:24px;padding:12px;background:var(--surface2);border:1px solid var(--border);border-radius:6px">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--rust);margin-bottom:10px">Employee Base Allowance (0.5 hrs/week)</div>
        <div style="font-size:11px;color:var(--muted);margin-bottom:12px">All active employees receive 0.5 hours per week of pre-approved OT to account for time between whistles and clock in/out before and after shifts.</div>
        <div class="table-wrap"><table>
          <thead><tr><th>Employee</th><th style="width:100px">Hours/Week</th></tr></thead>
          <tbody>
            ${allNames.map(name=>`<tr><td>${name}</td><td style="text-align:right;font-weight:600">0.5</td></tr>`).join('')}
            ${!allNames.length?'<tr><td colspan="2" style="text-align:center;color:var(--muted);padding:12px">No active employees</td></tr>':''}
          </tbody>
        </table></div>
      </div>
      <div style="margin-top:16px;text-align:right;display:flex;gap:8px;justify-content:flex-end">
        <button class="btn btn-outline" onclick="state.otEditing=false;render()">Cancel</button>
        <button class="btn btn-primary" onclick="saveOT()">Save changes</button>
      </div>
    ` : `
      <div style="display:flex;justify-content:flex-end;margin-top:8px">
        <button class="btn btn-primary btn-sm" onclick="state.otEditing=true;render()">✎ Edit OT</button>
      </div>
      ${viewSection('Before Shift Pre-Approved OT (Hours/Day)',state.ot.pre,tPr)}
      ${viewSection('After Shift Pre-Approved OT (Hours/Day)',state.ot.post,tP)}
      ${viewSection('Friday Pre-Approved (Hours/Day)',state.ot.weekend,tW)}
      <div style="margin-top:24px;padding:12px;background:var(--surface2);border:1px solid var(--border);border-radius:6px">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--rust);margin-bottom:10px">Employee Base Allowance (0.5 hrs/week)</div>
        <div style="font-size:11px;color:var(--muted);margin-bottom:12px">All active employees receive 0.5 hours per week of pre-approved OT to account for time between whistles and clock in/out before and after shifts.</div>
        <div style="font-size:12px;font-weight:600;color:var(--text)">${allNames.length} active employees × 0.5 hrs/week = ${(allNames.length * 0.5).toFixed(1)} hrs/week base allowance</div>
      </div>
      ${!all.length?'<div class="loading-state">No OT assignments yet</div>':''}
    `}
  `;
}


// ============================================================
// OVERTIME CRUD
// ============================================================
function typeToKey(t){ return t==='Post-Shift'?'post':t==='Pre-Shift'?'pre':'weekend'; }

function addOT(type){
  type=type||'post';
  const otType=type==='post'?'Post-Shift':type==='pre'?'Pre-Shift':'Weekend';
  state.ot[type].push({name:'',hours:1,desc:'',otType});
  state.dirty=true; render();
}

function updateOT(type,idx,field,val){
  if(field==='otType'){
    // Move to different type array
    const rec={...state.ot[type][idx],otType:val};
    state.ot[type].splice(idx,1);
    state.ot[typeToKey(val)].push(rec);
  } else {
    state.ot[type][idx][field]=val;
  }
  state.dirty=true;
}

function deleteOT(type,idx){
  if(!confirm('Remove this OT assignment?')) return;
  state.ot[type].splice(idx,1);
  state.dirty=true; render();
}

async function saveOT(){
  const rows=[];
  state.ot.pre.forEach(r=>{if(r.name)rows.push({name:r.name,ot_type:'Pre-Shift',hours:r.hours||0,description:r.desc||''});});
  state.ot.post.forEach(r=>{if(r.name)rows.push({name:r.name,ot_type:'Post-Shift',hours:r.hours||0,description:r.desc||''});});
  state.ot.weekend.forEach(r=>{if(r.name)rows.push({name:r.name,ot_type:'Weekend',hours:r.hours||0,description:r.desc||''});});
  try{
    const res=await fetch('/api/data?table=overtime',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({rows})});
    if(!res.ok) throw new Error();
    toast('Overtime saved','success'); state.dirty=false;
    // Reload to get new ids
    const fresh=await fetch('/api/data?table=overtime');
    const d=await fresh.json();
    state.ot={pre:[],post:[],weekend:[]};
    (d.data||[]).forEach(r=>{
      const rec={id:r.id,name:r.name,hours:parseFloat(r.hours)||0,desc:r.description||''};
      if(r.ot_type==='Pre-Shift')state.ot.pre.push(rec);
      else if(r.ot_type==='Post-Shift')state.ot.post.push(rec);
      else state.ot.weekend.push(rec);
    });
    state.otEditing=false; render();
  }catch(e){ toast('Save failed: '+e.message,'error'); }
}
