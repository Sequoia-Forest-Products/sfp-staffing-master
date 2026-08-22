// salaries — the Salaries & Wages tab.
//
// Shares one global scope with the other files in src/js (see core.js).
//
// TWO COLUMNS, TWO OWNERS, AND THAT IS THE WHOLE DESIGN.
//
//   employees.annual_salary   ours. Nothing else writes it. Editable here, and
//                             only here, and only by the salaries tier.
//   employees.wage            BBSI's. payroll-db.updateEmployeeWage rewrites it
//                             from the daily file every morning with the
//                             service key. READ-ONLY, everywhere, forever.
//
// The hourly section has no inputs, and that is deliberate rather than
// unfinished. A rate typed into this app would be replaced by the next
// morning's import with nobody told, which is worse than having nowhere to type
// it: the person who typed it would go away believing the number changed. The
// server agrees — permissions-lib refuses `wage` on write for every tier,
// including admin.
//
// The tab itself is hidden without the salaries tier, but that is cosmetic. The
// figures are not in the payload at all without it: /api/data builds its
// projection from the caller's tiers, so annual_salary is absent from the
// select= before any row is read.

// 40 hours x 52 weeks, mirroring SALARY_HOURS_PER_YEAR in
// netlify/functions/wage-sync.js. The mill's own week is 4x10, which is the
// same 40, so this is the conventional annualisation and not a schedule
// assumption. It is the divisor the costing reports already use, so showing it
// here is showing what those reports will do with the number — not a second
// opinion about it.
const SALARY_HOURS_PER_YEAR = 2080;

function fmtSalary(n){
  if(n==null||n==='') return '—';
  const v=Number(n);
  return isFinite(v) ? '$'+v.toLocaleString('en-US',{maximumFractionDigits:0}) : '—';
}

// Accepts what somebody actually types: 105000, 105,000, $105,000, 105000.00.
// Returns a number, null for an empty field, or undefined for something that is
// neither — the three cases have to stay distinct, because null is a real
// instruction ("this person has no salary on file") and undefined is a refusal.
function parseSalary(raw){
  const s=String(raw==null?'':raw).trim();
  if(s==='') return null;
  const n=Number(s.replace(/[$,\s]/g,''));
  if(!isFinite(n)||n<0) return undefined;
  return Math.round(n*100)/100;
}

function salaryDraft(e){
  return Object.prototype.hasOwnProperty.call(state.salaryDrafts,e.id)
    ? state.salaryDrafts[e.id]
    : (e.annualSalary==null?'':String(e.annualSalary));
}

function salarySet(id,v){ state.salaryDrafts[id]=v; salaryRefreshBar(); }

// The Save bar is updated in place rather than through render(), because a full
// re-render on every keystroke moves the caret to the end of the field.
function salaryRefreshBar(){
  const bar=document.getElementById('salaryBar');
  if(!bar) return;
  const n=salaryChanges().length;
  bar.innerHTML=salaryBarInner(n);
}

// Which rows actually differ from what the database returned. Comparing the
// PARSED values, not the strings: typing '105,000' over a stored 105000 is not
// a change, and saving it would write a row and log an edit for nothing.
function salaryChanges(){
  const out=[];
  for(const e of salariedPeople()){
    if(!Object.prototype.hasOwnProperty.call(state.salaryDrafts,e.id)) continue;
    const raw=state.salaryDrafts[e.id];
    const parsed=parseSalary(raw);
    const current=e.annualSalary==null?null:Number(e.annualSalary);
    if(parsed===undefined){ out.push({e,raw,parsed:undefined}); continue; }
    if(parsed===current) continue;
    out.push({e,raw,parsed});
  }
  return out;
}

function salariedPeople(){
  return (state.employees||[]).filter(e=>isSalaried(e))
    .sort((a,b)=>String(a.name||'').localeCompare(String(b.name||'')));
}

function hourlyPeople(){
  return (state.employees||[]).filter(e=>!isSalaried(e))
    .sort((a,b)=>String(a.name||'').localeCompare(String(b.name||'')));
}

