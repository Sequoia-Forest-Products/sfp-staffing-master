// employees — the roster tab: filtering, the table, the edit modal and its save,
// SMS reachability, the TextBolt list and the Drive folder link.
//
// Shares one global scope with the other files in src/js (see core.js).

function getFiltered(){
  let list = state.employees.filter(e=>
    (state.filterStatus==='all'||e.status===state.filterStatus)&&
    (state.filterDept==='all'||(state.filterDept==='__none__'?!hasDepartment(e.department):e.department===state.filterDept))&&
    (!state.filterName||e.name.toLowerCase().includes(state.filterName.toLowerCase()))
  );
  const col = state.sortCol || 'name';
  const dir = state.sortDir === 'desc' ? -1 : 1;
  return [...list].sort((a,b)=>{
    if(col==='wage'){
      const av=parseFloat(String(a.wage||'0').replace(/[$,]/g,''))||0;
      const bv=parseFloat(String(b.wage||'0').replace(/[$,]/g,''))||0;
      return (av-bv)*dir;
    }
    const av=String(a[col]||'').toLowerCase();
    const bv=String(b[col]||'').toLowerCase();
    return av<bv?-dir:av>bv?dir:0;
  });
}

// ---------------------------------------------------------------------------
// The three taxonomy selects, built here so the roster filter and the edit modal
// cannot drift apart on what is offered.
//
// ESCAPING: every value lands in HTML twice — once as option TEXT and once inside
// the option's value ATTRIBUTE — and the optgroup label is an attribute too.
// 'Sales & Marketing' and the 'SG&A' cost class carry ampersands, and an
// unescaped & in an attribute is where markup actually breaks, so all three go
// through esc(). esc() only touches what goes INTO the HTML: this.value read back
// off the select is the raw 'Sales & Marketing', which is what reaches the payload.
function taxonomyOptions(list,selected){
  return list.map(v=>`<option value="${esc(v)}"${selected===v?' selected':''}>${esc(v)}</option>`).join('');
}

// Twelve flat options are unreadable, so they are grouped by cost class. The
// grouping is presentation ONLY — choosing a department never sets the cost class.
function departmentOptions(selected){
  return COST_CLASSES.map(cc=>
    `<optgroup label="${esc(cc)}">${taxonomyOptions(DEPARTMENTS_BY_COST_CLASS[cc]||[],selected)}</optgroup>`
  ).join('');
}

// A stored value that is no longer offered — a row still on the retired 'SG&A'
// department, say — is real data somebody chose. It is shown, selected, and
// labelled as needing reassignment. Dropping it would make the select display a
// value the row does not hold, and the next save would write that blank over it.
function retiredOption(v,list){
  const s=String(v==null?'':v).trim();
  if(!s||list.indexOf(s)>=0) return '';
  return `<option value="${esc(s)}" selected>${esc(s)} — retired, please reassign</option>`;
}

