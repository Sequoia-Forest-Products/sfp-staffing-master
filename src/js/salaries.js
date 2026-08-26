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
// THE PAGE IS NO LONGER ONE GATE. The hourly half is open to everybody signed
// in; the salaried half needs the tier. The tab is visible to everyone and the
// section inside it is what is gated, because a supervisor who cannot set a pay
// rate anywhere is worse than a page with a section they cannot see.
//
// ------------------------------------------------------------------------
// ONE PERSON AT A TIME, AND ONLY THE ACTIVE ONES
// ------------------------------------------------------------------------
//
// The page used to be two tables of open inputs with a Save bar under each.
// Every row on the roster was an editable field, all of them live at once, and
// one Save committed whatever had been typed anywhere. Three things were wrong
// with that and only the third is cosmetic:
//
//   1. A MIS-CLICK LOOKED LIKE AN EDIT. Tabbing through a table of inputs, or
//      clicking the wrong row, put a caret in somebody's pay. Nothing about the
//      screen distinguished "I meant to change Ana's rate" from "I was aiming
//      for the row above".
//
//   2. ONE SAVE MOVED SEVERAL PEOPLE'S PAY. The bar said "3 unsaved changes"
//      and committed all three. Every one of them wrote a wage_history row
//      attributing a rate change to whoever clicked, and the reviewer of that
//      history has no way to tell a deliberate batch from a stray keystroke
//      that rode along.
//
//   3. Inactive people were in the list, which is most of the length of it and
//      none of the interest.
//
// So: the list is READ-ONLY and a row opens that person's own screen, with one
// field, a Save and a Cancel. Leaving the screen without saving discards. The
// list shows ACTIVE employees only — a terminated person's rate is history, and
// history is what wage_history is for.
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

// Mirrors WAGE_CHANGE_ALERT_PCT's default. The server decides what is actually
// flagged — this only warns before the click, so a mistyped 2450 for 24.50 is
// visible while it can still be fixed.
const WAGE_FLAG_PCT = 20;

function fmtSalary(n){
  if(n==null||n==='') return '—';
  const v=Number(n);
  return isFinite(v) ? '$'+v.toLocaleString('en-US',{maximumFractionDigits:0}) : '—';
}

// ------------------------------------------------------------------------
// who is on the page
// ------------------------------------------------------------------------

// Active only. A blank status reads as active, matching isActive() in
// ot-report-lib.js and wage-sync.js: the roster is the thing being listed here,
// and guessing "inactive" would hide a real person.
function payActive(e){
  const raw=String((e&&e.status)==null?'':e.status).trim();
  return raw==='' || raw.toLowerCase()==='active';
}

const byName=(a,b)=>String(a.name||'').localeCompare(String(b.name||''));

function salariedPeople(){
  return (state.employees||[]).filter(e=>isSalaried(e)&&payActive(e)).sort(byName);
}

function hourlyPeople(){
  return (state.employees||[]).filter(e=>!isSalaried(e)&&payActive(e)).sort(byName);
}

// How many are being left out, so "where is everybody" has an answer on the
// page rather than in somebody's head.
function inactiveCount(){
  return (state.employees||[]).filter(e=>!payActive(e)).length;
}

// ------------------------------------------------------------------------
// parsing — the client mirror of the server's rules
// ------------------------------------------------------------------------
//
// A MIRROR, NOT A SECOND SET OF THEM. wage-edit-lib.js decides what an edit
// means and refuses what cannot be recorded; everything below exists so the
// page does not OFFER a control the server would refuse, and so the refusal
// reads as a sentence rather than a status code when it happens anyway. If the
// two ever disagree, the server wins and the user is told what it said.

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

// The same three-way answer, for the same reason — except that here null is NOT
// a real instruction. A cleared salary means "this person has no salary on
// file"; a cleared rate cannot mean anything, because wage_history.rate is NOT
// NULL and a rate that disappeared without a record is exactly what that
// history exists to prevent. So null is refused too, with its own sentence.
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
// is why their row does not open.
function canEditRate(e){ return !!String((e&&e.empNum)||'').trim(); }

function wageMovePct(e,parsed){
  const current=currentRate(e);
  if(current==null||current===0||parsed==null||parsed===undefined) return null;
  return Math.round(((parsed-current)/current)*10000)/100;
}

// ------------------------------------------------------------------------
// the detail screen
// ------------------------------------------------------------------------

function payPerson(){
  if(!state.pay||state.pay.id==null) return null;
  return (state.employees||[]).find(e=>String(e.id)===String(state.pay.id))||null;
}

