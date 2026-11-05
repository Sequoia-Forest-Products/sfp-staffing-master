// alerts — the Alerts tab, and the open-alert badge on its nav button.
//
// Shares one global scope with the other files in src/js (see core.js). Every
// function here is global because inline on* handlers call them by bare name.
//
// The server owns every decision: which conditions hold, when an alert opens,
// when it resolves. This file draws what /api/alerts returns and sends the two
// things a person can do — acknowledge, or mark a number as BBSI staff. The
// thresholds shown in the footer come from the server's config, so the words
// on screen cannot drift from the numbers in timeclock-config.js.

const ALERTS_CSS=`<style>
  .al-list{display:flex;flex-direction:column;gap:10px;margin-bottom:24px}
  .al-card{background:var(--surface);border:1px solid var(--border);border-left:4px solid var(--muted);border-radius:6px;padding:12px 14px}
  .al-card.sev-critical{border-left-color:#c0392b}
  .al-card.sev-warning{border-left-color:#e67e22}
  .al-card.sev-info{border-left-color:#3a5fa0}
  .al-card.st-acknowledged{opacity:.75}
  .al-card.st-resolved{opacity:.55}
  .al-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
  .al-type{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--muted)}
  .al-title{font-size:13.5px;font-weight:700;color:var(--text);margin-top:2px}
  .al-meta{font-size:11px;color:var(--muted);margin-top:4px}
  .al-detail{font-size:12px;color:var(--textDim);margin-top:6px;line-height:1.5}
  .al-actions{display:flex;gap:6px;flex-shrink:0}
  .al-filters{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px}
  .al-chip{font-family:var(--font);font-size:11px;padding:4px 10px;border-radius:14px;border:1px solid var(--border);background:var(--surface);color:var(--text);cursor:pointer}
  .al-chip.on{background:var(--orange);color:#fff;border-color:var(--orange)}
  .al-empty{background:var(--surface);border:1px dashed var(--border);border-radius:6px;padding:24px;text-align:center;color:var(--muted);font-size:13px}
  .al-var table{font-size:12px} .al-var td,.al-var th{padding:6px 10px}
  .al-pos{color:#2a7a47} .al-neg{color:#c0392b}
  .sfp-tab .al-badge{display:inline-block;min-width:16px;padding:1px 5px;margin-left:6px;border-radius:9px;background:#c0392b;color:#fff;font-size:10px;font-weight:700;line-height:14px;text-align:center}
</style>`;

// ---- badge ----

// Hidden when the count is zero: a "0" badge is a badge nobody stops reading.
function setAlertBadge(count){
  const el=document.getElementById('alertBadge');
  if(!el) return;
  const n=Number(count)||0;
  el.textContent=n>99?'99+':String(n);
  el.style.display=n>0?'inline-block':'none';
}

async function loadAlertCount(){
  try{
    const res=await fetch('/api/alerts?count=1');
    if(!res.ok) return;
    const json=await res.json();
    if(json&&json.ok) setAlertBadge(json.openCount);
  }catch(e){ /* the badge is a convenience; the tab itself reports failures */ }
}

// ---- data ----

