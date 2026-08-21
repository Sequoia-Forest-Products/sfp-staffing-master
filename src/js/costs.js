// costs — the Manufacturing Costs tab and the Overhead tab.
//
// Shares one global scope with the other files in src/js (see core.js).
//
// Both tabs are the same report over /api/cost-report, asked about a different
// cost class. Manufacturing Costs asks about one; Overhead asks about two and
// stacks them.
//
// NOTHING HERE COMPUTES A COST. Every figure arrives already aggregated, because
// the browser cannot price a salaried person even in principle: annual_salary is
// deliberately absent from /api/data's projection and effectiveHourlyRate lives
// in wage-sync.js, which never reaches a browser. That is the whole reason the
// endpoint exists — see the note at the top of netlify/functions/cost-lib.js.
//
// This file replaced Staffing Economics, which rendered each position's holder
// alongside their hourly rate. There is still no permissions system, so anything
// on screen is readable by every signed-in sequoiafp.com account, and a page of
// per-person rates is exactly what this phase set out to stop rendering.

const COST_CLASS_MANUFACTURING = 'Manufacturing';
const COST_CLASS_MILL_OVERHEAD = 'Mill Overhead';
const COST_CLASS_SGA = 'SG&A';

// The Overhead tab's two sections, in the order they read.
const OVERHEAD_CLASSES = [COST_CLASS_MILL_OVERHEAD, COST_CLASS_SGA];

function emptyCostView(){
  return {report:null, weeks:[], week:'', loading:false, error:'',
          truncated:false, window:null, allocations:null, loaded:false};
}

// One view per cost class, keyed by the class itself so the tab cannot ask for
// one class and render another's numbers.
function costView(costClass){
  if(!state.cost) state.cost={};
  if(!state.cost[costClass]) state.cost[costClass]=emptyCostView();
  return state.cost[costClass];
}

// The two display parameters. They are not stored — they are the reader's
// assumptions for this sitting, and they go to the server because burden
// multiplies figures the browser never sees.
function costBurden(){const v=Number(state.burden);return isFinite(v)&&v>=0?v:0;}
function costMbf(){const v=Number(state.mhr);return isFinite(v)&&v>=0?v:0;}

async function loadCostReport(costClass, week){
  const view=costView(costClass);
  view.loading=true; view.error=''; render();
  try{
    const qs=new URLSearchParams({
      class:costClass,
      burden:String(costBurden()),
      mbfPerHour:String(costMbf())
    });
    if(week) qs.set('week',week);
    const res=await fetch('/api/cost-report?'+qs.toString());
    if(res.status===401){location.href='/';return;}
    let json=null;
    try{json=await res.json();}catch(e){json=null;}
    if(!res.ok||!json||json.ok===false) throw new Error((json&&json.error)||('Request failed ('+res.status+')'));
    view.report=json.report||null;
    view.weeks=json.availableWeeks||[];
    view.week=(json.week&&json.week.start)||week||'';
    view.weekEnd=(json.week&&json.week.end)||'';
    // The endpoint scans a bounded window and says so rather than returning a
    // short answer that looks whole; the page has to repeat that out loud.
    view.truncated=json.truncated===true;
    view.window=json.dataWindow||null;
    view.allocations=json.allocations||null;
  }catch(err){
    view.report=null; view.error=err.message;
    view.truncated=false; view.window=null;
    toast('Could not load '+costClass+' costs: '+err.message,'error');
  }
  view.loaded=true; view.loading=false; render();
}

// Called when a tab opens. Loads once; the Refresh button is how a reader asks
// again, the same way the OT report behaves.
function loadCostsOnce(classes){
  for(const c of classes){
    const v=costView(c);
    if(!v.loaded&&!v.loading) loadCostReport(c, v.week||'');
  }
}

function reloadAllCostViews(){
  for(const c of Object.keys(state.cost||{})){
    const v=state.cost[c];
    if(v.loaded||v.loading) loadCostReport(c, v.week||'');
  }
}

// ============================================================
// RENDER
// ============================================================

