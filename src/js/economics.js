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

// Mirrors MAX_CEILING in netlify/functions/economics.js. A guard against an
// annual figure typed into an hourly field, not a policy about pay.
const ECON_MAX_CEILING = 1000;

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
    econForgetHistory(seatId);
    if(state.econHistoryOpen===String(seatId)) econLoadHistory(seatId);

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

// ------------------------------------------------------------------------
// THE POSITION RATE
// ------------------------------------------------------------------------
//
// `max_wage` is the seat's budgeted hourly ceiling, and the whole Variance
// column is measured against it. It was read-only here for a phase, on the
// argument that moving a ceiling is a budgeting decision — see the header of
// netlify/functions/economics.js for why that was reversed.
//
// SAVES ON BLUR, ONE SEAT AT A TIME, like the assignment dropdown beside it and
// for the same reason: it is a single fact with nothing to reconcile against
// anything else, so there is no Save button and no draft to lose. `onchange`
// rather than `oninput` — a rate that saved per keystroke would write 4, then
// 45, then 45.5 on the way to 45.50.
//
// The DRAFT is held per seat in state.econMaxDrafts so a re-render mid-edit
// cannot swallow what was typed, and is cleared once the server answers.

function econMaxDraft(p){
  const d=state.econMaxDrafts||{};
  if(Object.prototype.hasOwnProperty.call(d,String(p.id))) return d[String(p.id)];
  return p.max_wage==null?'':Number(p.max_wage).toFixed(2);
}

function econMaxSet(seatId,v){
  if(!state.econMaxDrafts) state.econMaxDrafts={};
  state.econMaxDrafts[String(seatId)]=v;
}

// Commits the typed ceiling. Refuses before the round trip what the server
// would refuse anyway, so the message arrives as a sentence rather than a
// status code — a mirror of the endpoint's rules, not a second set of them.
async function econSaveMax(seatId,raw){
  if(state.econBusy) return;
  const seat=(state.economics||[]).find(s=>String(s.id)===String(seatId));
  if(!seat) return;

  const current=seat.max_wage==null?null:Number(seat.max_wage);
  const text=String(raw==null?'':raw).replace(/[$,\s]/g,'');

  let next;
  if(text===''){
    next=null;                       // clearing is allowed: a seat with no ceiling is a real state
  }else{
    const n=Number(text);
    if(!isFinite(n)||n<0){
      toast(`"${String(raw).trim()}" is not a position rate — enter an hourly figure like 45.00`,'error');
      econMaxSet(seatId,current==null?'':current.toFixed(2)); render(); return;
    }
    if(n>ECON_MAX_CEILING){
      // The realistic accident: an annual figure in an hourly field.
      toast(`${n} is too high for an hourly position rate — nothing was changed`,'error');
      econMaxSet(seatId,current==null?'':current.toFixed(2)); render(); return;
    }
    next=Math.round(n*100)/100;
  }

  const same=(current==null&&next==null)||
             (current!=null&&next!=null&&Math.abs(current-next)<0.005);
  if(same){ econClearMaxDraft(seatId); render(); return; }

  state.econBusy=seatId; render();
  try{
    const res=await fetch('/api/economics',{
      method:'PATCH',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({id:seatId,maxWage:next==null?'':next})
    });
    if(res.status===401){location.href='/';return;}
    const d=await res.json().catch(()=>({}));
    if(!res.ok||d.ok===false) throw new Error(d.detail||d.error||('Request failed ('+res.status+')'));

    if(d.seat) Object.assign(seat,d.seat);
    econClearMaxDraft(seatId);
    // The change is now in economics_history. Drop the cached log so the next
    // open re-reads rather than showing a list one row out of date — and
    // re-read immediately if it is open on screen right now.
    econForgetHistory(seatId);
    if(state.econHistoryOpen===String(seatId)) econLoadHistory(seatId);

    if(d.unchanged){
      // Nothing to say — the server declined to write a value already there.
    }else{
      const was=d.previousMaxWage;
      const label=seat.seat||'Seat';
      if(next==null) toast(`${label} now has no position rate`,'success');
      else if(was==null) toast(`${label} position rate set to ${fmt$(next)}`,'success');
      else toast(`${label} position rate ${fmt$(was)} → ${fmt$(next)}`,'success');
    }
  }catch(err){
    // The field goes back to what the database still holds, so the screen never
    // shows a ceiling that was not saved.
    econMaxSet(seatId,current==null?'':current.toFixed(2));
    toast(err.message,'error');
  }
  state.econBusy=null; render();
}

