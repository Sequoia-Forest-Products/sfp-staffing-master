// economics — Staffing Economics: the budgeted staffing plan, seat by seat.
//
// Shares one global scope with the other files in src/js (see core.js).
//
// BACK FROM PHASE C, AND DIFFERENT IN TWO WAYS.
//
// It was deleted, not replaced. Manufacturing Costs answers the costing
// question in aggregate, but this page answers a different one — "is the person
// in this seat inside the rate ceiling budgeted for it" — and max_wage and the
// variance column had no replacement anywhere.
//
// What changed on the way back:
//
//   GATED. /api/data refuses `economics` to anyone without the salaries tier,
//   all-or-nothing rather than by column: every field here is part of the same
//   compensation view — the seat, who is in it, their rate, and the ceiling for
//   it. That is what made this page unpublishable when everybody had the same
//   access, and it is the only thing that changed about who may see it.
//
//   ASSIGNMENT IS PER-SEAT. The old dropdown saved with PUT — delete-and-replace
//   over the whole table, and the only record of a per-seat ceiling. The
//   dropdown is back, but it now PATCHes one row and sets one column through
//   /api/economics, which is the only write to this table that exists anywhere.
//   Nothing on this page can touch a seat the user did not change.
//
//   THE REST OF THE PLAN IS NOT EDITABLE HERE. Seat number, section, title and
//   the rate ceiling are the plan itself; moving a ceiling is a budgeting
//   decision, not staffing, and the server refuses those columns rather than
//   filtering them out. This screen answers "who is sitting here".

function econRows(){ return state.economics || []; }

// The hourly rate behind a seat's occupant, looked up BY ID. A salaried person
// has no hourly rate at all — employees.wage is NULL for them since Phase D
// retired the sentinel — so they contribute nothing here rather than a rate of
// zero. The plan is a plan for hourly seats.
//
// By id and not by name, which is the point of the whole change: a rename moves
// the name and leaves the id alone, so nothing here has to notice.
function econWageFor(employeeId){
  if(!employeeId) return null;
  const emp=(state.employees||[]).find(e=>String(e.id)===String(employeeId));
  if(!emp||isSalaried(emp)) return null;
  const n=parseFloat(String(emp.wage==null?'':emp.wage).replace(/[$,]/g,''));
  return isFinite(n)?n:null;
}

function econDollarPerM(wage){
  const mhr=Number(state.mhr);
  if(!isFinite(mhr)||mhr<=0||wage==null) return null;
  return wage*(1+(Number(state.burden)||0))/mhr;
}

async function loadEconomics(){
  if(state.econLoading) return;
  state.econLoading=true; state.econError=''; render();
  try{
    const res=await fetch('/api/economics');
    if(res.status===401){location.href='/';return;}
    const d=await res.json().catch(()=>({}));
    if(!res.ok||d.ok===false){
      // 403 is the ordinary answer for most of the roster, not a fault. Said in
      // words rather than as a status code.
      throw new Error(res.status===403
        ? (d.detail||'This page needs the salaries tier.')
        : (d.error||('Request failed ('+res.status+')')));
    }
    state.economics=d.seats||[];
    // Whether the server can accept an assignment at all. False before
    // SCHEMA_ECONOMICS_EMPLOYEE_ID.sql has run: the page still READS, and says
    // why the dropdowns are inert rather than letting somebody discover it by
    // clicking one.
    state.econAssignable=d.assignable!==false;
    state.econNote=d.note||'';
    state.econError='';
  }catch(err){
    state.economics=[];
    state.econError=err.message;
  }
  state.econLoaded=true; state.econLoading=false; render();
}

