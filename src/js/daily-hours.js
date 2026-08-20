// daily-hours — the Daily Hours tab: manual import and its preview, the imported
// days list, the department re-stamp and the email ingestion queue.
//
// Shares one global scope with the other files in src/js (see core.js).

// ============================================================
// DAILY HOURS — manual import, imported days, admin actions
// ============================================================
async function previewDailyFile(){
  const input=document.getElementById('dhFile');
  const file=input&&input.files&&input.files[0];
  if(!file){toast('Choose the .xlsx payroll file first','error');return;}
  if(!state.dailyWorkDate){toast('Pick the work date — the file does not contain one','error');return;}

  state.dailyDupAck=false;
  state.dailyBusy=true; render();
  try{
    const fileBase64=await fileToBase64(file);
    // The server parses the workbook so the manual path and the email path
    // produce byte-identical rows; the browser only ships the bytes.
    const json=await payrollPost({action:'preview',fileName:file.name,fileBase64,workDate:state.dailyWorkDate});
    state.dailyPreview=json.preview||null;
    state.dailyPreviewFile={fileName:file.name,fileBase64,workDate:state.dailyWorkDate};
  }catch(err){
    state.dailyPreview=null; state.dailyPreviewFile=null;
    toast('Preview failed: '+err.message,'error');
  }
  state.dailyBusy=false; render();
}

function cancelDailyPreview(){
  state.dailyPreview=null; state.dailyPreviewFile=null; state.dailyDupAck=false; render();
}

// Filing the same bytes under a second date double-counts that day in every
// weekly report from then on, and the server now refuses the commit without an
// explicit confirmDuplicateFile. So the acknowledgement is a deliberate act —
// a box that has to be ticked with the two dates named in it — not an OK on a
// dialog that gets dismissed by reflex.
function ackDuplicateFile(on){state.dailyDupAck=!!on;render();}

async function commitDailyImport(){
  const f=state.dailyPreviewFile, p=state.dailyPreview;
  if(!f||!p) return;
  // Same bytes, different date is the one duplicate that doubles a day; same
  // bytes, same date is a harmless re-upload and must not ask for anything extra.
  const dup=p.duplicateFileHash;
  const crossDate=!!(dup&&!dup.sameDate);
  if(crossDate&&!state.dailyDupAck){toast('Tick the double-count acknowledgement before filing this file under a second date','error');return;}
  const overwrite=!!p.existing;
  if(overwrite&&!confirm('Overwrite the '+(p.existing.rowCount||0)+' rows already imported for '+fmtDate(f.workDate)+'?\n\nThe day is deleted and re-inserted, so anyone dropped from a corrected re-send disappears too.')) return;

  state.dailyBusy=true; render();
  let imported=false;
  try{
    const body={action:'commit',fileName:f.fileName,fileBase64:f.fileBase64,workDate:f.workDate,confirmOverwrite:overwrite};
    if(crossDate) body.confirmDuplicateFile=true;
    const json=await payrollPost(body);
    // removed = people who were on the old file for this date and are not on the
    // new one. Nothing else in the app would ever mention them again, so the
    // count is said out loud here and left on screen in the panel below.
    const removed=json.removed||0;
    state.dailyLastImport={workDate:f.workDate,inserted:json.inserted||0,replaced:json.replaced||0,removed};
    toast((json.inserted||0)+' rows imported for '+fmtDate(f.workDate)+(json.replaced?(', '+json.replaced+' replaced'):'')
      +(removed?(', '+removed+' employee'+(removed===1?'':'s')+' dropped from the day'):''),removed?'warning':'success');
    state.dailyPreview=null; state.dailyPreviewFile=null; state.dailyDupAck=false;
    state.otReport=null;  // the week that just changed has to be refetched
    await loadDailyDays();
    imported=true;
  }catch(err){
    toast('Import failed: '+err.message,'error');
  }
  // Auto-send is a courtesy on top of the import and never fails it. The week has to be
  // reloaded first, or the email reports whatever was on screen before this import.
  if(imported&&state.emailSettings.autoSend&&(state.emailSettings.managers||[]).length){
    try{
      await loadOTReport(f.workDate);
      if(state.otReport) await sendOTReportEmail({auto:true});
      else toast('Imported, but the OT report would not load — no manager email sent','warning');
    }catch(err){
      toast('Imported, but the manager email failed: '+err.message,'warning');
    }
  }
  state.dailyBusy=false; render();
}

