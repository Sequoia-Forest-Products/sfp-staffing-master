// timeclock — the Timeclock tab: manual uploads of BBSI's timeclock files.
//
// Replaced the automatic email import on 2026-11-24. BBSI's Work Summary
// Payroll report has no date in it, and the daily and weekly versions have the
// same nine columns, so the person uploading says what each file covers:
//
//   Daily uploads           one or more files, each with its own work date,
//                           suggested (file name, else yesterday; Monday:
//                           Fri/Sat/Sun) and CONFIRMED per file before anything
//                           is written. Each day is replaced, never appended.
//   Weekly reconciliation   the Wednesday file for last Mon–Sun. A check only:
//                           it never writes a day. It lists who is off, by how
//                           much, and where to look; re-uploading a corrected
//                           day re-runs the comparison.
//
// The server (/api/timeclock-upload) makes every decision and re-checks every
// guard on commit; this file draws and sends. Only the uploaders can commit —
// everyone else sees the same screen without the upload controls.
//
// Shares one global scope with the other files in src/js (see core.js).

const TC_CSS=`<style>
  .tc-modes{display:flex;gap:6px;margin-bottom:16px}
  .tc-mode{font-family:var(--font);font-size:12.5px;padding:7px 14px;border-radius:16px;border:1px solid var(--border);background:var(--surface);color:var(--text);cursor:pointer}
  .tc-mode.on{background:var(--orange);color:#fff;border-color:var(--orange);font-weight:600}
  .tc-panel{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:14px 16px;margin-bottom:18px}
  .tc-file{border:1px solid var(--border);border-radius:6px;padding:12px 14px;margin-top:12px;background:var(--surface)}
  .tc-file.blocked{border-color:#c0392b;background:#fdf3f2}
  .tc-file.done{border-color:#2e7d4f;background:#f1f8f3}
  .tc-row{display:flex;gap:14px;align-items:flex-end;flex-wrap:wrap}
  .tc-field label{display:block;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--muted);margin-bottom:4px}
  .tc-field input[type=date]{font-family:var(--font);font-size:13px;border:1px solid var(--border);border-radius:4px;padding:6px 8px}
  .tc-stats{display:flex;gap:18px;flex-wrap:wrap;margin-top:10px;font-size:12px}
  .tc-stat b{display:block;font-size:15px;color:var(--text)}
  .tc-stat span{color:var(--muted);font-size:10.5px;text-transform:uppercase;letter-spacing:.4px}
  .tc-err{color:#c0392b;font-weight:600;font-size:12px;margin-top:8px;line-height:1.45}
  .tc-warn{color:#9a600a;font-size:12px;margin-top:6px;line-height:1.45}
  .tc-ack{display:flex;gap:8px;align-items:flex-start;margin-top:8px;font-size:12px;font-weight:600;line-height:1.45;cursor:pointer}
  .tc-ack input{margin-top:2px;width:15px;height:15px;flex-shrink:0}
  .tc-note{font-size:11.5px;color:var(--muted);line-height:1.5}
  .tc-chip{display:inline-block;font-size:10.5px;padding:1px 7px;border-radius:10px;margin:1px 3px 1px 0;border:1px solid var(--border);color:var(--muted)}
  .tc-chip.zero{border-color:#c0392b;color:#c0392b;font-weight:700}
  .tc-chip.not_uploaded{border-color:#9a600a;color:#9a600a;font-weight:700}
  .tc-pos{color:#2e7d4f;font-weight:600} .tc-neg{color:#c0392b;font-weight:600}
  .tc-st{font-size:11px;font-weight:700}
</style>`;

