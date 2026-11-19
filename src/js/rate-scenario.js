// rate-scenario — Manufacturing Costs → Rate Scenario.
//
// Shares one global scope with the other files in src/js (see core.js).
//
// A WHAT-IF, NOT AN EDITOR. Type a different hourly rate for anybody on the
// hourly Manufacturing roster and see what Manufacturing's fully burdened cost
// per MBF would be. Nothing here is saved:
//
//   * the scenario rates live in state.rs.overrides, in memory, and nowhere
//     else — not localStorage, not the database, not the URL of any page. A
//     reload or Reset is a clean slate.
//   * the only request this file makes is GET /api/rate-scenario, which reads
//     and writes nothing (see netlify/functions/rate-scenario.js).
//   * no other view reads state.rs, so no other report or export can see it.
//
// NOTHING HERE COMPUTES A COST. Both the current and the scenario figures come
// back from the server, from the same cost-lib.buildCostReport the Department &
// Group view uses. The only arithmetic in this file is the rate-change column —
// scenario rate minus current rate — which is a difference of two typed numbers,
// not a costing rule.

// Changes bigger than this get a warning. They are allowed — a scenario is
// allowed to be bold — but a 250% raise is more often a typo than a plan.
const RS_WARN_PCT = 0.25;
const RS_DEBOUNCE_MS = 200;

function rsState(){
  if(!state.rs){
    state.rs={loaded:false, loading:false, error:'', data:null,
      week:'', from:'', to:'',
      overrides:{},   // employee number -> scenario rate (number). Valid edits only.
      drafts:{},      // employee number -> what is in the box, as typed
      onlyChanged:false, collapsed:{}, seq:0, timer:null};
  }
  return state.rs;
}

function rsRangeActive(){
  const s=rsState();
  return !!(String(s.from||'').trim()&&String(s.to||'').trim());
}

// The request, built from the reader's assumptions and the scenario. Exposed
// on its own so a test can see exactly what goes over the wire.
function rsQuery(){
  const s=rsState();
  const qs=new URLSearchParams({
    burden:String(costBurden()),
    mbfPerHour:String(costMbf()),
    overrides:JSON.stringify(s.overrides)
  });
  if(rsRangeActive()){ qs.set('from',String(s.from).trim()); qs.set('to',String(s.to).trim()); }
  else if(s.week) qs.set('week',s.week);
  return qs.toString();
}

async function rsLoad(){
  const s=rsState();
  const seq=++s.seq;
  s.loading=true; s.error='';
  rsRender();
  try{
    const res=await fetch('/api/rate-scenario?'+rsQuery());
    if(res.status===401){location.href='/';return;}
    let json=null;
    try{json=await res.json();}catch(e){json=null;}
    if(seq!==s.seq) return;   // a newer edit already asked again
    if(!res.ok||!json||json.ok===false) throw new Error((json&&json.error)||('Request failed ('+res.status+')'));
    s.data=json;
    s.week=(json.week&&!(json.period&&json.period.isRange)&&json.week.start)||s.week;
  }catch(err){
    if(seq!==s.seq) return;
    s.error=err.message;
  }
  s.loaded=true; s.loading=false;
  rsRender();
}

function rsLoadOnce(){
  const s=rsState();
  if(!s.loaded&&!s.loading) rsLoad();
}

// Debounced, so typing 24.75 asks once rather than five times.
function rsSchedule(){
  const s=rsState();
  if(s.timer) clearTimeout(s.timer);
  s.timer=setTimeout(()=>{s.timer=null; rsLoad();}, RS_DEBOUNCE_MS);
}

// Render without stealing the cursor from the rate box being typed in.
function rsRender(){
  const a=(typeof document!=='undefined'&&document.activeElement)||null;
  const id=a&&a.id&&String(a.id).indexOf('rs-in-')===0?a.id:null;
  let pos=null;
  try{pos=id?a.selectionStart:null;}catch(e){pos=null;}
  render();
  if(!id) return;
  const el=document.getElementById(id);
  if(!el||typeof el.focus!=='function') return;
  el.focus();
  try{ if(pos!=null) el.setSelectionRange(pos,pos); }catch(e){ void e; }
}

