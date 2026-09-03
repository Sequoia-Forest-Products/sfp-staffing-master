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
  }catch(err){
    toast('Import failed: '+err.message,'error');
  }
  // An import used to send the manager email from here, in the browser, when
  // autoSend was on. It was the only automatic sender and it quietly stopped
  // being reachable: hours arrive by email now, collected hourly by the
  // payroll-email-ingest function, and nothing about that path opens a browser
  // or runs this file. The checkbox stayed on and the email stopped going out.
  //
  // The automatic send is now netlify/functions/ot-weekly-email.js — a Monday
  // schedule over the week that just finished, which cannot be bypassed by a
  // change to how the data arrives. Nothing replaces it here on purpose: two
  // automatic senders covering different weeks is worse than one.
  //
  // The "Email managers" button on the OT Report tab is untouched, so a
  // corrected import can still be sent out by hand straight away.
  state.dailyBusy=false; render();
}

async function loadDailyDays(){
  if(!state.dailyFrom||!state.dailyTo){state.dailyTo=isoToday();state.dailyFrom=isoShift(state.dailyTo,-30);}
  state.dailyLoading=true; render();
  try{
    const json=await payrollPost({action:'days',from:state.dailyFrom,to:state.dailyTo});
    state.dailyDays=json.days||[];
    // Set when the delivery ledger could not be read. Every empty day then reads
    // as missing, which is the safe direction, but the table has to say so
    // rather than let a day nobody worked look like a failed delivery.
    state.dailyDeliveryUnavailable=!!json.deliveryUnavailable;
    state.dailyRosterUnavailable=!!json.rosterUnavailable;
    state.dailyLoaded=true;
  }catch(err){
    state.dailyDays=[];
    state.dailyDeliveryUnavailable=false;
    toast('Could not load the day list: '+err.message,'error');
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

// The confirmation already existed and is kept — moving the button into the
// overflow is on top of it, not instead of it. What it now names is what is
// actually being destroyed: the hours and the headcount, not just a row count.
// "37 rows" is not a quantity anybody can weigh; "37 rows · 312.50 hrs · 37
// people" is.
async function deleteDailyDay(workDate,rowCount,totalHours,people){
  const scale=rowCount+' row'+(rowCount===1?'':'s')
    +(totalHours?' · '+fmtHrs(totalHours)+' hrs':'')
    +(people?' · '+people+' '+(people===1?'person':'people'):'');
  if(!confirm('Delete '+scale+' imported for '+fmtDate(workDate)+'?\n\n'
    +'This cannot be undone. The day disappears from the OT report, the weekly '
    +'manager email and every cost report that covers it, and would have to be '
    +'imported again.')) return;
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

// Every date in the range now comes back from /api/payroll-import days, including
// the ones with no rows, each carrying a `state`. Gaps used to be derived here by
// walking the range and subtracting what came back — which could only ever
// produce one kind of absence, and so reported a day nobody worked and a day
// whose file never arrived as the same thing.
//
// The five states are decided server-side (see dayState in payroll-import.js).
// This is only how they read.
const DAY_STATES={
  data:null,
  'no-hours':{
    label:'No hours reported',
    hint:'The file arrived and was imported. Nobody logged time.',
    color:'var(--muted)', tone:'quiet'
  },
  'not-imported':{
    label:'File arrived, not imported',
    hint:'Waiting on a decision — see Ingestion issues below.',
    color:'#9a600a', tone:'warn'
  },
  'no-file':{
    label:'No file received',
    hint:'BBSI sends every day, so this one did not arrive, was not labelled, or failed to import.',
    color:'var(--brick)', tone:'bad'
  },
  future:{
    label:'Not yet due',
    hint:'This day has not happened yet.',
    color:'var(--muted)', tone:'quiet'
  }
};

function dayStateOf(d){ return DAY_STATES[d&&d.state]||null; }

function countDayStates(){
  const c={data:0,'no-hours':0,'not-imported':0,'no-file':0,future:0};
  (state.dailyDays||[]).forEach(d=>{ if(c[d.state]!==undefined) c[d.state]++; });
  return c;
}

// The Data Quality panel names people and links to them. daily_hours carries an
// employee_number; the profile card is opened by employees.id, so the roster
// already in memory is what bridges the two. Somebody the roster has never heard
// of (an unknown_employee flag) has no card to open, and gets named without a
// link rather than a link that goes nowhere.
// THE FIELD IS empNum, NOT employee_number. loadData() in data.js renames the
// column when it maps a roster row (`empNum:r.employee_number||''`), so a lookup
// on e.employee_number reads undefined for every person and quietly reports the
// whole roster as unknown. That is exactly what shipped: every named person on
// this tab came back "(not on the roster)", including people who are on it and
// fully classified.
//
// It survived a test because the test built its own fixture with a
// employee_number field — a fixture that agreed with the bug. The test now
// builds its roster row through the same mapping data.js uses.
function employeeIdForNumber(employeeNumber){
  const n=String(employeeNumber==null?'':employeeNumber).trim();
  if(!n) return null;
  const hit=(state.employees||[]).find(e=>String(e.empNum||'').trim()===n);
  return hit?hit.id:null;
}

function personChip(p){
  const label=p.name||('#'+(p.employeeNumber||'?'));
  const id=employeeIdForNumber(p.employeeNumber);
  if(id) return `<a href="#" onclick="event.preventDefault();goToEmployeeProfile('${esc(String(id))}')" style="color:inherit;text-decoration:underline;cursor:pointer">${esc(label)}</a>`;
  // No match and no roster in memory are different answers. loadData() runs at
  // bootstrap, but this tab can render first, and "not on the roster" is a
  // serious claim to make about somebody because the page was early.
  if(!(state.employees||[]).length) return esc(label);
  return `${esc(label)}<span style="font-weight:400;color:var(--muted)"> (not on the roster)</span>`;
}

function namedList(people,omitted){
  const names=(people||[]).map(personChip).join(', ');
  return names+(omitted>0?`<span style="font-weight:400;color:var(--muted)"> and ${omitted} more</span>`:'');
}

// The row's two rare actions, both behind this rather than on the row.
//
// "Correct date" is a hedge against date inference going wrong and is used
// roughly never. It is not deleted: the work date is still derived from when
// the email arrived, and if BBSI ever sends late enough to cross midnight a day
// genuinely lands on the wrong date with nothing else able to move it.
//
// "Delete day" is here because it is the most destructive thing on this screen —
// it drops a day of imported hours out of every report built on it — and it was
// a primary button on every row, one stray click from gone. It keeps its
// confirmation on top of that.
//
// THE MENU IS RENDERED INLINE, IN NORMAL FLOW, and that is load-bearing rather
// than a style choice. The first version positioned it absolutely inside the
// cell, and app.html's `.table-wrap{overflow:hidden}` clipped it away entirely:
// the markup was in the DOM, a test asserting the markup passed, and clicking
// the button did visibly nothing. Anything absolutely positioned inside that
// wrapper has the same fate.
function toggleDayMenu(workDate){
  state.dailyMenu=state.dailyMenu===workDate?null:workDate;
  render();
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
  .dh-menu{margin-top:6px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:8px;min-width:200px}
  .dh-menu-note{font-size:10px;color:var(--muted);margin-top:5px;line-height:1.4}
  .dh-danger{background:var(--brick);border:1px solid var(--brick);color:#fff;font-weight:700}
  .dh-qhead{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;margin:14px 0 6px}
  tr.dh-quiet td{background:var(--surface2);color:var(--muted)}
  tr.dh-quiet td.sub{font-weight:400}
  td.num,th.num{text-align:right}
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
            <div><div class="k">Regular hours</div><div class="v">${fmtHrs(totals.regularHours)}</div></div>
            <div><div class="k">OT hours</div><div class="v">${fmtHrs(totals.otHours)}</div></div>
            <div><div class="k">Total hours</div><div class="v">${fmtHrs(totals.totalHours)}</div></div>
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
              <thead><tr><th>Department</th><th class="num">Employees</th><th class="num">Reg hrs</th><th class="num">OT hrs</th><th class="num">Total hrs</th></tr></thead>
              <tbody>
                ${depts.length?depts.map(d=>`<tr${(d.department===null||d.department==='Unassigned')?' style="background:#fef5e8"':''}>
                  <td style="font-weight:600">${esc(d.department||'Unassigned')}</td>
                  <td class="num">${d.employees||0}</td>
                  <td class="num">${fmtHrs(d.regularHours)}</td>
                  <td class="num">${fmtHrs(d.otHours)}</td>
                  <td class="num">${fmtHrs(d.totalHours)}</td>
                </tr>`).join(''):'<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:20px">No rows</td></tr>'}
              </tbody>
            </table>
          </div>

          ${(p.sample||[]).length?`
          <div class="section-head" style="margin-top:16px"><span>First ${p.sample.length} rows</span></div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Emp #</th><th>Name</th><th>Department</th><th class="num">Reg</th><th class="num">OT</th><th class="num">Total hrs</th><th>Flags</th></tr></thead>
              <tbody>${p.sample.map(s=>`<tr>
                <td>${esc(s.employeeNumber)}</td>
                <td style="font-weight:600">${esc(s.name||'')}</td>
                <td${s.department?'':' style="color:#9a600a"'}>${esc(s.department||'Unassigned')}</td>
                <td class="num">${fmtHrs(s.regularHours)}</td>
                <td class="num">${fmtHrs(s.otHours)}</td>
                <td class="num">${fmtHrs(s.totalHours)}</td>
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

  const upload=`
    <div class="section-head"><span>Import hours file</span></div>
    <div class="dh-panel">
      <div class="dh-row">
        <div class="dh-field" style="flex:1;min-width:260px">
          <label>Hours file (.xlsx)</label>
          <input type="file" id="dhFile" accept=".xlsx">
        </div>
        <div class="dh-field">
          <label>Work date this file covers</label>
          <input type="date" id="dhDate" value="${state.dailyWorkDate||''}" oninput="state.dailyWorkDate=this.value">
        </div>
        <button class="btn btn-primary" ${state.dailyBusy?'disabled style="opacity:.5"':''} onclick="previewDailyFile()">${state.dailyBusy?'Working…':'Preview import'}</button>
      </div>
      ${li?`<div class="${li.removed?'dh-flag':'dh-ok'}" style="margin-top:12px${li.removed?'':';padding:8px 12px'}">
        <strong>Last import — ${fmtDate(li.workDate)}:</strong> ${li.inserted} row${li.inserted===1?'':'s'} written${li.replaced?', '+li.replaced+' replaced':''}${li.removed
          ? `, and <strong>${li.removed} employee${li.removed===1?'':'s'} removed from the day</strong> — ${li.removed===1?'that person was':'those people were'} on the earlier file for ${fmtDate(li.workDate)} and ${li.removed===1?'is':'are'} not on this one, so ${li.removed===1?'their':'their'} hours and earnings are gone from ${fmtDate(li.workDate)} and from every report that covers it.`
          : '. Nobody was dropped from the day.'}</div>`:''}
    </div>`;

  const st=countDayStates();
  const list=`
    <div class="section-head">
      <span>Every day</span>
      <span style="font-weight:400;text-transform:none;letter-spacing:0;display:flex;gap:8px;align-items:center">
        <input type="date" value="${state.dailyFrom||''}" onchange="state.dailyFrom=this.value" style="font-family:var(--font);font-size:12px;border:1px solid var(--border);border-radius:4px;padding:5px 8px">
        <span style="color:var(--muted)">to</span>
        <input type="date" value="${state.dailyTo||''}" onchange="state.dailyTo=this.value" style="font-family:var(--font);font-size:12px;border:1px solid var(--border);border-radius:4px;padding:5px 8px">
        <button class="btn btn-outline btn-sm" onclick="loadDailyDays()">Load</button>
      </span>
    </div>
    ${state.dailyLoading?'<div class="loading-state">Loading days…</div>':`
    ${state.dailyDeliveryUnavailable?`<div class="dh-warn"><strong>The delivery ledger could not be read.</strong>
      A day with no hours cannot be told apart from a day whose file never arrived, so every empty day below reads as missing. Reload in a minute.</div>`:''}
    <div style="font-size:11px;color:var(--muted);margin-bottom:8px">
      ${st.data} day${st.data===1?'':'s'} with hours${st['no-hours']?` · <strong style="color:var(--text)">${st['no-hours']} with none reported</strong>`:''}${st['not-imported']?` · <strong style="color:#9a600a">${st['not-imported']} arrived but not imported</strong>`:''}${st['no-file']?` · <strong style="color:var(--brick)">${st['no-file']} with no file at all</strong>`:''}
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th style="width:120px">Date</th><th style="width:170px">Source</th>
          <th class="num">People</th><th class="num">Hours</th><th class="num">OT hrs</th>
          <th style="width:230px">Data quality</th><th style="width:120px"></th>
        </tr></thead>
        <tbody>
          ${days.length?days.map(d=>{
            // dateSource is one value when the rows agree and a comma-joined
            // list when they disagree.
            const inferred=String(d.dateSource||'').includes('email_received');
            const src=String(d.source||'manual');
            const ds=dayStateOf(d);
            const dateCell=`<td style="font-weight:600">${fmtDate(d.workDate)}<div style="font-size:11px;color:var(--muted);font-weight:400">${esc(d.dayName||dayNameOf(d.workDate))}</div></td>`;

            // A day with no rows is a row like any other. It used to be a chip
            // in a banner above the table, which read as a warning about
            // something already dealt with and made a genuine gap easy to skim
            // past. Four columns of counts would all be zero and say nothing, so
            // the state says it once, in their place.
            if(ds){
              return `<tr class="dh-quiet">
                ${dateCell}
                <td colspan="4" style="color:${ds.color};font-weight:700">${esc(ds.label)}
                  <div style="font-size:11px;font-weight:400;color:var(--muted)">${esc(ds.hint)}</div></td>
                <td style="font-size:11px;color:var(--muted)">—</td>
                <td></td>
              </tr>`;
            }

            const menuOpen=state.dailyMenu===d.workDate;
            return `<tr>
              ${dateCell}
              <td>
                <span class="badge ${src.includes('email')?'en':'inactive'}">${esc(src)}</span>
                ${inferred?`<div style="font-size:10px;color:#9a600a;font-weight:700;margin-top:4px">inferred from email arrival</div>
                  <div style="font-size:10px;color:var(--muted)">received ${fmtStamp(d.emailReceivedAt)}</div>`:''}
              </td>
              <td class="num">${d.employees||0}</td>
              <td class="num">${fmtHrs(d.totalHours)}</td>
              <td class="num">${fmtHrs(d.otHours)}</td>
              <td style="font-size:11px;line-height:1.5">
                ${d.flagCount?`<div style="color:var(--brick);font-weight:700">${d.flagCount} flagged — ${namedList(d.flagged,d.flaggedOmitted)}
                  <div style="font-weight:400;color:var(--muted)">${esc([...new Set((d.flagged||[]).flatMap(f=>f.flags||[]))].join(', '))}</div></div>`:''}
                ${d.unassignedCount?`<div style="color:#9a600a;font-weight:700;margin-top:${d.flagCount?'4px':'0'}">${d.unassignedCount} unassigned — ${namedList(d.unassigned,d.unassignedOmitted)}
                  <div style="font-weight:400;color:var(--muted)">no payroll department on the roster — set one on their profile</div></div>`:''}
                ${d.staleCount?`<div style="color:var(--muted);font-weight:700;margin-top:${(d.flagCount||d.unassignedCount)?'4px':'0'}">${d.staleCount} stale department — ${namedList(d.stale,d.staleOmitted)}
                  <div style="font-weight:400">Classified on the roster${d.stale&&d.stale[0]&&d.stale[0].rosterDepartment?' ('+esc(d.stale[0].rosterDepartment)+')':''}, but this day was imported before that.
                  <code>daily_hours</code> stores the department as it was at import, on purpose. Use <strong>Re-stamp departments</strong> below to bring the day up to date — nothing needs changing on their profile.</div></div>`:''}
                ${!d.flagCount&&!d.unassignedCount&&!d.staleCount?'<span style="color:#2a7a47">clean</span>':''}
              </td>
              <td>
                <button class="btn btn-outline btn-sm" style="padding:2px 9px" title="${menuOpen?'Close':'More actions'}" onclick="toggleDayMenu('${d.workDate}')">${menuOpen?'✕':'⋯'}</button>
                ${menuOpen?`<div class="dh-menu">
                  <button class="btn btn-outline btn-sm" style="width:100%" onclick="toggleDayMenu('${d.workDate}');correctDailyDate('${esc(d.uploadBatchId)}','${d.workDate}')">Correct date</button>
                  <div class="dh-menu-note">The work date comes from when the email arrived. Use this only if a day landed on the wrong one.</div>
                  <button class="btn btn-sm dh-danger" style="width:100%;margin-top:8px" onclick="toggleDayMenu('${d.workDate}');deleteDailyDay('${d.workDate}',${d.rowCount||0},${Number(d.totalHours)||0},${d.employees||0})">Delete day</button>
                  <div class="dh-menu-note">Drops all ${d.rowCount||0} rows for this day. Every report covering it changes. Asks first.</div>
                </div>`:''}
              </td>
            </tr>`;
          }).join(''):'<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:32px">Pick a date range and press Load.</td></tr>'}
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
