// sga-ot — the SG&A Overtime view under the Overtime tab.
//
// Shares one global scope with the other files in src/js (see core.js).
//
// ------------------------------------------------------------------------
// WHY THIS EXISTS AS ITS OWN VIEW
// ------------------------------------------------------------------------
//
// SG&A is not analysed in this app any more — the Overhead tab is gone and
// pay-scope-lib.js holds no compensation for the class. ONE thing about SG&A
// still has to be tracked: overtime. It is a real cost the mill pays and
// somebody has to see it, and it is the one SG&A figure that does not need a
// rate to be useful.
//
// It is a separate view rather than a row in the OT Report because the OT
// Report is a PRODUCTION report: its departments, its scheduled/weekend split,
// its Net OT against a pre-approved allowance and its cost per hour are all
// about the mill floor. An office employee's overtime answers a different
// question for a different reader, and folding it into the production
// breakdown makes both harder to read.
//
// ------------------------------------------------------------------------
// HOURS ONLY, NO DOLLARS, AND THAT IS THE POINT
// ------------------------------------------------------------------------
//
// These people have no wage in this system by design, so there is no rate to
// multiply by and nothing on this page is money. That is not a limitation to be
// worked around later: costing SG&A is exactly what was retired. If a dollar
// figure is ever wanted here, the question to answer first is whether SG&A is
// being analysed again — not how to get a rate onto this page.
//
// ------------------------------------------------------------------------
// WHERE THE NUMBERS COME FROM
// ------------------------------------------------------------------------
//
// /api/payroll-report, already loaded by the OT Report view, and no second
// request: report.employees is one row per person with hours for the week, and
// state.employees carries cost_class at the base tier. The join is on employee
// number, which is what the payroll file identifies people by.
//
// COST CLASS, NOT DEPARTMENT, and that distinction is the whole reason this
// view is not three lines long.
//
// ot-report-lib has a NON_PRODUCTION bucket whose value is the literal string
// 'SG&A', and `report.issues.nonProductionWithHours` lists whoever lands in it.
// That looks like this view already built — but that bucket is keyed on
// employees.DEPARTMENT, and 'SG&A' was retired as a department value when the
// v2 model gave the class five departments of its own. Nobody on the roster
// holds it. Axeri Ramirez is department 'Accounting', cost class 'SG&A', so she
// has never appeared in that bucket and never will.
//
// So the filter is the cost class, read off the roster. The department is shown
// beside each person because it is the line the cost actually belongs to.
//
// TODAY THAT IS ONE PERSON. Axeri Ramirez is the only hourly SG&A employee, and
// the salaried ones cannot generate overtime — the payroll import drops every
// salaried row, and a salaried person does not earn an OT hour anyway. The view
// is written for the class rather than for her: the second hourly office hire
// appears here without anybody remembering to add them.

// The week comes from the OT Report's own picker. One week selection for the
// whole tab is deliberate — two sub-views of one tab showing different weeks is
// a bug nobody can see, and the report is loaded once for both.
function sgaOtRows(){
  const report = state.otReport;
  if(!report) return [];

  // Employee number -> roster row, for the people in the SG&A cost class. Built
  // from the roster rather than from the report: somebody with no hours this
  // week still belongs on the page, as a zero, so the reader can tell "no
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
      department:e.department||'—',
      position:e.position||'',
      // A person absent from the file this week has no row, which is zero hours
      // and NOT missing data: the file carries every employee who clocked in,
      // so absence is the answer rather than a gap.
      hours:r?r.totalHours:0,
      otHours:r?r.otHours:0,
      daysWorked:r?r.daysWorked:0,
      inFile:!!r
    };
  }).sort((a,b)=>b.otHours-a.otHours||b.hours-a.hours||a.name.localeCompare(b.name));
}