function renderEmployees(){
  const active=state.employees.filter(e=>e.status==='Active');
  const en=active.filter(e=>e.language==='English').length;
  const es=active.filter(e=>e.language==='Spanish').length;
  // Staffed MANUFACTURING departments, out of the six — not out of all twelve
  // assignable values. A card reading "8 of 12" while two production departments sit
  // empty would be misleading if office departments were silently making up the
  // difference, so everything outside manufacturing is counted and labelled on its own.
  const deptCount=MANUFACTURING_DEPARTMENTS.filter(d=>state.employees.some(e=>e.department===d)).length;
  const offMfg=active.filter(e=>hasDepartment(e.department)&&MANUFACTURING_DEPARTMENTS.indexOf(e.department)<0).length;
  // Any department is an assignment, so an assigned person is not in this number.
  const noDept=active.filter(e=>!hasDepartment(e.department)).length;
  const filtered=getFiltered();
  return `
    <div class="stat-row">
      <div class="stat-card"><div class="stat-label">Active headcount</div><div class="stat-value">${active.length}</div><div class="stat-sub">of ${state.employees.length} total</div></div>
      <div class="stat-card"><div class="stat-label">English speakers</div><div class="stat-value">${en}</div><div class="stat-sub">${es} Spanish</div></div>
      <div class="stat-card"><div class="stat-label">Departments staffed</div><div class="stat-value">${deptCount}</div><div class="stat-sub">of ${MANUFACTURING_DEPARTMENTS.length} production · ${offMfg} active outside manufacturing · ${noDept} active unassigned</div></div>
      <div class="stat-card"><div class="stat-label">Inactive</div><div class="stat-value">${state.employees.length-active.length}</div><div class="stat-sub">on roster</div></div>
    </div>
    <div class="section-head">
      <span>Employee roster</span>
      <div style="display:flex;gap:8px">
        <button class="btn btn-outline btn-sm" onclick="copyTextBoltList()" id="copyTBBtn">📋 Copy TextBolt list</button>
        <button class="btn btn-primary btn-sm" onclick="openAdd()">+ Add employee</button>
      </div>
    </div>
    <div class="search-row">
      <input type="text" id="empSearch" placeholder="Search by name…" value="${state.filterName}" oninput="state.filterName=this.value;renderEmployeeList()">
      <!-- All twelve assignable departments, grouped by cost class: somebody on
           'Sales & Marketing' or 'Mill Overhead' has to be findable, and being
           assigned to one of them is NOT the same thing as being unassigned. Both the
           option value attribute and the optgroup label go through esc() — two of
           these values carry an ampersand — and the value that comes back off this
           select is the raw 'Sales & Marketing'. -->
      <select onchange="state.filterDept=this.value;renderEmployeeList()">
        <option value="all" ${state.filterDept==='all'?'selected':''}>All departments</option>
        ${departmentOptions(state.filterDept)}
        <option value="__none__" ${state.filterDept==='__none__'?'selected':''}>— unassigned —</option>
      </select>
      <select onchange="state.filterStatus=this.value;renderEmployeeList()">
        <option value="Active" ${state.filterStatus==='Active'?'selected':''}>Active only</option>
        <option value="Inactive" ${state.filterStatus==='Inactive'?'selected':''}>Inactive</option>
        <option value="all" ${state.filterStatus==='all'?'selected':''}>All</option>
      </select>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          ${['name','wage','department','costClass','status','language','days','phone'].map(col=>{
            const labels={name:'Name',wage:'Wage/hr',department:'Department',costClass:'Cost class',status:'Status',language:'Lang',days:'Schedule',phone:'Phone'};
            const active=state.sortCol===col;
            const arrow=active?(state.sortDir==='asc'?'↑':'↓'):'';
            return '<th style="cursor:pointer;user-select:none;white-space:nowrap" onclick="sortEmployees(\''+col+'\')">'+labels[col]+(arrow?'<span style=\"color:var(--orange);margin-left:3px\">'+arrow+'</span>':'')+'</th>';
          }).join('')}
          <th style="width:96px">SMS</th><th style="width:60px"></th>
        </tr></thead>
        <tbody>
          ${filtered.length?filtered.map(e=>`
            <tr>
              <td style="font-weight:600">${e.name}</td>
              <td>${fmtWage(e)}</td>
              <td${hasDepartment(e.department)?'':' style="color:var(--muted)"'}>${hasDepartment(e.department)?esc(e.department):'—'}</td>
              <!-- Cost class is read-only here and this is the only screen that shows
                   it, so it is how the column gets audited. esc() because 'SG&A' has
                   an ampersand. -->
              <td${e.costClass?'':' style="color:var(--muted)"'}>${e.costClass?esc(e.costClass):'—'}</td>
              <td><span class="badge ${e.status==='Active'?'active':'inactive'}">${e.status||'—'}</span></td>
              <td><span class="badge ${e.language==='Spanish'?'es':'en'}">${e.language==='Spanish'?'ES':'EN'}</span></td>
              <td style="color:var(--muted);font-size:11px">${e.days||'—'}</td>
              <td style="color:var(--muted);font-size:11px">${e.phone||'—'}</td>
              <td>${smsCell(e)}</td>
              <td><button class="btn btn-outline btn-sm" onclick="openEdit(${state.employees.indexOf(e)})">Edit</button></td>
            </tr>`).join(''):
            '<tr><td colspan="10" style="text-align:center;color:var(--muted);padding:32px">No employees match</td></tr>'}
        </tbody>
      </table>
    </div>
    ${state.editing!==null?renderModal():''}
  `;
}