// The value the field starts at: what the database holds, formatted the way it
// will be stored. Not blank — somebody correcting 24.50 to 25.00 should not
// have to retype the part that is already right.
function payInitialDraft(e){
  if(isSalaried(e)) return e.annualSalary==null?'':String(e.annualSalary);
  const r=currentRate(e);
  return r==null?'':r.toFixed(2);
}

function openPay(id){
  const e=(state.employees||[]).find(x=>String(x.id)===String(id));
  if(!e) return;
  // Refused before the screen opens rather than on Save. The list already
  // excludes all three cases, but openPay is reachable from a row rendered
  // before a status changed and from the console, so the list is not the gate.
  if(!payActive(e)){
    toast(`${e.name} is not active. Their pay is history — reactivate them on the Employees tab first.`,'error');
    return;
  }
  if(isSalaried(e)&&!canSeeSalaries()){ toast('Annual salaries need the salaries tier','error'); return; }
  if(!isSalaried(e)&&!canEditRate(e)){
    toast(`${e.name} has no employee number, so a rate change could not be recorded. Set their Emp # on the Employees tab first.`,'error');
    return;
  }
  state.pay={id:String(id), draft:payInitialDraft(e), saving:false, error:''};
  render();
}

function closePay(){
  state.pay={id:null, draft:'', saving:false, error:''};
  render();
}

// Updated in place rather than through render(), because a full re-render on
// every keystroke moves the caret to the end of the field.
function paySet(v){
  if(!state.pay) return;
  state.pay.draft=v;
  const el=document.getElementById('payFoot');
  if(el) el.innerHTML=payFootInner();
}

// Whether the draft differs from what is stored. Compared as PARSED values:
// '24.5' over a stored '24.50' is not a change, and saving it would append a
// wage_history row saying a rate moved when it did not.
function payDirty(){
  const e=payPerson();
  if(!e||!state.pay) return false;
  if(isSalaried(e)){
    const parsed=parseSalary(state.pay.draft);
    if(parsed===undefined) return true;             // unparseable counts as dirty so Save is reachable and can explain
    const current=e.annualSalary==null?null:Number(e.annualSalary);
    return parsed!==current;
  }
  const parsed=parseRate(state.pay.draft);
  if(parsed===undefined||parsed===null) return true;
  const current=currentRate(e);
  return current==null||Math.abs(current-parsed)>=0.005;
}

async function savePay(){
  const e=payPerson();
  if(!e||!state.pay||state.pay.saving) return;

  const salaried=isSalaried(e);
  const parsed=salaried?parseSalary(state.pay.draft):parseRate(state.pay.draft);

  // Each refusal gets its own sentence, because each has a different remedy.
  if(parsed===undefined){
    state.pay.error=salaried
      ? `"${String(state.pay.draft).trim()}" is not a number. Enter an annual salary, e.g. 105000.`
      : `"${String(state.pay.draft).trim()}" is not an hourly rate. Enter a number greater than zero, e.g. 24.50.`;
    render(); return;
  }
  if(!salaried&&parsed===null){
    state.pay.error='A rate cannot be cleared, only corrected. Wage history has no way to record a rate that went away.';
    render(); return;
  }
  if(!payDirty()){ toast('Nothing has changed','warning'); return; }

  state.pay.saving=true; state.pay.error=''; render();
  try{
    const body=salaried
      ? {annual_salary:parsed}
      : {wage:parsed.toFixed(2)};
    const res=await fetch('/api/data?table=employees&id='+encodeURIComponent(e.id),{
      method:'PATCH',headers:{'Content-Type':'application/json'},
      body:JSON.stringify(body)
    });
    if(!res.ok){
      const d=await res.json().catch(()=>({}));
      // 409 is the server refusing to RECORD the change — salaried, no employee
      // number, something this page could not have known was stale. Its detail
      // is written to be read by the person who typed the number.
      // 403 is the tier being revoked between the page loading and the Save.
      throw new Error(
        res.status===409 ? (d.detail||d.error||'the change could not be recorded') :
        res.status===403 ? (salaried?'no longer permitted to edit salaries':'no longer permitted to edit rates') :
        (d.error||('failed with status '+res.status)));
    }
    // The local copy advances only after the write is known to have landed.
    if(salaried) e.annualSalary=parsed; else e.wage=parsed.toFixed(2);
    closePay();
    toast(salaried?'Salary saved':'Rate saved','success');
  }catch(err){
    state.pay.saving=false;
    state.pay.error=err.message;
    render();
  }
}