function rsPerson(empNum){
  const d=rsState().data;
  const people=(d&&d.scenario&&d.scenario.people)||[];
  return people.find(p=>p.employeeNumber===String(empNum))||null;
}

// What the box holds, parsed: {value} for a usable rate, {error} otherwise,
// {empty:true} for a cleared box (which means "back to current").
function rsParseRate(raw){
  const t=String(raw==null?'':raw).replace(/[$,\s]/g,'');
  if(t==='') return {empty:true};
  const n=Number(t);
  if(!isFinite(n)) return {error:'Not a number'};
  if(n<=0) return {error:'Must be a positive number'};
  if(n>1000) return {error:'Too high for an hourly rate'};
  return {value:Math.round(n*100)/100};
}

// One keystroke in one rate box.
function rsSetRate(empNum, raw){
  const s=rsState();
  const key=String(empNum);
  s.drafts[key]=String(raw);
  const p=rsPerson(key);
  const parsed=rsParseRate(raw);
  const before=JSON.stringify(s.overrides);
  if(parsed.empty || (parsed.value!=null && p && p.currentRate!=null && Math.abs(parsed.value-p.currentRate)<0.005)){
    // Cleared, or typed back to what it is: not an edit.
    delete s.overrides[key];
  }else if(parsed.value!=null){
    s.overrides[key]=parsed.value;
  }
  // An invalid box leaves the last valid scenario rate in force and says so on
  // the row. It never sends a bad number.
  rsRender();
  if(JSON.stringify(s.overrides)!==before) rsSchedule();
}

function rsReset(){
  const s=rsState();
  s.overrides={}; s.drafts={};
  if(s.timer){clearTimeout(s.timer); s.timer=null;}
  rsLoad();
}

function rsToggleOnlyChanged(){ const s=rsState(); s.onlyChanged=!s.onlyChanged; rsRender(); }
function rsToggleDept(dept){ const s=rsState(); s.collapsed[dept]=!s.collapsed[dept]; rsRender(); }

function rsSetWeek(week){ const s=rsState(); s.from=''; s.to=''; s.week=week; rsLoad(); }
function rsSetRangePart(which, value){ const s=rsState(); if(which==='from') s.from=value; else s.to=value; }
function rsApplyRange(){
  if(!rsRangeActive()){ toast('Enter both a from and a to date — one on its own is not a period','error'); return; }
  rsLoad();
}
function rsClearRange(){ const s=rsState(); s.from=''; s.to=''; rsLoad(); }
function rsSetBurden(pct){ const v=Number(pct); state.burden=isFinite(v)&&v>=0?v/100:0; rsLoad(); }
function rsSetMbf(v){ const n=Number(v); state.mhr=isFinite(n)&&n>=0?n:0; rsLoad(); }

// ---- formatting ----

function rsMoney(v){ return v==null?'—':fmt$(v); }
function rsSigned$(v){
  if(v==null) return '—';
  if(Math.abs(v)<0.005) return fmt$(0);
  return (v>0?'+':'−')+fmt$(Math.abs(v));
}
// Per-person $/MBF moves are fractions of a cent per MBF, so the impact column
// carries three decimals rather than rounding every row to $0.00.
function rsSignedMbf(v){
  if(v==null) return '—';
  if(Math.abs(v)<0.0005) return '$0.000';
  return (v>0?'+':'−')+'$'+Math.abs(v).toFixed(3);
}
function rsSignedPct(v){
  if(v==null) return '—';
  if(Math.abs(v)<0.00005) return '0.0%';
  return (v>0?'+':'−')+(Math.abs(v)*100).toFixed(1)+'%';
}
// Up is bad, down is good: this is a cost.
function rsDirClass(v){ return v==null||Math.abs(v)<0.0005?'rs-even':(v>0?'rs-up':'rs-down'); }

