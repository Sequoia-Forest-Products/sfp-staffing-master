// salaries — the Salaries view under the Overhead tab.
//
// Shares one global scope with the other files in src/js (see core.js).
//
// IT WAS A TOP-LEVEL TAB CALLED 'Salaries & Wages' AND IT HELD BOTH COLUMNS.
// That tab is gone and its two halves went to different places, because they
// were never one audience:
//
//   employees.wage           base tier, read and write. Every signed-in account
//                            may set an hourly rate, and the people who need to
//                            correct one are supervisors. It is now typed on the
//                            employee's own PROFILE CARD — see employees.js —
//                            which is where somebody already goes to change a
//                            phone number or a department.
//   employees.annual_salary  the salaries tier, both directions. Set HERE and
//                            nowhere else, under a tab only that tier can open.
//
// A page holding both meant a supervisor opening the company salary list to
// change one hourly rate, and it meant the tab itself had to be ungated with a
// gated section inside it. Splitting them costs one screen and buys a gate that
// matches the data: Overhead is the salaried staff, so the salaried roster
// belongs under it.
//
// ------------------------------------------------------------------------
// ONE PERSON AT A TIME, AND ONLY THE ACTIVE ONES
// ------------------------------------------------------------------------
//
// The page used to be a table of open inputs with a Save bar under it. Every
// row on the roster was an editable field, all of them live at once, and one
// Save committed whatever had been typed anywhere. Three things were wrong with
// that and only the third is cosmetic:
//
//   1. A MIS-CLICK LOOKED LIKE AN EDIT. Tabbing through a table of inputs, or
//      clicking the wrong row, put a caret in somebody's pay. Nothing about the
//      screen distinguished "I meant to change Ana's salary" from "I was aiming
//      for the row above".
//
//   2. ONE SAVE MOVED SEVERAL PEOPLE'S PAY, and a reviewer of the record has no
//      way to tell a deliberate batch from a stray keystroke that rode along.
//
//   3. Inactive people were in the list, which is most of the length of it and
//      none of the interest.
//
// So: the list is READ-ONLY and a row opens that person's own screen, with one
// field, a Save and a Cancel. Leaving the screen without saving discards. The
// list shows ACTIVE employees only — a terminated person's pay is history.
//
// The tier check below is cosmetic and load-bearing on the server: /api/data
// builds its projection from the caller's tiers, so annual_salary is absent
// from the select= before any row is read, and a write of it is refused with a
// 403 that names the column.

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

// ------------------------------------------------------------------------
// who is on the page
// ------------------------------------------------------------------------

function salariedPeople(){
  return (state.employees||[]).filter(e=>isSalaried(e)&&payActive(e)).sort(byPayName);
}

// How many are being left out, so "where is everybody" has an answer on the
// page rather than in somebody's head.
function inactiveSalariedCount(){
  return (state.employees||[]).filter(e=>isSalaried(e)&&!payActive(e)).length;
}

// ------------------------------------------------------------------------
// the detail screen
// ------------------------------------------------------------------------

function payPerson(){
  if(!state.pay||state.pay.id==null) return null;
  return (state.employees||[]).find(e=>String(e.id)===String(state.pay.id))||null;
}

// The value the field starts at: what the database holds. Not blank — somebody
// correcting 105000 to 110000 should not have to retype the part that is
// already right.
function payInitialDraft(e){
  return e.annualSalary==null?'':String(e.annualSalary);
}

