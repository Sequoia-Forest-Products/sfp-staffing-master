// ot-report — the weekly OT Report tab over /api/payroll-report, and the manager
// email built from the same figures.
//
// Shares one global scope with the other files in src/js (see core.js).

// ============================================================
// OT REPORT — weekly view over /api/payroll-report
// ============================================================
// A RANGE WINS OVER THE WEEK, matching the endpoint and the cost report.
function otRangeActive(){
  return !!(String(state.otFrom||'').trim() && String(state.otTo||'').trim());
}

function otSetRangePart(which, value){
  if(which==='from') state.otFrom=value; else state.otTo=value;
  // Deliberately no reload and no render — see rangeControl() in core.js.
}

function otApplyRange(){
  if(!otRangeActive()){
    toast('Enter both a from and a to date — one on its own is not a period','error');
    return;
  }
  loadOTReport('');
}

function otClearRange(){
  state.otFrom=''; state.otTo='';
  loadOTReport(state.otReportWeek||'');
}

async function loadOTReport(week){
  state.otReportLoading=true; state.otReportError=''; render();
  try{
    const qs=new URLSearchParams();
    if(otRangeActive()){
      qs.set('from',String(state.otFrom).trim());
      qs.set('to',String(state.otTo).trim());
    }
    else if(week) qs.set('week',week);
    const res=await fetch('/api/payroll-report'+(qs.toString()?('?'+qs.toString()):''));
    if(res.status===401){location.href='/';return;}
    let json=null;
    try{json=await res.json();}catch(e){json=null;}
    if(!res.ok||!json||json.ok===false) throw new Error((json&&json.error)||('Request failed ('+res.status+')'));
    state.otReport=json.report||null;
    state.otReportWeeks=json.availableWeeks||[];
    // The week the dropdown should show. A RANGE MUST NOT OVERWRITE IT: the
    // report's weekStart is the range's first date when a range was asked for,
    // and storing that would leave the dropdown pointing at a week nobody chose
    // and Clear returning to it.
    if(!otRangeActive()) state.otReportWeek=(json.report&&json.report.weekStart)||week||'';
    // The endpoint scans a bounded window and says so rather than returning a
    // short answer that looks whole; the page has to repeat that out loud.
    state.otReportTruncated=json.truncated===true;
    state.otReportWindow=json.dataWindow||null;
  }catch(err){
    state.otReport=null; state.otReportError=err.message;
    state.otReportTruncated=false; state.otReportWindow=null;
    toast('Could not load the OT report: '+err.message,'error');
  }
  state.otReportLoading=false; render();
}

// ============================================================
// MANAGER OT EMAIL
// ============================================================

// The old email hardcoded 10%. It drives an over/under-budget flag managers act on,
// so it lives in emailSettings and is editable on the Settings tab.
// graceHrs() moved to core.js in Phase C task 4. It reads emailSettings and is
// now needed by the employee profile card as well as by this report, and a
// settings reader that two unrelated screens depend on does not belong in the OT
// report's module.
const OT_BUDGET_DEFAULT=10;
function otBudgetPct(){const v=Number(state.emailSettings.otBudgetPercent);return isFinite(v)&&v>=0?v:OT_BUDGET_DEFAULT;}

function otWeekRangeLabel(a,b){
  const pa=dateParts(a),pb=dateParts(b);
  if(!pa||!pb) return '—';
  const lbl=(iso,p)=>dayNameOf(iso).slice(0,3)+' '+MONTH_ABBR[p[1]-1]+' '+p[2];
  return lbl(a,pa)+' – '+lbl(b,pb)+', '+pb[0];
}