// The rate-change cells, from what is IN THE BOX — so they move as the reader
// types, before the server answers.
function rsRowEdit(p){
  const s=rsState();
  const key=p.employeeNumber;
  const hasDraft=Object.prototype.hasOwnProperty.call(s.drafts,key);
  const draft=hasDraft?s.drafts[key]:(p.currentRate==null?'':Number(p.currentRate).toFixed(2));
  const parsed=hasDraft?rsParseRate(draft):{value:p.currentRate};
  const override=Object.prototype.hasOwnProperty.call(s.overrides,key)?s.overrides[key]:null;
  const rate=override!=null?override:p.currentRate;
  const delta=(override!=null&&p.currentRate!=null)?Math.round((override-p.currentRate)*100)/100:0;
  const pct=(override!=null&&p.currentRate)?(override-p.currentRate)/p.currentRate:0;
  return {draft, error:parsed.error||null, edited:override!=null, rate, delta, pct,
          big:override!=null&&Math.abs(pct)>RS_WARN_PCT};
}

const rsStyle=`<style>
  .rs-head{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;margin-bottom:12px}
  .rs-ctrls{margin-left:auto;display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
  .rs-only{font-size:11px;font-weight:700;color:var(--brick);background:#fce8e8;border-radius:10px;padding:3px 10px;white-space:nowrap}
  .rs-summary{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:6px}
  .rs-big{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px}
  .rs-big .stat-value{font-size:30px}
  .rs-up{color:#c0392b}
  .rs-down{color:#2a7a47}
  .rs-even{color:var(--muted)}
  .rs-line{font-size:12px;color:var(--text);margin:6px 0 14px;padding:8px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:6px}
  .rs-row{display:grid;grid-template-columns:minmax(150px,1.6fr) 96px 92px 72px 92px 104px 92px 92px 80px;gap:8px;align-items:center;padding:6px 10px;font-size:12px;border-bottom:1px solid var(--border)}
  .rs-row.rs-hdr{font-size:10px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.3px}
  .rs-row.rs-changed{background:#fff7e6}
  .rs-dept{display:grid;grid-template-columns:minmax(150px,1.6fr) 96px 92px 72px 92px 104px 92px 92px 80px;gap:8px;align-items:center;padding:7px 10px;font-size:12px;font-weight:800;background:var(--surface2);border-bottom:1px solid var(--border);cursor:pointer;user-select:none}
  .rs-num{text-align:right;font-variant-numeric:tabular-nums}
  .rs-sub{font-size:10.5px;color:var(--muted);font-weight:400}
  .rs-mark{display:inline-block;font-size:9px;font-weight:800;color:#fff;background:var(--orange);border-radius:8px;padding:0 6px;margin-left:6px;vertical-align:middle}
  .rs-in{width:100%;font-family:var(--font);font-size:12px;text-align:right;font-variant-numeric:tabular-nums;border:1px solid var(--border);border-radius:4px;padding:3px 6px;background:#fff}
  .rs-in.rs-bad{border-color:#c0392b;background:#fff6f5}
  .rs-in.rs-warn{border-color:#e67e22}
  .rs-msg{font-size:10px;font-weight:700}
  .rs-msg.rs-bad{color:#c0392b}
  .rs-msg.rs-warn{color:#e67e22}
  @media (max-width:900px){.rs-summary{grid-template-columns:1fr}}
</style>`;

function rsControls(){
  const s=rsState();
  const d=s.data||{};
  const weeks=d.availableWeeks||[];
  const active=rsRangeActive();
  return `<div class="cost-bar">
    <label class="cost-bar-label">Period</label>
    <select onchange="rsSetWeek(this.value)">
      ${weeks.length
        ? weeks.map(w=>`<option value="${w.weekStart}" ${!active&&w.weekStart===s.week?'selected':''}>${fmtDate(w.weekStart)} – ${fmtDate(w.weekEnd)} · ${fmtHrs(w.totalHours)} hrs</option>`).join('')
        : '<option value="">No week has data yet</option>'}
    </select>
    ${rangeControl({from:s.from, to:s.to, active, set:'rsSetRangePart', apply:'rsApplyRange()', clear:'rsClearRange()'})}
    <div class="cost-ctrl"><label>Burden</label><input type="number" value="${(costBurden()*100).toFixed(0)}" min="0" max="500" step="1" onchange="rsSetBurden(this.value)"> %</div>
    <div class="cost-ctrl"><label>MBF/hr</label><input type="number" value="${costMbf()}" min="0" step="0.5" onchange="rsSetMbf(this.value)"></div>
    <div class="rs-ctrls">
      <span class="rs-only">Scenario only — actual rates are not changed.</span>
      <button class="btn btn-outline btn-sm" onclick="rsReset()" ${Object.keys(s.overrides).length||Object.keys(s.drafts).length?'':'disabled'}>Reset</button>
    </div>
  </div>`;
}

