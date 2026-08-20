// economics — the Staffing Economics tab: positions, assignment and burdened cost.
//
// Shares one global scope with the other files in src/js (see core.js).

function calcDollarPerM(wage){
  return wage * (1 + state.burden) / state.mhr;
}

function getEmpWage(name){
  const emp = state.employees.find(e=>e.name===name);
  if(!emp) return 0;
  const w = String(emp.wage||'').replace(/[$,]/g,'');
  return parseFloat(w)||0;
}

function renderEcon(){
  const burden = state.burden;
  const mhr = state.mhr;

  // Active hourly employees. This report is about hourly labour wages, and the old
  // test against the LEGACY dept column's 'SG&A' value (not the current
  // department field, which now carries an SG&A of its own) was only ever a proxy
  // for "salaried", so test the wage.
  const eligible = state.employees.filter(e=>e.status==='Active' && !isSalaried(e));

  // Find duplicates
  const nameCount = {};
  state.economics.forEach(p=>{ if(p.name) nameCount[p.name]=(nameCount[p.name]||0)+1; });
  const dupes = new Set(Object.keys(nameCount).filter(n=>nameCount[n]>1));

  // Unassigned = eligible employees not in any position
  const assignedNames = new Set(state.economics.map(p=>p.name).filter(Boolean));
  const unassigned = eligible.filter(e=>!assignedNames.has(e.name));

  const secs = [...new Set(state.economics.map(e=>e.section))];
  const totalWage = state.economics.reduce((s,p)=>s+(p.name?getEmpWage(p.name):0),0);
  const totalDpm = state.economics.reduce((s,p)=>s+(p.name?calcDollarPerM(getEmpWage(p.name)):0),0);

  // Build dropdown options — all eligible employees
  const empOptions = eligible.map(e=>`<option value="${e.name}">${e.name}</option>`).join('');

  // Build position rows
  const posRows = secs.map(sec=>{
    const positions = state.economics.filter(p=>p.section===sec);
    const hdr = `<div class="dept-header">${sec}</div>`;
    const rows = positions.map(p=>{
      const econIdx = state.economics.indexOf(p);
      const wage = p.name ? getEmpWage(p.name) : 0;
      const dpm = wage ? '$'+calcDollarPerM(wage).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : '—';
      const variance = (p.name && p.max) ? wage - p.max : null;
      const isOver = variance !== null && variance > 0;
      const isUnder = variance !== null && variance < 0;
      const varStr = variance === null ? '—' : (variance > 0 ? '+$'+variance.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : '-$'+Math.abs(variance).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}));
      const varCls = isOver ? 'var-over' : isUnder ? 'var-under' : 'var-even';
      const isDupe = p.name && dupes.has(p.name);
      const rowAlert = isDupe ? ' style="border-color:#e67e22;background:#fffbf5"' : '';

      return `<div class="pos-row"${rowAlert}>
        <div class="pos-num">${p.num}</div>
        <div class="pos-title">${p.position}</div>
        <div>
          <select class="pos-select${isDupe?' dupe-select':''}" onchange="econAssign(${econIdx},this.value)">
            <option value="">— unassigned —</option>
            ${eligible.map(e=>`<option value="${e.name}" ${p.name===e.name?'selected':''}>${e.name}</option>`).join('')}
          </select>
          ${isDupe ? '<span style="color:#e67e22;font-size:10px;font-weight:700;margin-left:6px">⚠ assigned twice</span>' : ''}
        </div>
        <div class="pos-dpm">${wage ? '$'+wage.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : '—'}</div>
        <div class="pos-dpm">${dpm}</div>
        <div class="pos-max">${p.max ? '$'+Number(p.max).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : '—'}</div>
        <div class="pos-var ${varCls}">${varStr}</div>
      </div>`;
    }).join('');
    return hdr + rows;
  }).join('');

  return `<style>
    .econ-layout{display:grid;grid-template-columns:190px 1fr;gap:16px;align-items:start}
    .unassigned-panel{background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:12px;position:sticky;top:0}
    .unassigned-panel h4{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--rust);margin:0 0 8px}
    .unemp{font-size:12px;font-weight:600;padding:4px 0;border-bottom:1px solid var(--border);color:var(--text)}
    .unemp:last-child{border:none}
    .dept-header{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.8px;color:white;background:var(--rust);padding:5px 12px;border-radius:6px;margin-top:10px}
    .pos-row{display:grid;grid-template-columns:28px 130px 1fr 65px 65px 65px 75px;gap:8px;align-items:center;padding:6px 8px;background:var(--surface);border:1px solid var(--border);border-radius:6px;font-size:11px;margin-top:3px}
    .pos-select{font-family:var(--font);font-size:11px;border:1px solid var(--border);border-radius:4px;padding:3px 6px;width:100%;background:white}
    .pos-select.dupe-select{border-color:#e67e22}
    .pos-num{color:var(--muted);font-size:10px;font-weight:700}
    .pos-title{font-weight:600;font-size:11px}
    .pos-dpm,.pos-max{font-size:11px}
    .pos-var{font-size:11px;font-weight:600}
    .var-over{color:#e74c3c}
    .var-under{color:#2a7a47}
    .var-even{color:var(--muted)}
    .econ-controls{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:12px;padding:10px 14px;background:var(--surface2);border:1px solid var(--border);border-radius:8px}
    .econ-ctrl{display:flex;align-items:center;gap:6px;font-size:12px}
    .econ-ctrl label{color:var(--muted);font-weight:600}
    .econ-ctrl input{width:65px;font-family:var(--font);font-size:12px;border:1px solid var(--border);border-radius:4px;padding:3px 7px}
    .col-hdr{font-size:10px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.3px}
  </style>

  <div class="stat-row">
    <div class="stat-card"><div class="stat-label">Positions</div><div class="stat-value">${state.economics.length}</div>
      <div class="stat-sub">${unassigned.length>0?'<span style="color:#e67e22">⚠ '+unassigned.length+' unassigned</span>':'✓ All filled'}</div></div>
    <div class="stat-card"><div class="stat-label">Wage pool</div><div class="stat-value">$${totalWage.toFixed(0)}<span style="font-size:13px">/hr</span></div></div>
    <div class="stat-card"><div class="stat-label">Burdened cost</div><div class="stat-value">$${totalDpm.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}<span style="font-size:13px">/m</span></div></div>
    <div class="stat-card"><div class="stat-label">Duplicates</div><div class="stat-value" style="color:${dupes.size?'#e67e22':'#2a7a47'}">${dupes.size}</div>
      <div class="stat-sub">${dupes.size?[...dupes].join(', '):'none'}</div></div>
  </div>

  <div class="econ-controls">
    <div class="econ-ctrl"><label>Burden %</label><input type="number" value="${(burden*100).toFixed(0)}" min="0" max="100" step="1" onchange="state.burden=+this.value/100;render()"> %</div>
    <div class="econ-ctrl"><label>M/Hr</label><input type="number" value="${mhr}" min="1" step="0.5" onchange="state.mhr=+this.value;render()"></div>
    <div style="margin-left:auto"><button class="btn btn-primary btn-sm" onclick="saveEconomics()">Save staffing plan</button></div>
  </div>

  <div class="econ-layout">
    <div class="unassigned-panel">
      <h4>Unassigned (${unassigned.length})</h4>
      ${unassigned.length
        ? unassigned.map(e=>`<div class="unemp">${e.name}<span style="color:var(--muted);font-size:10px;float:right">${getEmpWage(e.name)?'$'+getEmpWage(e.name).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):''}</span></div>`).join('')
        : '<div style="font-size:11px;color:#2a7a47;padding:4px">&#x2713; All employees assigned</div>'}
    </div>
    <div>
      <div style="display:grid;grid-template-columns:28px 130px 1fr 65px 65px 65px 75px;gap:8px;padding:3px 8px;margin-bottom:4px">
        <div class="col-hdr">#</div>
        <div class="col-hdr">Position</div>
        <div class="col-hdr">Employee</div>
        <div class="col-hdr">$/hr</div>
        <div class="col-hdr">$/m</div>
        <div class="col-hdr">Max $/hr</div>
        <div class="col-hdr">Variance</div>
      </div>
      ${posRows}
    </div>
  </div>`;
}

function econAssign(posIdx, name) {
  state.economics[posIdx].name = name;
  render();
}

function econUnassign(posIdx) {
  state.economics[posIdx].name = '';
  render();
}

async function saveEconomics() {
  try {
    for(const p of state.economics){
      if(p.id){
        await fetch('/api/data?table=economics&id='+p.id,{
          method:'PATCH', headers:{'Content-Type':'application/json'},
          body:JSON.stringify({name:p.name||''})
        });
      }
    }
    toast('Staffing plan saved', 'success');
  } catch(e) { toast('Save failed: '+e.message, 'error'); }
}
