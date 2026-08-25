// salaries — the Salaries & Wages tab.
//
// Shares one global scope with the other files in src/js (see core.js).
//
// TWO COLUMNS, TWO AUDIENCES, AND THAT IS THE WHOLE DESIGN.
//
//   employees.annual_salary   behind the salaries tier, both directions. Set
//                             here and nowhere else.
//   employees.wage            every signed-in user, read and write. Set here
//                             and nowhere else.
//
// The hourly section used to have no inputs, deliberately: BBSI's daily file
// rewrote employees.wage every morning, so a rate typed here would have been
// replaced overnight and the person who typed it would have gone away believing
// the number changed.
//
// That stopped being true on 2026-08-22. The file's Pay Rate column was a human
// transcription out of BBSI's payroll system into Timenet, kept alive only so
// the feed could exist, and nobody maintains it there any more. The import no
// longer reads it. employees.wage is the record of truth behind every dollar
// this system computes, so this page is where it is typed — and every change is
// recorded in wage_history by the server, which writes the history row before
// the rate.
//
// SO THE PAGE IS NO LONGER ONE GATE. The hourly half is open to everybody
// signed in; the salaried half needs the tier. The tab is visible to everyone
// and the section inside it is what is gated, because a supervisor who cannot
// set a pay rate anywhere is worse than a page with a section they cannot see.
//
// The gate on the salaried half is cosmetic here and load-bearing on the
// server: /api/data builds its projection from the caller's tiers, so
// annual_salary is absent from the select= before any row is read, and a write
// of it is refused with a 403 that names the column.

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

// ------------------------------------------------------------------------
// hourly rates
// ------------------------------------------------------------------------
//
// A MIRROR OF THE SERVER'S RULES, NOT A SECOND SET OF THEM. wage-edit-lib.js
// decides what an edit means and refuses what cannot be recorded; everything
// below exists so the page does not OFFER a control the server would refuse,
// and so the refusal reads as a sentence rather than as a status code when it
// happens anyway. If the two ever disagree, the server wins and the user is
// told what it said.

// The same three-way answer parseSalary gives, for the same reason — except
// that here null is NOT a real instruction. A cleared salary means "this person
// has no salary on file"; a cleared rate cannot mean anything, because
// wage_history.rate is NOT NULL and a rate that disappeared without a record is
// exactly what that history exists to prevent. So null is refused too, just
// with its own sentence.
function parseRate(raw){
  const s=String(raw==null?'':raw).trim();
  if(s==='') return null;
  const n=Number(s.replace(/[$,\s]/g,''));
  if(!isFinite(n)||n<=0) return undefined;
  return Math.round(n*100)/100;
}

// The rate the roster currently holds, as a number, or null. Shares parseRate's
// view of zero: a stored '0.00' is not a rate, so typing a real one over it is
// a first observation rather than a change.
function currentRate(e){
  const n=parseRate(e&&e.wage);
  return (n===undefined||n===null)?null:n;
}

// wage_history is keyed by employee number and the column is NOT NULL, so a
// person without one cannot have a rate recorded. The server refuses it; this
// is why the row has no input to type into.
function canEditRate(e){ return !!String((e&&e.empNum)||'').trim(); }

function wageDraft(e){
  return Object.prototype.hasOwnProperty.call(state.wageDrafts,e.id)
    ? state.wageDrafts[e.id]
    : (currentRate(e)==null?'':currentRate(e).toFixed(2));
}

function wageSet(id,v){ state.wageDrafts[id]=v; wageRefreshBar(); }

function wageRefreshBar(){
  const bar=document.getElementById('wageBar');
  if(!bar) return;
  bar.innerHTML=wageBarInner(wageChanges().length);
}

// Which rows actually differ. Comparing PARSED values: '24.5' over a stored
// '24.50' is not a change, and saving it would append a wage_history row saying
// a rate moved when it did not.
function wageChanges(){
  const out=[];
  for(const e of hourlyPeople()){
    if(!Object.prototype.hasOwnProperty.call(state.wageDrafts,e.id)) continue;
    const raw=state.wageDrafts[e.id];
    const parsed=parseRate(raw);
    const current=currentRate(e);
    if(parsed===undefined||parsed===null){ out.push({e,raw,parsed}); continue; }
    if(current!=null&&Math.abs(current-parsed)<0.005) continue;
    out.push({e,raw,parsed,current});
  }
  return out;
}