async function saveSalaries(){
  const changes=salaryChanges();
  if(!changes.length){toast('Nothing has changed','warning');return;}

  // A field that cannot be read as a number stops the whole save before any of
  // it happens. Writing the rows that parsed and silently skipping the one that
  // did not is how somebody walks away believing all of it saved.
  const unparseable=changes.filter(c=>c.parsed===undefined);
  if(unparseable.length){
    toast('Not a number: '+unparseable.map(c=>`${c.e.name} ("${c.raw}")`).join('; '),'error');
    return;
  }

  state.salarySaving=true; render();
  const failures=[];
  let saved=0;
  for(const c of changes){
    try{
      const res=await fetch('/api/data?table=employees&id='+c.e.id,{
        method:'PATCH',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({annual_salary:c.parsed})
      });
      if(!res.ok){
        const d=await res.json().catch(()=>({}));
        // 403 here means the tier was revoked between the page loading and the
        // Save. Said plainly rather than as a status code, because it is the
        // one failure a user cannot fix by retrying.
        throw new Error(res.status===403
          ? 'no longer permitted to edit salaries'
          : (d.error||('failed with status '+res.status)));
      }
      c.e.annualSalary=c.parsed;
      delete state.salaryDrafts[c.e.id];
      saved++;
    }catch(err){
      failures.push(`${c.e.name} — ${err.message}`);
    }
  }
  state.salarySaving=false;
  render();

  if(failures.length){
    // Never "Saved" when part of it did not commit. Names the people whose rows
    // did not, and leaves their drafts in place so the values are not lost.
    toast(`Saved ${saved} of ${changes.length}. NOT saved: ${failures.join('; ')}`,'error');
  }else{
    toast(saved===1?'Salary saved':`${saved} salaries saved`,'success');
  }
}

function salaryCancel(){
  state.salaryDrafts={};
  render();
}

function salaryBarInner(n){
  const dis=state.salarySaving||!n?' disabled':'';
  return `
    <span style="font-size:12px;color:var(--muted)">${
      state.salarySaving?'Saving…':(n?`${n} unsaved ${n===1?'change':'changes'}`:'No unsaved changes')}</span>
    <span style="flex:1"></span>
    <button class="btn" style="background:none;border:1px solid var(--border);color:var(--muted)"
      onclick="salaryCancel()"${dis}>Discard</button>
    <button class="btn btn-primary" onclick="saveSalaries()"${dis}>Save</button>`;
}