function renderSgaOT(){
  if(state.otReportLoading&&!state.otReport){
    return '<div class="loading-state">Loading the week…</div>';
  }
  if(state.otReportError&&!state.otReport){
    return `<div class="loading-state">${esc(state.otReportError)}
      <div style="margin-top:14px"><button class="btn btn-primary btn-sm" onclick="loadOTReport(state.otReportWeek)">Try again</button></div>
    </div>`;
  }

  const rows=sgaOtRows();
  const totalOt=rows.reduce((s,r)=>s+Number(r.otHours||0),0);
  const totalHours=rows.reduce((s,r)=>s+Number(r.hours||0),0);
  const weeks=state.otReportWeeks||[];
  const week=state.otReportWeek||(state.otReport&&state.otReport.weekStart)||'';

  return `
    <div style="max-width:1000px;margin:0 auto;padding:20px">
      <div class="cost-bar" style="margin-bottom:14px">
        <label class="cost-bar-label">Work week (Mon–Sun)</label>
        <select onchange="loadOTReport(this.value)">
          ${weeks.length
            ? weeks.map(w=>`<option value="${esc(w.weekStart)}" ${w.weekStart===week?'selected':''}>${fmtDate(w.weekStart)} – ${fmtDate(w.weekEnd)}</option>`).join('')
            : '<option value="">No week has data yet</option>'}
        </select>
        <button class="btn btn-outline btn-sm" onclick="loadOTReport(state.otReportWeek)">Refresh</button>
        <div class="cost-bar-note">Same week as the OT Report — one picker for the tab.</div>
      </div>

      <div class="cost-note"><strong>Overtime worked by hourly SG&amp;A staff, in hours.</strong>
        SG&amp;A is not costed in this app: these people carry no wage or salary here, so there are no
        dollars on this page and that is deliberate. Everyone in the SG&amp;A cost class who can earn an
        overtime hour is listed, including at zero — an empty row means no overtime, not no data.
        Salaried office staff are not listed: the payroll file drops them and they earn no OT hour.</div>

      <div class="stat-row">
        <div class="stat-card"><div class="stat-label">SG&amp;A overtime</div>
          <div class="stat-value">${fmtHrs(totalOt)}</div><div class="stat-sub">hours this week</div></div>
        <div class="stat-card"><div class="stat-label">SG&amp;A hours worked</div>
          <div class="stat-value">${fmtHrs(totalHours)}</div><div class="stat-sub">all hours, same people</div></div>
        <div class="stat-card"><div class="stat-label">People</div>
          <div class="stat-value">${rows.length}</div><div class="stat-sub">hourly SG&amp;A on the roster</div></div>
      </div>

      ${rows.length?`
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Name</th><th>Department</th><th>Position</th>
            <th style="text-align:right">Days</th>
            <th style="text-align:right">Hours</th>
            <th style="text-align:right">Overtime</th>
          </tr></thead>
          <tbody>
            ${rows.map(r=>`<tr>
              <td style="font-weight:600">${esc(r.name)}${r.empNum?` <span style="color:var(--muted);font-size:11px">#${esc(r.empNum)}</span>`:''}</td>
              <td>${esc(r.department)}</td>
              <td style="color:var(--muted)">${esc(r.position||'—')}</td>
              <td style="text-align:right">${r.inFile?r.daysWorked:'—'}</td>
              <td style="text-align:right">${fmtHrs(r.hours)}</td>
              <td style="text-align:right;font-weight:${Number(r.otHours)>0?'800':'400'};color:${Number(r.otHours)>0?'var(--rust)':'var(--muted)'}">${fmtHrs(r.otHours)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`:`
      <div style="font-size:13px;color:var(--muted);padding:16px;background:var(--surface2);border-radius:4px;text-align:center">
        Nobody on the roster is both hourly and in the SG&amp;A cost class, so there is no SG&amp;A overtime
        to track. Cost class and pay type are set on the Employees tab.
      </div>`}

      <div style="font-size:11px;color:var(--muted);line-height:1.6;margin-top:14px">
        Hours come from the same weekly payroll file as the OT Report, joined to the roster on employee
        number. Somebody hourly and SG&amp;A with no employee number would be invisible here — the file
        has no other way to identify them — so set one on their profile card.
      </div>
    </div>`;
}
