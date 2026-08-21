// data — every read and write against /api/data and /api/settings.
//
// Shares one global scope with the other files in src/js (see core.js).

async function loadData(){
  try{
    // The `economics` table is no longer read. Staffing Economics was the only
    // reader, and it rendered each position's holder next to their hourly rate —
    // which is what Manufacturing Costs replaced, in aggregate, for exactly that
    // reason. The table and its position/max reference data are untouched in the
    // database; nothing in the app reads them.
    // The `overtime` table is no longer read here either. The pre-approved
    // allowance comes from /api/preapproved-ot, keyed on employees.id, and it is
    // loaded when the Reports tab opens rather than on every page load — the old
    // grid needed the whole table in memory because it saved by replacing it.
    const [empRes, ptRes] = await Promise.all([
      fetch('/api/data?table=employees'),
      fetch('/api/data?table=points')
    ]);
    if(empRes.status===401){location.href='/';return;}

    const [empJson, ptJson] = await Promise.all([
      empRes.json(), ptRes.json()
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
      // The third axis of the v2 model. Legitimately null for anyone who is not
      // manufacturing floor staff, so a blank here is a real answer, not a gap.
      // annual_salary is deliberately NOT mapped. /api/data does not return it
      // — the projection in netlify/functions/data.js leaves it out until the
      // Salaries & Wages tier can gate it. Mapping it would read '' forever,
      // which is exactly how somebody later "fixes" it by re-adding the column.
      positionGroup:r.position_group||'',
      // Phase B. `position` is the specific job WITHIN a position group and
      // applies to everyone: the CEO has a position and no position group. The
      // address columns have existed since SCHEMA_V2_MODEL.sql section 4 and
      // were simply never projected, so nothing could show them.
      position:r.position||'',
      addressStreet:r.address_street||'', addressCity:r.address_city||'',
      addressState:r.address_state||'', addressPostalCode:r.address_postal_code||''
    }));

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
  department:'the payroll department needs SCHEMA_DAILY_HOURS.sql to persist',
  cost_class:'the cost class needs SCHEMA_V2_MODEL.sql section 2 to persist',
  position_group:'the position group needs SCHEMA_V2_MODEL.sql section 3 to persist',
  position:'the position needs SCHEMA_PHASE_B_POSITION.sql to persist',
  address_street:'the address needs SCHEMA_V2_MODEL.sql section 4 to persist',
  address_city:'the address needs SCHEMA_V2_MODEL.sql section 4 to persist',
  address_state:'the address needs SCHEMA_V2_MODEL.sql section 4 to persist',
  address_postal_code:'the address needs SCHEMA_V2_MODEL.sql section 4 to persist'
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
        // clock_in and clock_out are deliberately NOT written. Nothing reads them
        // (audited across the frontend, every Netlify function and both report
        // libraries), so the profile stopped offering them. The COLUMNS remain
        // and are still projected, so the stored values stay readable — dropping
        // them is a separate, later, deliberate act, the way `dept` was handled.
        //
        // Absent is not null: PostgREST leaves a column a PATCH does not name
        // alone, so this loop re-writing every row does NOT blank them.
        days:e.days,
        break_1:e.break1||'7:00 AM', break_2:e.break2||'12:45 PM',
        birthday:e.birthday, phone:e.phone, language:e.language,
        email:e.email, sms_opted_out:e.smsOptedOut===true,
        drive_folder_id:e.driveFolderId||null,
        employee_number:normEmpNum(e.empNum)||null, department:e.department||null,
        // Written here too: this loop re-writes every row on the roster, so leaving
        // the two new axes out would not preserve them — it would just make Sync the
        // one path that never carries them.
        cost_class:e.costClass||null, position_group:e.positionGroup||null,
        // Same reasoning for the Phase B fields: Sync must not be the one path
        // that quietly stops carrying them.
        position:e.position||null,
        address_street:e.addressStreet||null, address_city:e.addressCity||null,
        address_state:e.addressState||null, address_postal_code:e.addressPostalCode||null
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
      // The third axis of the v2 model. Legitimately null for anyone who is not
      // manufacturing floor staff, so a blank here is a real answer, not a gap.
      // annual_salary is deliberately NOT mapped. /api/data does not return it
      // — the projection in netlify/functions/data.js leaves it out until the
      // Salaries & Wages tier can gate it. Mapping it would read '' forever,
      // which is exactly how somebody later "fixes" it by re-adding the column.
      positionGroup:r.position_group||'',
      // Phase B. `position` is the specific job WITHIN a position group and
      // applies to everyone: the CEO has a position and no position group. The
      // address columns have existed since SCHEMA_V2_MODEL.sql section 4 and
      // were simply never projected, so nothing could show them.
      position:r.position||'',
      addressStreet:r.address_street||'', addressCity:r.address_city||'',
      addressState:r.address_state||'', addressPostalCode:r.address_postal_code||''
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