// ONE SEAT, ONE COLUMN, ONE REQUEST. There is deliberately no Save button and no
// draft: an assignment is a single fact with nothing to reconcile against
// anything else, so batching it would only create a window where the screen and
// the database disagree.
//
// The row is replaced from what the SERVER returned, not from what was picked.
// It canonicalises the name against the roster, and showing the picked value
// instead would hide a mismatch rather than surface it.
async function econAssign(seatId, employeeId){
  if(state.econBusy||!state.econAssignable) return;
  const seat=(state.economics||[]).find(s=>String(s.id)===String(seatId));
  const before=seat?{...seat}:null;
  state.econBusy=seatId; render();
  try{
    const res=await fetch('/api/economics',{
      method:'PATCH',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({id:seatId,employeeId:employeeId||''})
    });
    if(res.status===401){location.href='/';return;}
    const d=await res.json().catch(()=>({}));
    if(!res.ok||d.ok===false) throw new Error(d.detail||d.error||('Request failed ('+res.status+')'));

    if(seat&&d.seat) Object.assign(seat,d.seat);

    if(d.unchanged){
      // Nothing to say. The server declined to write a value that was already
      // there, so reporting a save would be reporting something that did not
      // happen.
    }else if(d.alsoIn&&d.alsoIn.length){
      // Allowed and reported in the same breath. Somebody in two seats is always
      // a plan error, but refusing it would make a straight swap impossible
      // without unassigning first.
      toast(d.seat.name+' is now in '+(d.alsoIn.length+1)+' seats — also '+d.alsoIn.join(', '),'error');
    }else if(!d.seat.name){
      toast((seat?seat.seat:'Seat')+' is now vacant','success');
    }else{
      toast(d.seat.name+' assigned to '+d.seat.seat,'success');
    }
  }catch(err){
    // Put the WHOLE row back to what the database still holds, so the screen
    // never shows an assignment that did not happen. The name and the id have
    // to move together — restoring one and not the other is how a row comes to
    // show a person it does not point at.
    if(seat&&before) Object.assign(seat,before);
    toast(err.message,'error');
  }
  state.econBusy=null; render();
}

function econSetBurden(v){ const n=Number(v); state.burden=isFinite(n)&&n>=0?n/100:0; render(); }
function econSetMhr(v){ const n=Number(v); state.mhr=isFinite(n)&&n>0?n:state.mhr; render(); }