// The wage input is an HOURLY RATE and nothing else. It used to write the literal
// string 'Salary' into employees.wage, which is exactly the conflation
// SCHEMA_V2_MODEL.sql section 5b removes — pay type is its own column now, so
// this must never put a word where a rate goes.
//
// Somebody typing 'salary' out of habit is still meaning something real, so it
// is honoured as a pay-type change rather than discarded: pay type flips to
// Salaried, the rate is cleared, and the re-render disables the field.
function formatWageInput(input) {
  const val = input.value.trim();
  if (isSalaried(state.editing)) { state.editing.wage = ''; return; }

  if (val.toLowerCase() === 'salary') {
    state.editing.payType = 'Salaried';
    state.editing.wage = '';
    render();
    return;
  }
  if (!val) { state.editing.wage = ''; input.value = ''; return; }

  const num = parseFloat(val.replace(/[$,]/g, ''));
  if (!isNaN(num)) {
    const formatted = '$' + num.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
    input.value = formatted;
    state.editing.wage = num;
    return;
  }
  // Not a number and not the old word. It cannot be stored, so it is cleared on
  // the spot rather than left looking accepted and then dropped on save.
  input.value = '';
  state.editing.wage = '';
}

// The pay type select. Switching to Salaried clears the hourly rate in the same
// move — leaving a stale rate behind on a salaried person is how a number nobody
// entered ends up in a report. Re-renders so the wage field's disabled state and
// its note follow the choice immediately.
function setPayType(v) {
  state.editing.payType = v === 'Salaried' ? 'Salaried' : 'Hourly';
  if (state.editing.payType === 'Salaried') state.editing.wage = '';
  render();
}

function sortEmployees(col) {
  if (state.sortCol === col) {
    state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    state.sortCol = col;
    state.sortDir = 'asc';
  }
  render();
}

function renderEmployeeList() {
  const filtered = getFiltered();

  // Update stat cards
  const active = state.employees.filter(e => e.status === 'Active');
  const spanish = active.filter(e => e.language === 'Spanish').length;
  // The same count the full render puts in this card: staffed MANUFACTURING
  // departments out of six. Counting distinct department values instead would now
  // print numbers up to twelve under a label that says "of 6 production".
  const depts = MANUFACTURING_DEPARTMENTS.filter(d => state.employees.some(e => e.department === d)).length;
  const inactive = state.employees.filter(e => e.status === 'Inactive').length;

  const statEls = document.querySelectorAll('.stat-value');
  if (statEls.length >= 4) {
    statEls[0].textContent = active.length;
    statEls[1].textContent = active.length - spanish;
    statEls[2].textContent = depts;
    statEls[3].textContent = inactive;
  }

  // Update table body only
  const tbody = document.querySelector('.table-wrap tbody');
  if (!tbody) return;

  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:var(--muted);padding:32px">No employees match</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(e => {
    const idx = state.employees.indexOf(e);
    return `<tr>
      <td style="font-weight:600">${e.name}</td>
      <td>${e.wage||'—'}</td>
      <td style="color:${hasDepartment(e.department)?'var(--text)':'var(--muted)'}">${hasDepartment(e.department)?esc(e.department):'—'}</td>
      <td style="color:${e.costClass?'var(--text)':'var(--muted)'}">${e.costClass?esc(e.costClass):'—'}</td>
      <td><span class="badge ${e.status==='Active'?'active':'inactive'}">${e.status}</span></td>
      <td><span class="badge ${e.language==='Spanish'?'es':'en'}">${e.language==='Spanish'?'ES':'EN'}</span></td>
      <td style="color:var(--muted);font-size:11px">${e.days||'—'}</td>
      <td style="color:var(--muted);font-size:11px">${e.phone||'—'}</td>
      <td>${smsCell(e)}</td>
      <td><button class="btn btn-outline btn-sm" onclick="openEdit(${idx})">Edit</button></td>
    </tr>`;
  }).join('');
}