async function alertsPost(body){
  const res=await fetch('/api/alerts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(res.status===401){location.href='/';throw new Error('Session expired');}
  let json=null; try{json=await res.json();}catch(e){}
  if(!res.ok||!json||json.ok===false) throw new Error((json&&json.error)||('Request failed ('+res.status+')'));
  return json;
}

async function loadAlerts(evaluate){
  state.alertsLoading=true; state.alertsError=null; render();
  try{
    const qs=new URLSearchParams();
    if(evaluate) qs.set('evaluate','1');
    if(state.alertsShowResolved) qs.set('resolved','1');
    const res=await fetch('/api/alerts?'+qs.toString());
    if(res.status===401){location.href='/';return;}
    const json=await res.json();
    if(!res.ok||!json.ok) throw new Error(json.error||('Request failed ('+res.status+')'));
    state.alerts=json;
    setAlertBadge(json.openCount);
    const rec=await alertsPost({action:'reconciliations'}).catch(()=>null);
    state.alertsReconciliations=rec?rec.reconciliations:null;
  }catch(err){
    state.alertsError=err.message;
  }finally{
    state.alertsLoading=false; render();
  }
}

async function ackAlert(id){
  try{
    await alertsPost({action:'acknowledge',id});
    toast('Alert acknowledged','success');
    await loadAlerts(false);
  }catch(err){ toast('Could not acknowledge: '+err.message,'error'); }
}

async function markBbsiStaff(employeeNumber){
  if(!confirm('Mark #'+employeeNumber+' as BBSI staff?\n\nTheir timeclock rows stay stored and are never counted toward hours, overtime or cost. Use this only for people who are not SFP employees.')) return;
  try{
    await alertsPost({action:'markBbsiStaff',employeeNumber});
    toast('#'+employeeNumber+' marked as BBSI staff','success');
    await loadAlerts(false);
  }catch(err){ toast('Could not mark: '+err.message,'error'); }
}

async function showVariance(importId){
  try{
    const json=await alertsPost({action:'variance',importId});
    state.alertsVariance=json.import;
    render();
    const el=document.getElementById('alertsVariance');
    if(el&&el.scrollIntoView) el.scrollIntoView({behavior:'smooth'});
  }catch(err){ toast('Could not load the variance: '+err.message,'error'); }
}

function closeVariance(){ state.alertsVariance=null; render(); }
function setAlertFilter(type){ state.alertsFilter=type; render(); }
function toggleResolvedAlerts(){ state.alertsShowResolved=!state.alertsShowResolved; loadAlerts(false); }

// ---- render ----

function alertWhen(a){
  const bits=[];
  if(a.work_date) bits.push(fmtDate(String(a.work_date).slice(0,10)));
  if(a.employee_number) bits.push('#'+esc(a.employee_number));
  bits.push('raised '+fmtStamp(a.created_at));
  if(a.status==='acknowledged') bits.push('acknowledged by '+esc(a.acknowledged_by||'someone'));
  if(a.status==='resolved') bits.push('resolved '+fmtStamp(a.resolved_at)+(a.resolved_reason?' — '+esc(a.resolved_reason):''));
  return bits.join(' · ');
}

function alertDetail(a){
  const d=a.details||{};
  const lines=[];
  if(a.type==='new_employee') lines.push(`${esc(d.hours)} hours held across ${esc(d.days)} day${d.days===1?'':'s'} (${fmtDate(d.firstDate)}${d.lastDate&&d.lastDate!==d.firstDate?' – '+fmtDate(d.lastDate):''}). Not counted until the number is on the roster.`);
  if(a.type==='thin_day') lines.push(`${esc(d.rows)} hourly rows; the trailing median for this weekday is ${esc(d.median)} (alert below ${esc(d.threshold)}).${d.status?' Day is '+esc(d.status)+'.':''}`);
  if(a.type==='zero_hour_rows'&&Array.isArray(d.employees)) lines.push(d.employees.slice(0,12).map(e=>esc((e.name||'')+' #'+e.employeeNumber)).join(', ')+(d.employees.length>12?' and '+(d.employees.length-12)+' more':''));
  if(a.type==='active_no_hours') lines.push(`${esc(d.department||'No department')} · no counted hours ${fmtDate(d.from)} – ${fmtDate(d.to)}.`);
  if(a.type==='weekly_variance') lines.push(`Labor cost ${costMoneyOr(d.dollarsBefore)} → ${costMoneyOr(d.dollarsAfter)} (${d.dollarsChange>=0?'+':''}${costMoneyOr(d.dollarsChange)}${d.pct!=null?', '+esc(d.pct)+'%':''}); hours ${d.hoursChange>=0?'+':''}${esc(d.hoursChange)}; ${esc(d.fixedPunches)} fixed punch${d.fixedPunches===1?'':'es'}.`);
  if(d.action) lines.push(esc(d.action));
  return lines.map(l=>`<div class="al-detail">${l}</div>`).join('');
}

function costMoneyOr(v){
  const n=Number(v);
  if(!Number.isFinite(n)) return '—';
  return (n<0?'−':'')+'$'+Math.abs(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
}

function alertCard(a,types){
  const label=(types&&types[a.type]&&types[a.type].label)||a.type;
  const actions=[];
  if(a.status==='open') actions.push(`<button class="btn btn-outline btn-sm" onclick="ackAlert('${jsStr(a.id)}')">Acknowledge</button>`);
  if(a.type==='new_employee'&&a.status!=='resolved') actions.push(`<button class="btn btn-outline btn-sm" onclick="markBbsiStaff('${jsStr(a.employee_number)}')">BBSI staff</button>`);
  if(a.type==='weekly_variance'&&a.details&&a.details.importId) actions.push(`<button class="btn btn-outline btn-sm" onclick="showVariance('${jsStr(a.details.importId)}')">Variance</button>`);
  return `<div class="al-card sev-${esc(a.severity)} st-${esc(a.status)}" data-alert-type="${esc(a.type)}">
    <div class="al-head">
      <div><div class="al-type">${esc(label)} · ${esc(a.severity)} · ${esc(a.status)}</div>
        <div class="al-title">${esc(a.title)}</div>
        <div class="al-meta">${alertWhen(a)}</div></div>
      <div class="al-actions">${actions.join('')}</div>
    </div>
    ${alertDetail(a)}
  </div>`;
}

function varianceBlock(imp){
  if(!imp) return '';
  const v=imp.variance||{};
  const t=v.totals||{};
  const cls=n=>Number(n)>0?'al-pos':(Number(n)<0?'al-neg':'');
  const days=(v.days||[]).map(d=>`<tr><td>${fmtDate(d.date)}</td><td>${esc(d.rowsBefore)} → ${esc(d.rowsAfter)}</td>
    <td>${esc(d.hoursBefore)} → ${esc(d.hoursAfter)}</td><td class="${cls(d.hoursChange)}">${d.hoursChange>0?'+':''}${esc(d.hoursChange)}</td>
    <td class="${cls(d.dollarsChange)}">${d.dollarsChange>0?'+':''}${costMoneyOr(d.dollarsChange)}</td></tr>`).join('');
  const emps=(v.employees||[]).slice(0,60).map(e=>`<tr><td>${fmtDate(e.date)}</td><td>${esc(e.name||'')} #${esc(e.employeeNumber)}</td>
    <td>${esc(e.hoursBefore)} → ${esc(e.hoursAfter)}</td><td class="${cls(e.hoursChange)}">${e.hoursChange>0?'+':''}${esc(e.hoursChange)}</td>
    <td class="${cls(e.dollarsChange)}">${e.dollarsChange==null?'no rate':(e.dollarsChange>0?'+':'')+costMoneyOr(e.dollarsChange)}</td></tr>`).join('');
  const fixed=(v.fixedPunches||[]).map(f=>esc((f.name||'')+' #'+f.employeeNumber+' '+fmtDate(f.date)+' ('+f.hours+' h'+(f.wasMissing?', was missing':'')+')')).join(', ');
  return `<div id="alertsVariance" class="dh-panel al-var">
    <div class="section-head"><span>Reconciliation ${fmtDate(imp.work_date_from)} – ${fmtDate(imp.work_date_to)}</span>
      <button class="btn btn-outline btn-sm" onclick="closeVariance()">Close</button></div>
    <div class="al-detail">Labor cost ${costMoneyOr(t.dollarsBefore)} → ${costMoneyOr(t.dollarsAfter)}
      (<span class="${cls(t.dollarsChange)}">${t.dollarsChange>0?'+':''}${costMoneyOr(t.dollarsChange)}</span>${t.dollarsChangePct!=null?', '+esc(t.dollarsChangePct)+'%':''});
      hours ${esc(t.hoursBefore)} → ${esc(t.hoursAfter)}. Priced with the roster rate and the 1.5×/2.0× overtime rule.
      ${(v.ratesMissing||[]).length?'<br>No rate on file for '+v.ratesMissing.map(n=>'#'+esc(n)).join(', ')+' — their dollars are not in these figures.':''}</div>
    <div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>Day</th><th>Rows</th><th>Hours</th><th>Δ hours</th><th>Δ labor $</th></tr></thead><tbody>${days||'<tr><td colspan="5">No days.</td></tr>'}</tbody></table></div>
    ${emps?`<div class="section-head"><span>Per employee — ${(v.employees||[]).length} change${(v.employees||[]).length===1?'':'s'}</span></div>
    <div class="table-wrap"><table><thead><tr><th>Day</th><th>Employee</th><th>Hours</th><th>Δ hours</th><th>Δ labor $</th></tr></thead><tbody>${emps}</tbody></table></div>`:''}
    <div class="al-detail"><strong>Fixed punches (0.00 or missing → hours):</strong> ${fixed||'none'}</div>
  </div>`;
}

function reconciliationsBlock(list){
  if(!list||!list.length) return `<div class="al-detail" style="margin-bottom:20px">No weekly file has been reconciled yet. Days stay <strong>provisional</strong> (daily snapshot only) until one is.</div>`;
  return `<div class="section-head"><span>Weekly reconciliations</span></div>
    <div class="table-wrap"><table><thead><tr><th>Week</th><th>Received</th><th>Rows</th><th>Δ hours</th><th>Δ labor $</th><th>Fixed punches</th><th></th></tr></thead><tbody>
    ${list.map(r=>`<tr><td>${fmtDate(r.from)} – ${fmtDate(r.to)}</td><td>${fmtStamp(r.receivedAt||r.createdAt)}</td><td>${esc(r.rowsCounted)}</td>
      <td>${r.totals?esc(r.totals.hoursChange):'—'}</td><td>${r.totals?costMoneyOr(r.totals.dollarsChange):'—'}</td><td>${esc(r.fixedPunches)}</td>
      <td><button class="btn btn-outline btn-sm" onclick="showVariance('${jsStr(r.id)}')">Variance</button></td></tr>`).join('')}
    </tbody></table></div>`;
}

function renderAlertsTab(){
  const data=state.alerts;
  if(state.alertsLoading&&!data) return ALERTS_CSS+'<div class="loading-state">Checking alerts…</div>';
  if(state.alertsError&&!data) return ALERTS_CSS+`<div class="al-empty">Alerts could not be loaded: ${esc(state.alertsError)} <button class="btn btn-outline btn-sm" onclick="loadAlerts(true)">Retry</button></div>`;
  if(!data) return ALERTS_CSS+'<div class="loading-state">Checking alerts…</div>';

  const types=data.types||{};
  const all=data.alerts||[];
  const filter=state.alertsFilter||'all';
  const shown=filter==='all'?all:all.filter(a=>a.type===filter);
  const counts={};
  for(const a of all) if(a.status==='open') counts[a.type]=(counts[a.type]||0)+1;
  const chips=[`<button class="al-chip ${filter==='all'?'on':''}" onclick="setAlertFilter('all')">All (${data.openCount||0} open)</button>`]
    .concat(Object.keys(types).map(k=>`<button class="al-chip ${filter===k?'on':''}" onclick="setAlertFilter('${jsStr(k)}')">${esc(types[k].label)}${counts[k]?' ('+counts[k]+')':''}</button>`));
  const cfg=data.config||{};
  const th=cfg.thresholds||{};

  return ALERTS_CSS+`
    <div class="section-head"><span>Alerts</span>
      <span style="display:flex;gap:6px">
        <button class="btn btn-outline btn-sm" onclick="toggleResolvedAlerts()">${state.alertsShowResolved?'Hide resolved':'Show resolved'}</button>
        <button class="btn btn-primary btn-sm" ${state.alertsLoading?'disabled':''} onclick="loadAlerts(true)">${state.alertsLoading?'Checking…':'Re-check now'}</button>
      </span></div>
    <div class="al-filters">${chips.join('')}</div>
    <div class="al-list">${shown.length?shown.map(a=>alertCard(a,types)).join(''):'<div class="al-empty">Nothing here. Every condition is clear.</div>'}</div>
    ${varianceBlock(state.alertsVariance)}
    ${reconciliationsBlock(state.alertsReconciliations)}
    <div class="dh-note">Daily file expected by ${esc(cfg.daily&&cfg.daily.expectedHour)}:00 AM Pacific, missing after ${esc(cfg.daily&&cfg.daily.missingAfterHour)}:00.
      Weekly file expected Mondays by ${esc(cfg.weekly&&cfg.weekly.expectedHour)}:00 AM, missing after ${esc(cfg.weekly&&cfg.weekly.missingAfterHour)}:00.
      Thin day: below ${Math.round((th.thinDayRatio||0)*100)}% of the trailing ${esc(th.thinDayLookbackWeeks)}-week median for that weekday.
      Weekly variance: more than ${esc(th.weeklyVariancePct)}% or $${esc(th.weeklyVarianceDollars)}.
      Active, no hours: none in the last ${esc(th.noHoursLookbackDays)} days.
      Alerts resolve themselves when their condition clears; Weekly variance resolves when acknowledged.</div>`;
}