function econClearMaxDraft(seatId){
  if(state.econMaxDrafts) delete state.econMaxDrafts[String(seatId)];
}

// ------------------------------------------------------------------------
// SEAT HISTORY
// ------------------------------------------------------------------------
//
// Both writes on this page are recorded in economics_history — the ceiling and
// the occupant — and this is where that record is read. Without a surface it
// would be a write-only table, which is only half of an audit trail: the reason
// SQL-only editing was a problem was that nobody could see what had happened.
//
// LOADED PER SEAT, ON DEMAND. 55 seats' history on every page load would be
// most of a table nobody has asked to see. One seat at a time, cached in
// state.econHistory until the page is reloaded, and re-read after a change to
// that seat so the new row appears without a refresh.

async function econToggleHistory(seatId){
  const key=String(seatId);
  if(!state.econHistory) state.econHistory={};
  if(state.econHistoryOpen===key){ state.econHistoryOpen=null; render(); return; }
  state.econHistoryOpen=key;
  render();
  if(state.econHistory[key]) return;          // already read this sitting
  await econLoadHistory(seatId);
}

async function econLoadHistory(seatId){
  const key=String(seatId);
  if(!state.econHistory) state.econHistory={};
  state.econHistory[key]={loading:true,rows:[],error:'',missing:false};
  render();
  try{
    const res=await fetch('/api/economics?history='+encodeURIComponent(seatId));
    if(res.status===401){location.href='/';return;}
    const d=await res.json().catch(()=>({}));
    if(!res.ok||d.ok===false) throw new Error(d.detail||d.error||('Request failed ('+res.status+')'));
    state.econHistory[key]={loading:false,rows:d.history||[],error:'',
                            missing:d.historyMissing===true,note:d.note||''};
  }catch(err){
    state.econHistory[key]={loading:false,rows:[],error:err.message,missing:false};
  }
  render();
}

// Dropped after a change so the next open re-reads rather than showing a list
// that is one row out of date.
function econForgetHistory(seatId){
  if(state.econHistory) delete state.econHistory[String(seatId)];
}

function econHistoryWhen(iso){
  const d=new Date(iso);
  if(isNaN(d)) return String(iso||'');
  return d.toLocaleString('en-US',{month:'short',day:'numeric',year:'numeric',
                                   hour:'numeric',minute:'2-digit'});
}

// A change, in one line. The two fields read differently on purpose: a ceiling
// moved between figures, an occupant moved between people, and 'none' means
// different things in each ('no ceiling' vs 'vacant').
function econHistoryLine(h){
  const none=h.field==='max_wage'?'no rate':'vacant';
  const from=h.previous==null?none:(h.field==='max_wage'?fmt$(Number(h.previous)):h.previous);
  const to=h.next==null?none:(h.field==='max_wage'?fmt$(Number(h.next)):h.next);
  const what=h.field==='max_wage'?'Position rate':'Assigned';
  // The opening rows the migration wrote are not somebody's edit and must not
  // be presented as one — see §4 of SCHEMA_ECONOMICS_HISTORY.sql.
  if(h.opening){
    return `<b>${what}</b> ${esc(to)} <span style="color:var(--muted)">— on file before changes were recorded</span>`;
  }
  return `<b>${what}</b> ${esc(from)} → ${esc(to)}`;
}

function renderSeatHistory(p){
  const key=String(p.id);
  if(state.econHistoryOpen!==key) return '';
  const h=(state.econHistory||{})[key];
  const wrap=(inner)=>`<div class="econ-hist">${inner}</div>`;
  if(!h||h.loading) return wrap('<span style="color:var(--muted)">Reading the record…</span>');
  if(h.error) return wrap(`<span style="color:var(--brick)">${esc(h.error)}</span>`);
  if(h.missing) return wrap(`<span style="color:#b8860b">No record yet — ${esc(h.note||'the history table has not been created.')}</span>`);
  if(!h.rows.length) return wrap('<span style="color:var(--muted)">Nothing recorded for this seat.</span>');
  return wrap(h.rows.map(r=>`
    <div class="econ-hist-row">
      <div>${econHistoryLine(r)}</div>
      <div style="color:var(--muted);white-space:nowrap">${
        r.opening?'':esc(r.changedBy)+' · '}${esc(econHistoryWhen(r.changedAt))}</div>
    </div>`).join(''));
}

function econSetBurden(v){ const n=Number(v); state.burden=isFinite(n)&&n>=0?n/100:0; render(); }
function econSetMhr(v){ const n=Number(v); state.mhr=isFinite(n)&&n>0?n:state.mhr; render(); }