function renderSalaries(){
  // Defence in depth, and it costs one line. The tab is hidden without the
  // tier, the figures are absent from the payload without it, and this refuses
  // to draw the page anyway — because a deep link, a stale tab or a hand-typed
  // switchTab() in the console should all land somewhere honest.
  if(!canSeeSalaries()){
    return `<div style="max-width:720px;margin:40px auto;padding:20px;text-align:center">
      <div style="font-size:16px;font-weight:700;margin-bottom:8px">Salaries &amp; Wages</div>
      <div style="font-size:13px;color:var(--muted);line-height:1.6">
        This page needs the salaries tier. An administrator can grant it under Settings → Access.
      </div></div>`;
  }

  const salaried=salariedPeople();
  const hourly=hourlyPeople();
  const changes=salaryChanges().length;

  const known=salaried.filter(e=>e.annualSalary!=null&&e.annualSalary!=='');
  const totalAnnual=known.reduce((s,e)=>s+Number(e.annualSalary||0),0);
  const missing=salaried.length-known.length;
  const noRate=hourly.filter(e=>{
    const n=parseFloat(String(e.wage==null?'':e.wage).replace(/[$,]/g,''));
    return isNaN(n);
  });

  return `
    <div style="max-width:1100px;margin:0 auto;padding:20px">
      <h2 style="font-size:24px;font-weight:700;margin-bottom:6px;color:var(--text)">Salaries &amp; Wages</h2>
      <div style="font-size:12px;color:var(--muted);line-height:1.6;margin-bottom:24px;max-width:760px">
        Two columns with two different owners. <b>Annual salary</b> is ours — this is the only place
        it is set, and nothing else writes it. <b>Hourly rates</b> are BBSI's: the daily payroll file
        overwrites them every morning, so they are shown here and cannot be edited anywhere in the app.
      </div>

      <!-- ---------------------------------------------------------------- -->
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:24px;margin-bottom:24px">
        <div style="display:flex;align-items:baseline;gap:12px;margin-bottom:6px">
          <div style="font-size:16px;font-weight:700">Salaried</div>
          <div style="font-size:12px;color:var(--muted)">${salaried.length} ${salaried.length===1?'person':'people'}</div>
        </div>
        <div style="font-size:12px;color:var(--muted);line-height:1.6;margin-bottom:18px">
          The hourly equivalent is <b>salary ÷ ${SALARY_HOURS_PER_YEAR.toLocaleString('en-US')}</b>, which is
          what the costing reports divide by — shown so this page and those reports cannot disagree
          about what a salary means. ${missing?`<b style="color:#b8860b">${missing} ${missing===1?'person has':'people have'} no salary on file, so ${missing===1?'their':'their'} cost cannot be computed at all.</b>`:''}
        </div>

        ${salaried.length?`
        <table>
          <thead><tr>
            <th>Name</th><th>Position</th><th>Department</th>
            <th style="text-align:right">Annual salary</th>
            <th style="text-align:right">Hourly equivalent</th>
          </tr></thead>
          <tbody>
            ${salaried.map(e=>{
              const draft=salaryDraft(e);
              const parsed=parseSalary(draft);
              const bad=parsed===undefined;
              const dirty=!bad&&parsed!==(e.annualSalary==null?null:Number(e.annualSalary));
              return `<tr${bad?' style="background:rgba(184,134,11,.08)"':(dirty?' style="background:var(--surface2)"':'')}>
                <td style="font-size:13px;padding:10px 12px;font-weight:600">${esc(e.name||'')}</td>
                <td style="font-size:13px;padding:10px 12px">${esc(e.position||'—')}</td>
                <td style="font-size:13px;padding:10px 12px">${esc(e.department||'—')}</td>
                <td style="padding:8px 12px;text-align:right">
                  <input type="text" value="${esc(draft)}" placeholder="—"
                    style="width:130px;text-align:right${bad?';border-color:#b8860b':''}"
                    ${state.salarySaving?'disabled':''}
                    oninput="salarySet('${jsStr(e.id)}',this.value)"></td>
                <td style="font-size:13px;padding:10px 12px;text-align:right;color:var(--muted)">${
                  bad?'—':(parsed==null?'—':fmt$(Math.round(parsed/SALARY_HOURS_PER_YEAR*100)/100))}</td>
              </tr>`;
            }).join('')}
          </tbody>
          <tfoot><tr>
            <td colspan="3" style="font-size:12px;padding:12px;color:var(--muted)">
              Total of the ${known.length} on file${missing?`, excluding ${missing} with none`:''}</td>
            <td style="text-align:right;padding:12px;font-weight:700">${fmtSalary(totalAnnual)}</td>
            <td></td>
          </tr></tfoot>
        </table>

        <div id="salaryBar" style="display:flex;align-items:center;gap:10px;margin-top:16px">
          ${salaryBarInner(changes)}
        </div>
        `:`
        <div style="font-size:13px;color:var(--muted);padding:16px;background:var(--surface2);border-radius:4px;text-align:center">
          Nobody on the roster is marked salaried. Pay type is set on the Employees tab.
        </div>`}
      </div>

      <!-- ---------------------------------------------------------------- -->
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:24px">
        <div style="display:flex;align-items:baseline;gap:12px;margin-bottom:6px">
          <div style="font-size:16px;font-weight:700">Hourly</div>
          <div style="font-size:12px;color:var(--muted)">${hourly.length} ${hourly.length===1?'person':'people'} · read-only</div>
        </div>
        <div style="font-size:12px;color:var(--muted);line-height:1.6;margin-bottom:18px">
          From the daily BBSI payroll file, which rewrites this column every morning. There is no
          field to change it here or anywhere else in the app — a rate typed in would be replaced
          overnight and nobody would be told. To change one, change it in BBSI.
          ${noRate.length?`<b style="color:#b8860b">${noRate.length} ${noRate.length===1?'person has':'people have'} no rate on file.</b>`:''}
        </div>

        ${hourly.length?`
        <table>
          <thead><tr>
            <th>Name</th><th>Position</th><th>Department</th><th>Emp #</th>
            <th style="text-align:right">Rate</th>
          </tr></thead>
          <tbody>
            ${hourly.map(e=>`<tr>
              <td style="font-size:13px;padding:10px 12px;font-weight:600">${esc(e.name||'')}</td>
              <td style="font-size:13px;padding:10px 12px">${esc(e.position||'—')}</td>
              <td style="font-size:13px;padding:10px 12px">${esc(e.department||'—')}</td>
              <td style="font-size:13px;padding:10px 12px;color:var(--muted)">${esc(e.empNum||'—')}</td>
              <td style="font-size:13px;padding:10px 12px;text-align:right">${esc(fmtWage(e))}</td>
            </tr>`).join('')}
          </tbody>
        </table>
        `:`
        <div style="font-size:13px;color:var(--muted);padding:16px;background:var(--surface2);border-radius:4px;text-align:center">
          Nobody on the roster is hourly.
        </div>`}
      </div>
    </div>
  `;
}