function rsSummary(sc){
  const cur=sc.current, scen=sc.scenario, ch=sc.change;
  const noVolume=sc.volumeMbf==null;
  const na='<span title="No production volume for this period — MBF/hr × hours is zero">unavailable</span>';
  const dirCls=rsDirClass(ch.costPerThousand);
  return `<div class="rs-summary">
    <div class="rs-big"><div class="stat-label">Current fully burdened $/MBF</div>
      <div class="stat-value">${noVolume?na:rsMoney(cur.costPerThousand)}</div>
      <div class="stat-sub">rates on file</div></div>
    <div class="rs-big"><div class="stat-label">Scenario fully burdened $/MBF</div>
      <div class="stat-value">${noVolume?na:rsMoney(scen.costPerThousand)}</div>
      <div class="stat-sub">${sc.changedCount} ${sc.changedCount===1?'rate':'rates'} changed</div></div>
    <div class="rs-big"><div class="stat-label">Change</div>
      <div class="stat-value ${dirCls}">${noVolume?na:rsSigned$(ch.costPerThousand)+'<span style="font-size:13px">/MBF</span>'}</div>
      <div class="stat-sub ${dirCls}">${noVolume?'':rsSignedPct(ch.costPerThousandPct)}</div></div>
  </div>
  <div class="rs-line">Fully burdened labor for the period: <strong>${rsMoney(cur.burdenedCost)}</strong> current
    vs <strong>${rsMoney(scen.burdenedCost)}</strong> scenario
    (<span class="${rsDirClass(ch.burdenedCost)}">${rsSigned$(ch.burdenedCost)}</span>) ·
    annualized impact <strong class="${rsDirClass(ch.annualized)}">${rsSigned$(ch.annualized)}</strong>
    <span class="rs-sub">(× ${ch.annualFactor==null?'—':round1(ch.annualFactor)}, a 2,080-hour year over ${fmtHrs(sc.standardHours)} standard hours)</span>
    <div class="rs-sub" style="margin-top:3px">All of Manufacturing, salaried included, at ${(sc.burden*100).toFixed(0)}% burden and
      ${sc.mbfPerHour} MBF per labour hour${sc.volumeMbf==null?'':' = '+fmtHrs(sc.volumeMbf)+' MBF'}; overtime at 1.5× for hours 10–12 and 2.0× above 12.
      The same calculation as Department &amp; Group.</div>
  </div>`;
}

function rsPersonRow(p){
  const e=rsRowEdit(p);
  const cls='rs-row'+(e.edited?' rs-changed':'');
  const inCls='rs-in'+(e.error?' rs-bad':(e.big?' rs-warn':''));
  return `<div class="${cls}">
    <div><strong>${esc(p.name)}</strong>${e.edited?'<span class="rs-mark" title="Scenario rate differs from the rate on file">edited</span>':''}
      <div class="rs-sub">#${esc(p.employeeNumber)}</div></div>
    <div>${esc(p.department)}</div>
    <div class="rs-num">${fmtHrs(p.hours)}<div class="rs-sub">${fmtHrs(p.regularHours)} reg · ${fmtHrs(p.otHours)} OT</div></div>
    <div class="rs-num">${rsMoney(p.currentRate)}</div>
    <div><input type="text" inputmode="decimal" class="${inCls}" id="rs-in-${esc(p.employeeNumber)}"
        value="${esc(e.draft)}" aria-label="Scenario rate for ${esc(p.name)}"
        oninput="rsSetRate('${jsStr(p.employeeNumber)}',this.value)">
      ${e.error?`<div class="rs-msg rs-bad">${esc(e.error)} — not applied</div>`:(e.big?'<div class="rs-msg rs-warn">⚠ over 25% change</div>':'')}</div>
    <div class="rs-num ${rsDirClass(e.delta)}">${e.edited?rsSigned$(e.delta):'—'}<div class="rs-sub">${e.edited?rsSignedPct(e.pct):''}</div></div>
    <div class="rs-num">${rsMoney(p.currentBurdened)}</div>
    <div class="rs-num">${rsMoney(p.scenarioBurdened)}</div>
    <div class="rs-num ${rsDirClass(p.perMbfImpact)}">${rsSignedMbf(p.perMbfImpact)}</div>
  </div>`;
}