function payFootInner(){
  const e=payPerson();
  if(!e||!state.pay) return '';
  const salaried=isSalaried(e);
  const parsed=salaried?parseSalary(state.pay.draft):parseRate(state.pay.draft);
  const dirty=payDirty();

  let note='';
  if(parsed===undefined){
    note=`<span style="color:#b8860b">Not a number</span>`;
  }else if(salaried){
    note=parsed==null
      ? `<span style="color:var(--muted)">No salary on file — their cost cannot be computed</span>`
      : `<span style="color:var(--muted)">Hourly equivalent ${fmt$(Math.round(parsed/SALARY_HOURS_PER_YEAR*100)/100)}</span>`;
  }else if(parsed===null){
    note=`<span style="color:#b8860b">A rate cannot be cleared, only corrected</span>`;
  }else{
    const pct=wageMovePct(e,parsed);
    const flag=pct!=null&&Math.abs(pct)>WAGE_FLAG_PCT;
    note=pct==null
      ? `<span style="color:var(--muted)">First rate on file</span>`
      : `<span style="color:${flag?'#b8860b':'var(--muted)'}">${pct>0?'+':''}${pct}%${flag?' — this will be flagged for review':''}</span>`;
  }

  const dis=state.pay.saving?' disabled':'';
  return `
    <div style="font-size:12px;flex:1">${state.pay.saving?'<span style="color:var(--muted)">Saving…</span>':note}</div>
    <button class="btn" style="background:none;border:1px solid var(--border);color:var(--muted)"
      onclick="closePay()"${dis}>Cancel</button>
    <button class="btn btn-primary" onclick="savePay()"${dis||(dirty?'':' disabled')}>Save</button>`;
}

function renderPayDetail(){
  const e=payPerson();
  if(!e) return '';
  const salaried=isSalaried(e);

  return `
    <div style="max-width:640px;margin:0 auto;padding:20px">
      <button class="btn" style="background:none;border:1px solid var(--border);color:var(--muted);margin-bottom:20px"
        onclick="closePay()">&larr; Salaries &amp; Wages</button>

      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:24px">
        <div style="font-size:20px;font-weight:700;margin-bottom:4px">${esc(e.name||'')}</div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:24px">
          ${esc(e.position||'—')} · ${esc(e.department||'—')}${e.empNum?' · Emp # '+esc(e.empNum):''}
        </div>

        <label class="form-label">${salaried?'Annual salary':'Hourly rate ($/hr)'}</label>
        <input type="text" id="payInput" value="${esc(state.pay.draft)}" placeholder="${salaried?'105000':'24.50'}"
          style="width:180px;font-size:16px;padding:10px"
          ${state.pay.saving?'disabled':''}
          oninput="paySet(this.value)">

        <div style="font-size:12px;color:var(--muted);line-height:1.6;margin-top:14px">
          ${salaried
            ? `Divided by ${SALARY_HOURS_PER_YEAR.toLocaleString('en-US')} to give the hourly equivalent the costing reports use.`
            : `Every change is recorded in wage history — the previous rate, the new one, and who made the change. That record cannot be edited afterwards.`}
        </div>

        ${state.pay.error?`
        <div style="font-size:12px;color:var(--brick);line-height:1.6;margin-top:14px;padding:10px 12px;background:rgba(178,58,44,.08);border-radius:4px">
          <b>Not saved.</b> ${esc(state.pay.error)}
        </div>`:''}

        <div id="payFoot" style="display:flex;align-items:center;gap:10px;margin-top:24px">
          ${payFootInner()}
        </div>
      </div>
    </div>
  `;
}

// ------------------------------------------------------------------------
// the list
// ------------------------------------------------------------------------

const payRowStyle='font-size:13px;padding:10px 12px';

