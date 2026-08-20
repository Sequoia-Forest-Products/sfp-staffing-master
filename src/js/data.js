// data — every read and write against /api/data and /api/settings.
//
// Shares one global scope with the other files in src/js (see core.js).

async function loadData(){
  try{
    const [empRes, econRes, otRes, ptRes] = await Promise.all([
      fetch('/api/data?table=employees'),
      fetch('/api/data?table=economics'),
      fetch('/api/data?table=overtime'),
      fetch('/api/data?table=points')
    ]);
    if(empRes.status===401){location.href='/';return;}

    const [empJson, econJson, otJson, ptJson] = await Promise.all([
      empRes.json(), econRes.json(), otRes.json(), ptRes.json()
    ]);

    // Employees
    state.employees = (empJson.data||[]).map(r=>({
      id:r.id, name:r.name||'', wage:r.wage||'', dept:r.dept||'',
      status:r.status||'Active', days:r.days||'', clockIn:r.clock_in||'',
      clockOut:r.clock_out||'', break1:r.break_1||'', break2:r.break_2||'',
      birthday:r.birthday||'', phone:r.phone||'', language:r.language||'',
      email:r.email||'', ...normalizeSms(r), driveFolderId:r.drive_folder_id||'',
      empNum:r.employee_number||'', department:r.department||'',
      // pay_type is absent until SCHEMA_V2_MODEL.sql section 5b runs. Left blank
      // rather than defaulted, so isSalaried falls back to the legacy wage
      // marker instead of reading a guess as a stated fact.
      payType:r.pay_type||'', costClass:r.cost_class||'',
      annualSalary:r.annual_salary==null?'':r.annual_salary
    }));

    // Economics
    state.economics = (econJson.data||[]).map(r=>({
      id:r.id, num:r.num, section:r.section||'', position:r.position||'',
      name:r.name||'', max:parseFloat(r.max_wage)||0
    }));

    // OT
    state.ot = {pre:[], post:[], weekend:[]};
    (otJson.data||[]).forEach(r=>{
      const rec={id:r.id, name:r.name, hours:parseFloat(r.hours)||0, desc:r.description||''};
      if(r.ot_type==='Pre-Shift') state.ot.pre.push(rec);
      else if(r.ot_type==='Post-Shift') state.ot.post.push(rec);
      else state.ot.weekend.push(rec);
    });

    // Points
    state.points = (ptJson.data||[]).map(r=>({
      id:r.id, name:r.name, points:r.points||0, lastDate:r.last_point_date||'',
      levelElig:r.level_up_eligible||'', disciplinary:r.disciplinary||false,
      discDate:r.disc_date||''
    }));

    state.loading=false;
  }catch(e){console.error('loadData error:',e);state.loading=false;}
  render();
}


function setSyncStatus(s){
  const el=document.getElementById('syncStatus');
  if(!el) return;
  if(s==='saving'){el.textContent='● Saving…';el.className='sfp-sync-status saving';}
  else if(s==='error'){el.textContent='● Sync error';el.className='sfp-sync-status error';}
  else{el.textContent='● Synced';el.className='sfp-sync-status idle';}
}

// Columns that only exist once their migration has been run. PostgREST rejects
// the whole row when one of them is missing (surfacing as a 500 from /api/data),
// so the write is retried once without them rather than losing the user's edit.
const OPTIONAL_EMPLOYEE_COLUMNS = {
  sms_opted_out:'the SMS opt-out needs SCHEMA_SMS_OPTOUT.sql to persist',
  pay_type:'the pay type needs SCHEMA_V2_MODEL.sql section 5b to persist',
  employee_number:'the payroll employee # needs SCHEMA_DAILY_HOURS.sql to persist',
  department:'the payroll department needs SCHEMA_DAILY_HOURS.sql to persist'
};

async function writeEmployeeRow(url, method, row){
  const send = body => fetch(url, {
    method, headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)
  });

  let res = await send(row);
  if(res.ok) return res;

  const detail = await res.clone().text().catch(()=>'');
  const missing = Object.keys(OPTIONAL_EMPLOYEE_COLUMNS).filter(c => (c in row) && detail.includes(c));
  if(!missing.length) return res;

  console.warn('employees is missing ' + missing.join(', ') + ' — run the schema migration. Saving without those fields for now.');
  // Say so out loud: everything else saves, but these fields will not stick
  // until the migration runs, and silently dropping them is what caused the
  // last round of lost data.
  missing.forEach(c => {
    if(writeEmployeeRow._warned[c]) return;
    writeEmployeeRow._warned[c] = true;
    setTimeout(()=>toast('Saved — but ' + OPTIONAL_EMPLOYEE_COLUMNS[c], 'error'), 400);
  });
  const fallback = {...row};
  missing.forEach(c => delete fallback[c]);
  return send(fallback);
}
writeEmployeeRow._warned = {};