// Mirrors WAGE_CHANGE_ALERT_PCT's default. The server decides what is actually
// flagged — this only warns before the click, so a mistyped 2450 for 24.50 is
// visible while it can still be fixed.
const WAGE_FLAG_PCT=20;

function wageMovePct(e,parsed){
  const current=currentRate(e);
  if(current==null||current===0||parsed==null||parsed===undefined) return null;
  return Math.round(((parsed-current)/current)*10000)/100;
}

async function saveWages(){
  const changes=wageChanges();
  if(!changes.length){toast('Nothing has changed','warning');return;}

  // A field that cannot be saved stops the WHOLE save before any of it happens,
  // exactly as the salary half does. Writing the rows that parsed and skipping
  // the one that did not is how somebody walks away believing all of it landed.
  const blank=changes.filter(c=>c.parsed===null);
  if(blank.length){
    toast('A rate cannot be cleared, only corrected: '+blank.map(c=>c.e.name).join('; ')+
          '. Wage history has no way to record a rate that went away.','error');
    return;
  }
  const bad=changes.filter(c=>c.parsed===undefined);
  if(bad.length){
    toast('Not an hourly rate: '+bad.map(c=>`${c.e.name} ("${c.raw}")`).join('; ')+
          '. Enter a number greater than zero.','error');
    return;
  }

  state.wageSaving=true; render();
  const failures=[];
  let saved=0;
  for(const c of changes){
    try{
      const res=await fetch('/api/data?table=employees&id='+c.e.id,{
        method:'PATCH',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({wage:c.parsed.toFixed(2)})
      });
      if(!res.ok){
        const d=await res.json().catch(()=>({}));
        // 409 is the server refusing to record the change — salaried, no
        // employee number, nothing this page could have known was stale. Its
        // detail is written to be read by the person who typed the number, so
        // it is shown rather than replaced with a status code.
        throw new Error(res.status===409
          ? (d.detail||d.error||'the change could not be recorded')
          : (d.error||('failed with status '+res.status)));
      }
      c.e.wage=c.parsed.toFixed(2);
      delete state.wageDrafts[c.e.id];
      saved++;
    }catch(err){
      failures.push(`${c.e.name} — ${err.message}`);
    }
  }
  state.wageSaving=false;
  render();

  if(failures.length){
    toast(`Saved ${saved} of ${changes.length}. NOT saved: ${failures.join('; ')}`,'error');
  }else{
    toast(saved===1?'Rate saved':`${saved} rates saved`,'success');
  }
}

function wageCancel(){
  state.wageDrafts={};
  render();
}

function wageBarInner(n){
  const dis=state.wageSaving||!n?' disabled':'';
  return `
    <span style="font-size:12px;color:var(--muted)">${
      state.wageSaving?'Saving…':(n?`${n} unsaved ${n===1?'change':'changes'}`:'No unsaved changes')}</span>
    <span style="flex:1"></span>
    <button class="btn" style="background:none;border:1px solid var(--border);color:var(--muted)"
      onclick="wageCancel()"${dis}>Discard</button>
    <button class="btn btn-primary" onclick="saveWages()"${dis}>Save</button>`;
}