// Every dollar figure here comes straight off the report and nothing is recomputed
// from hours and a rate. This comment used to say the report took OT dollars as the
// residual of the vendor's own blended earnings; it does not, and has not since the
// feed became hours-only. ot-report-lib prices the week from employees.wage through
// pay-rules-lib, which models the California 4x10 tiers (1.5x for hours 10-12,
// 2.0x above 12) explicitly rather than inheriting them from someone else's totals.
//
// netlify/functions/ot-weekly-email-lib.js builds this same payload server-side for
// the Monday email. Change the shape here and change it there; the test that pins
// them together is tests/ot-weekly-email.test.js.
function otEmailPayload(){
  const r=state.otReport; if(!r) return null;
  const s=r.summary||{};
  const payroll=Number(s.totalHourlyPayroll)||0;
  const pct=d=>payroll>0?((Number(d)||0)/payroll*100).toFixed(1):'0.0';
  const exceeded=(r.employees||[]).filter(e=>(Number(e.netOtHours)||0)>0)
    .sort((a,b)=>(Number(b.netOtHours)||0)-(Number(a.netOtHours)||0));
  const shown=exceeded.slice(0,15);
  const regular=(Number(s.totalHours)||0)-(Number(s.allOtHours)||0);
  return {
    dateRange:otWeekRangeLabel(r.weekStart,r.weekEnd),
    totalPayroll:payroll.toFixed(2),
    totalOTHours:(Number(s.allOtHours)||0).toFixed(2),
    totalRegularHours:regular.toFixed(2),
    totalPreApprovedHours:(Number(s.preApprovedHours)||0).toFixed(2),
    netOTHours:(Number(s.netOtHours)||0).toFixed(2),
    totalOTPercent:pct(s.allOtDollars),
    preApprovedOTPercent:pct(s.preApprovedDollars),
    netOTPercent:pct(s.netOtDollars),
    otBudgetPercent:otBudgetPct().toFixed(1),
    employeeCount:Number(s.headcount)||0,
    exceededEmployees:shown.map(e=>({name:e.name||('#'+e.employeeNumber),unapprovedHours:(Number(e.netOtHours)||0).toFixed(2)})),
    exceededOmitted:exceeded.length-shown.length,
    reportLink:'https://seq-staffing.netlify.app/app.html',
    uploadTime:new Date().toLocaleString('en-US',{timeZone:'America/Los_Angeles',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'})+' PT'
  };
}

async function sendOTReportEmail(opts){
  const auto=!!(opts&&opts.auto);
  // The ACCESS LIST, since 2026-09-15 — everyone who can use the app receives
  // the report. The server reads it again for itself and does not trust this;
  // the count is here only to stop offering a button that would fail.
  const managers=state.perms.list||[];
  if(!managers.length){ if(!auto) toast('Nobody is on the access list — add somebody under Settings → Access','error'); return false; }
  const data=otEmailPayload();
  if(!data){ toast('Load the OT report before emailing it','error'); return false; }
  state.otEmailSending=true; render();
  let ok=false;
  try{
    const res=await fetch('/api/send-ot-email',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({to:managers,subject:'OT Report: '+data.dateRange,data})});
    if(res.status===401){state.otEmailSending=false;location.href='/';return false;}
    let json=null; try{json=await res.json();}catch(e){json=null;}
    const sent=(json&&json.sent)||0, failed=(json&&json.failed)||0;
    if(!res.ok&&!sent) throw new Error((json&&json.error)||('Request failed ('+res.status+')'));
    ok=sent>0;
    toast(sent+' manager email'+(sent===1?'':'s')+' sent for '+data.dateRange+(failed?(' — '+failed+' failed'):''),failed?'warning':'success');
  }catch(err){
    toast('Manager email failed: '+err.message,'error');
  }
  state.otEmailSending=false; render();
  return ok;
}

// A truncated report is worse than a failed one: every figure below is real,
// internally consistent and too small. So this says which half came up short and
// by how much, and it is deliberately the loudest thing on the page. It renders
// nothing at all when the response was complete.
function otTruncationBanner(){
  if(!state.otReportTruncated) return '';
  const w=state.otReportWindow||{};
  const bits=[];
  if(w.weekIndexTruncated){
    bits.push(`<li><strong>The list of weeks is short.</strong> The scan over ${w.from&&w.to?(fmtDate(w.from)+' – '+fmtDate(w.to)):'the reporting window'} stopped at ${fmtCount(w.rowsScanned)} row${w.rowsScanned===1?'':'s'}${w.rowsAvailable!=null?(' of '+fmtCount(w.rowsAvailable)+' that exist'):', and the true total could not be counted'}.
      Weeks are missing from the picker above — a week with data may simply not be listed.</li>`);
  }
  if(w.weekDetailTruncated){
    const short=(w.weekRowsExpected!=null&&w.weekRowsFetched!=null)?(w.weekRowsExpected-w.weekRowsFetched):null;
    bits.push(`<li><strong>This week's own rows are short.</strong> ${fmtCount(w.weekRowsFetched)} row${w.weekRowsFetched===1?'':'s'} came back${w.weekRowsExpected!=null?(' of '+fmtCount(w.weekRowsExpected)+' the index says exist'+(short?(' — '+fmtCount(short)+' missing'):'')):''}.
      Every hour, dollar, headcount and percentage below is computed from what came back, so all of them understate the week.</li>`);
  }
  if(!bits.length) bits.push('<li>The report hit its row cap, so the figures below may be incomplete.</li>');
  return `<div class="ot-trunc">
    <div class="ot-trunc-hd">⚠ Incomplete data — the figures below may understate this week</div>
    <ul style="margin:8px 0 0 18px;line-height:1.6">${bits.join('')}</ul>
    <div style="margin-top:8px">Nothing here is wrong on its own; it is simply not all of it. Treat every total on this page as a floor, and do not send it to managers until it comes back complete.</div>
  </div>`;
}

function otSort(col){
  if(state.otSortCol===col) state.otSortDir=state.otSortDir==='asc'?'desc':'asc';
  else{state.otSortCol=col;state.otSortDir='desc';}
  render();
}

function toggleOtDay(date){
  const open=state.otOpenDays[date]===undefined?!isScheduledDate(date):state.otOpenDays[date];
  state.otOpenDays[date]=!open;
  render();
}

const otReportStyle=`<style>
  .ot-bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:18px;padding:10px 14px;background:var(--surface2);border:1px solid var(--border);border-radius:8px}
  .ot-bar-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--muted)}
  .ot-bar select,.ot-bar input{font-family:var(--font);font-size:12px;border:1px solid var(--border);border-radius:4px;padding:6px 10px;background:var(--surface);color:var(--text)}
  .ot-bar-note{margin-left:auto;font-size:11px;color:var(--muted)}
  .ot-pa{margin-top:10px;padding:12px 14px}
    .ot-pa-row{display:grid;grid-template-columns:1fr auto auto;gap:14px;padding:5px 0;font-size:13px;border-bottom:1px solid var(--border)}
    .ot-pa-row span:nth-child(2),.ot-pa-row span:nth-child(3){text-align:right;font-variant-numeric:tabular-nums;min-width:90px}
    .ot-pa-tot{font-weight:700;border-bottom:none;border-top:2px solid var(--nearBlk);margin-top:2px}
    .ot-pa-note{font-size:11.5px;color:var(--textDim);margin-top:8px;line-height:1.5}
    .ot-note{font-size:11px;color:var(--textDim);background:var(--surface2);border:1px solid var(--border);border-left:3px solid var(--gold);border-radius:4px;padding:8px 12px;margin-bottom:18px;line-height:1.5}
  .ot-panel{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:16px;margin-bottom:24px}
  .ot-split{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
  .ot-split-card{border:1px solid var(--border);border-radius:6px;padding:12px 14px;background:var(--surface)}
  .ot-split-card.nonsched{border-color:var(--gold);background:#fffdf7}
  .ot-split-hdr{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:var(--rust);margin-bottom:8px}
  .ot-kv{display:flex;justify-content:space-between;font-size:12px;padding:3px 0}
  .ot-kv span:last-child{font-weight:700}
  td.num,th.num{text-align:right}
  tr.nonsched-row td{background:#fffdf7}
  tr.day-workers td{background:var(--surface2);white-space:normal;max-width:none}
  .ot-chip{display:inline-block;font-size:11px;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:2px 8px;margin:2px 3px 2px 0}
  .ot-flag{background:#fce8e8;border:1px solid #e0a5a5;border-radius:4px;padding:8px 12px;margin-bottom:10px;font-size:12px;color:#7a1f1f}
  .ot-warn{background:#fef5e8;border:1px solid #e6b87f;border-radius:4px;padding:8px 12px;margin-bottom:10px;font-size:12px;color:#6b4a0a}
  .ot-ok{font-size:12px;color:#2a7a47;font-weight:600}
  .ot-trunc{background:#fce8e8;border:1px solid var(--brick);border-left:6px solid var(--brick);border-radius:6px;padding:14px 18px;margin-bottom:18px;font-size:12.5px;color:#7a1f1f;line-height:1.5}
  .ot-trunc-hd{font-size:15px;font-weight:800;letter-spacing:.2px}
  .comp-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:8px}
  .comp-day{border:1px solid var(--border);border-radius:6px;padding:10px;text-align:center;font-size:11px}
  .comp-day.data{background:#e8f5ec;border-color:#9fcdb0}
  .comp-day.missing{background:#fce8e8;border-color:#e0a5a5}
  .comp-day.pending{background:var(--surface);border-color:var(--border);color:var(--muted)}
  .comp-name{font-weight:800;font-size:11px;text-transform:uppercase;letter-spacing:.5px}
  .comp-status{margin-top:4px;color:var(--textDim);line-height:1.35}
  .sortable{cursor:pointer;user-select:none}
</style>`;

// ---------------------------------------------------------------------------
// SG&A OVERTIME
// ---------------------------------------------------------------------------
//
// The one thing still tracked about a cost class this app otherwise stopped
// analysing on 2026-09-14. It is a section of THIS report rather than a view of
// its own — it was briefly a sub-tab — because it is one line of a weekly
// overtime picture and a tab for one line is furniture.
//
// HOURS ONLY, NO DOLLARS — still, but for a different reason since 2026-09-15.
//
// It used to be that there was no rate to multiply by: SG&A carried no pay at
// all. That changed when hourly SG&A staff got their wage back, precisely
// because this section exists — an hourly person's overtime is paid at a rate,
// and the roster had no way to say what it was.
//
// So the rate is now AVAILABLE here and is deliberately not used. Costing SG&A
// overtime is analysing SG&A, which is the thing that stopped on 2026-09-14,
// and one table quietly growing a dollar column is how that decision would get
// reversed without anybody deciding to reverse it. Adding the column is a small
// change when somebody asks for it; the question to answer first is still
// whether SG&A is being analysed again.
//
// COST CLASS, NOT DEPARTMENT, and that distinction is the whole reason this is
// not three lines long. ot-report-lib has a NON_PRODUCTION bucket whose value
// is the literal string 'SG&A', and report.issues.nonProductionWithHours lists
// whoever lands in it — which looks like this section already built. But that
// bucket is keyed on employees.DEPARTMENT, and 'SG&A' was retired as a
// department value when the v2 model gave the class five departments of its
// own. Nobody on the roster holds it. Axeri Ramirez is department 'Accounting',
// cost class 'SG&A', so she has never appeared in that bucket and never will.
//
// So the filter is the cost class, read off the roster and joined to the report
// on employee number — what the payroll file identifies people by. The
// department is shown beside each person because it is the line the cost
// actually belongs to.
function sgaOtRows(){
  const report = state.otReport;
  if(!report) return [];

  // Built from the ROSTER, not from the report: somebody with no hours this
  // week still belongs in the list, as a zero, so a reader can tell "no
  // overtime" from "not looked at".
  const byNumber = new Map();
  for(const e of (state.employees||[])){
    if(String(e.costClass||'').trim()!=='SG&A') continue;
    if(!payActive(e)) continue;
    // Salaried office staff are dropped at import and cannot earn an OT hour.
    // Listing them as permanent zeros would bury the one person who can.
    if(isSalaried(e)) continue;
    const num=String(e.empNum||'').trim();
    if(num) byNumber.set(num,e);
  }

  const reported = new Map();
  for(const r of (report.employees||[])){
    const num=String(r.employeeNumber||'').trim();
    if(num&&byNumber.has(num)) reported.set(num,r);
  }

  return [...byNumber.entries()].map(([num,e])=>{
    const r=reported.get(num)||null;
    return {
      empNum:num,
      name:e.name||(r&&r.name)||'',
      department:e.department||'\u2014',
      // Absent from the file is zero hours and NOT missing data: the file
      // carries everybody who clocked in, so absence is the answer.
      hours:r?r.totalHours:0,
      otHours:r?r.otHours:0,
      daysWorked:r?r.daysWorked:0,
      inFile:!!r
    };
  }).sort((a,b)=>b.otHours-a.otHours||b.hours-a.hours||a.name.localeCompare(b.name));
}

// WHAT PERIOD THIS IS, and — when it is not one week — what that did to the
// allowances.
//
// The pre-approved entitlement and the clock grace are WEEKLY, so a range
// accrues them once per scheduled week. Net OT is overtime worked minus those,
// so a reader comparing a three-week report against a weekly one needs to know
// the allowance moved with it; stating the multiplier is what stops the bigger
// Net OT reading as a worse three weeks.
function otPeriodNote(r){
  const weeks=Number(r.weeks);
  const oneWeek=!(isFinite(weeks)) || Math.abs(weeks-1)<0.001;
  const span=`${fmtDate(r.weekStart)} through ${fmtDate(r.weekEnd)}`;
  if(oneWeek && (r.dayCount==null || r.dayCount===7)){
    return `<div style="font-size:12px;color:var(--muted);margin-bottom:12px">Week of ${span}</div>`;
  }
  return `<div class="ot-note" style="margin-bottom:12px"><strong>${span}</strong> —
    ${r.dayCount} day${r.dayCount===1?'':'s'}, worth <strong>${weeks}</strong> scheduled
    week${Math.abs(weeks-1)<0.001?'':'s'} of production (Mon–Thu).
    The pre-approved allowance and the timeclock grace are weekly, so both are counted
    ${weeks}&times; here — Net OT is overtime worked minus that, and comparing this against a
    single week means comparing against ${weeks}&times; the allowance too.</div>`;
}

function renderOTReport(){
  const weeks=state.otReportWeeks||[];
  const mgrs=(state.perms.list||[]).length;
  const emailBlocked=state.otEmailSending?'Sending…':(!mgrs?'Nobody is on the access list — add somebody under Settings → Access':(!state.otReport?'Load a week before emailing it':''));
  const emailBtn=`<button class="btn btn-outline btn-sm" onclick="sendOTReportEmail()" ${emailBlocked?'disabled':''} title="${esc(emailBlocked||('Email this week to '+mgrs+' '+(mgrs===1?'person':'people')+' with access'))}">${state.otEmailSending?'Sending…':'Email managers'}</button>`;
  const picker=`
    <div class="ot-bar">
      <label class="ot-bar-label">Work week (Mon–Sun)</label>
      <select onchange="state.otFrom='';state.otTo='';loadOTReport(this.value)">
        ${weeks.length?weeks.map(w=>`<option value="${w.weekStart}" ${w.weekStart===state.otReportWeek?'selected':''}>${fmtDate(w.weekStart)} – ${fmtDate(w.weekEnd)} · ${w.days} days · ${fmtHrs(w.totalHours)} hrs</option>`).join(''):'<option value="">No week has data yet</option>'}
      </select>
      <button class="btn btn-outline btn-sm" onclick="loadOTReport(state.otReportWeek)">Refresh</button>
      ${emailBtn}
      <button class="btn btn-outline btn-sm" onclick="goToSettings('dailyhours')">Daily Hours</button>
      ${rangeControl({
        from: state.otFrom, to: state.otTo, active: otRangeActive(),
        set: 'otSetRangePart', apply: 'otApplyRange()', clear: 'otClearRange()'
      })}
      <div class="ot-bar-note">Hourly payroll only — salaried staff are excluded at import.</div>
    </div>`;

  const trunc=otTruncationBanner();

  if(state.otReportLoading) return otReportStyle+picker+'<div class="loading-state">Loading the weekly report…</div>';
  if(!state.otReport) return otReportStyle+picker+trunc+`
    <div class="loading-state">
      ${state.otReportError?esc(state.otReportError):'No payroll data for this week yet — import a day on the Daily Hours tab.'}
      <div style="margin-top:14px"><button class="btn btn-primary btn-sm" onclick="loadOTReport(state.otReportWeek)">Try again</button></div>
    </div>`;

  const r=state.otReport;
  const s=r.summary||{};
  const pa=r.preApproved||{}; const gr=pa.grace||{hours:0,dollars:0,headcount:0,hoursPerEmployee:0,rateMissing:[]};
  const split=r.split||{};
  const maint=split.maintenance||{}, prod=split.production||{}, otherDept=split.other||{};
  const hol=r.holidays||{dates:[],byDate:[],byDepartment:[],hours:0,earnings:0,headcount:0,datesWithoutData:[]};
  const days=r.days||[];
  const depts=r.departments||[];
  const deptNames=depts.map(d=>d.department);
  const dayDept=state.otDayDept||'all';

  // 1. Summary cards
  //
  // FIVE, not seven. 'Total hourly payroll' and 'Weekend labor (Fri-Sun)' were
  // removed on 2026-09-15 — neither was a question this report gets opened to
  // answer, and both were saying something another part of the page already
  // says better.
  //
  // The payroll DOLLARS are still computed and still on screen: they are the
  // denominator of the two percentage cards, which name it inline ("$X of $Y")
  // because a bare percentage cannot be checked without it. summary
  // .totalHourlyPayroll is untouched in ot-report-lib and the Monday email
  // still reads it — see otEmailPayload above.
  //
  // The week's SIZE — total hours and headcount — rode along in that card's
  // sub-line and would have gone with it, so it moved to the All OT card, where
  // it is the thing an OT figure most needs next to it: 12 OT hours out of 430
  // and 12 out of 60 are different weeks.
  //
  // Fri-Sun was already on this page TWICE more, in more useful shape: the
  // Production/maintenance split card carries its hours, OT hours, OT dollars,
  // total labor dollars and headcount, and the weekend section further down
  // breaks it out by person. The card was the least informative of the three.
  const cards=`
    <div class="stat-row">
      <div class="stat-card"><div class="stat-label">All OT</div><div class="stat-value">${fmtHrs(s.allOtHours)}<span style="font-size:13px"> hrs</span></div><div class="stat-sub">${fmt$(s.allOtDollars)} · of ${fmtHrs(s.totalHours)} hrs worked by ${s.headcount||0} hourly employees</div></div>
      <div class="stat-card"><div class="stat-label">Pre-approved OT</div><div class="stat-value">${fmtHrs(s.preApprovedHours)}<span style="font-size:13px"> hrs</span></div><div class="stat-sub">${fmt$(s.preApprovedDollars)} · ${fmtHrs(pa.standing&&pa.standing.hours)} OT table + ${fmtHrs(gr.hours)} clock grace</div></div>
      <div class="stat-card"><div class="stat-label">Net OT</div><div class="stat-value" style="color:${(s.netOtHours||0)>0?'var(--brick)':'#2a7a47'}">${fmtHrs(s.netOtHours)}<span style="font-size:13px"> hrs</span></div><div class="stat-sub">${fmt$(s.netOtDollars)}</div></div>
      <div class="stat-card"><div class="stat-label">All OT % of hourly payroll</div><div class="stat-value">${fmtPct(s.allOtPctOfPayroll)}</div><div class="stat-sub">by dollars · ${fmt$(s.allOtDollars)} of ${fmt$(s.totalHourlyPayroll)} · salaried staff are not in the denominator</div></div>
      <div class="stat-card"><div class="stat-label">Net OT % of hourly payroll</div><div class="stat-value" style="color:${(s.netOtDollars||0)>0?'var(--brick)':'#2a7a47'}">${fmtPct(s.netOtPctOfPayroll)}</div><div class="stat-sub">by dollars · how far past the approved allowance, not a cost share — negative in a light week</div></div>
    </div>`;

  // 2. The overtime table carries no week and no dollars, so the number above is
  // not "OT approved for this week" — it is the standing allowance, applied whole
  // to every week, and its dollars are computed here rather than sourced.
  const graceMissing=(gr.rateMissing||[]);
  const standingNote=`<div class="ot-note"><strong>Pre-approved OT is a standing weekly allowance.</strong>
    The Pre-Approved Overtime table has no week dimension and no dollar amounts, so the same allowance is applied to every week,
    and the dollars are derived as hours × rate × 1.5 — they are not sourced from payroll.
    Net OT is OT worked minus that allowance, so it goes negative in a week where less OT was worked than was approved; the negative is shown as-is rather than floored at zero.</div>
    <div class="ot-panel ot-pa">
      <div class="ot-pa-row"><span>Overtime table</span><span>${fmtHrs(pa.standing&&pa.standing.hours)} hrs</span><span>${fmt$(pa.standing&&pa.standing.dollars)}</span></div>
      <div class="ot-pa-row"><span>Timeclock grace</span><span>${fmtHrs(gr.hours)} hrs</span><span>${fmt$(gr.dollars)}</span></div>
      <div class="ot-pa-row ot-pa-tot"><span>Pre-approved OT</span><span>${fmtHrs(s.preApprovedHours)} hrs</span><span>${fmt$(s.preApprovedDollars)}</span></div>
      <div class="ot-pa-note">Clock grace is ${fmtHrs(gr.hoursPerEmployee)} hrs × ${gr.headcount||0} active hourly employees on the roster.
        Employees may clock in 7.5 minutes early and out 7.5 minutes late; that time is compensable and cannot be rounded away, so it is pre-approved by policy.
        It is counted per roster, not per employee who worked, so it does not shrink in a light week — someone out all week still carries their allowance.
        Change the rate on the Settings tab.${graceMissing.length?` <strong style="color:var(--brick)">${graceMissing.length} employee${graceMissing.length===1?'':'s'} had no rate on file</strong> — their grace hours are counted but contribute $0: ${graceMissing.map(esc).join(', ')}.`:''}</div>
    </div>`;

  // 3. Maintenance vs production — BY DEPARTMENT
  //
  // This was Mon-Thu vs Fri-Sun until 2026-09-15, and the label was the problem
  // rather than the split: it called a day block a department block. In the week
  // of 2026-09-07, holiday excluded, that filed 121.5 hours of
  // Maintenance-department work under "production days" and 63.1 hours of
  // Production-department work under "maintenance days" — 184.7 hours, 12% of
  // the week's worked time, on the wrong side of a two-line summary somebody
  // reads in five seconds.
  //
  // The department is a recorded fact about the person doing the work; the day
  // was a proxy for it. Fri-Sun has not gone anywhere — the per-day table is
  // still labelled with it and the weekend section still measures it — it just
  // no longer DECIDES which side of this card an hour lands on.
  //
  // THREE CARDS, not two. SG&A and Unassigned rows are both findings, and
  // folding them into production would hide a data problem inside a number
  // people act on. The third card appears only when it has something in it, so
  // a clean week still reads as two.
  const otherHasAnything=(Number(otherDept.hours)||0)>0||(Number(otherDept.earnings)||0)>0;
  const splitCard=(title,sub,b,cls)=>`
        <div class="ot-split-card${cls?' '+cls:''}">
          <div class="ot-split-hdr">${title}</div>
          <div style="font-size:11px;color:var(--muted);margin:-4px 0 8px">${sub}</div>
          <div class="ot-kv"><span>Hours</span><span>${fmtHrs(b.hours)}</span></div>
          <div class="ot-kv"><span>OT hours</span><span>${fmtHrs(b.otHours)}</span></div>
          <div class="ot-kv"><span>OT $</span><span>${fmt$(b.otDollars)}</span></div>
          <div class="ot-kv"><span>Total labor $</span><span>${fmt$(b.earnings)}</span></div>
          <div class="ot-kv"><span>Headcount</span><span>${b.headcount||0}</span></div>
        </div>`;
  const splitBlock=`
    <div class="section-head"><span>Maintenance vs production</span></div>
    <div class="ot-panel">
      <div class="ot-split">
        ${splitCard('Maintenance',esc((split.maintenanceDepartments||['Maintenance']).join(', ')),maint,'nonsched')}
        ${splitCard('Production',esc((split.productionDepartments||[]).join(', ')),prod,'')}
        ${otherHasAnything?splitCard('Neither','SG&amp;A or no department — a finding, not a bucket',otherDept,''):''}
      </div>
      <div class="ot-note" style="margin:12px 0 0">Two different numbers matter on each card and they are not interchangeable:
        <strong>OT $</strong> is the premium portion, comparable against the pre-approved allowance;
        <strong>total labor $</strong> is every dollar paid for that department's work, which is what it costs to run.${
        otherHasAnything?` <strong style="color:var(--brick)">${fmtHrs(otherDept.hours)} hrs are in neither</strong> — somebody is in the SG&amp;A cost class or has no department set. Both are fixed on the Employees tab.`:''}</div>
    </div>`;

  // 3b. Holiday pay — hours that were PAID but not WORKED.
  //
  // Labor Day 2026 posted 508 hours the mill never worked, and until the holiday
  // list existed they sat inside every figure on this page. Marked days are out
  // of all of them now; this block is where the money stays visible, because it
  // was really paid and somebody still has to account for it.
  const holBlock=(hol.dates||[]).length?`
    <div class="section-head"><span>Holiday pay</span></div>
    <div class="ot-panel">
      <div class="ot-note" style="margin:0 0 12px"><strong>Paid, not worked — and not in any figure above.</strong>
        ${(hol.dates||[]).length===1?'This day is':'These days are'} marked as a mill holiday on the Settings tab,
        so the hours are out of the totals, the department split, the per-person rows and both percentages of payroll.
        They are real dollars and are shown here on their own.</div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Day</th><th class="num">People</th><th class="num">Hours paid</th><th class="num">Cost</th></tr></thead>
          <tbody>
            ${(hol.byDate||[]).map(d=>`<tr>
              <td style="font-weight:600">${esc(fmtDate(d.date))}</td>
              <td>${esc(d.dayName||'')}</td>
              <td class="num">${d.headcount||0}</td>
              <td class="num">${fmtHrs(d.hours)}</td>
              <td class="num">${fmt$(d.earnings)}</td>
            </tr>`).join('')}
          </tbody>
          ${(hol.byDate||[]).length>1?`<tfoot><tr>
            <td colspan="2" style="font-weight:700;padding:10px 12px">${hol.dates.length} days</td>
            <td class="num" style="font-weight:700">${hol.headcount||0}</td>
            <td class="num" style="font-weight:700">${fmtHrs(hol.hours)}</td>
            <td class="num" style="font-weight:800">${fmt$(hol.earnings)}</td>
          </tr></tfoot>`:''}
        </table>
      </div>
      ${(hol.byDepartment||[]).length?`<div class="ot-note" style="margin:12px 0 0">By department:
        ${hol.byDepartment.map(d=>`${esc(d.department)} ${fmtHrs(d.hours)} hrs`).join(' · ')}</div>`:''}
    </div>`:((hol.datesWithoutData||[]).length?`
    <div class="section-head"><span>Holiday pay</span></div>
    <div class="ot-panel"><div class="ot-ok">${hol.datesWithoutData.map(esc).join(', ')} ${hol.datesWithoutData.length===1?'is':'are'}
      marked as a mill holiday and no hours were imported for ${hol.datesWithoutData.length===1?'it':'them'} — nothing to exclude.</div></div>`:'');

  // 4. Departments
  const rec=(r.issues&&r.issues.reconciliation)||null;
  const reconBlock=!rec?'':(rec.balanced
    ? `<div class="ot-ok" style="margin-top:10px">✓ Department rows reconcile to the weekly totals.</div>`
    : `<div class="ot-flag" style="margin-top:10px"><strong>Departments do not reconcile to the weekly totals.</strong>
        Hours: departments ${fmtHrs(rec.departmentHours)} vs summary ${fmtHrs(rec.summaryHours)} — delta <strong>${fmtHrs(rec.hoursDelta!=null?rec.hoursDelta:(rec.departmentHours||0)-(rec.summaryHours||0))}</strong>.
        Earnings: departments ${fmt$(rec.departmentEarnings)} vs summary ${fmt$(rec.summaryEarnings)} — delta <strong>${fmt$(rec.earningsDelta!=null?rec.earningsDelta:(rec.departmentEarnings||0)-(rec.summaryEarnings||0))}</strong>.</div>`);

  const deptBlock=`
    <div class="section-head"><span>By department</span></div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Department</th>
          <th class="num">Sched hrs</th><th class="num">Sched $</th>
          <th class="num">Weekend hrs</th><th class="num">Weekend $</th>
          <th class="num">OT hrs</th><th class="num">OT $</th>
          <th class="num">Pre-appr hrs</th><th class="num">Pre-appr $</th>
          <th class="num">Net OT hrs</th><th class="num">Net OT $</th>
          <th class="num">Total labor $</th>
        </tr></thead>
        <tbody>
          ${depts.length?depts.map(d=>`<tr${d.department==='Unassigned'?' style="background:#fef5e8"':''}>
            <td style="font-weight:600">${esc(d.department)}</td>
            <td class="num">${fmtHrs((d.scheduled||{}).hours)}</td><td class="num">${fmt$((d.scheduled||{}).earnings)}</td>
            <td class="num">${fmtHrs((d.weekend||{}).hours)}</td><td class="num">${fmt$((d.weekend||{}).earnings)}</td>
            <td class="num">${fmtHrs((d.week||{}).otHours)}</td><td class="num">${fmt$((d.week||{}).otDollars)}</td>
            <td class="num">${fmtHrs(d.preApprovedHours)}</td><td class="num">${fmt$(d.preApprovedDollars)}</td>
            <td class="num" style="font-weight:700;color:${(d.netOtHours||0)>0?'var(--brick)':'inherit'}">${fmtHrs(d.netOtHours)}</td>
            <td class="num" style="font-weight:700">${fmt$(d.netOtDollars)}</td>
            <td class="num">${fmt$((d.week||{}).earnings)}</td>
          </tr>`).join(''):'<tr><td colspan="12" style="text-align:center;color:var(--muted);padding:24px">No departments in this week</td></tr>'}
        </tbody>
      </table>
    </div>
    ${reconBlock}`;

  // 4b. SG&A overtime — the office, which is not one of the departments above.
  //
  // Placed here because a reader who has just finished the department table is
  // asking exactly the question this answers: is that everybody? It is not —
  // these people are in the file and in no production department.
  const sgaRows=sgaOtRows();
  const sgaTotalOt=sgaRows.reduce((t,x)=>t+Number(x.otHours||0),0);
  const sgaTotalHrs=sgaRows.reduce((t,x)=>t+Number(x.hours||0),0);
  const sgaBlock=`
    <div class="section-head"><span>SG&amp;A overtime</span></div>
    <div class="ot-note"><strong>Hours only — SG&amp;A overtime is not costed in this app.</strong>
      Everyone in the SG&amp;A cost class who can earn an overtime hour is listed, including at zero:
      an empty row means no overtime, not no data. Salaried office staff are not listed — the payroll
      file drops them and they earn no OT hour. These hours are NOT in the department table above or
      in any figure on this page; SG&amp;A is not a production department.</div>
    ${sgaRows.length?`
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Name</th><th>Department</th>
          <th class="num">Days</th><th class="num">Hours</th><th class="num">Overtime</th>
        </tr></thead>
        <tbody>
          ${sgaRows.map(x=>`<tr>
            <td style="font-weight:600">${esc(x.name)}${x.empNum?` <span style="color:var(--muted);font-size:11px">#${esc(x.empNum)}</span>`:''}</td>
            <td>${esc(x.department)}</td>
            <td class="num">${x.inFile?x.daysWorked:'\u2014'}</td>
            <td class="num">${fmtHrs(x.hours)}</td>
            <td class="num" style="font-weight:${Number(x.otHours)>0?'800':'400'};color:${Number(x.otHours)>0?'var(--brick)':'var(--muted)'}">${fmtHrs(x.otHours)}</td>
          </tr>`).join('')}
        </tbody>
        <tfoot><tr>
          <td colspan="3" style="font-weight:700;padding:10px 12px">${sgaRows.length} ${sgaRows.length===1?'person':'people'}</td>
          <td class="num" style="font-weight:700">${fmtHrs(sgaTotalHrs)}</td>
          <td class="num" style="font-weight:800">${fmtHrs(sgaTotalOt)}</td>
        </tr></tfoot>
      </table>
    </div>`:`
    <div class="ot-panel"><div class="ot-ok">Nobody on the roster is both hourly and in the SG&amp;A cost class,
      so there is no SG&amp;A overtime to track. Cost class and pay type are set on the Employees tab.</div></div>`}`;

  // 5. Per-day breakdown Mon->Sun, filterable by department.
  const dayRows=days.map(d=>{
    const workers=(d.workers||[]).filter(w=>dayDept==='all'||(w.department||'Unassigned')===dayDept);
    const t=dayDept==='all'
      ? {hours:d.hours,otHours:d.otHours,otDollars:d.otDollars,earnings:d.earnings,headcount:d.headcount}
      : workers.reduce((a,w)=>({hours:a.hours+(+w.hours||0),otHours:a.otHours+(+w.otHours||0),otDollars:a.otDollars+(+w.otDollars||0),earnings:a.earnings+(+w.earnings||0),headcount:a.headcount+1}),{hours:0,otHours:0,otDollars:0,earnings:0,headcount:0});
    const open=state.otOpenDays[d.date]===undefined?!d.isScheduledDay:state.otOpenDays[d.date];
    // dateSource is null on an empty day, one value when the rows agree and a
    // comma-joined list when they disagree, so test for containment.
    const inferred=String(d.dateSource||'').includes('email_received');
    // A MARKED HOLIDAY IS A ROW OF ZEROS WITH AN EXPLANATION, not a gap and not
    // a dash. Its worked figures are genuinely zero — that is the whole point —
    // and the pay it did carry is named on the row so nobody reads the zeros as
    // a missing file and goes looking for one that arrived on time.
    const row=`<tr class="${d.isHoliday?'':(d.isScheduledDay?'':'nonsched-row')}"${d.isHoliday?' style="background:var(--surface2)"':''}>
      <td style="font-weight:600">${d.dayName||dayNameOf(d.date)}<div style="font-size:11px;color:var(--muted);font-weight:400">${fmtDate(d.date)}</div></td>
      <td>${d.isHoliday
        ? `<span class="badge" style="background:#e8e2d5;color:#6b5b3e">Mill holiday</span><div style="font-size:10px;color:var(--muted);margin-top:3px">${fmtHrs(d.holidayHours)} hrs paid · ${fmt$(d.holidayEarnings)} — not counted</div>`
        : `${schedBadge(d.isScheduledDay)}${inferred?'<div style="font-size:10px;color:#9a600a;margin-top:3px">date inferred from email arrival</div>':''}`}</td>
      <td class="num">${d.isHoliday?'—':(d.hasData?(t.headcount||0):'—')}</td>
      <td class="num">${d.isHoliday?'0.00':(d.hasData?fmtHrs(t.hours):'—')}</td>
      <td class="num">${d.isHoliday?'0.00':(d.hasData?fmtHrs(t.otHours):'—')}</td>
      <td class="num">${d.isHoliday?fmt$(0):(d.hasData?fmt$(t.otDollars):'—')}</td>
      <td class="num">${d.isHoliday?fmt$(0):(d.hasData?fmt$(t.earnings):'—')}</td>
      <td>${(!d.isHoliday&&workers.length)?`<button class="btn btn-outline btn-sm" onclick="toggleOtDay('${d.date}')">${open?'Hide':'Who worked'}</button>`:`<span style="color:var(--muted)">${d.isHoliday?'closed':'no rows'}</span>`}</td>
    </tr>`;
    const detail=(open&&workers.length&&!d.isHoliday)?`<tr class="day-workers"><td colspan="8">
      ${workers.slice().sort((a,b)=>(b.hours||0)-(a.hours||0)).map(w=>`<span class="ot-chip">${esc(w.name||('#'+w.employeeNumber))} · ${fmtHrs(w.hours)}h${(w.otHours||0)>0?' · OT '+fmtHrs(w.otHours)+'h':''} · ${fmt$(w.earnings)}<span style="color:var(--muted)"> · ${esc(w.department||'Unassigned')}</span></span>`).join('')}
    </td></tr>`:'';
    return row+detail;
  }).join('');

  const dayBlock=`
    <div class="section-head">
      <span>Day by day · Monday to Sunday</span>
      <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--muted)">
        Department:
        <select onchange="state.otDayDept=this.value;render()" style="font-family:var(--font);font-size:12px;border:1px solid var(--border);border-radius:4px;padding:4px 8px">
          <option value="all" ${dayDept==='all'?'selected':''}>All</option>
          ${deptNames.map(n=>`<option value="${esc(n)}" ${dayDept===n?'selected':''}>${esc(n)}</option>`).join('')}
        </select>
      </span>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th style="width:130px">Day</th><th style="width:190px">Day block</th><th class="num">People</th><th class="num">Hours</th><th class="num">OT hrs</th><th class="num">OT $</th><th class="num">Earnings</th><th style="width:120px"></th></tr></thead>
        <tbody>${dayRows||'<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:24px">No days in this week</td></tr>'}</tbody>
      </table>
    </div>`;

  // 6. Maintenance-day labor as its own block — small headcount, so name names.
  //
  // Fri-Sun is a day cut, not a department one: the Department column here will
  // show Production for someone in Production who worked a Saturday. The split
  // card above is by department and does not use this rule.
  const weekendDays=days.filter(d=>!d.isScheduledDay&&d.hasData);
  const weekendPeople={};
  weekendDays.forEach(d=>(d.workers||[]).forEach(w=>{
    const k=w.employeeNumber||w.name;
    if(!weekendPeople[k]) weekendPeople[k]={name:w.name,department:w.department,hours:0,otHours:0,earnings:0,days:[]};
    weekendPeople[k].hours+=(+w.hours||0);
    weekendPeople[k].otHours+=(+w.otHours||0);
    weekendPeople[k].earnings+=(+w.earnings||0);
    weekendPeople[k].days.push(d.dayName||dayNameOf(d.date));
  }));
  const weekendList=Object.values(weekendPeople).sort((a,b)=>b.hours-a.hours);
  const weekendBlock=`
    <div class="section-head"><span>Maintenance-day labor · Friday to Sunday</span></div>
    <div class="ot-panel">
      <div class="ot-split">
        <div class="ot-split-card nonsched">
          <div class="ot-split-hdr">Fri–Sun totals</div>
          <div class="ot-kv"><span>Hours</span><span>${fmtHrs(s.weekendHours)}</span></div>
          <div class="ot-kv"><span>Total maintenance-day labor $</span><span>${fmt$(s.weekendDollars)}</span></div>
          <div class="ot-kv"><span>OT hours</span><span>${fmtHrs(s.weekendOtHours)}</span></div>
          <div class="ot-kv"><span>Maintenance-day OT $</span><span>${fmt$(s.weekendOtDollars)}</span></div>
          <div class="ot-kv"><span>People</span><span>${s.weekendHeadcount||0}</span></div>
        </div>
        <div style="grid-column:span 2">
          <div class="ot-split-hdr">Who worked Fri–Sun</div>
          <div style="font-size:11px;color:var(--muted);margin-bottom:8px">Friday belongs to this block: these are the same Fri–Sun rows as the maintenance block above, so production days plus maintenance days equals the whole week. The Department column is where each person works — production days are Mon–Thu regardless of what it says.</div>
          ${weekendList.length?`<div class="table-wrap" style="margin-bottom:0"><table>
            <thead><tr><th>Employee</th><th>Department</th><th>Days</th><th class="num">Hours</th><th class="num">OT hrs</th><th class="num">Earnings</th></tr></thead>
            <tbody>${weekendList.map(w=>`<tr>
              <td style="font-weight:600">${esc(w.name||'—')}</td>
              <td>${esc(w.department||'Unassigned')}</td>
              <td style="color:var(--muted);font-size:11px">${w.days.join(', ')}</td>
              <td class="num">${fmtHrs(w.hours)}</td>
              <td class="num">${fmtHrs(w.otHours)}</td>
              <td class="num">${fmt$(w.earnings)}</td>
            </tr>`).join('')}</tbody>
          </table></div>`:'<div style="font-size:12px;color:var(--muted)">Nobody has weekend rows in this week.</div>'}
        </div>
      </div>
    </div>`;

  // 7. Per-employee, sortable, with production days and maintenance days split
  // apart. "Maint hrs" is hours worked in the Fri–Sun block — not hours worked
  // by the Maintenance department.
  const empCols=[
    ['name','Employee'],['department','Department'],
    ['scheduledHours','Prod hrs'],['scheduledEarnings','Prod $'],
    ['nonScheduledHours','Maint hrs'],['nonScheduledEarnings','Maint $'],
    ['otHours','OT hrs'],['otDollars','OT $'],
    ['preApprovedHours','OT-table hrs'],['graceHours','Grace hrs'],
    ['netOtHours','Net OT hrs'],['netOtDollars','Net OT $'],
    ['totalHours','Total hrs'],['totalEarnings','Total $']
  ];
  const sortCol=state.otSortCol||'netOtDollars';
  const dir=state.otSortDir==='asc'?1:-1;
  const empRows=(r.employees||[]).slice().sort((a,b)=>{
    const av=a[sortCol], bv=b[sortCol];
    if(typeof av==='number'||typeof bv==='number') return ((+av||0)-(+bv||0))*dir;
    return String(av||'').toLowerCase()<String(bv||'').toLowerCase()?-dir:String(av||'').toLowerCase()>String(bv||'').toLowerCase()?dir:0;
  });
  const empBlock=`
    <div class="section-head"><span>By employee</span></div>
    <div class="table-wrap">
      <table>
        <thead><tr>${empCols.map(([c,label])=>`<th class="sortable${c==='name'||c==='department'?'':' num'}" onclick="otSort('${c}')">${label}${sortCol===c?'<span style="color:var(--orange);margin-left:3px">'+(state.otSortDir==='asc'?'↑':'↓')+'</span>':''}</th>`).join('')}</tr></thead>
        <tbody>
          ${empRows.length?empRows.map(e=>`<tr>
            <td style="font-weight:600">${esc(e.name||'')}${e.onRoster?'':' <span class="badge disc">not on roster</span>'}${(e.totalHours||0)===0?' <span class="badge inactive">no hours</span>':''}<div style="font-size:10px;color:var(--muted);font-weight:400">${e.employeeNumber?'#'+esc(e.employeeNumber):'no employee number'}</div></td>
            <td>${esc(e.department||'Unassigned')}</td>
            <td class="num">${fmtHrs(e.scheduledHours)}</td><td class="num">${fmt$(e.scheduledEarnings)}</td>
            <td class="num"${(e.nonScheduledHours||0)>0?' style="font-weight:700;background:#fffdf7"':''}>${fmtHrs(e.nonScheduledHours)}</td>
            <td class="num"${(e.nonScheduledHours||0)>0?' style="background:#fffdf7"':''}>${fmt$(e.nonScheduledEarnings)}</td>
            <td class="num">${fmtHrs(e.otHours)}</td><td class="num">${fmt$(e.otDollars)}</td>
            <td class="num">${fmtHrs(e.preApprovedHours)}</td>
            <td class="num" style="font-weight:700;color:${(e.netOtHours||0)>0?'var(--brick)':'inherit'}">${fmtHrs(e.netOtHours)}</td>
            <td class="num">${fmt$(e.netOtDollars)}</td>
            <td class="num">${fmtHrs(e.totalHours)}</td><td class="num">${fmt$(e.totalEarnings)}</td>
          </tr>`).join(''):'<tr><td colspan="13" style="text-align:center;color:var(--muted);padding:24px">No employees worked this week</td></tr>'}
        </tbody>
      </table>
    </div>`;

  // 8. Completeness. BBSI sends the report every day, so any past day with no
  // rows is a probable missed delivery — Saturday included.
  const comp=r.completeness||{days:[]};
  // Three states, and the server decides all three. There used to be a fourth,
  // 'unknown', for an empty Fri–Sun: "nobody worked, or no report arrived". That
  // ambiguity was about the mill's schedule rather than the vendor's, and the
  // server can no longer produce it — an unreachable state in the UI is worse
  // than no state, so it is gone rather than left to rot.
  const compState=d=>d.hasData?'data':(d.status==='pending'?'pending':'missing');
  const compClass={data:'data',missing:'missing',pending:'pending'};
  const compText={
    missing:'no data — probable missed delivery',
    pending:'not due yet — this day has not happened'
  };
  const compBlock=`
    <div class="section-head"><span>Data completeness</span></div>
    <div class="ot-panel">
      <div class="comp-grid">
        ${(comp.days||[]).map(d=>{const st=compState(d);return `<div class="comp-day ${compClass[st]}">
          <div class="comp-name">${(d.dayName||dayNameOf(d.date)).slice(0,3)}</div>
          <div style="color:var(--muted);font-size:10px">${fmtDateShort(d.date)}</div>
          <div class="comp-status">${st==='data'?(d.rowCount||0)+' rows':compText[st]}</div>
        </div>`;}).join('')}
      </div>
      <div style="font-size:11px;color:var(--muted);margin-top:10px">
        ${comp.daysWithData||0} of ${comp.daysExpected||0} days have data${(comp.missingDays||[]).length?` · <span style="color:var(--brick);font-weight:700">missing: ${(comp.missingDays||[]).map(fmtDate).join(', ')}</span>`:''}
      </div>
    </div>`;

  // 9. Issues
  const iss=r.issues||{};
  const pre=r.preApproved||{};
  const issueBits=[];
  if((iss.unknownEmployeeNumbers||[]).length) issueBits.push(`<div class="ot-flag"><strong>${iss.unknownEmployeeNumbers.length} employee number(s) in daily hours are not on the roster:</strong> ${iss.unknownEmployeeNumbers.map(esc).join(', ')}
    <div style="font-size:11px;margin-top:4px">Set the employee # on the matching person in the roster — Edit on the Employees tab.</div>
    <div style="margin-top:6px"><button class="btn btn-outline btn-sm" onclick="goToTab('employees')">Set employee # on the Employees tab</button></div></div>`);
  if(iss.unassignedRows) issueBits.push(`<div class="ot-warn"><strong>${iss.unassignedRows} row(s) carry no department.</strong> ${(iss.unassignedEmployees||[]).map(esc).join(', ')}
    <div style="font-size:11px;margin-top:4px">Set the department on the employee, then re-stamp the affected dates from the Daily Hours tab — the department on a daily row is a snapshot taken at import.</div>
    <div style="margin-top:6px"><button class="btn btn-outline btn-sm" onclick="goToTab('employees')">Set department on the Employees tab</button>
    <button class="btn btn-outline btn-sm" onclick="goToSettings('dailyhours')">Re-stamp departments</button></div></div>`);
  if((iss.flagged||[]).length) issueBits.push(`<div class="ot-flag"><strong>${iss.flagged.length} flagged row(s):</strong>
    <div style="margin-top:6px">${iss.flagged.map(f=>`<span class="ot-chip">${fmtDateShort(f.workDate)} · ${esc(f.name||('#'+f.employeeNumber))} · ${(f.flags||[]).map(esc).join(', ')}</span>`).join('')}</div></div>`);
  if((pre.unmatchedNames||[]).length) issueBits.push(`<div class="ot-warn"><strong>Pre-approved OT names that match no employee:</strong> ${pre.unmatchedNames.map(esc).join(', ')}</div>`);
  if((pre.withoutHoursThisWeek||[]).length) issueBits.push(`<div class="ot-warn"><strong>Pre-approved but no hours this week:</strong>
    ${pre.withoutHoursThisWeek.map(p=>`<span class="ot-chip">${esc(p.name)} · ${esc(p.department||'Unassigned')} · ${fmtHrs(p.hours)}h · ${fmt$(p.dollars)}</span>`).join('')}
    <div style="font-size:11px;margin-top:4px">Their allowance still counts against net OT, so it is worth knowing they did not work.</div></div>`);
  if((pre.rateMissing||[]).length) issueBits.push(`<div class="ot-warn"><strong>Pre-approved dollars show as $0 for:</strong> ${pre.rateMissing.map(esc).join(', ')}
    <div style="font-size:11px;margin-top:4px">Their allowance is not free — no hourly rate is on the employee record, so the dollars cannot be derived. Their hours still count.</div></div>`);
  // Worked hours with no rate. Listed FIRST among the money findings because
  // every other dollar on this page is understated by exactly these people:
  // their earnings are null and every total folds a null to zero.
  if((iss.workedRateMissing||[]).length) issueBits.unshift(`<div class="ot-warn"><strong>${iss.workedRateMissing.length} ${iss.workedRateMissing.length===1?'person':'people'} worked with no hourly rate on file:</strong>
    <div style="margin-top:6px">${iss.workedRateMissing.map(p=>`<span class="ot-chip">${esc(p.name||('#'+p.employeeNumber))} · ${fmtHrs(p.hours)}h · ${esc(p.department||'Unassigned')}</span>`).join('')}</div>
    <div style="font-size:11px;margin-top:4px">Their hours are in every figure on this page and their dollars are not, so every dollar total here is understated by whatever they are owed. Set their rate on their profile card, under <strong>Employees</strong>; this report recomputes from it.</div></div>`);
  const issueBlock=`
    <div class="section-head"><span>Issues</span></div>
    <div class="ot-panel">${issueBits.length?issueBits.join(''):'<div class="ot-ok">✓ No data issues in this week.</div>'}</div>`;

  // Iterate the keys: a blank ot_type comes back as its own bucket.
  const byType=pre.byType||{};
  const preTypeBlock=`
    <div class="section-head"><span>Pre-approved OT by type</span></div>
    <div class="ot-panel">
      <div class="ot-split">
        ${Object.keys(byType).length?Object.keys(byType).map(t=>`<div class="ot-split-card">
          <div class="ot-split-hdr">${esc(t)}</div>
          <div class="ot-kv"><span>Hours</span><span>${fmtHrs((byType[t]||{}).hours)}</span></div>
          <div class="ot-kv"><span>Derived $</span><span>${fmt$((byType[t]||{}).dollars)}</span></div>
        </div>`).join(''):'<div style="font-size:12px;color:var(--muted)">No pre-approved OT on file.</div>'}
      </div>
    </div>`;

  return otReportStyle+picker+trunc+`
    ${otPeriodNote(r)}
    ${cards}${standingNote}${holBlock}${splitBlock}${deptBlock}${sgaBlock}${dayBlock}${weekendBlock}${empBlock}${compBlock}${preTypeBlock}${issueBlock}`;
}