// Opting out sets a flag and never touches the phone number, so opting back in
// resumes texting with nothing to re-enter. The old version overwrote the
// text_bolt column with 'STOP', destroying the stored address.
function toggleSmsOptOut(checkbox) {
  state.editing.smsOptedOut = checkbox.checked;
  refreshSmsStatus();
}

function refreshSmsStatus() {
  const status = document.getElementById('smsOptOutStatus');
  if (!status) return;
  const e = state.editing;
  status.textContent = smsStatusText(e);
  const bad = !normalizePhone(e.phone);
  status.style.color = e.smsOptedOut ? '#c0392b' : (bad ? '#b8860b' : 'var(--muted)');
}

// The opt-out lives in sms_opted_out. A leftover 'STOP' in the deprecated
// text_bolt column still counts as opted out until that column is dropped.
function normalizeSms(r) {
  return {
    smsOptedOut: r.sms_opted_out === true ||
                 String(r.text_bolt || '').trim().toUpperCase() === 'STOP'
  };
}

// Phone is the single source of truth for SMS. Free-text column, so strip to
// digits; a leading US country code is tolerated. Returns 10 digits or ''.
function normalizePhone(v) {
  const digits = String(v || '').replace(/\D/g, '');
  const local = (digits.length === 11 && digits.startsWith('1')) ? digits.slice(1) : digits;
  return local.length === 10 ? local : '';
}

// The TextBolt address is derived, never stored.
function textBoltAddress(phone) {
  const local = normalizePhone(phone);
  return local ? '+1' + local + '@sendemailtotext.com' : '';
}

function fmtPhone(phone) {
  const d = normalizePhone(phone);
  return d ? '(' + d.slice(0,3) + ') ' + d.slice(3,6) + '-' + d.slice(6) : '';
}

function smsStatusText(e) {
  const num = fmtPhone(e.phone);
  if (!num) return String(e.phone || '').trim()
    ? 'Phone number is not a valid 10-digit number \u2014 cannot text'
    : 'No phone number on file \u2014 cannot text';
  return e.smsOptedOut ? 'Opted out \u2014 not receiving texts' : 'Receiving texts at ' + num;
}

// Employees-table SMS cell. The phone number lives in its own column and stays
// visible and editable either way; this cell reports only SMS reachability.
function smsCell(e) {
  if (e.smsOptedOut) {
    return '<div style="font-size:10px;color:#c0392b;font-weight:700">OPTED OUT</div>';
  }
  if (!normalizePhone(e.phone)) {
    return String(e.phone || '').trim()
      ? '<div style="font-size:10px;color:#b8860b;font-weight:700" title="Phone does not normalize to 10 digits">BAD PHONE</div>'
      : '<span style="color:var(--muted)">\u2014</span>';
  }
  return '<div style="font-size:10px;color:#2a7a47;font-weight:700">SMS OK</div>';
}

function openEdit(idx){
  state.editing={...state.employees[idx],_idx:idx,_isNew:false};
  render();
  // Load Drive folder link after render
  setTimeout(()=>loadDriveLink(state.employees[idx].name), 50);
}

// Every taxonomy field starts BLANK on a new employee — no cost class implied by a
// department, no department implied by a position group. Each is a decision about a
// real person, and a default that follows from another field is the coupling the v2
// model exists to remove.
function openAdd(){state.editing={name:'',wage:'',payType:'Hourly',empNum:'',department:'',costClass:'',positionGroup:'',status:'Active',days:'MON-THU',clockIn:'4:55 AM',clockOut:'3:35 PM',break1:'7:00 AM',break2:'12:45 PM',birthday:'',phone:'',language:'English',email:'',smsOptedOut:false,_isNew:true};render();}
function closeModal(){state.editing=null;render();}