const costStyle=`<style>
  .cost-bar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:12px;padding:10px 14px;background:var(--surface2);border:1px solid var(--border);border-radius:8px}
  .cost-bar-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--muted)}
  .cost-bar select{font-family:var(--font);font-size:12px;border:1px solid var(--border);border-radius:4px;padding:4px 8px;background:white}
  .cost-ctrl{display:flex;align-items:center;gap:6px;font-size:12px}
  .cost-ctrl label{color:var(--muted);font-weight:600}
  .cost-ctrl input{width:70px;font-family:var(--font);font-size:12px;border:1px solid var(--border);border-radius:4px;padding:3px 7px}
  .cost-bar-note{font-size:11px;color:var(--muted);margin-left:auto;max-width:340px;text-align:right}
  .cost-note{font-size:11.5px;line-height:1.5;color:var(--text);background:var(--surface2);border:1px solid var(--border);border-left:3px solid var(--rust);border-radius:6px;padding:9px 12px;margin:10px 0}
  .cost-warn{border-left-color:#e67e22;background:#fffbf5}
  .cost-bad{border-left-color:#e74c3c;background:#fff6f5}
  .cost-panel{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:2px 0;margin-bottom:14px}
  .cost-row{display:grid;grid-template-columns:1fr 60px 78px 92px 92px 82px 82px;gap:8px;align-items:center;padding:6px 12px;font-size:11.5px;border-bottom:1px solid var(--border)}
  .cost-row:last-child{border-bottom:none}
  .cost-row.cost-hdr{font-size:10px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.3px;border-bottom:1px solid var(--border)}
  .cost-row.cost-tot{font-weight:800;background:var(--surface2)}
  .cost-row.cost-sup{color:var(--muted);background:#fcfcfc}
  .cost-key{font-weight:600}
  .cost-num{text-align:right;font-variant-numeric:tabular-nums}
  .cost-sup-tag{font-size:9.5px;font-weight:700;color:#e67e22;text-transform:uppercase;letter-spacing:.4px;margin-left:6px}
  .cost-gap{font-size:11px;padding:5px 12px;border-bottom:1px solid var(--border);color:var(--text)}
  .cost-gap:last-child{border-bottom:none}
  .cost-gap-why{color:var(--brick);font-size:10.5px}
  .cost-section-title{font-size:13px;font-weight:800;letter-spacing:.2px;margin:18px 0 6px}
</style>`;