// ============================================================
// EMAIL SETTINGS FUNCTIONS
// ============================================================
async function saveEmailSettings(){
  try {
    // Save to database
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        key: 'emailSettings',
        value: {...EMAIL_SETTINGS_DEFAULTS, ...state.emailSettings}
      })
    });
    if (!res.ok) {
      console.error('Failed to save settings to database');
      localStorage.setItem('emailSettings', JSON.stringify(state.emailSettings));
    }
  } catch (err) {
    console.error('Settings save error:', err);
    localStorage.setItem('emailSettings', JSON.stringify(state.emailSettings));
  }
}

async function loadEmailSettings(){
  try {
    const res = await fetch('/api/settings?key=emailSettings');
    if (res.ok) {
      const json = await res.json();
      const stored = parseSettingsValue(json.data && json.data.value);
      if (stored) {
        state.emailSettings = {...EMAIL_SETTINGS_DEFAULTS, ...stored};
        return;
      }
    }
  } catch (err) {
    console.error('Failed to load settings from database:', err);
  }
  // Fallback to localStorage
  const saved = localStorage.getItem('emailSettings');
  const stored = saved ? parseSettingsValue(saved) : null;
  if (stored) {
    state.emailSettings = {...EMAIL_SETTINGS_DEFAULTS, ...stored};
  }
}


async function syncToSheet(){
  const btn=document.getElementById('syncBtn');
  btn.textContent='Syncing…';btn.className='sfp-sync-btn saving';
  setSyncStatus('saving');
  try{
    for(const e of state.employees){
      const row={
        // A salaried person's wage is NULL, never '' and never the retired
        // 'Salary' sentinel — this loop re-writes every row on the roster, so an
        // empty string here would put junk back into a column the migration just
        // cleaned.
        name:e.name, wage:isSalaried(e)?null:(e.wage===''||e.wage==null?null:e.wage),
        pay_type:payTypeOf(e), status:e.status,
        days:e.days, clock_in:e.clockIn, clock_out:e.clockOut,
        break_1:e.break1||'7:00 AM', break_2:e.break2||'12:45 PM',
        birthday:e.birthday, phone:e.phone, language:e.language,
        email:e.email, sms_opted_out:e.smsOptedOut===true,
        drive_folder_id:e.driveFolderId||null,
        employee_number:normEmpNum(e.empNum)||null, department:e.department||null
      };
      if(e.id){
        await writeEmployeeRow('/api/data?table=employees&id='+e.id,'PATCH',row);
      } else {
        const res=await writeEmployeeRow('/api/data?table=employees','POST',row);
        const d=await res.json();
        if(d.data?.[0]?.id) e.id=d.data[0].id;
      }
    }
    // Reload employees from database to ensure OT report has latest wages
    const empRes = await fetch('/api/data?table=employees');
    const empJson = await empRes.json();
    state.employees = (empJson.data||[]).map(r=>({
      id:r.id, name:r.name||'', wage:r.wage||'', dept:r.dept||'',
      status:r.status||'Active', days:r.days||'', clockIn:r.clock_in||'',
      clockOut:r.clock_out||'', break1:r.break_1||'', break2:r.break_2||'',
      birthday:r.birthday||'', phone:r.phone||'', language:r.language||'',
      email:r.email||'', ...normalizeSms(r), driveFolderId:r.drive_folder_id||'',
      empNum:r.employee_number||'', department:r.department||'',
      // pay_type is absent until SCHEMA_V2_MODEL.sql section 5b runs. Left blank
      // rather than defaulted, so isSalaried falls back to the legacy wage
      // marker instead of reading a guess as a stated fact.
      payType:r.pay_type||'', costClass:r.cost_class||'',
      annualSalary:r.annual_salary==null?'':r.annual_salary
    }));

    state.dirty=false;
    btn.textContent='✓ Saved';btn.className='sfp-sync-btn saved';
    setSyncStatus('idle');
    toast('Saved to Supabase','success');
    setTimeout(()=>{btn.textContent='+ Sync';btn.className='sfp-sync-btn';},3000);
  }catch(err){
    btn.textContent='+ Sync';btn.className='sfp-sync-btn';
    setSyncStatus('error');
    toast('Sync failed: '+err.message,'error');
  }
}