function renderSalaries(){
  const salaried=salariedPeople();
  const hourly=hourlyPeople();
  const canSalaries=canSeeSalaries();
  const changes=salaryChanges().length;
  const wageEdits=wageChanges().length;

  const known=salaried.filter(e=>e.annualSalary!=null&&e.annualSalary!=='');
  const totalAnnual=known.reduce((s,e)=>s+Number(e.annualSalary||0),0);
  const missing=salaried.length-known.length;
  const noRate=hourly.filter(e=>currentRate(e)==null);
  const noNumber=hourly.filter(e=>!canEditRate(e));

  return `
    <div style="max-width:1100px;margin:0 auto;padding:20px">
      <h2 style="font-size:24px;font-weight:700;margin-bottom:6px;color:var(--text)">Salaries &amp; Wages</h2>
      <div style="font-size:12px;color:var(--muted);line-height:1.6;margin-bottom:24px;max-width:760px">
        Both columns are ours, and this is the only place either is set. <b>Hourly rates</b> are what
        every cost and overtime figure in the app is computed from — the daily payroll file carries
        hours and nothing else. Every change is recorded in wage history, which cannot be edited.
        <b>Annual salary</b> needs the salaries tier.
      </div>

      <!-- ---------------------------------------------------------------- -->
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:24px;margin-bottom:24px">
        <div style="display:flex;align-items:baseline;gap:12px;margin-bottom:6px">
          <div style="font-size:16px;font-weight:700">Hourly</div>
          <div style="font-size:12px;color:var(--muted)">${hourly.length} ${hourly.length===1?'person':'people'}</div>
        </div>
        <div style="font-size:12px;color:var(--muted);line-height:1.6;margin-bottom:18px">
          Typed here and nowhere else. Until 2026-08-22 this column came from the daily BBSI file;
          that rate was re-keyed by hand into the hours system and nobody maintains it there any
          more, so the import stopped reading it. A change takes effect the moment it is saved and
          every report recomputes from it.
          ${noRate.length?`<b style="color:#b8860b">${noRate.length} ${noRate.length===1?'person has':'people have'} no rate on file, so ${noRate.length===1?'their':'their'} cost cannot be computed at all.</b>`:''}
          ${noNumber.length?`<b style="color:#b8860b">${noNumber.length} ${noNumber.length===1?'person has':'people have'} no employee number, so no rate can be recorded for ${noNumber.length===1?'them':'them'} — set it on the Employees tab first.</b>`:''}
        </div>

        ${hourly.length?`
        <table>
          <thead><tr>
            <th>Name</th><th>Position</th><th>Department</th><th>Emp #</th>
            <th style="text-align:right">Rate</th>
            <th style="text-align:right">Change</th>
          </tr></thead>
          <tbody>
            ${hourly.map(e=>{
              const editable=canEditRate(e);
              const draft=wageDraft(e);
              const parsed=parseRate(draft);
              const bad=parsed===undefined||parsed===null;
              const current=currentRate(e);
              const dirty=!bad&&(current==null||Math.abs(current-parsed)>=0.005);
              const pct=dirty?wageMovePct(e,parsed):null;
              const flag=pct!=null&&Math.abs(pct)>WAGE_FLAG_PCT;
              return `<tr${(bad&&editable)?' style="background:rgba(184,134,11,.08)"':(dirty?' style="background:var(--surface2)"':'')}>
                <td style="font-size:13px;padding:10px 12px;font-weight:600">${esc(e.name||'')}</td>
                <td style="font-size:13px;padding:10px 12px">${esc(e.position||'—')}</td>
                <td style="font-size:13px;padding:10px 12px">${esc(e.department||'—')}</td>
                <td style="font-size:13px;padding:10px 12px;color:var(--muted)">${esc(e.empNum||'—')}</td>
                <td style="padding:8px 12px;text-align:right">${editable?`
                  <input type="text" value="${esc(draft)}" placeholder="—"
                    style="width:110px;text-align:right${(bad&&editable)?';border-color:#b8860b':''}"
                    ${state.wageSaving?'disabled':''}
                    oninput="wageSet('${jsStr(e.id)}',this.value)">`:`
                  <span style="font-size:13px;color:var(--muted)" title="wage history is keyed by employee number">${esc(fmtWage(e))}</span>`}</td>
                <td style="font-size:12px;padding:10px 12px;text-align:right;color:${flag?'#b8860b':'var(--muted)'}">${
                  !dirty?'':(current==null
                    ? 'first rate'
                    : `${pct>0?'+':''}${pct}%${flag?' — will be flagged':''}`)}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>

        <div id="wageBar" style="display:flex;align-items:center;gap:10px;margin-top:16px">
          ${wageBarInner(wageEdits)}
        </div>
        `:`
        <div style="font-size:13px;color:var(--muted);padding:16px;background:var(--surface2);border-radius:4px;text-align:center">
          Nobody on the roster is hourly.
        </div>`}
      </div>

      <!-- ---------------------------------------------------------------- -->
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:24px">
        <div style="display:flex;align-items:baseline;gap:12px;margin-bottom:6px">
          <div style="font-size:16px;font-weight:700">Salaried</div>
          <div style="font-size:12px;color:var(--muted)">${canSalaries?`${salaried.length} ${salaried.length===1?'person':'people'}`:'restricted'}</div>
        </div>
        ${!canSalaries?`
        <div style="font-size:13px;color:var(--muted);line-height:1.6;padding:16px;background:var(--surface2);border-radius:4px">
          Annual salaries need the salaries tier. An administrator can grant it under
          Settings&nbsp;→&nbsp;Access. The figures are not sent to this browser without it.
        </div>
        `:`
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
        </div>`}`}
      </div>
    </div>
  `;
}