function openPay(id){
  const e=(state.employees||[]).find(x=>String(x.id)===String(id));
  if(!e) return;
  // Refused before the screen opens rather than on Save. The list already
  // excludes all three cases, but openPay is reachable from a row rendered
  // before a status changed and from the console, so the list is not the gate.
  if(!canSeeSalaries()){ toast('Annual salaries need the salaries tier','error'); return; }
  if(!isSalaried(e)){
    toast(`${e.name} is hourly. Their rate is set on their profile card, under Employees.`,'error');
    return;
  }
  if(!payActive(e)){
    toast(`${e.name} is not active. Their pay is history — reactivate them on the Employees tab first.`,'error');
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

// Whether the draft differs from what is stored. Compared as PARSED values, so
// re-saving the same number is not offered as a change.
function payDirty(){
  const e=payPerson();
  if(!e||!state.pay) return false;
  const parsed=parseSalary(state.pay.draft);
  if(parsed===undefined) return true;   // unparseable counts as dirty so Save is reachable and can explain
  const current=e.annualSalary==null?null:Number(e.annualSalary);
  return parsed!==current;
}

async function savePay(){
  const e=payPerson();
  if(!e||!state.pay||state.pay.saving) return;

  const parsed=parseSalary(state.pay.draft);
  if(parsed===undefined){
    state.pay.error=`"${String(state.pay.draft).trim()}" is not a number. Enter an annual salary, e.g. 105000.`;
    render(); return;
  }
  if(!payDirty()){ toast('Nothing has changed','warning'); return; }

  state.pay.saving=true; state.pay.error=''; render();
  try{
    const res=await fetch('/api/data?table=employees&id='+encodeURIComponent(e.id),{
      method:'PATCH',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({annual_salary:parsed})
    });
    if(!res.ok){
      const d=await res.json().catch(()=>({}));
      // 403 is the tier being revoked between the page loading and the Save.
      throw new Error(
        res.status===403 ? 'no longer permitted to edit salaries' :
        (d.detail||d.error||('failed with status '+res.status)));
    }
    // The local copy advances only after the write is known to have landed.
    e.annualSalary=parsed;
    closePay();
    toast('Salary saved','success');
  }catch(err){
    state.pay.saving=false;
    state.pay.error=err.message;
    render();
  }
}

function payFootInner(){
  const e=payPerson();
  if(!e||!state.pay) return '';
  const parsed=parseSalary(state.pay.draft);
  const dirty=payDirty();

  let note='';
  if(parsed===undefined){
    note=`<span style="color:#b8860b">Not a number</span>`;
  }else if(parsed==null){
    note=`<span style="color:var(--muted)">No salary on file — their cost cannot be computed</span>`;
  }else{
    note=`<span style="color:var(--muted)">Hourly equivalent ${fmt$(Math.round(parsed/SALARY_HOURS_PER_YEAR*100)/100)}</span>`;
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

  return `
    <div style="max-width:640px;margin:0 auto;padding:20px">
      <button class="btn" style="background:none;border:1px solid var(--border);color:var(--muted);margin-bottom:20px"
        onclick="closePay()">&larr; Salaries</button>

      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:24px">
        <div style="font-size:20px;font-weight:700;margin-bottom:4px">${esc(e.name||'')}</div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:24px">
          ${esc(e.position||'—')} · ${esc(e.department||'—')}${e.empNum?' · Emp # '+esc(e.empNum):''}
        </div>

        <label class="form-label">Annual salary</label>
        <input type="text" id="payInput" value="${esc(state.pay.draft)}" placeholder="105000"
          style="width:180px;font-size:16px;padding:10px"
          ${state.pay.saving?'disabled':''}
          oninput="paySet(this.value)">

        <div style="font-size:12px;color:var(--muted);line-height:1.6;margin-top:14px">
          Divided by ${SALARY_HOURS_PER_YEAR.toLocaleString('en-US')} to give the hourly equivalent the costing reports use.
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

// Named renderSalariedPay, not renderSalaries: it is one view of the Overhead
// tab now rather than a tab of its own, and OVERHEAD_VIEWS in costs.js is what
// calls it.
//
// NO TIER CHECK OF ITS OWN. renderOverheadTab() refuses the whole tab without
// the salaries tier, so a reader who reaches this function holds it. A second
// check here would be a second answer to the same question, which is how two
// gates come to disagree.
function renderSalariedPay(){
  // One screen or the other, never both.
  if(state.pay&&state.pay.id!=null&&payPerson()) return renderPayDetail();

  const salaried=salariedPeople();
  const inactive=inactiveSalariedCount();

  const known=salaried.filter(e=>e.annualSalary!=null&&e.annualSalary!=='');
  const totalAnnual=known.reduce((s,e)=>s+Number(e.annualSalary||0),0);
  const missing=salaried.length-known.length;

  return `
    <div style="max-width:1100px;margin:0 auto;padding:20px">
      <h2 style="font-size:24px;font-weight:700;margin-bottom:6px;color:var(--text)">Salaries</h2>
      <div style="font-size:12px;color:var(--muted);line-height:1.6;margin-bottom:24px;max-width:760px">
        Annual salary is set here and nowhere else. The hourly equivalent is
        <b>salary ÷ ${SALARY_HOURS_PER_YEAR.toLocaleString('en-US')}</b>, which is what the costing reports divide
        by — shown so this page and those reports cannot disagree about what a salary means.
        <b>Click a row to change somebody's salary.</b>
        Hourly rates are not here: they are typed on each person's profile card, under Employees.
        ${inactive?`Active employees only — ${inactive} inactive salaried ${inactive===1?'person is':'people are'} not listed.`:''}
        ${missing?`<b style="color:#b8860b">${missing} ${missing===1?'person has':'people have'} no salary on file, so their cost cannot be computed at all.</b>`:''}
      </div>

      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:24px">
        <div style="display:flex;align-items:baseline;gap:12px;margin-bottom:18px">
          <div style="font-size:16px;font-weight:700">Salaried</div>
          <div style="font-size:12px;color:var(--muted)">${salaried.length} active ${salaried.length===1?'person':'people'}</div>
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
        </div>`}
      </div>
    </div>
  `;
}