function renderEconomics(){
  if(!canSeeSalaries()){
    return `<div style="max-width:720px;margin:40px auto;padding:20px;text-align:center">
      <div style="font-size:16px;font-weight:700;margin-bottom:8px">Staff</div>
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

  // One editable ceiling. Disabled while any seat is in flight, matching the
  // dropdowns: one write at a time is the whole concurrency model here.
  const maxField=(p)=>`<input type="text" class="econ-max" value="${esc(econMaxDraft(p))}"
      placeholder="none" inputmode="decimal"
      ${state.econBusy?'disabled':''}
      oninput="econMaxSet('${jsStr(p.id)}',this.value)"
      onchange="econSaveMax('${jsStr(p.id)}',this.value)">`;

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
      <div class="econ-fig">${maxField(p)}</div>
      <div class="econ-fig ${cls}">${esc(varStr)}</div>
      <div class="econ-hist-cell"><button class="econ-hist-btn" title="What has changed on this seat"
        onclick="econToggleHistory('${jsStr(p.id)}')">${state.econHistoryOpen===String(p.id)?'&times;':'&#8635;'}</button></div>
    </div>${renderSeatHistory(p)}`;
  };

  return `<style>
    .econ-row{display:grid;grid-template-columns:36px minmax(120px,1.2fr) minmax(150px,2fr) 92px 76px 92px 92px 24px;gap:8px;align-items:center;padding:7px 10px;background:var(--surface);border:1px solid var(--border);border-radius:6px;font-size:12px;margin-top:3px}
    .econ-head{font-size:10px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.4px;background:none;border:none;padding-bottom:0}
    .econ-sec{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.8px;color:#fff;background:var(--rust);padding:5px 12px;border-radius:6px;margin-top:14px}
    .econ-num{color:var(--muted);font-size:10px;font-weight:700}
    .econ-seat{font-weight:600}
    .econ-name{overflow:hidden;display:flex;align-items:center;gap:6px}
    /* Right-aligned and tabular, so a column of ceilings still reads as a
       column of figures rather than as a row of form controls. */
    .econ-max{width:100%;font-family:var(--font);font-size:12px;text-align:right;
      font-variant-numeric:tabular-nums;border:1px solid transparent;border-radius:4px;
      padding:3px 5px;background:transparent;color:var(--text)}
    .econ-max:hover:not(:disabled){border-color:var(--border);background:var(--surface2)}
    .econ-max:focus{border-color:var(--rust);background:#fff;outline:none}
    .econ-max:disabled{color:var(--muted)}
    .econ-hist-cell{display:flex;justify-content:flex-end}
    .econ-hist-btn{font-family:var(--font);font-size:13px;line-height:1;color:var(--muted);
      background:none;border:none;cursor:pointer;padding:2px 4px;border-radius:4px}
    .econ-hist-btn:hover{color:var(--rust);background:var(--surface2)}
    /* Sits directly under its own row and is visibly attached to it: a change
       log floating between two rows belongs to neither. */
    .econ-hist{background:var(--surface2);border:1px solid var(--border);border-top:none;
      border-radius:0 0 6px 6px;margin:0 0 3px;padding:8px 12px;font-size:11.5px;line-height:1.6}
    .econ-hist-row{display:flex;justify-content:space-between;gap:16px;padding:2px 0}
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
    <h2 style="font-size:24px;font-weight:700;margin-bottom:6px;color:var(--text)">Staff</h2>
    <div style="font-size:12px;color:var(--muted);line-height:1.6;margin-bottom:6px;max-width:820px">
      The budgeted staffing plan: one row per <b>seat</b>, not per person. A seat can be vacant and
      still be a real row — that is the point of the plan. <b>Current Rate</b> is what the occupant
      is actually paid, set on their profile card under Employees. <b>Position Rate</b> is what the
      seat is budgeted at, and <b>Variance</b> is the current rate minus it — so a red figure is
      somebody paid above the rate their seat was budgeted at.
    </div>
    <div style="font-size:12px;color:var(--muted);line-height:1.6;margin-bottom:6px;max-width:820px">
      <b>Both the assignment and the position rate save immediately</b>, one seat at a time — there
      is no Save button because there is nothing to reconcile. A position rate saves when you leave
      the field, and clearing it leaves the seat with no ceiling. What is NOT editable here is the
      shape of the plan: a seat's number, section and title are set in the database, because adding
      or retitling a seat changes what the plan is rather than what it budgets.
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
      <div class="econ-fig">Current Rate</div><div class="econ-fig">$/M</div>
      <div class="econ-fig">Position Rate</div><div class="econ-fig">Variance</div>
      <div class="econ-hist-cell"></div>
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