// A class list as a JS array literal safe to sit inside an HTML attribute.
// The & matters: 'SG&A' inside onchange="..." must be written &amp; or the
// browser is left deciding whether &A starts an entity.
function costArgs(classes){
  return JSON.stringify(classes).replace(/&/g,'&amp;').replace(/"/g,'&quot;');
}

function costMoney(v){return v==null?'—':fmt$(v);}
function costNum(v){return v==null?'—':fmtHrs(v);}

function costWeekLabel(view){
  if(!view.week) return '—';
  return fmtDateShort(view.week)+' – '+fmtDate(view.weekEnd||view.week);
}

// The suppression banner. It is not an apology — a reader looking at department
// figures that do not sum to the total needs to be told why before they go
// looking for the missing money.
function costSuppressionNote(report){
  if(!report||!report.hasSuppressedBuckets) return '';
  const k=report.minBucketHeadcount;
  return `<div class="cost-note cost-warn"><strong>Some groupings show hours but no cost.</strong>
    A grouping with fewer than ${k} people has no meaningful average — its cost per hour would be an individual's pay rate,
    and every signed-in account can open this tab. Those rows keep their headcount and hours and withhold their money,
    so the visible rows deliberately do not add up to the total. The total itself is never suppressed.</div>`;
}

function costRateGapNote(report){
  const gaps=(report&&report.rateGaps)||[];
  if(!gaps.length) return '';
  return `<div class="cost-note cost-bad"><strong>${gaps.length} ${gaps.length===1?'person has':'people have'} no usable pay rate.</strong>
    Their hours are counted and their cost is not, so every cost figure below is understated by whatever they earn.
    They are listed rather than dropped, and they are not costed at zero — nobody works for free.</div>
    <div class="cost-panel">
      ${gaps.map(g=>`<div class="cost-gap"><strong>${esc(g.name)}</strong> · ${esc(g.department||'—')}
        <div class="cost-gap-why">${esc(g.reason)}</div></div>`).join('')}
    </div>`;
}

function costBullpenBlock(report){
  const pen=(report&&report.bullpen)||[];
  if(!pen.length) return '';
  return `<div class="cost-section-title">Bullpen — no position group (${pen.length})</div>
    <div class="cost-note">Everyone in this cost class needs somewhere to sit. New hires arrive unclassified
      through the payroll auto-create path, so this list is how they stay visible until somebody assigns them.</div>
    <div class="cost-panel">
      ${pen.map(p=>`<div class="cost-gap"><strong>${esc(p.name)}</strong>
        · ${esc(p.department||'—')}${p.position?' · '+esc(p.position):''}
        ${p.employeeNumber?`<span style="color:var(--muted)"> · #${esc(p.employeeNumber)}</span>`:''}</div>`).join('')}
    </div>`;
}

function costTruncationNote(view){
  if(!view.truncated) return '';
  const w=view.window||{};
  const bits=[];
  if(w.weekIndexTruncated) bits.push('the week list was cut short by the scan ceiling');
  if(w.weekDetailTruncated) bits.push(`this week returned ${w.weekRowsFetched} of ${w.weekRowsExpected} rows`);
  return `<div class="cost-note cost-bad"><strong>This may be incomplete.</strong>
    ${bits.length?esc(bits.join('; '))+'.':'The data window could not be read whole.'}
    Hours and cost below are at best a floor.</div>`;
}

function costAllocationNote(view){
  const a=view.allocations;
  if(!a||a.available) return '';
  return `<div class="cost-note">${esc(a.note||'')}</div>`;
}

// One grouping table: department or position group.
function costTable(title, buckets, report, opts){
  const showMbf=!!(opts&&opts.showMbf);
  const rows=(buckets||[]).map(b=>{
    const cls='cost-row'+(b.suppressed?' cost-sup':'');
    const gaps=(b.gaps||[]).length;
    return `<div class="${cls}" ${b.suppressed?`title="${esc(b.suppressedReason||'')}"`:''}>
      <div class="cost-key">${esc(b.key)}${b.suppressed?'<span class="cost-sup-tag">withheld</span>':''}
        ${gaps?`<span class="cost-sup-tag" style="color:var(--brick)">${gaps} no rate</span>`:''}</div>
      <div class="cost-num">${b.headcount}</div>
      <div class="cost-num">${costNum(b.hours)}</div>
      <div class="cost-num">${costMoney(b.cost)}</div>
      <div class="cost-num">${costMoney(b.burdenedCost)}</div>
      <div class="cost-num">${costMoney(b.burdenedCostPerHour)}</div>
      <div class="cost-num">${showMbf?costMoney(b.costPerThousand):'—'}</div>
    </div>`;
  }).join('');

  const t=(report&&report.totals)||{};
  return `<div class="cost-section-title">${esc(title)}</div>
    <div class="cost-panel">
      <div class="cost-row cost-hdr">
        <div>${esc((opts&&opts.keyLabel)||'Grouping')}</div>
        <div class="cost-num">People</div>
        <div class="cost-num">Hours</div>
        <div class="cost-num">Cost</div>
        <div class="cost-num">Burdened</div>
        <div class="cost-num">$/hr</div>
        <div class="cost-num">$/MBF</div>
      </div>
      ${rows||'<div class="cost-gap" style="color:var(--muted)">Nobody in this cost class.</div>'}
      <div class="cost-row cost-tot">
        <div>Total</div>
        <div class="cost-num">${report?report.headcount:0}</div>
        <div class="cost-num">${costNum(t.hours)}</div>
        <div class="cost-num">${costMoney(t.cost)}</div>
        <div class="cost-num">${costMoney(t.burdenedCost)}</div>
        <div class="cost-num">${costMoney(t.burdenedCostPerHour)}</div>
        <div class="cost-num">${showMbf?costMoney(t.costPerThousand):'—'}</div>
      </div>
    </div>`;
}

function costStatCards(report, opts){
  const showMbf=!!(opts&&opts.showMbf);
  const t=(report&&report.totals)||{};
  return `<div class="stat-row">
    <div class="stat-card"><div class="stat-label">People</div><div class="stat-value">${report?report.headcount:0}</div>
      <div class="stat-sub">${(report&&report.totals&&report.totals.peopleWithoutRate)||0} without a rate</div></div>
    <div class="stat-card"><div class="stat-label">Hours</div><div class="stat-value">${costNum(t.hours)}</div>
      <div class="stat-sub">salaried staff at a standard ${report?report.standardWeeklyHours:40}-hr week</div></div>
    <div class="stat-card"><div class="stat-label">Cost</div><div class="stat-value">${costMoney(t.cost)}</div>
      <div class="stat-sub">wages only, no burden</div></div>
    <div class="stat-card"><div class="stat-label">Burdened cost</div><div class="stat-value">${costMoney(t.burdenedCost)}</div>
      <div class="stat-sub">at ${(costBurden()*100).toFixed(0)}% burden</div></div>
    <div class="stat-card"><div class="stat-label">Burdened $/hr</div><div class="stat-value">${costMoney(t.burdenedCostPerHour)}</div></div>
    ${showMbf?`<div class="stat-card"><div class="stat-label">Burdened $/MBF</div><div class="stat-value">${costMoney(t.costPerThousand)}</div>
      <div class="stat-sub">at ${costMbf()} MBF per labour hour</div></div>`:''}
  </div>`;
}

// The controls, shared by both tabs. `classes` is who gets reloaded when a
// parameter changes: on the Overhead tab both sections move together, because
// two sections of the same page disagreeing about burden would be a bug nobody
// could see.
function costControls(view, classes, opts){
  const weeks=view.weeks||[];
  const cls=costArgs(classes);
  return `<div class="cost-bar">
    <label class="cost-bar-label">Work week (Mon–Sun)</label>
    <select onchange="costSetWeek(${cls},this.value)">
      ${weeks.length
        ? weeks.map(w=>`<option value="${w.weekStart}" ${w.weekStart===view.week?'selected':''}>${fmtDate(w.weekStart)} – ${fmtDate(w.weekEnd)} · ${w.days} days · ${fmtHrs(w.totalHours)} hrs</option>`).join('')
        : '<option value="">No week has data yet</option>'}
    </select>
    <div class="cost-ctrl"><label>Burden</label><input type="number" value="${(costBurden()*100).toFixed(0)}" min="0" max="500" step="1" onchange="costSetBurden(${cls},this.value)"> %</div>
    ${opts&&opts.showMbf?`<div class="cost-ctrl"><label>MBF/hr</label><input type="number" value="${costMbf()}" min="0" step="0.5" onchange="costSetMbf(${cls},this.value)"></div>`:''}
    <button class="btn btn-outline btn-sm" onclick="costRefresh(${cls})">Refresh</button>
    <div class="cost-bar-note">Aggregates only. Individual pay rates are never sent to the browser.</div>
  </div>`;
}

function costSetWeek(classes, week){
  for(const c of classes) loadCostReport(c, week);
}
function costSetBurden(classes, pct){
  const v=Number(pct);
  state.burden=isFinite(v)&&v>=0?v/100:0;
  for(const c of classes) loadCostReport(c, costView(c).week||'');
}
function costSetMbf(classes, v){
  const n=Number(v);
  state.mhr=isFinite(n)&&n>=0?n:0;
  for(const c of classes) loadCostReport(c, costView(c).week||'');
}
function costRefresh(classes){
  for(const c of classes) loadCostReport(c, costView(c).week||'');
}

// One cost class, rendered whole. Used once by Manufacturing Costs and twice by
// Overhead.
function costSection(costClass, classes, opts){
  const view=costView(costClass);
  if(view.loading&&!view.report) return `<div class="loading-state">Loading ${esc(costClass)} costs…</div>`;
  if(!view.report) return `<div class="loading-state">
      ${view.error?esc(view.error):'Nothing to show for '+esc(costClass)+' yet.'}
      <div style="margin-top:14px"><button class="btn btn-primary btn-sm" onclick="costRefresh(${costArgs(classes)})">Try again</button></div>
    </div>`;

  const r=view.report;
  return costTruncationNote(view)
    + costAllocationNote(view)
    + costStatCards(r, opts)
    + costSuppressionNote(r)
    + costRateGapNote(r)
    + costTable('By department', r.byDepartment, r, {...opts, keyLabel:'Department'})
    + costTable('By position group', r.byPositionGroup, r, {...opts, keyLabel:'Position group'})
    + costBullpenBlock(r);
}

// ---- Manufacturing Costs (was Staffing Economics) ----
function renderCosts(){
  const classes=[COST_CLASS_MANUFACTURING];
  const view=costView(COST_CLASS_MANUFACTURING);
  return costStyle
    + costControls(view, classes, {showMbf:true})
    + `<div class="cost-note"><strong>Everyone whose cost class is Manufacturing, whatever their pay type.</strong>
        Membership is the cost class alone — not pay type, not department. A salaried production supervisor belongs here;
        an hourly accounting clerk does not. Hourly people are costed on the hours the payroll file reports;
        salaried people on a standard ${view.report?view.report.standardWeeklyHours:40}-hour week, because the file reports them as zeros.</div>`
    + costSection(COST_CLASS_MANUFACTURING, classes, {showMbf:true});
}

// ---- Overhead: Mill Overhead and SG&A ----
function renderOverhead(){
  const classes=OVERHEAD_CLASSES.slice();
  const view=costView(COST_CLASS_MILL_OVERHEAD);
  return costStyle
    + costControls(view, classes, {showMbf:false})
    + `<div class="cost-note"><strong>Two cost classes, side by side.</strong>
        Mill Overhead is the salaried staff whose cost belongs to the mill but not to a board foot;
        SG&A is everything corporate, broken out by department. Neither carries a cost per MBF —
        they are not production cost, which is the point of separating them.</div>`
    + OVERHEAD_CLASSES.map(c=>
        `<div class="cost-section-title" style="font-size:15px;border-bottom:2px solid var(--rust);padding-bottom:4px">${esc(c)}</div>`
        + costSection(c, classes, {showMbf:false})
      ).join('');
}