async function saveEdit(){
  const e={...state.editing};const idx=e._idx;const isNew=e._isNew;
  delete e._idx;delete e._isNew;

  setSyncStatus('saving');
  try{
    // Pay type is the fact; wage is only ever an hourly rate. A salaried person
    // is written with a NULL wage — never the literal 'Salary', which is the
    // sentinel SCHEMA_V2_MODEL.sql section 5b retires. Salaried compensation is
    // annual_salary, edited elsewhere.
    const payType = isSalaried(e) ? 'Salaried' : 'Hourly';
    let wage = e.wage;
    if(payType === 'Salaried'){
      wage = null;
    } else if(typeof wage === 'string'){
      // A rate or nothing. Anything unparseable is NOT stored as text — that is
      // how 'Salary' got into this column in the first place.
      const parsed = parseFloat(wage.replace(/[$,]/g,''));
      wage = isNaN(parsed) ? null : parsed;
    }
    e.wage = wage === null ? '' : wage;   // what the roster row will render
    e.payType = payType;

    const row={
      name:e.name, wage:wage, pay_type:payType, status:e.status,
      days:e.days, clock_in:e.clockIn, clock_out:e.clockOut,
      break_1:e.break1||'7:00 AM', break_2:e.break2||'12:45 PM',
      birthday:e.birthday, phone:e.phone, language:e.language,
      email:e.email, sms_opted_out:e.smsOptedOut===true,
      drive_folder_id:e.driveFolderId||null,
      employee_number:normEmpNum(e.empNum)||null, department:e.department||null,
      // The other two axes of the v2 model, each written from its own select and
      // neither derived from the other. Blank means "not decided" and is stored as
      // NULL, not as ''. Both are in OPTIONAL_EMPLOYEE_COLUMNS (data.js), so a
      // database without the columns still saves the rest of the row.
      cost_class:e.costClass||null, position_group:e.positionGroup||null
    };

    if(e.id){
      const res=await writeEmployeeRow('/api/data?table=employees&id='+e.id,'PATCH',row);
      if(!res.ok) throw new Error(`Save failed with status ${res.status}`);
    } else {
      const res=await writeEmployeeRow('/api/data?table=employees','POST',row);
      if(!res.ok) throw new Error(`Save failed with status ${res.status}`);
      const d=await res.json();
      if(d.data?.[0]?.id) e.id=d.data[0].id;
    }

    if(isNew)state.employees.push(e);else state.employees[idx]=e;
    state.editing=null;
    setSyncStatus('idle');
    toast('Saved','success');

    // Auto-create Drive folder for new employees in the background
    if(isNew && e.name){
      fetch('/api/documents?employee='+encodeURIComponent(e.name))
        .catch(()=>{});
    }
    render();
  }catch(err){
    setSyncStatus('error');
    toast('Save failed: '+err.message,'error');
  }
}