function rsTable(sc){
  const s=rsState();
  const hdr=`<div class="rs-row rs-hdr">
    <div>Name / #</div><div>Department</div><div class="rs-num">Hours</div>
    <div class="rs-num">Current</div><div class="rs-num">Scenario rate</div><div class="rs-num">Rate change</div>
    <div class="rs-num">Burdened now</div><div class="rs-num">Burdened scen.</div><div class="rs-num">$/MBF impact</div></div>`;
  const people=sc.people||[];
  const body=(sc.departments||[]).map(d=>{
    const rows=people.filter(p=>p.department===d.department)
      .filter(p=>!s.onlyChanged||rsRowEdit(p).edited);
    if(s.onlyChanged&&!rows.length) return '';
    const open=!s.collapsed[d.department];
    return `<div class="rs-dept" onclick="rsToggleDept('${jsStr(d.department)}')">
        <div>${open?'▾':'▸'} ${esc(d.department)} <span class="rs-sub">${d.headcount} ${d.headcount===1?'person':'people'}${d.changed?' · '+d.changed+' edited':''}</span></div>
        <div></div><div class="rs-num">${fmtHrs(d.hours)}</div><div></div><div></div><div></div>
        <div class="rs-num">${rsMoney(d.currentBurdened)}</div>
        <div class="rs-num">${rsMoney(d.scenarioBurdened)}</div>
        <div class="rs-num ${rsDirClass(d.perMbfImpact)}">${rsSignedMbf(d.perMbfImpact)}</div>
      </div>${open?rows.map(rsPersonRow).join(''):''}`;
  }).join('');
  return `<div style="display:flex;align-items:center;gap:10px;margin:14px 0 6px">
      <div class="cost-section-title" style="margin:0">Hourly Manufacturing roster</div>
      <label style="font-size:12px;margin-left:auto;cursor:pointer"><input type="checkbox" ${s.onlyChanged?'checked':''}
        onchange="rsToggleOnlyChanged()"> Show only changed</label>
    </div>
    <div class="cost-panel">${hdr}${body||'<div class="cost-gap" style="color:var(--muted)">'+(s.onlyChanged?'No rates changed yet.':'Nobody on the hourly Manufacturing roster.')+'</div>'}</div>`;
}

function renderRateScenario(){
  const s=rsState();
  const d=s.data;
  let main;
  if(!d){
    main=s.error
      ? `<div class="loading-state">${esc(s.error)}<div style="margin-top:14px"><button class="btn btn-primary btn-sm" onclick="rsLoad()">Try again</button></div></div>`
      : '<div class="loading-state">Loading the rate scenario…</div>';
  }else{
    const sc=d.scenario;
    main=(s.error?`<div class="cost-note cost-bad"><strong>Could not recalculate:</strong> ${esc(s.error)}. The figures below are from the last good answer.</div>`:'')
      +`<div class="rs-sub" style="margin:-4px 0 8px">${esc(periodLabel(d.period, d.week&&d.week.start, d.week&&d.week.end))}${s.loading?' · recalculating…':''}</div>`
      +rsSummary(sc)
      +((sc.rateGaps||[]).length?`<div class="cost-note cost-bad">${sc.rateGaps.length} ${sc.rateGaps.length===1?'person has':'people have'} no rate on file, so their cost is in neither figure. A scenario rate for an hourly person prices them in the scenario only.</div>`:'')
      +rsTable(sc);
  }
  // costStyle (costs.js) carries the shared .cost-bar / .cost-note / .cost-panel
  // rules this view's controls and notes use.
  return costStyle+rsStyle+rsControls()+main;
}