function renderSalaries(){
  // One screen or the other, never both.
  if(state.pay&&state.pay.id!=null&&payPerson()) return renderPayDetail();

  const salaried=salariedPeople();
  const hourly=hourlyPeople();
  const canSalaries=canSeeSalaries();
  const inactive=inactiveCount();

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
        <b>Click a row to change somebody's pay.</b>
        ${inactive?`Active employees only — ${inactive} inactive ${inactive===1?'person is':'people are'} not listed.`:''}
      </div>

      <!-- ---------------------------------------------------------------- -->
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:24px;margin-bottom:24px">
        <div style="display:flex;align-items:baseline;gap:12px;margin-bottom:6px">
          <div style="font-size:16px;font-weight:700">Hourly</div>
          <div style="font-size:12px;color:var(--muted)">${hourly.length} active ${hourly.length===1?'person':'people'}</div>
        </div>
        <div style="font-size:12px;color:var(--muted);line-height:1.6;margin-bottom:18px">
          Typed here and nowhere else. Until 2026-08-22 this column came from the daily BBSI file;
          that rate was re-keyed by hand into the hours system and nobody maintains it there any
          more, so the import stopped reading it. A change takes effect the moment it is saved and
          every report recomputes from it.
          ${noRate.length?`<b style="color:#b8860b">${noRate.length} ${noRate.length===1?'person has':'people have'} no rate on file, so their cost cannot be computed at all.</b>`:''}
          ${noNumber.length?`<b style="color:#b8860b">${noNumber.length} ${noNumber.length===1?'person has':'people have'} no employee number, so no rate can be recorded for them — set it on the Employees tab first.</b>`:''}
        </div>

        ${hourly.length?`
        <table>
          <thead><tr>
            <th>Name</th><th>Position</th><th>Department</th><th>Emp #</th>
            <th style="text-align:right">Rate</th><th style="width:1%"></th>
          </tr></thead>
          <tbody>
            ${hourly.map(e=>{
              const editable=canEditRate(e);
              const rate=currentRate(e);
              return `<tr${editable?` style="cursor:pointer" onclick="openPay('${jsStr(e.id)}')"`:''}>
                <td style="${payRowStyle};font-weight:600">${esc(e.name||'')}</td>
                <td style="${payRowStyle}">${esc(e.position||'—')}</td>
                <td style="${payRowStyle}">${esc(e.department||'—')}</td>
                <td style="${payRowStyle};color:var(--muted)">${esc(e.empNum||'—')}</td>
                <td style="${payRowStyle};text-align:right${rate==null?';color:#b8860b':''}">${
                  rate==null?'no rate':fmt$(rate)}</td>
                <td style="${payRowStyle};text-align:right;color:var(--muted);white-space:nowrap">${
                  editable?'Change &rsaquo;':'<span title="wage history is keyed by employee number">needs Emp #</span>'}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
        `:`
        <div style="font-size:13px;color:var(--muted);padding:16px;background:var(--surface2);border-radius:4px;text-align:center">
          Nobody active on the roster is hourly.
        </div>`}
      </div>

      <!-- ---------------------------------------------------------------- -->
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:24px">
        <div style="display:flex;align-items:baseline;gap:12px;margin-bottom:6px">
          <div style="font-size:16px;font-weight:700">Salaried</div>
          <div style="font-size:12px;color:var(--muted)">${canSalaries?`${salaried.length} active ${salaried.length===1?'person':'people'}`:'restricted'}</div>
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
          about what a salary means. ${missing?`<b style="color:#b8860b">${missing} ${missing===1?'person has':'people have'} no salary on file, so their cost cannot be computed at all.</b>`:''}
        </div>

        ${salaried.length?`
        <table>
          <thead><tr>
            <th>Name</th><th>Position</th><th>Department</th>
            <th style="text-align:right">Annual salary</th>
            <th style="text-align:right">Hourly equivalent</th>
            <th style="width:1%"></th>
          </tr></thead>
          <tbody>
            ${salaried.map(e=>{
              const v=e.annualSalary==null||e.annualSalary===''?null:Number(e.annualSalary);
              return `<tr style="cursor:pointer" onclick="openPay('${jsStr(e.id)}')">
                <td style="${payRowStyle};font-weight:600">${esc(e.name||'')}</td>
                <td style="${payRowStyle}">${esc(e.position||'—')}</td>
                <td style="${payRowStyle}">${esc(e.department||'—')}</td>
                <td style="${payRowStyle};text-align:right${v==null?';color:#b8860b':''}">${
                  v==null?'none on file':fmtSalary(v)}</td>
                <td style="${payRowStyle};text-align:right;color:var(--muted)">${
                  v==null?'—':fmt$(Math.round(v/SALARY_HOURS_PER_YEAR*100)/100)}</td>
                <td style="${payRowStyle};text-align:right;color:var(--muted);white-space:nowrap">Change &rsaquo;</td>
              </tr>`;
            }).join('')}
          </tbody>
          <tfoot><tr>
            <td colspan="3" style="font-size:12px;padding:12px;color:var(--muted)">
              Total of the ${known.length} on file${missing?`, excluding ${missing} with none`:''}</td>
            <td style="text-align:right;padding:12px;font-weight:700">${fmtSalary(totalAnnual)}</td>
            <td></td><td></td>
          </tr></tfoot>
        </table>
        `:`
        <div style="font-size:13px;color:var(--muted);padding:16px;background:var(--surface2);border-radius:4px;text-align:center">
          Nobody active on the roster is marked salaried. Pay type is set on the Employees tab.
        </div>`}`}
      </div>
    </div>
  `;
}