async function loadDailyDays(){
  if(!state.dailyFrom||!state.dailyTo){state.dailyTo=isoToday();state.dailyFrom=isoShift(state.dailyTo,-30);}
  state.dailyLoading=true; render();
  try{
    const json=await payrollPost({action:'days',from:state.dailyFrom,to:state.dailyTo});
    state.dailyDays=json.days||[];
    state.dailyLoaded=true;
  }catch(err){
    state.dailyDays=[];
    toast('Could not load imported days: '+err.message,'error');
  }
  state.dailyLoading=false; render();
}

async function correctDailyDate(uploadBatchId,current){
  const next=prompt('The email states no work date, so an inferred date can be wrong. New work date for the '+fmtDate(current)+' import (YYYY-MM-DD):',current);
  if(next===null) return;
  const v=String(next).trim();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(v)){toast('Enter the date as YYYY-MM-DD','error');return;}
  if(v===current) return;
  try{
    const json=await payrollPost({action:'correctDate',uploadBatchId,newWorkDate:v});
    const warn=((json.validation||{}).warnings||[]).join(' · ');
    toast((json.moved||0)+' rows moved from '+fmtDate(json.from||current)+' to '+fmtDate(json.workDate||v)+(warn?' — '+warn:''),'success');
    state.otReport=null;
    await loadDailyDays();
  }catch(err){toast('Could not change the date: '+err.message,'error');}
}

async function deleteDailyDay(workDate,rowCount){
  if(!confirm('Delete all '+rowCount+' rows imported for '+fmtDate(workDate)+'?\n\nThis cannot be undone — the day would have to be imported again.')) return;
  try{
    const json=await payrollPost({action:'deleteDay',workDate});
    toast((json.deleted||0)+' rows deleted for '+fmtDate(workDate),'success');
    state.otReport=null;
    await loadDailyDays();
  }catch(err){toast('Delete failed: '+err.message,'error');}
}

async function restampDepartments(){
  if(!state.restampFrom||!state.restampTo){toast('Pick both dates for the re-stamp range','error');return;}
  if(!confirm('Re-stamp departments on every daily hours row from '+fmtDate(state.restampFrom)+' to '+fmtDate(state.restampTo)+'?\n\nThis rewrites the department snapshot on those rows from the current employee records.')) return;
  state.dailyBusy=true; render();
  try{
    const json=await payrollPost({action:'restamp',from:state.restampFrom,to:state.restampTo});
    state.restampResult={scanned:json.scanned||0,updated:json.updated||0,stillUnassigned:json.stillUnassigned||0,changes:json.changes||[]};
    toast(state.restampResult.updated+' rows re-stamped','success');
    state.otReport=null;
    await loadDailyDays();
  }catch(err){toast('Re-stamp failed: '+err.message,'error');}
  state.dailyBusy=false; render();
}

async function loadPendingEmails(){
  state.dailyBusy=true; render();
  try{
    const json=await payrollPost({action:'pending'});
    state.dailyPending=json.emails||[];
  }catch(err){
    state.dailyPending=null;
    toast('Could not load ingestion issues: '+err.message,'error');
  }
  state.dailyBusy=false; render();
}

// Closing a queue entry is permanent and quiet: the row leaves the actionable
// list and the morning missed-delivery check never mentions it again. That is
// the point — one ambiguous delivery used to mail Peter every single morning
// with nothing anyone could do about it — but it also means this is the one
// control here that can hide a real problem, so the prompt says so.
async function resolveIngestionEmail(messageId){
  const note=prompt('Mark this ingestion issue as handled?\n\nResolving is permanent: this item leaves the queue and is never reported again — the daily missed-delivery check skips it for good. Only close one that has actually been dealt with.\n\nOptional note (kept alongside the original error as the audit trail):','');
  if(note===null) return;
  state.dailyBusy=true; render();
  try{
    const body={action:'resolveEmail',messageId};
    const n=String(note).trim(); if(n) body.note=n;
    await payrollPost(body);
    toast('Marked handled — this item will not be reported again','success');
    await loadPendingEmails();
  }catch(err){
    toast('Could not mark it handled: '+err.message,'error');
  }
  state.dailyBusy=false; render();
}