async function tcPost(body){
  const res=await fetch('/api/timeclock-upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(res.status===401){location.href='/';throw new Error('Session expired');}
  let json=null;
  try{json=await res.json();}catch(e){json=null;}
  if(!res.ok||!json||json.ok===false) throw new Error((json&&json.error)||('Request failed ('+res.status+')'));
  return json;
}

function tcMoney(n){
  if(n==null||!isFinite(Number(n))) return '—';
  const v=Number(n);
  return (v<0?'−':v>0?'+':'')+'$'+Math.abs(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
}
function tcHrsDelta(n){
  const v=Number(n)||0;
  const cls=v>0?'tc-pos':v<0?'tc-neg':'';
  return `<span class="${cls}">${v>0?'+':v<0?'−':''}${fmtHrs(Math.abs(v))}</span>`;
}
function tcCanUpload(){ return !!(state.tcOverview&&state.tcOverview.canUpload); }
function tcMondayOf(iso){ const d=isoDow(iso); return d?isoShift(iso,-(d-1)):iso; }

// ---- load ----

async function loadTimeclock(){
  state.tcLoading=true; state.tcError=''; render();
  try{
    const json=await tcPost({action:'overview'});
    state.tcOverview=json;
    if(!state.tcWeekStart) state.tcWeekStart=json.defaultWeekStart;
  }catch(err){ state.tcError=err.message; }
  state.tcLoading=false; render();
  if(state.tcMode==='weekly'&&state.tcWeekStart) loadTimeclockWeek(state.tcWeekStart);
}

function setTimeclockMode(mode){
  state.tcMode=mode==='weekly'?'weekly':'daily';
  render();
  if(state.tcMode==='weekly'&&state.tcWeekStart&&!state.tcWeek) loadTimeclockWeek(state.tcWeekStart);
}

// From an alert: straight to a week's variance list.
function openTimeclockWeek(weekStart){
  state.tcMode='weekly';
  state.tcWeekStart=weekStart;
  state.tcWeek=null;
  goToTab('timeclock');
}

// ---- daily ----

async function tcPickDailyFiles(input){
  const files=Array.from((input&&input.files)||[]);
  if(!files.length) return;
  state.tcBusy=true; render();
  try{
    const loaded=[];
    for(const f of files) loaded.push({fileName:f.name,fileBase64:await fileToBase64(f)});
    const json=await tcPost({action:'suggest',fileNames:loaded.map(f=>f.fileName)});
    state.tcFiles=loaded.map((f,i)=>{
      const s=(json.suggestions||[])[i]||{};
      return {...f,workDate:s.workDate||'',dateSource:s.source||'default',fileNameDate:s.fileNameDate||null,
        preview:null,dateConfirmed:false,confirm:{},result:null,error:''};
    });
  }catch(err){ toast('Could not read the files: '+err.message,'error'); }
  state.tcBusy=false; render();
}

function tcSetDate(i,v){
  const f=(state.tcFiles||[])[i]; if(!f) return;
  f.workDate=v; f.preview=null; f.dateConfirmed=false; f.confirm={}; f.error='';
  render();
}
function tcConfirmDate(i,on){ const f=(state.tcFiles||[])[i]; if(f){f.dateConfirmed=!!on; render();} }
function tcConfirm(i,key,on){ const f=(state.tcFiles||[])[i]; if(f){f.confirm[key]=!!on; render();} }
function tcRemoveFile(i){ (state.tcFiles||[]).splice(i,1); render(); }
function tcClearDaily(){ state.tcFiles=[]; render(); }

async function tcPreviewDaily(){
  const files=(state.tcFiles||[]).filter(f=>!f.result);
  if(!files.length) return;
  if(files.some(f=>!f.workDate)){toast('Every file needs a work date','error');return;}
  state.tcBusy=true; render();
  try{
    const json=await tcPost({action:'previewDaily',files:files.map(f=>({fileName:f.fileName,fileBase64:f.fileBase64,workDate:f.workDate}))});
    (json.previews||[]).forEach((p,i)=>{ files[i].preview=p; files[i].confirm={}; files[i].dateConfirmed=false; });
  }catch(err){ toast('Preview failed: '+err.message,'error'); }
  state.tcBusy=false; render();
}

// What still stands between a previewed file and a commit, in words.
function tcMissing(f){
  const p=f.preview;
  if(f.result) return [];
  if(!p) return ['preview'];
  if(p.blocked) return ['blocked'];
  const out=[];
  if(!f.dateConfirmed) out.push('confirm the date');
  const n=p.needs||{};
  if(n.confirmOverwrite&&!f.confirm.overwrite) out.push('confirm the replacement');
  if(n.confirmReconciled&&!f.confirm.reconciled) out.push('confirm overwriting a reconciled day');
  if(n.confirmDuplicateFile&&!f.confirm.duplicate) out.push('confirm the duplicate file');
  return out;
}

async function tcCommitDaily(){
  const ready=(state.tcFiles||[]).filter(f=>!f.result&&f.preview&&!tcMissing(f).length);
  if(!ready.length){toast('Nothing is ready to commit — preview, then confirm each file','error');return;}
  state.tcBusy=true; render();
  let ok=0;
  for(const f of ready){
    try{
      const json=await tcPost({action:'commitDaily',fileName:f.fileName,fileBase64:f.fileBase64,workDate:f.workDate,
        confirmOverwrite:!!f.confirm.overwrite,confirmReconciled:!!f.confirm.reconciled,confirmDuplicateFile:!!f.confirm.duplicate});
      f.result=json; f.error=''; ok++;
    }catch(err){ f.error=err.message; }
    render();
  }
  state.tcBusy=false;
  toast(ok+' of '+ready.length+' day'+(ready.length===1?'':'s')+' committed',ok===ready.length?'success':'warning');
  state.otReport=null;
  state.tcWeek=null;
  if(typeof loadAlertCount==='function') loadAlertCount();
  await loadTimeclock();
}

function tcDailyFileCard(f,i){
  const p=f.preview;
  const done=!!f.result;
  const cls=done?'done':(p&&p.blocked?'blocked':'');
  const dateNote=f.dateSource==='filename'?'from the file name':'default — check it';
  const head=`<div class="tc-row">
    <div class="tc-field" style="flex:1;min-width:220px"><label>File</label><div style="font-weight:600;font-size:13px">${esc(f.fileName)}</div></div>
    <div class="tc-field"><label>Work date</label>
      <input type="date" value="${esc(f.workDate)}" ${done?'disabled':''} onchange="tcSetDate(${i},this.value)">
      <div class="tc-note">${esc(dayNameOf(f.workDate))} · ${esc(dateNote)}</div></div>
    ${done?'':`<button class="btn btn-outline btn-sm" onclick="tcRemoveFile(${i})">Remove</button>`}
  </div>`;
  if(done){
    const r=f.result;
    return `<div class="tc-file done" data-tc-file="${i}">${head}
      <div class="tc-note" style="margin-top:8px;color:#2e7d4f;font-weight:600">Committed: ${esc(r.inserted)} counted, ${esc(r.held)} held${r.replaced?', '+esc(r.replaced)+' replaced':''}.
      ${r.week?` Week of ${fmtDateShort(r.week.weekStart)} re-checked: <strong>${esc(r.week.status)}</strong>${r.week.varianceCount?' — '+esc(r.week.varianceCount)+' still off':''}.`:''}</div></div>`;
  }
  if(!p) return `<div class="tc-file" data-tc-file="${i}">${head}${f.error?`<div class="tc-err">${esc(f.error)}</div>`:''}</div>`;

  const h=p.held||{};
  const n=p.needs||{};
  const stats=p.counted!=null?`<div class="tc-stats">
    <div class="tc-stat"><span>Date</span><b>${fmtDateShort(p.workDate)} ${esc((p.dayName||'').slice(0,3))}</b></div>
    <div class="tc-stat"><span>Hourly counted</span><b>${esc(p.counted)}</b></div>
    <div class="tc-stat"><span>Total hours</span><b>${fmtHrs(p.totalHours)}</b></div>
    <div class="tc-stat"><span>OT hours</span><b>${fmtHrs(p.otHours)}</b></div>
    <div class="tc-stat"><span>Held</span><b>${(h.salaried||0)+(h.external||0)+(h.unknown||0)}</b>
      <div class="tc-note">${esc(h.salaried||0)} salaried · ${esc(h.external||0)} BBSI · ${esc(h.unknown||0)} unknown no.</div></div>
  </div>
  ${(h.unknownPeople||[]).length?`<div class="tc-warn">Not on the roster (held, raises a New employee alert): ${h.unknownPeople.map(u=>esc('#'+u.employeeNumber+(u.name?' '+u.name:''))).join(', ')}</div>`:''}`:'';
  const errs=(p.errors||[]).map(e=>`<div class="tc-err">${esc(e)}</div>`).join('');
  const warns=(p.warnings||[]).map(w=>`<div class="tc-warn">${esc(w)}</div>`).join('');
  const acks=p.blocked?'':`
    ${n.confirmOverwrite?`<label class="tc-ack"><input type="checkbox" ${f.confirm.overwrite?'checked':''} onchange="tcConfirm(${i},'overwrite',this.checked)">
      Replace what is already on ${fmtDate(p.workDate)}: ${esc(p.existing.rowCount)} people, ${fmtHrs(p.existing.totalHours)} hours (${fmtHrs(p.existing.otHours)} OT), from ${esc(p.existing.source||'an earlier upload')} ${fmtStamp(p.existing.createdAt)}.</label>`:''}
    ${n.confirmReconciled?`<label class="tc-ack" style="color:#c0392b"><input type="checkbox" ${f.confirm.reconciled?'checked':''} onchange="tcConfirm(${i},'reconciled',this.checked)">
      ${fmtDate(p.workDate)} has already been reconciled by a weekly file. Overwrite it anyway.</label>`:''}
    ${n.confirmDuplicateFile?`<label class="tc-ack" style="color:#c0392b"><input type="checkbox" ${f.confirm.duplicate?'checked':''} onchange="tcConfirm(${i},'duplicate',this.checked)">
      This exact file is already stored as ${fmtDate(p.duplicateFile.workDate)}. Filing it as ${fmtDate(p.workDate)} too counts that day twice — I am sure.</label>`:''}
    <label class="tc-ack"><input type="checkbox" ${f.dateConfirmed?'checked':''} onchange="tcConfirmDate(${i},this.checked)">
      This file is the timeclock for <span style="text-decoration:underline">${esc(dayNameOf(p.workDate))}, ${fmtDate(p.workDate)}</span>.</label>`;
  return `<div class="tc-file ${cls}" data-tc-file="${i}">${head}${stats}${errs}${warns}${acks}
    ${f.error?`<div class="tc-err">Commit failed: ${esc(f.error)}</div>`:''}</div>`;
}

function tcDailyUpload(){
  if(!tcCanUpload()) return '';
  const files=state.tcFiles||[];
  const pending=files.filter(f=>!f.result);
  const ready=pending.filter(f=>f.preview&&!tcMissing(f).length);
  const needPreview=pending.some(f=>!f.preview);
  return `<div class="tc-panel">
    <div class="tc-row">
      <div class="tc-field" style="flex:1;min-width:260px"><label>Daily timeclock files (.xlsx) — one per day</label>
        <input type="file" id="tcDailyFiles" accept=".xlsx" multiple onchange="tcPickDailyFiles(this)"></div>
      ${files.length?`<button class="btn btn-outline" onclick="tcClearDaily()">Clear</button>`:''}
    </div>
    <div class="tc-note" style="margin-top:6px">Monday's upload covers Friday, Saturday and Sunday: choose all three files at once and they default to those days. A date in the file name (e.g. “11-9”) is used as the default when there is one. Every date is yours to confirm.</div>
    ${files.map(tcDailyFileCard).join('')}
    ${pending.length?`<div style="display:flex;gap:8px;margin-top:14px">
      <button class="btn btn-outline" ${state.tcBusy?'disabled':''} onclick="tcPreviewDaily()">${state.tcBusy?'Working…':(needPreview?'Preview':'Preview again')}</button>
      <button class="btn btn-primary" ${state.tcBusy||!ready.length?'disabled style="opacity:.5"':''} onclick="tcCommitDaily()">Commit ${ready.length} day${ready.length===1?'':'s'}</button>
    </div>`:''}
  </div>`;
}

function tcDayState(d){
  if(d.uploaded) return `<span class="tc-st" style="color:#2e7d4f">Uploaded</span> ${dayStatusBadge(d.status)}`;
  if(!d.owed) return '<span class="tc-note">Before uploads began</span>';
  if(d.overdue) return `<span class="tc-st" style="color:#c0392b">Missing — was due ${fmtDateShort(d.dueDate)} noon</span>`;
  return `<span class="tc-note">Due ${esc(dayNameOf(d.dueDate).slice(0,3))} ${fmtDateShort(d.dueDate)} noon</span>`;
}

function tcDailySchedule(o){
  const days=(o&&o.days)||[];
  return `<div class="section-head"><span>Daily uploads — last ${days.length} days</span></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Work date</th><th>Status</th><th class="num">People</th><th class="num">Hours</th><th class="num">OT hrs</th></tr></thead>
      <tbody>${days.map(d=>`<tr data-tc-day="${esc(d.workDate)}"><td style="font-weight:600">${fmtDate(d.workDate)}<div class="tc-note">${esc(dayNameOf(d.workDate))}</div></td>
        <td>${tcDayState(d)}</td><td class="num">${d.uploaded?esc(d.people):'—'}</td>
        <td class="num">${d.uploaded?fmtHrs(d.totalHours):'—'}</td><td class="num">${d.uploaded?fmtHrs(d.otHours):'—'}</td></tr>`).join('')}</tbody>
    </table></div>`;
}

// ---- weekly ----

function tcSetWeek(v){
  if(!v) return;
  state.tcWeekStart=tcMondayOf(v);
  state.tcWeek=null; state.tcWeekly=null;
  render();
  loadTimeclockWeek(state.tcWeekStart);
}

async function loadTimeclockWeek(weekStart){
  if(!weekStart) return;
  state.tcWeekLoading=true; render();
  try{
    const json=await tcPost({action:'week',weekStart});
    state.tcWeek={weekStart,week:json.week,comparison:json.comparison};
  }catch(err){ state.tcWeek={weekStart,error:err.message}; }
  state.tcWeekLoading=false; render();
}

async function tcPickWeeklyFile(input){
  const f=input&&input.files&&input.files[0];
  if(!f) return;
  state.tcWeekly={fileName:f.name,fileBase64:await fileToBase64(f),preview:null,confirmReplace:false,error:''};
  render();
}

async function tcPreviewWeekly(){
  const w=state.tcWeekly; if(!w) return;
  state.tcBusy=true; render();
  try{
    const json=await tcPost({action:'previewWeekly',fileName:w.fileName,fileBase64:w.fileBase64,weekStart:state.tcWeekStart});
    w.preview=json.preview; w.error='';
  }catch(err){ w.preview=null; w.error=err.message; }
  state.tcBusy=false; render();
}

async function tcCommitWeekly(){
  const w=state.tcWeekly; if(!w||!w.preview) return;
  state.tcBusy=true; render();
  try{
    const json=await tcPost({action:'commitWeekly',fileName:w.fileName,fileBase64:w.fileBase64,weekStart:state.tcWeekStart,
      confirmReplace:!!w.confirmReplace});
    state.tcWeek={weekStart:state.tcWeekStart,week:json.week,comparison:json.comparison};
    state.tcWeekly=null;
    toast('Weekly file stored for the week of '+fmtDate(state.tcWeekStart)+' — '+(json.week&&json.week.status==='reconciled'?'every person matches':'see the variances below'),'success');
    if(typeof loadAlertCount==='function') loadAlertCount();
    loadTimeclock();
  }catch(err){ w.error=err.message; }
  state.tcBusy=false; render();
}

async function tcAcceptWeek(){
  const ws=state.tcWeekStart;
  const note=prompt('Accept the remaining variances for the week of '+fmtDate(ws)+'?\n\nSay why — the note is kept with the week.');
  if(note==null) return;
  if(note.trim().length<3){toast('The note is required','error');return;}
  try{
    await tcPost({action:'acceptWeek',weekStart:ws,note});
    toast('Week accepted','success');
    if(typeof loadAlertCount==='function') loadAlertCount();
    await loadTimeclockWeek(ws);
    loadTimeclock();
  }catch(err){ toast('Could not accept: '+err.message,'error'); }
}

function tcStatusLabel(st){
  if(st==='reconciled') return '<span class="badge active">Reconciled</span>';
  if(st==='accepted') return '<span class="badge es">Accepted with variances</span>';
  if(st==='open') return '<span class="badge inactive" style="color:#c0392b">Variances open</span>';
  return '<span class="tc-note">No weekly file</span>';
}

function tcVarianceTable(c){
  if(!c) return '';
  const v=c.variances||[];
  const t=c.totals||{};
  const missing=(c.daysNotUploaded||[]);
  const head=`<div class="tc-note" style="margin:8px 0">
    ${esc(t.people||0)} people compared · weekly file ${fmtHrs(t.weeklyHours)} hrs · daily rows ${fmtHrs(t.dailyHours)} hrs ·
    ${v.length?`<strong style="color:#c0392b">${v.length} off by ${fmtHrs(t.absHoursOff)} hrs (${tcMoney(t.dollarsDiff)})</strong>`:'<strong style="color:#2e7d4f">everyone matches within 0.02 hrs</strong>'}
    ${missing.length?`<br><strong style="color:#9a600a">No daily upload yet for ${missing.map(d=>esc(dayNameOf(d).slice(0,3))+' '+fmtDateShort(d)).join(', ')}.</strong>`:''}
    <br>Positive = the weekly file has more than the daily rows. Dollars at the roster rate, OT at 1.5×.</div>`;
  if(!v.length) return head;
  return head+`<div class="table-wrap"><table data-tc-variances>
    <thead><tr><th>Person</th><th class="num">Daily sum<br><span class="tc-note">reg / OT / total</span></th><th class="num">Weekly file<br><span class="tc-note">reg / OT / total</span></th>
      <th class="num">Δ hours</th><th class="num">Δ $</th><th>Zero-hour days — look here in TimeNet</th></tr></thead>
    <tbody>${v.map(p=>`<tr data-tc-person="${esc(p.employeeNumber)}">
      <td style="font-weight:600">${esc(p.name||'—')}<div class="tc-note">#${esc(p.employeeNumber)}${p.onRoster?'':' · not on roster'}${p.inWeeklyFile?'':' · not in weekly file'}</div></td>
      <td class="num">${fmtHrs(p.daily.regular)} / ${fmtHrs(p.daily.ot)} / <strong>${fmtHrs(p.daily.total)}</strong></td>
      <td class="num">${fmtHrs(p.weekly.regular)} / ${fmtHrs(p.weekly.ot)} / <strong>${fmtHrs(p.weekly.total)}</strong></td>
      <td class="num">${tcHrsDelta(p.diff.total)}${(p.diff.ot||0)!==0?`<div class="tc-note">OT ${tcHrsDelta(p.diff.ot)}</div>`:''}</td>
      <td class="num">${p.dollarsDiff==null?'<span class="tc-note">no rate</span>':tcMoney(p.dollarsDiff)}</td>
      <td>${(p.zeroDays||[]).filter(z=>z.state!=='none'||isScheduledDate(z.date)).map(z=>`<span class="tc-chip ${esc(z.state)}" title="${z.state==='zero'?'A row at 0.00 — likely an open punch':z.state==='not_uploaded'?'This day has not been uploaded':'No row this day'}">${esc(dayNameOf(z.date).slice(0,3))} ${fmtDateShort(z.date)}${z.state==='zero'?' 0.00':z.state==='not_uploaded'?' not uploaded':''}</span>`).join('')||'<span class="tc-note">none</span>'}</td>
    </tr>`).join('')}</tbody></table></div>`;
}

function tcWeeklyUpload(){
  if(!tcCanUpload()) return '';
  const w=state.tcWeekly;
  const p=w&&w.preview;
  return `<div class="tc-panel">
    <div class="tc-row">
      <div class="tc-field" style="flex:1;min-width:260px"><label>Weekly timeclock file (.xlsx) for ${fmtDate(state.tcWeekStart)} – ${fmtDate(isoShift(state.tcWeekStart,6))}</label>
        <input type="file" id="tcWeeklyFile" accept=".xlsx" onchange="tcPickWeeklyFile(this)"></div>
      ${w?`<button class="btn btn-outline" ${state.tcBusy?'disabled':''} onclick="tcPreviewWeekly()">${state.tcBusy?'Working…':'Preview'}</button>`:''}
    </div>
    <div class="tc-note" style="margin-top:6px">A check only: the weekly file is stored as week totals and compared with the daily uploads. It never changes a day — corrections come from re-uploading the day.</div>
    ${w&&w.error?`<div class="tc-err">${esc(w.error)}</div>`:''}
    ${p?`<div class="tc-file ${p.blocked?'blocked':''}">
      <div class="tc-stats">
        <div class="tc-stat"><span>Week</span><b>${fmtDateShort(p.weekStart)} – ${fmtDateShort(p.weekEnd)}</b></div>
        <div class="tc-stat"><span>People in file</span><b>${esc(p.people)}</b></div>
        <div class="tc-stat"><span>Hourly hours</span><b>${fmtHrs(p.totalHours)}</b></div>
        <div class="tc-stat"><span>OT hours</span><b>${fmtHrs(p.otHours)}</b></div>
      </div>
      ${(p.errors||[]).map(e=>`<div class="tc-err">${esc(e)}</div>`).join('')}
      ${(p.warnings||[]).map(x=>`<div class="tc-warn">${esc(x)}</div>`).join('')}
      ${p.blocked?'':`<div class="section-head" style="margin-top:12px"><span>What the comparison will show</span></div>${tcVarianceTable(p.comparison)}
        ${p.needs&&p.needs.confirmReplace?`<label class="tc-ack"><input type="checkbox" ${w.confirmReplace?'checked':''} onchange="state.tcWeekly.confirmReplace=this.checked;render()">
          Replace the weekly file already stored for this week (${esc(p.existing.fileName||'')}, ${fmtStamp(p.existing.uploadedAt)}).</label>`:''}
        <button class="btn btn-primary" style="margin-top:10px" ${state.tcBusy||(p.needs&&p.needs.confirmReplace&&!w.confirmReplace)?'disabled style="opacity:.5;margin-top:10px"':''} onclick="tcCommitWeekly()">Store weekly file for ${fmtDateShort(p.weekStart)} – ${fmtDateShort(p.weekEnd)}</button>`}
    </div>`:''}
  </div>`;
}

function tcWeekDetail(){
  const d=state.tcWeek;
  if(state.tcWeekLoading&&!d) return '<div class="loading-state">Loading the week…</div>';
  if(!d) return '';
  if(d.error) return `<div class="tc-err">${esc(d.error)}</div>`;
  const wk=d.week;
  if(!wk) return `<div class="tc-panel" data-tc-week="none">No weekly file has been uploaded for ${fmtDate(d.weekStart)} – ${fmtDate(isoShift(d.weekStart,6))}.</div>`;
  const canAccept=tcCanUpload()&&wk.status==='open';
  return `<div class="tc-panel" data-tc-week="${esc(wk.status)}">
    <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap">
      <div><div style="font-weight:700;font-size:14px">Week of ${fmtDate(wk.weekStart)} – ${fmtDate(wk.weekEnd)} ${tcStatusLabel(wk.status)}</div>
        <div class="tc-note">Weekly file ${esc(wk.fileName||'')} uploaded ${fmtStamp(wk.uploadedAt)}${wk.uploadedBy?' by '+esc(wk.uploadedBy):''} · compared ${fmtStamp(wk.comparedAt)}</div>
        ${wk.status==='accepted'?`<div class="tc-note">Accepted by ${esc(wk.acceptedBy||'')} ${fmtStamp(wk.acceptedAt)}: “${esc(wk.acceptNote||'')}”</div>`:''}</div>
      <div style="display:flex;gap:6px">
        <button class="btn btn-outline btn-sm" onclick="loadTimeclockWeek('${jsStr(wk.weekStart)}')">Re-check</button>
        ${canAccept?`<button class="btn btn-outline btn-sm" onclick="tcAcceptWeek()">Accept remaining variances…</button>`:''}
      </div>
    </div>
    ${tcVarianceTable(d.comparison)}
    ${wk.status==='open'?'<div class="tc-note" style="margin-top:8px">To fix: find each person’s days in TimeNet, export the corrected day, and upload it under Daily uploads. Each upload replaces that day and re-runs this comparison.</div>':''}
  </div>`;
}

function tcWeeksList(o){
  const weeks=(o&&o.weeks)||[];
  return `<div class="section-head"><span>Weeks</span></div>
    <div class="table-wrap"><table><thead><tr><th>Week</th><th>Weekly file</th><th class="num">People off</th><th class="num">Hours off</th><th></th></tr></thead>
    <tbody>${weeks.map(w=>`<tr><td style="font-weight:600">${fmtDateShort(w.weekStart)} – ${fmtDateShort(w.weekEnd)}</td>
      <td>${w.uploaded?tcStatusLabel(w.status):(!w.owed?'<span class="tc-note">Before uploads began</span>':w.overdue?`<span class="tc-st" style="color:#c0392b">Missing — was due ${fmtDateShort(w.dueDate)} noon</span>`:`<span class="tc-note">Due Wed ${fmtDateShort(w.dueDate)} noon</span>`)}</td>
      <td class="num">${w.uploaded&&w.varianceCount!=null?esc(w.varianceCount):'—'}</td>
      <td class="num">${w.uploaded&&w.absHoursOff!=null?fmtHrs(w.absHoursOff):'—'}</td>
      <td><button class="btn btn-outline btn-sm" onclick="tcSetWeek('${jsStr(w.weekStart)}')">Open</button></td></tr>`).join('')}</tbody></table></div>`;
}

// ---- tab ----

function renderTimeclock(){
  const o=state.tcOverview;
  if(state.tcLoading&&!o) return TC_CSS+'<div class="loading-state">Loading the upload schedule…</div>';
  if(state.tcError&&!o) return TC_CSS+`<div class="tc-err">The timeclock schedule could not be loaded: ${esc(state.tcError)} <button class="btn btn-outline btn-sm" onclick="loadTimeclock()">Retry</button></div>`;
  if(!o) return TC_CSS+'<div class="loading-state">Loading the upload schedule…</div>';
  const mode=state.tcMode==='weekly'?'weekly':'daily';
  const viewOnly=!o.canUpload?`<div class="tc-panel tc-note" data-tc-view-only>View only. Peter and Axeri upload the timeclock files; everyone can see what is in and what is owed.</div>`:'';
  const modes=`<div class="tc-modes">
    <button class="tc-mode ${mode==='daily'?'on':''}" onclick="setTimeclockMode('daily')">Daily uploads</button>
    <button class="tc-mode ${mode==='weekly'?'on':''}" onclick="setTimeclockMode('weekly')">Weekly reconciliation</button></div>`;
  if(mode==='daily') return TC_CSS+modes+viewOnly+tcDailyUpload()+tcDailySchedule(o);
  return TC_CSS+modes+viewOnly+`<div class="tc-panel"><div class="tc-row">
      <div class="tc-field"><label>Week (Monday)</label><input type="date" value="${esc(state.tcWeekStart||'')}" onchange="tcSetWeek(this.value)"></div>
      <div class="tc-note" style="flex:1">${fmtDate(state.tcWeekStart)} – ${fmtDate(isoShift(state.tcWeekStart,6))}. The weekly file is due by noon Pacific the Wednesday after.</div>
    </div></div>`+tcWeeklyUpload()+tcWeekDetail()+tcWeeksList(o);
}