function renderModal(){
  const e=state.editing;
  // Asked once, through the shared predicate, so the disabled state of the wage
  // field and the note under it cannot disagree with the select above them.
  const salariedHere=isSalaried(e);
  return `
    <div class="modal-bg" onclick="if(event.target===this)closeModal()">
      <div class="modal">
        <div class="modal-title" style="padding:20px 28px 0;flex-shrink:0">
          <span>${e._isNew?'Add employee':'Edit — '+(state.employees[e._idx]?.name||'')}</span>
          <button class="close-btn" onclick="closeModal()">×</button>
        </div>

        <div class="modal-body">
        <div id="modal-details-pane">
        <div class="form-grid">
          <div class="form-group full"><label class="form-label">Full name</label><input type="text" value="${e.name}" oninput="state.editing.name=this.value"></div>
          <div class="form-group"><label class="form-label">Pay type</label><select onchange="setPayType(this.value)">
            ${PAY_TYPES.map(t=>`<option value="${t}" ${payTypeOf(e)===t?'selected':''}>${t}</option>`).join('')}
          </select></div>
          <div class="form-group"><label class="form-label">Hourly wage ($/hr)</label><input type="text" value="${salariedHere?'':esc(String(e.wage==null?'':e.wage))}" id="wageInput"
            ${salariedHere?'disabled readonly placeholder="—"':''}
            oninput="state.editing.wage=this.value"
            onblur="formatWageInput(this)"></div>
          ${salariedHere?`<div class="form-group full" style="margin-top:-6px"><div style="font-size:11px;color:var(--muted);line-height:1.5">Hourly rates come from the daily payroll file; a salaried person has none, and their salary is entered on the Salaries &amp; Wages page, not here.</div></div>`:''}
          <div class="form-group"><label class="form-label">Employee # (payroll)</label><input type="text" value="${e.empNum||''}" placeholder="0319" oninput="state.editing.empNum=this.value" onchange="this.value=normEmpNum(this.value);state.editing.empNum=this.value"></div>
          <!-- The three taxonomy axes: three separate selects, three separate columns,
               and no handler here touches more than its own field. Changing the
               department does not set the cost class and does not filter this list. -->
          <div class="form-group"><label class="form-label">Department</label><select onchange="state.editing.department=this.value">
            <option value=""${hasDepartment(e.department)?'':' selected'}>— not set —</option>
            ${retiredOption(e.department,PAYROLL_DEPARTMENTS)}
            ${departmentOptions(e.department)}
          </select></div>
          <div class="form-group"><label class="form-label">Cost class</label><select onchange="state.editing.costClass=this.value">
            <option value=""${e.costClass?'':' selected'}>— not set —</option>
            ${retiredOption(e.costClass,COST_CLASSES)}
            ${taxonomyOptions(COST_CLASSES,e.costClass)}
          </select></div>
          <div class="form-group"><label class="form-label">Position group</label><select onchange="state.editing.positionGroup=this.value">
            <option value=""${e.positionGroup?'':' selected'}>— none —</option>
            ${retiredOption(e.positionGroup,POSITION_GROUPS)}
            ${taxonomyOptions(POSITION_GROUPS,e.positionGroup)}
          </select></div>
          <div class="form-group full" style="margin-top:-6px"><div style="font-size:11px;color:var(--muted);line-height:1.5">Employee # and Department drive the daily hours import and the OT report. None of these three is ever filled in automatically — each is set here, one employee at a time. <b>Department</b> is the accounting line; the list is grouped by cost class only so twelve values stay readable. <b>Cost class</b> is a separate fact and must be chosen on its own: a salaried person can sit in Manufacturing and an hourly person in ${esc('SG&A')}. <b>Position group</b> describes where in the mill somebody stands; it is for manufacturing floor staff and is correctly left as “— none —” for everyone else.</div></div>
          <div class="form-group"><label class="form-label">Status</label><select onchange="state.editing.status=this.value"><option value="Active" ${e.status==='Active'?'selected':''}>Active</option><option value="Inactive" ${e.status==='Inactive'?'selected':''}>Inactive</option></select></div>
          <div class="form-group"><label class="form-label">Language</label><select onchange="state.editing.language=this.value"><option value="English" ${e.language==='English'?'selected':''}>English</option><option value="Spanish" ${e.language==='Spanish'?'selected':''}>Spanish</option></select></div>
          <div class="form-group"><label class="form-label">Schedule days</label><input type="text" value="${e.days}" oninput="state.editing.days=this.value"></div>
          <div class="form-group"><label class="form-label">Clock in</label><input type="text" value="${e.clockIn}" oninput="state.editing.clockIn=this.value"></div>
          <div class="form-group"><label class="form-label">Clock out</label><input type="text" value="${e.clockOut}" oninput="state.editing.clockOut=this.value"></div>
          <div class="form-group"><label class="form-label">Birthday</label><input type="text" value="${e.birthday}" oninput="state.editing.birthday=this.value"></div>
          <div class="form-group"><label class="form-label">Phone</label><input type="text" value="${e.phone}" oninput="state.editing.phone=this.value;refreshSmsStatus()"></div>
          <div class="form-group full"><label class="form-label">Email</label><input type="text" value="${e.email}" oninput="state.editing.email=this.value"></div>
          <div class="form-group full" style="padding:10px 12px;background:var(--surface2);border-radius:6px;border:1px solid var(--border)">
            <label style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;user-select:none">
              <div>
                <div style="font-size:12px;font-weight:700;color:var(--text)">SMS opt-out</div>
                <div style="font-size:11px;color:var(--muted);margin-top:2px">Check to stop all text messages to this employee. Their phone number is untouched either way.</div>
              </div>
              <input type="checkbox" ${e.smsOptedOut?'checked':''} onchange="toggleSmsOptOut(this)" style="width:18px;height:18px;cursor:pointer;accent-color:#c0392b">
            </label>
            <div id="smsOptOutStatus" style="font-size:11px;margin-top:8px;color:${e.smsOptedOut?'#c0392b':(normalizePhone(e.phone)?'var(--muted)':'#b8860b')}">${smsStatusText(e)}</div>
          </div>
        </div>

        </div><!-- end modal-details-pane -->
        ${!e._isNew ? `
        <div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--border)">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--rust);margin-bottom:10px">HR File</div>
          <div id="driveLinkArea">
            <div style="font-size:12px;color:var(--muted)">Loading folder link…</div>
          </div>
        </div>
        ` : ''}


        </div><!-- end modal-body -->
        <div class="modal-footer">
          <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="saveEdit()">Save changes</button>
        </div>
      </div>
    </div>`;
}