// The days action omits dates that have no rows, so gaps have to be derived from
// the range itself. BBSI sends the report seven days a week, so ANY past day
// with nothing imported is a probable missed delivery — weekends included. This
// used to skip Fri–Sun as unknowable, which was true of the mill's schedule and
// never true of the vendor's.
function missingDays(){
  const have={};
  (state.dailyDays||[]).forEach(d=>{have[d.workDate]=true;});
  const today=isoToday();
  const out=[];
  let cur=state.dailyFrom, guard=0;
  while(cur&&state.dailyTo&&cur<=state.dailyTo&&guard++<400){
    if(cur<today&&!have[cur]) out.push(cur);
    cur=isoShift(cur,1);
  }
  return out;
}

const dailyStyle=`<style>
  .dh-panel{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:16px;margin-bottom:24px}
  .dh-row{display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap}
  .dh-field{display:flex;flex-direction:column;gap:5px}
  .dh-field label{font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}
  .dh-field input[type=date],.dh-field input[type=file]{font-family:var(--font);font-size:12px;border:1px solid var(--border);border-radius:4px;padding:7px 10px;background:var(--surface);color:var(--text)}
  .dh-note{font-size:11px;color:var(--textDim);line-height:1.5;background:var(--surface2);border:1px solid var(--border);border-left:3px solid var(--gold);border-radius:4px;padding:8px 12px;margin-top:12px}
  .dh-stat{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:14px 0}
  .dh-stat div{border:1px solid var(--border);border-radius:6px;padding:10px 12px}
  .dh-stat .k{font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}
  .dh-stat .v{font-size:18px;font-weight:800;margin-top:4px}
  .dh-flag{background:#fce8e8;border:1px solid #e0a5a5;border-radius:4px;padding:10px 12px;margin-bottom:10px;font-size:12px;color:#7a1f1f}
  .dh-warn{background:#fef5e8;border:1px solid #e6b87f;border-radius:4px;padding:10px 12px;margin-bottom:10px;font-size:12px;color:#6b4a0a}
  .dh-ok{font-size:12px;color:#2a7a47;font-weight:600}
  .dh-chip{display:inline-block;font-size:11px;background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:2px 8px;margin:2px 3px 2px 0}
  .dh-ack{display:flex;gap:8px;align-items:flex-start;margin-top:10px;padding:8px 10px;background:var(--surface);border:1px solid #e0a5a5;border-radius:4px;cursor:pointer;font-weight:600;line-height:1.45}
  .dh-ack input{margin-top:2px;width:16px;height:16px;flex-shrink:0;cursor:pointer;accent-color:var(--brick)}
  .dh-qhead{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;margin:14px 0 6px}
  tr.dh-quiet td{background:var(--surface2);color:var(--muted)}
  tr.dh-quiet td.sub{font-weight:400}
  td.num,th.num{text-align:right}
  tr.nonsched-row td{background:#fffdf7}
</style>`;