function renderEconomics(){
  if(!canSeeSalaries()){
    return `<div style="max-width:720px;margin:40px auto;padding:20px;text-align:center">
      <div style="font-size:16px;font-weight:700;margin-bottom:8px">Staffing Economics</div>
      <div style="font-size:13px;color:var(--muted);line-height:1.6">
        This page needs the salaries tier. An administrator can grant it under Settings → Access.
      </div></div>`;
  }
  if(state.econLoading&&!state.econLoaded) return '<div class="loading-state">Loading the staffing plan…</div>';
  if(state.econError){
    return `<div class="loading-state">${esc(state.econError)}
      <div style="margin-top:14px"><button class="btn btn-primary btn-sm" onclick="loadEconomics()">Try again</button></div>
    </div>`;
  }

  const rows=econRows();
  const eligible=(state.employees||[]).filter(e=>e.status==='Active'&&!isSalaried(e));

  // A person in two seats is a plan error, not a data error, and it is the thing
  // this page has always been best at catching. Counted by ID, which also
  // catches what a name count could not: the same person in two seats under two
  // spellings.
  const count={};
  rows.forEach(p=>{ if(p.employeeId) count[p.employeeId]=(count[p.employeeId]||0)+1; });
  const dupes=new Set(Object.keys(count).filter(k=>count[k]>1));

  const assigned=new Set(rows.map(p=>String(p.employeeId)).filter(x=>x!=='null'&&x!==''));
  const unassigned=eligible.filter(e=>!assigned.has(String(e.id)));

  // A seat whose occupant is not linked to anybody on the roster. Post-migration
  // that means the backfill could not match the recorded name — the rows section
  // 4b of SCHEMA_ECONOMICS_EMPLOYEE_ID.sql lists — and it is a decision for a
  // person, not a fault. It is also what a seat looks like before the migration
  // has run at all.
  const unknown=rows.filter(p=>p.unlinked);

  let totalWage=0, totalDpm=0, priced=0;
  for(const p of rows){
    const w=econWageFor(p.employeeId);
    if(w==null) continue;
    priced++; totalWage+=w;
    const d=econDollarPerM(w); if(d!=null) totalDpm+=d;
  }

  const overs=rows.filter(p=>{
    const w=econWageFor(p.employeeId);
    return w!=null&&p.max_wage!=null&&w>Number(p.max_wage);
  });

  const sections=[...new Set(rows.map(p=>p.section))];

  const seatRow=(p)=>{
    const wage=econWageFor(p.employeeId);
    const max=p.max_wage==null?null:Number(p.max_wage);
    const dpm=econDollarPerM(wage);
    const variance=(wage!=null&&max!=null)?Math.round((wage-max)*100)/100:null;
    const cls=variance==null?'var-even':(variance>0?'var-over':(variance<0?'var-under':'var-even'));
    // Signed, and the sign goes OUTSIDE the currency symbol: fmt$(-5) renders
    // '$-5.00', which reads as a typo. A variance is a direction before it is an
    // amount, so the direction goes first.
    const varStr=variance==null?'—'
      :(variance===0?fmt$(0)
      :(variance>0?'+'+fmt$(variance):'-'+fmt$(Math.abs(variance))));
    const isDupe=p.employeeId&&dupes.has(String(p.employeeId));
    // A seat whose occupant is LINKED but is not somebody the select offers —
    // Eduardo Rivera is salaried and sits in Production Lead, and the options
    // are active hourly people only.
    //
    // Without an option of their own the browser finds nothing selected and
    // falls back to the first one, so the seat renders as "— vacant —" when it
    // is not, and one stray change on that select clears somebody who is
    // actually in the job. The migration's own §2c is what surfaced this.
    //
    // Distinct from `unlinked`: this row HAS a key and resolves fine. It just
    // cannot be reassigned from here, and the option says so.
    const notOfferable=p.employeeId&&!eligible.some(e=>String(e.id)===String(p.employeeId));
    return `<div class="econ-row"${isDupe?' style="border-color:#e67e22;background:rgba(230,126,34,.06)"':''}>
      <div class="econ-num">${esc(String(p.num==null?'':p.num))}</div>
      <div class="econ-seat">${esc(p.seat||'')}</div>
      <div class="econ-name">
        <select class="econ-select${isDupe?' econ-select-dupe':''}"
          ${state.econBusy||!state.econAssignable?'disabled':''}
          onchange="econAssign('${jsStr(p.id)}',this.value)">
          <option value=""${p.employeeId||p.unlinked?'':' selected'}>— vacant —</option>
          ${p.unlinked?`<option value="" selected>${esc(p.name||'unknown')} — not linked to anybody on the roster</option>`:''}
          ${notOfferable?`<option value="${esc(String(p.employeeId))}" selected>${esc(p.name||'unknown')} — ${p.occupantSalaried?'salaried':'not active'}, cannot be reassigned here</option>`:''}
          ${eligible.map(e=>`<option value="${esc(String(e.id))}"${String(p.employeeId)===String(e.id)?' selected':''}>${esc(e.name)}</option>`).join('')}
        </select>${
        isDupe?'<span class="econ-flag">⚠ in two seats</span>':''}</div>
      <div class="econ-fig">${wage==null?'—':esc(fmt$(wage))}</div>
      <div class="econ-fig">${dpm==null?'—':esc(fmt$(dpm))}</div>
      <div class="econ-fig">${max==null?'—':esc(fmt$(max))}</div>
      <div class="econ-fig ${cls}">${esc(varStr)}</div>
    </div>`;
  };

  return `<style>
    .econ-row{display:grid;grid-template-columns:36px minmax(120px,1.2fr) minmax(150px,2fr) 80px 80px 80px 90px;gap:8px;align-items:center;padding:7px 10px;background:var(--surface);border:1px solid var(--border);border-radius:6px;font-size:12px;margin-top:3px}
    .econ-head{font-size:10px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.4px;background:none;border:none;padding-bottom:0}
    .econ-sec{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.8px;color:#fff;background:var(--rust);padding:5px 12px;border-radius:6px;margin-top:14px}
    .econ-num{color:var(--muted);font-size:10px;font-weight:700}
    .econ-seat{font-weight:600}
    .econ-name{overflow:hidden;display:flex;align-items:center;gap:6px}
    .econ-select{font-family:var(--font);font-size:12px;border:1px solid var(--border);border-radius:4px;padding:3px 6px;min-width:0;flex:1;background:var(--surface)}
    .econ-select-dupe{border-color:#e67e22}
    .econ-flag{color:#e67e22;font-size:10px;font-weight:700;margin-left:8px}
    .econ-fig{text-align:right}
    .var-over{color:#e74c3c;font-weight:700}
    .var-under{color:#2a7a47;font-weight:600}
    .var-even{color:var(--muted)}
    .econ-ctrls{display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin:14px 0;padding:10px 14px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;font-size:12px}
    .econ-ctrls input{width:70px;font-family:var(--font);font-size:12px;border:1px solid var(--border);border-radius:4px;padding:3px 7px}
  </style>

  <div style="max-width:1100px;margin:0 auto;padding:20px">
    <h2 style="font-size:24px;font-weight:700;margin-bottom:6px;color:var(--text)">Staffing Economics</h2>
    <div style="font-size:12px;color:var(--muted);line-height:1.6;margin-bottom:6px;max-width:820px">
      The budgeted staffing plan: one row per <b>seat</b>, not per person. A seat can be vacant and
      still be a real row — that is the point of the plan. <b>Max</b> is the rate ceiling budgeted
      for that seat and <b>Variance</b> is the occupant's rate minus it, so a red figure is somebody
      paid above the ceiling their seat was budgeted at.
    </div>
    <div style="font-size:12px;color:var(--muted);line-height:1.6;margin-bottom:6px;max-width:820px">
      <b>Assignment saves immediately</b>, one seat at a time — there is no Save button because
      there is nothing to reconcile. Everything else about a seat is the plan itself: its number,
      section, title and ceiling are set in the database, because moving a ceiling is a budgeting
      decision rather than a staffing one.
    </div>
    <div style="font-size:12px;color:var(--muted);line-height:1.6;margin-bottom:6px;max-width:820px">
      Seats are hourly. A salaried person contributes no rate here, because there is no hourly rate
      to contribute — not a rate of zero.
    </div>

    <div class="econ-ctrls">
      <span><b>Burden</b>
        <input type="number" min="0" max="100" step="1" value="${Math.round((Number(state.burden)||0)*100)}"
          onchange="econSetBurden(this.value)"> %</span>
      <span><b>M/hr</b>
        <input type="number" min="0.5" step="0.5" value="${esc(String(state.mhr))}"
          onchange="econSetMhr(this.value)"></span>
      <span style="color:var(--muted)">Display assumptions for the $/M column only. They are not stored.</span>
      <span style="margin-left:auto"><button class="btn btn-sm" style="background:none;border:1px solid var(--border);color:var(--muted)" onclick="loadEconomics()">Refresh</button></span>
    </div>

    <div class="stat-row">
      <div class="stat-card"><div class="stat-label">Seats</div><div class="stat-value">${rows.length}</div>
        <div class="stat-sub">${rows.filter(p=>!p.name).length} vacant</div></div>
      <div class="stat-card"><div class="stat-label">Wage pool</div><div class="stat-value">${esc(fmt$(totalWage))}<span style="font-size:13px">/hr</span></div>
        <div class="stat-sub">${priced} of ${rows.length} seats priced</div></div>
      <div class="stat-card"><div class="stat-label">Burdened</div><div class="stat-value">${esc(fmt$(totalDpm))}<span style="font-size:13px">/M</span></div></div>
      <div class="stat-card"><div class="stat-label">Over the ceiling</div>
        <div class="stat-value" style="color:${overs.length?'#e74c3c':'#2a7a47'}">${overs.length}</div>
        <div class="stat-sub">${overs.length?esc(overs.map(p=>p.name).join(', ')):'none'}</div></div>
    </div>

    ${dupes.size?`<div class="cost-note" style="border-color:#e67e22"><strong>⚠ ${dupes.size} ${dupes.size===1?'person is':'people are'} assigned to more than one seat:</strong>
      ${esc([...dupes].join(', '))}. The wage pool counts them once per seat, so it is overstated until the plan is corrected.</div>`:''}
    ${unknown.length?`<div class="cost-note" style="border-color:#e67e22"><strong>⚠ ${unknown.length} ${unknown.length===1?'seat names somebody':'seats name people'} not on the active hourly roster:</strong>
      ${esc(unknown.map(p=>`${p.seat} → ${p.name}`).join('; '))}. They have left, changed pay type, or are spelled differently here.</div>`:''}

    <div class="econ-row econ-head" style="margin-top:16px">
      <div>#</div><div>Seat</div><div>Assigned</div>
      <div class="econ-fig">Rate</div><div class="econ-fig">$/M</div>
      <div class="econ-fig">Max</div><div class="econ-fig">Variance</div>
    </div>
    ${rows.length
      ? sections.map(sec=>`<div class="econ-sec">${esc(sec||'—')}</div>`
          + rows.filter(p=>p.section===sec).map(seatRow).join('')).join('')
      : `<div style="font-size:13px;color:var(--muted);padding:16px;background:var(--surface2);border-radius:4px;text-align:center;margin-top:8px">The staffing plan has no seats in it.</div>`}

    <div style="margin-top:22px;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:18px">
      <div style="font-size:14px;font-weight:700;margin-bottom:4px">Not in any seat</div>
      <div style="font-size:12px;color:var(--muted);line-height:1.6;margin-bottom:12px">
        Active hourly employees the plan has no seat for. Not necessarily wrong — the plan can lag a
        hire — but each one is somebody whose cost is real and unbudgeted.
      </div>
      ${unassigned.length
        ? `<div style="display:flex;flex-wrap:wrap;gap:6px">${unassigned.map(e=>
            `<span style="background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:2px 10px;font-size:12px">${esc(e.name)} · ${esc(fmtWage(e))}</span>`
          ).join('')}</div>`
        : `<div style="font-size:13px;color:var(--muted)">Everybody active and hourly is in a seat.</div>`}
    </div>
  </div>`;
}