// ============================================================
// TEXTBOLT LIST
// ============================================================
function copyTextBoltList() {
  const addresses = state.employees
    .filter(e => e.status === 'Active' && !e.smsOptedOut)
    .map(e => textBoltAddress(e.phone))
    .filter(Boolean);

  if (!addresses.length) {
    toast('No active opted-in employees found', 'error');
    return;
  }

  const list = addresses.join(', ');
  navigator.clipboard.writeText(list).then(() => {
    const btn = document.getElementById('copyTBBtn');
    btn.textContent = '✓ Copied ' + addresses.length + ' addresses';
    btn.style.color = '#2a7a47';
    btn.style.borderColor = '#2a7a47';
    toast(addresses.length + ' TextBolt addresses copied to clipboard', 'success');
    setTimeout(() => {
      btn.textContent = '📋 Copy TextBolt list';
      btn.style.color = '';
      btn.style.borderColor = '';
    }, 3000);
  }).catch(() => {
    // Fallback for browsers that block clipboard
    const ta = document.createElement('textarea');
    ta.value = list;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    toast(addresses.length + ' addresses copied', 'success');
  });
}

// ============================================================
// DRIVE FOLDER LINK
// ============================================================
function loadDriveLink(employeeName) {
  const el = document.getElementById('driveLinkArea');
  if (!el) return;
  el.innerHTML = '<div style="font-size:12px;color:var(--muted)">Looking up folder…</div>';

  fetch('/api/documents?employee=' + encodeURIComponent(employeeName))
    .then(r => r.json())
    .then(data => {
      const link = data.folderLink || null;
      if (link) {
        el.innerHTML = `<a href="${link}" target="_blank" class="btn btn-outline btn-sm" style="display:inline-flex;align-items:center;gap:6px;text-decoration:none">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          Open HR File in Drive
        </a>`;
      } else {
        el.innerHTML = '<div style="font-size:12px;color:var(--muted)">No folder found — will be created on first upload via Drive</div>';
      }
    })
    .catch(() => {
      el.innerHTML = '<div style="font-size:12px;color:var(--muted)">Could not load folder link</div>';
    });
}

// ============================================================
// EMPLOYEES — payroll field helpers
// ============================================================

// Matches normalizeEmpNumber on the server: the payroll export delivers
// zero-padded four-character ids ('0319'), so store them padded.
function normEmpNum(v){const s=String(v==null?'':v).trim();return /^\d+$/.test(s)?s.padStart(4,'0'):s;}