function renderDailyPreview(){
  const p=state.dailyPreview;
  if(!p) return '';
  const v=p.validation||{errors:[],warnings:[]};
  const errors=v.errors||[], warnings=v.warnings||[];
  const dup=p.duplicateFileHash;
  const crossDate=!!(dup&&!dup.sameDate);
  const blocked=errors.length>0||(crossDate&&!state.dailyDupAck);
  const counts=p.counts||{}, totals=p.totals||{};
  const depts=p.departments||[];
  const empCount=depts.reduce((s,d)=>s+(d.employees||0),0);
  const btnLabel=p.existing?('Overwrite '+(p.existing.rowCount||0)+' existing rows'):('Import '+(counts.imported||0)+' rows');
  return `
    <div class="modal-bg" onclick="if(event.target===this)cancelDailyPreview()">
      <div class="modal" style="max-width:920px">
        <div class="modal-title" style="padding:20px 28px 0;flex-shrink:0">
          <span>Import preview — ${fmtDate(p.workDate)} · ${esc(p.dayName||dayNameOf(p.workDate))}<div style="font-size:11px;font-weight:400;color:var(--muted);margin-top:2px">${esc(p.fileName||'')}${p.sheetName?' · sheet “'+esc(p.sheetName)+'”':''}</div></span>
          <button class="close-btn" onclick="cancelDailyPreview()">×</button>
        </div>
        <div class="modal-body" style="padding:20px 24px">
          <div style="margin-bottom:12px">${schedBadge(p.isScheduledDay)}</div>

          ${p.existing?`<div class="dh-flag"><strong>${fmtDate(p.workDate)} already has ${p.existing.rowCount||0} imported rows</strong>
            (source ${esc(p.existing.source||'unknown')}, imported ${fmtStamp(p.existing.createdAt)}${(p.existing.batchCount||1)>1?', across '+p.existing.batchCount+' separate imports':''}).
            Importing deletes the day and re-inserts it, so anyone dropped from a corrected re-send disappears too.</div>`:''}
          ${dup?(dup.sameDate
            ? `<div class="dh-warn"><strong>These exact bytes are already imported under this same date</strong> (${dup.rowCount||0} rows, imported ${fmtStamp(dup.createdAt)}). Re-uploading the same file for the same day is harmless — it replaces the day with identical rows, and nothing extra is asked of you.</div>`
            : `<div class="dh-flag"><strong>These exact bytes are already imported under ${fmtDate(dup.workDate)}</strong>
                (${dup.rowCount||0} rows, imported ${fmtStamp(dup.createdAt)}). Filing the same file under ${fmtDate(p.workDate)} as well counts that one day's payroll twice — in this week's report and in every report built on it afterwards.
                If ${fmtDate(dup.workDate)} was the wrong date, close this and use <strong>Correct date</strong> on the imported days list instead of importing the file a second time.
                <label class="dh-ack"><input type="checkbox" ${state.dailyDupAck?'checked':''} onchange="ackDuplicateFile(this.checked)">
                <span>I have checked both dates. ${fmtDate(dup.workDate)} and ${fmtDate(p.workDate)} are genuinely two different work days that happen to have identical payroll files — import this one as well.</span></label></div>`):''}
          ${errors.length?`<div class="dh-flag"><strong>Cannot import:</strong><ul style="margin:6px 0 0 18px">${errors.map(e=>'<li>'+esc(e)+'</li>').join('')}</ul></div>`:''}
          ${warnings.length?`<div class="dh-warn"><strong>Worth checking:</strong><ul style="margin:6px 0 0 18px">${warnings.map(w=>'<li>'+esc(w)+'</li>').join('')}</ul></div>`:''}

          <div class="dh-stat">
            <div><div class="k">Rows to import</div><div class="v">${counts.imported||0}</div><div style="font-size:11px;color:var(--muted)">of ${counts.totalRows||0} in the file</div></div>
            <div><div class="k">Employees</div><div class="v">${empCount}</div></div>
            <div><div class="k">Total hours</div><div class="v">${fmtHrs(totals.totalHours)}</div></div>
            <div><div class="k">Total earnings</div><div class="v">${fmt$(totals.totalEarnings)}</div></div>
            <div><div class="k">OT hours</div><div class="v">${fmtHrs(totals.otHours)}</div></div>
            <div><div class="k">OT dollars</div><div class="v">${fmt$(totals.otDollars)}</div></div>
          </div>

          <div class="dh-note"><strong>${counts.salariedSkipped||0} salaried row${(counts.salariedSkipped||0)===1?'':'s'} skipped.</strong>
            Salaried staff are excluded by design, so every figure in this system — hours, earnings, OT and the percentages built on them — is hourly payroll only.
            ${(counts.salariedWithHoursSkipped||0)>0?`<strong>${counts.salariedWithHoursSkipped} of them carried hours or earnings and were skipped too</strong> &mdash; flagged salaried_with_hours in the anomalies below, because a salaried row with activity on it means the payroll file changed shape.`:''}</div>

          ${(p.anomalies||[]).length?`<div class="dh-flag" style="margin-top:12px"><strong>${p.anomalies.length} anomal${p.anomalies.length===1?'y':'ies'} in this file:</strong>
            <table style="width:100%;font-size:11px;margin-top:6px">
              ${p.anomalies.map(a=>`<tr><td style="padding:2px 6px 2px 0;white-space:nowrap">${esc(a.name||('#'+a.employeeNumber))}</td><td style="padding:2px 6px 2px 0;font-weight:700">${esc(a.type)}</td><td style="padding:2px 0;white-space:normal">${esc(a.detail||'')}</td></tr>`).join('')}
            </table></div>`:''}

          <div class="section-head" style="margin-top:16px"><span>By department</span></div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Department</th><th class="num">Employees</th><th class="num">Reg hrs</th><th class="num">OT hrs</th><th class="num">Total hrs</th><th class="num">OT $</th><th class="num">Earnings</th></tr></thead>
              <tbody>
                ${depts.length?depts.map(d=>`<tr${(d.department===null||d.department==='Unassigned')?' style="background:#fef5e8"':''}>
                  <td style="font-weight:600">${esc(d.department||'Unassigned')}</td>
                  <td class="num">${d.employees||0}</td>
                  <td class="num">${fmtHrs(d.regularHours)}</td>
                  <td class="num">${fmtHrs(d.otHours)}</td>
                  <td class="num">${fmtHrs(d.totalHours)}</td>
                  <td class="num">${fmt$(d.otDollars)}</td>
                  <td class="num">${fmt$(d.totalEarnings)}</td>
                </tr>`).join(''):'<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:20px">No rows</td></tr>'}
              </tbody>
            </table>
          </div>

          ${(p.sample||[]).length?`
          <div class="section-head" style="margin-top:16px"><span>First ${p.sample.length} rows</span></div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Emp #</th><th>Name</th><th>Department</th><th class="num">Rate</th><th class="num">Reg</th><th class="num">OT</th><th class="num">Total hrs</th><th class="num">Earnings</th><th class="num">OT $</th><th>Flags</th></tr></thead>
              <tbody>${p.sample.map(s=>`<tr>
                <td>${esc(s.employeeNumber)}</td>
                <td style="font-weight:600">${esc(s.name||'')}</td>
                <td${s.department?'':' style="color:#9a600a"'}>${esc(s.department||'Unassigned')}</td>
                <td class="num">${fmt$(s.payRate)}</td>
                <td class="num">${fmtHrs(s.regularHours)}</td>
                <td class="num">${fmtHrs(s.otHours)}</td>
                <td class="num">${fmtHrs(s.totalHours)}</td>
                <td class="num">${fmt$(s.totalEarnings)}</td>
                <td class="num">${fmt$(s.otDollars)}</td>
                <td style="font-size:10px">${(s.flags||[]).map(f=>'<span class="dh-chip">'+esc(f)+'</span>').join('')}</td>
              </tr>`).join('')}</tbody>
            </table>
          </div>`:''}

          ${(p.unmatched||[]).length?`<div class="dh-warn"><strong>${p.unmatched.length} employee number(s) are not on the roster:</strong>
            ${p.unmatched.map(u=>`<span class="dh-chip">#${esc(u.employeeNumber)} ${esc([u.firstName,u.lastName].filter(Boolean).join(' '))}</span>`).join('')}
            <div style="font-size:11px;margin-top:4px">Their hours import, but they carry no name and no department until the employee # is on the roster. Edit the matching person on the Employees tab and set their Employee #.</div>
            <div style="margin-top:8px"><button class="btn btn-outline btn-sm" onclick="goToTab('employees')">Set employee # on the Employees tab</button></div></div>`:''}
          ${(p.missingDepartment||[]).length?`<div class="dh-warn"><strong>${p.missingDepartment.length} matched employee(s) have no payroll department</strong> — their rows import as Unassigned:
            ${p.missingDepartment.map(m=>`<span class="dh-chip">${esc(m.name||('#'+m.employeeNumber))}</span>`).join('')}
            <div style="font-size:11px;margin-top:4px">Edit each of them on the Employees tab and set a Department, then re-stamp this date — the department on a daily row is a snapshot taken at import.</div>
            <div style="margin-top:8px"><button class="btn btn-outline btn-sm" onclick="goToTab('employees')">Set department on the Employees tab</button></div></div>`:''}
        </div>
        <div class="modal-footer">
          <button class="btn btn-outline" onclick="cancelDailyPreview()">Cancel</button>
          <button class="btn btn-primary" ${blocked||state.dailyBusy?'disabled style="opacity:.5;cursor:not-allowed"':''} onclick="${blocked?'':'commitDailyImport()'}">${state.dailyBusy?'Working…':btnLabel}</button>
        </div>
      </div>
    </div>`;
}

function renderDailyHours(){
  const days=state.dailyDays||[];
  const pending=state.dailyPending;
  // actionable comes from the server; fall back to the same two statuses it uses
  // so a row from an older response is never quietly filed as "nothing to do".
  const isActionable=e=>e.actionable!==undefined?!!e.actionable:(e.status==='pending_review'||e.status==='error');
  const pendAct=pending?pending.filter(isActionable):[];
  const pendLog=pending?pending.filter(e=>!isActionable(e)):[];
  const li=state.dailyLastImport;
  const rr=state.restampResult;
  const gaps=state.dailyLoaded?missingDays():[];

  const upload=`
    <div class="section-head"><span>Import a day</span></div>
    <div class="dh-panel">
      <div class="dh-row">
        <div class="dh-field" style="flex:1;min-width:260px">
          <label>Payroll file (.xlsx)</label>
          <input type="file" id="dhFile" accept=".xlsx">
        </div>
        <div class="dh-field">
          <label>Work date (required)</label>
          <input type="date" id="dhDate" value="${state.dailyWorkDate||''}" oninput="state.dailyWorkDate=this.value">
        </div>
        <button class="btn btn-primary" ${state.dailyBusy?'disabled style="opacity:.5"':''} onclick="previewDailyFile()">${state.dailyBusy?'Working…':'Preview import'}</button>
      </div>
      <div class="dh-note">The payroll file contains no date — not in a column, not in the sheet name, nowhere — so the work date has to be chosen here. Nothing is hunting for one inside the file.
        Mon–Thu is the scheduled block and Fri–Sun is non-scheduled; both are normal work days.</div>
      ${li?`<div class="${li.removed?'dh-flag':'dh-ok'}" style="margin-top:12px${li.removed?'':';padding:8px 12px'}">
        <strong>Last import — ${fmtDate(li.workDate)}:</strong> ${li.inserted} row${li.inserted===1?'':'s'} written${li.replaced?', '+li.replaced+' replaced':''}${li.removed
          ? `, and <strong>${li.removed} employee${li.removed===1?'':'s'} removed from the day</strong> — ${li.removed===1?'that person was':'those people were'} on the earlier file for ${fmtDate(li.workDate)} and ${li.removed===1?'is':'are'} not on this one, so ${li.removed===1?'their':'their'} hours and earnings are gone from ${fmtDate(li.workDate)} and from every report that covers it.`
          : '. Nobody was dropped from the day.'}</div>`:''}
    </div>`;

  const list=`
    <div class="section-head">
      <span>Imported days</span>
      <span style="font-weight:400;text-transform:none;letter-spacing:0;display:flex;gap:8px;align-items:center">
        <input type="date" value="${state.dailyFrom||''}" onchange="state.dailyFrom=this.value" style="font-family:var(--font);font-size:12px;border:1px solid var(--border);border-radius:4px;padding:5px 8px">
        <span style="color:var(--muted)">to</span>
        <input type="date" value="${state.dailyTo||''}" onchange="state.dailyTo=this.value" style="font-family:var(--font);font-size:12px;border:1px solid var(--border);border-radius:4px;padding:5px 8px">
        <button class="btn btn-outline btn-sm" onclick="loadDailyDays()">Load</button>
      </span>
    </div>
    ${state.dailyLoading?'<div class="loading-state">Loading imported days…</div>':`
    ${gaps.length?`<div class="dh-warn"><strong>${gaps.length} day${gaps.length===1?'':'s'} in this range have no data at all:</strong>
      ${gaps.map(g=>'<span class="dh-chip">'+fmtDate(g)+' · '+dayNameOf(g)+'</span>').join('')}
      <div style="font-size:11px;margin-top:4px">BBSI sends the report every day, so each of those is a probable missed delivery — weekends included. Import it by hand, or check the "payroll import" label in info@.</div></div>`:''}
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th style="width:120px">Date</th><th style="width:180px">Classification</th><th style="width:150px">Source</th>
          <th class="num">People</th><th class="num">Hours</th><th class="num">OT hrs</th><th class="num">Earnings</th>
          <th style="width:150px">Data quality</th><th style="width:190px"></th>
        </tr></thead>
        <tbody>
          ${days.length?days.map(d=>{ /* newest first, and days with no rows are not returned at all */
            // dateSource is null on an empty day, one value when the rows agree
            // and a comma-joined list when they disagree.
            const inferred=String(d.dateSource||'').includes('email_received');
            const src=String(d.source||'manual');
            return `<tr class="${d.isScheduledDay?'':'nonsched-row'}">
              <td style="font-weight:600">${fmtDate(d.workDate)}<div style="font-size:11px;color:var(--muted);font-weight:400">${esc(d.dayName||dayNameOf(d.workDate))}</div></td>
              <td>${schedBadge(d.isScheduledDay)}</td>
              <td>
                <span class="badge ${src.includes('email')?'en':'inactive'}">${esc(src)}</span>
                ${inferred?`<div style="font-size:10px;color:#9a600a;font-weight:700;margin-top:4px">inferred from email arrival</div>
                  <div style="font-size:10px;color:var(--muted)">received ${fmtStamp(d.emailReceivedAt)}</div>`:''}
              </td>
              <td class="num">${d.employees||0}</td>
              <td class="num">${fmtHrs(d.totalHours)}</td>
              <td class="num">${fmtHrs(d.otHours)}</td>
              <td class="num">${fmt$(d.totalEarnings)}</td>
              <td style="font-size:11px">
                ${d.flagCount?`<div style="color:var(--brick);font-weight:700">${d.flagCount} flagged</div>`:''}
                ${d.unassignedCount?`<div style="color:#9a600a;font-weight:700">${d.unassignedCount} unassigned <button class="btn btn-outline btn-sm" style="padding:1px 6px;font-size:10px" onclick="goToTab('employees')">fix on Employees</button></div>`:''}
                ${!d.flagCount&&!d.unassignedCount?'<span style="color:#2a7a47">clean</span>':''}
              </td>
              <td>
                <button class="btn btn-outline btn-sm" onclick="correctDailyDate('${esc(d.uploadBatchId)}','${d.workDate}')">Correct date</button>
                <button class="btn btn-outline btn-sm" onclick="deleteDailyDay('${d.workDate}',${d.rowCount||0})">Delete day</button>
              </td>
            </tr>`;
          }).join(''):'<tr><td colspan="9" style="text-align:center;color:var(--muted);padding:32px">No days imported in this range.</td></tr>'}
        </tbody>
      </table>
    </div>`}`;

  const admin=`
    <div class="section-head"><span>Admin actions</span></div>
    <div class="dh-panel">
      <div style="font-size:12px;font-weight:700;margin-bottom:6px">Re-stamp departments</div>
      <div style="font-size:11px;color:var(--textDim);line-height:1.5;margin-bottom:10px">
        <code>daily_hours</code> stores a department snapshot taken at import, so a transfer never silently rewrites historical reports.
        That is also why this is manual and explicitly scoped: run it only over dates imported before the back-fill was done.
      </div>
      <div class="dh-row">
        <div class="dh-field"><label>From</label><input type="date" value="${state.restampFrom||''}" onchange="state.restampFrom=this.value"></div>
        <div class="dh-field"><label>To</label><input type="date" value="${state.restampTo||''}" onchange="state.restampTo=this.value"></div>
        <button class="btn btn-outline" ${state.dailyBusy?'disabled style="opacity:.5"':''} onclick="restampDepartments()">Re-stamp departments</button>
      </div>
      ${rr?`<div style="margin-top:10px;font-size:12px">Scanned <strong>${rr.scanned}</strong> rows · updated <strong>${rr.updated}</strong> · still unassigned <strong style="color:${rr.stillUnassigned?'var(--brick)':'#2a7a47'}">${rr.stillUnassigned}</strong>${rr.stillUnassigned?' — those employee numbers still have no payroll department on the roster.':''}
        ${(rr.changes||[]).length?`<div style="margin-top:8px">${rr.changes.slice(0,12).map(c=>`<span class="dh-chip">${fmtDateShort(c.workDate)} · #${esc(c.employeeNumber)} · ${esc(c.from||'Unassigned')} → ${esc(c.to||'Unassigned')}</span>`).join('')}
          ${rr.changes.length>12?`<span style="color:var(--muted)">and ${rr.changes.length-12} more</span>`:''}</div>`:''}</div>`:''}
    </div>

    <div class="dh-panel">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <div style="font-size:12px;font-weight:700">Ingestion issues</div>
        <button class="btn btn-outline btn-sm" ${state.dailyBusy?'disabled style="opacity:.5"':''} onclick="loadPendingEmails()">Check the email pipeline</button>
      </div>
      <div style="font-size:11px;color:var(--textDim);margin-bottom:10px">Payroll emails that did not end up imported — duplicates, rejects, errors and anything held for review.
        Only the first group is waiting on a decision; the rest is the ingester working correctly and saying so.</div>
      ${pending===null?'<div style="font-size:12px;color:var(--muted)">Not checked yet.</div>'
        :!pending.length?'<div class="dh-ok">No ingestion problems — every payroll email was imported.</div>'
        :`${pendAct.length?`<div class="dh-qhead" style="color:var(--brick)">${pendAct.length} waiting on you</div>
          <div class="table-wrap" style="margin-bottom:0"><table>
            <thead><tr><th style="width:110px">Status</th><th style="width:150px">Waiting</th><th style="width:110px">Work date</th><th>Subject</th><th>Error</th><th style="width:120px">Flags</th><th style="width:120px"></th></tr></thead>
            <tbody>${pendAct.map(e=>`<tr>
              <td><span class="badge ${e.status==='error'?'disc':'inactive'}">${esc(e.status)}</span></td>
              <td style="font-size:11px">
                <div style="font-weight:700;color:${waitedColor(e.received_at)}">${esc(waitedLabel(e.received_at))}</div>
                <div style="color:var(--muted)">arrived ${fmtStamp(e.received_at)}</div>
                <div style="color:var(--muted)">${e.notified_at?'alerted '+fmtStamp(e.notified_at):'never alerted'}</div>
              </td>
              <td>${e.work_date?fmtDate(e.work_date):'—'}</td>
              <td style="white-space:normal;max-width:300px">${esc(e.subject||'—')}
                <div style="font-size:10px;color:var(--muted)">from ${esc(e.from_address||'unknown sender')}</div></td>
              <td style="white-space:normal;max-width:280px;font-size:11px;color:var(--brick)">${esc(e.error||'')}</td>
              <td style="font-size:11px">${(e.flags||[]).map(f=>'<span class="dh-chip">'+esc(f)+'</span>').join('')}</td>
              <td><button class="btn btn-outline btn-sm" ${state.dailyBusy?'disabled style="opacity:.5"':''} onclick="resolveIngestionEmail('${jsStr(e.message_id)}')">Mark handled</button></td>
            </tr>`).join('')}</tbody>
          </table></div>
          <div style="font-size:11px;color:var(--textDim);margin-top:6px"><strong>Mark handled</strong> closes an item for good: it leaves this list and the daily missed-delivery check never reports it again. Use it once the day has been imported by hand or the email has been confirmed as not a payroll file.</div>`
          :'<div class="dh-ok">Nothing is waiting on you — no held or failed deliveries.</div>'}
        ${pendLog.length?`<div class="dh-qhead" style="color:var(--muted)">${pendLog.length} logged · no action needed</div>
          <div class="table-wrap" style="margin-bottom:0"><table>
            <thead><tr><th style="width:110px">Status</th><th style="width:110px">Work date</th><th>Subject</th><th style="width:150px">Received</th><th>Detail</th><th style="width:120px">Flags</th></tr></thead>
            <tbody>${pendLog.map(e=>`<tr class="dh-quiet">
              <td class="sub"><span class="badge inactive">${esc(e.status)}</span></td>
              <td class="sub">${e.work_date?fmtDate(e.work_date):'—'}</td>
              <td class="sub" style="white-space:normal;max-width:300px">${esc(e.subject||'—')}
                <div style="font-size:10px">from ${esc(e.from_address||'unknown sender')}</div></td>
              <td class="sub" style="font-size:11px">${fmtStamp(e.received_at)}</td>
              <td class="sub" style="white-space:normal;max-width:280px;font-size:11px">${esc(e.error||'')}</td>
              <td class="sub" style="font-size:11px">${(e.flags||[]).map(f=>'<span class="dh-chip">'+esc(f)+'</span>').join('')}</td>
            </tr>`).join('')}</tbody>
          </table></div>`:''}`}
    </div>`;

  return dailyStyle+upload+list+admin+(state.dailyPreview?renderDailyPreview():'');
}
