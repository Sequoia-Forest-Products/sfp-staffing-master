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

// ONE row template, used by the full render and by the search re-render.
//
// There were two copies, and they had already drifted twice: this one used
// fmtWage(e) while renderEmployeeList printed e.wage raw, so the same person's
// wage read differently depending on whether you had typed in the search box.
// Both also interpolated name, days, phone and status UNESCAPED — employee names
// are user-controlled, which makes that an XSS surface on the roster.
//
// esc() on every interpolated value. fmtWage() produces its own markup-free
// string from a parsed number, so it is safe as-is, and it is the one formatter
// both renderers now go through.
function employeeRow(e){
  const idx=state.employees.indexOf(e);
  return `<tr>
      <!-- The name opens the read-only profile. It is a button rather than an
           anchor so there is no href to middle-click into a dead route. -->
      <td style="font-weight:600">
        <button class="emp-name-btn" onclick="openProfile(${idx})" title="Open profile">${esc(e.name)}</button>
      </td>
      <td>${fmtWage(e)}</td>
      <td${hasDepartment(e.department)?'':' style="color:var(--muted)"'}>${hasDepartment(e.department)?esc(e.department):'—'}</td>
      <td${e.costClass?'':' style="color:var(--muted)"'}>${e.costClass?esc(e.costClass):'—'}</td>
      <td><span class="badge ${e.status==='Active'?'active':'inactive'}">${esc(e.status||'—')}</span></td>
      <td><span class="badge ${e.language==='Spanish'?'es':'en'}">${e.language==='Spanish'?'ES':'EN'}</span></td>
      <td style="color:var(--muted);font-size:11px">${esc(e.days||'—')}</td>
      <td style="color:var(--muted);font-size:11px">${esc(e.phone||'—')}</td>
      <td>${smsCell(e)}</td>
      <td><button class="btn btn-outline btn-sm" onclick="openEdit(${idx})">Edit</button></td>
    </tr>`;
}

// The four stat cards, computed once. The search re-render used to recompute them
// inline and disagreed on two: it counted English as "active minus Spanish",
// which files anybody with no language recorded under English, and counted
// Inactive by status rather than as "everyone who is not Active". Same numbers
// from the same place now.
function rosterStats(){
  const active=state.employees.filter(e=>e.status==='Active');
  return {
    active:active.length,
    total:state.employees.length,
    english:active.filter(e=>e.language==='English').length,
    spanish:active.filter(e=>e.language==='Spanish').length,
    // Staffed MANUFACTURING departments, out of the six.
    depts:MANUFACTURING_DEPARTMENTS.filter(d=>state.employees.some(e=>e.department===d)).length,
    offMfg:active.filter(e=>hasDepartment(e.department)&&MANUFACTURING_DEPARTMENTS.indexOf(e.department)<0).length,
    noDept:active.filter(e=>!hasDepartment(e.department)).length,
    inactive:state.employees.length-active.length
  };
}

function renderEmployees(){
  // Staffed MANUFACTURING departments, out of the six — not out of all twelve
  // assignable values. A card reading "8 of 12" while two production departments sit
  // empty would be misleading if office departments were silently making up the
  // difference, so everything outside manufacturing is counted and labelled on its own.
  const st=rosterStats();
  const filtered=getFiltered();
  return `
    ${profileStyle}
    <div class="stat-row">
      <div class="stat-card"><div class="stat-label">Active headcount</div><div class="stat-value">${st.active}</div><div class="stat-sub">of ${st.total} total</div></div>
      <div class="stat-card"><div class="stat-label">English speakers</div><div class="stat-value">${st.english}</div><div class="stat-sub">${st.spanish} Spanish</div></div>
      <div class="stat-card"><div class="stat-label">Departments staffed</div><div class="stat-value">${st.depts}</div><div class="stat-sub">of ${MANUFACTURING_DEPARTMENTS.length} production · ${st.offMfg} active outside manufacturing · ${st.noDept} active unassigned</div></div>
      <div class="stat-card"><div class="stat-label">Inactive</div><div class="stat-value">${st.inactive}</div><div class="stat-sub">on roster</div></div>
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
        <!-- Cost class is read-only on the roster, and after the v2 activation this is
             the only screen that shows it at all, so this column is how the data gets
             audited. Its values go through esc() — 'SG&A' has an ampersand. Kept out of
             the row template so the comment is not repeated once per employee. -->
        <tbody>
          ${filtered.length?filtered.map(employeeRow).join(''):
            '<tr><td colspan="10" style="text-align:center;color:var(--muted);padding:32px">No employees match</td></tr>'}
        </tbody>
      </table>
    </div>
    ${state.editing!==null&&state.profile===null?renderModal():''}
    ${state.profile!==null?renderProfile():''}
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

  // The same four numbers the full render shows, from the same function. Two of
  // them used to be computed differently here: English was "active minus
  // Spanish", which counts anybody with no language recorded as an English
  // speaker, and Inactive was counted by status rather than as everyone who is
  // not Active. Typing in the search box changed the cards.
  const st = rosterStats();
  const statEls = document.querySelectorAll('.stat-value');
  if (statEls.length >= 4) {
    statEls[0].textContent = st.active;
    statEls[1].textContent = st.english;
    statEls[2].textContent = st.depts;
    statEls[3].textContent = st.inactive;
  }

  // Update table body only
  const tbody = document.querySelector('.table-wrap tbody');
  if (!tbody) return;

  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:var(--muted);padding:32px">No employees match</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(employeeRow).join('');
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

// ---------------------------------------------------------------------------
// The employee profile card.
//
// The roster used to go straight from a row to the edit modal, so the only way to
// look somebody up was to open the form that could overwrite them. The card is
// read-only until asked otherwise: Edit swaps the same card into inputs, Save
// writes through the existing saveEdit(), Cancel discards.
//
// COMPENSATION IS NOT ON THIS CARD. Neither annual_salary nor wage appears, in
// either mode. There is no permissions system yet, so every signed-in
// sequoiafp.com account can open every profile; annual_salary is not even in the
// payload (see the projection in netlify/functions/data.js) and wage, although it
// is in the payload and on the roster, is not extended onto a new surface. That
// waits for the Salaries & Wages tier.
//
// state.profile is {idx} and is separate from state.editing. Edit mode sets BOTH:
// state.editing is what saveEdit() reads, and it clears it on success, which
// drops the card back to read-only with no extra plumbing.
function openProfile(idx){
  state.profile={idx:idx};
  state.editing=null;
  render();
  if(needsDriveLookup(state.employees[idx])) setTimeout(()=>loadDriveLink(state.employees[idx].name),50);
}

function closeProfile(){
  state.profile=null;
  state.editing=null;
  render();
}

function startProfileEdit(){
  if(state.profile===null) return;
  state.editing={...state.employees[state.profile.idx],_idx:state.profile.idx,_isNew:false};
  render();
  if(needsDriveLookup(state.employees[state.profile.idx])) setTimeout(()=>loadDriveLink(state.employees[state.profile.idx].name),50);
}

function cancelProfileEdit(){
  state.editing=null;
  render();
  if(state.profile!==null&&needsDriveLookup(state.employees[state.profile.idx])){
    setTimeout(()=>loadDriveLink(state.employees[state.profile.idx].name),50);
  }
}

// The position vocabulary, read from the roster at render time rather than
// hardcoded, because the vocabulary is still settling and a hardcoded list would
// be wrong the first time somebody is hired into a new title. Filtered to the
// position group in play, since "Sawmill Operators" and "Accounting" do not share
// job titles — but with every other value still reachable, because `position`
// applies to everyone and the filter is a convenience, not a rule.
function positionsForGroup(group){
  const g=String(group==null?'':group).trim();
  const inGroup=new Set(), others=new Set();
  for(const e of state.employees){
    const pos=String(e.position==null?'':e.position).trim();
    if(!pos) continue;
    (String(e.positionGroup==null?'':e.positionGroup).trim()===g?inGroup:others).add(pos);
  }
  const sort=set=>[...set].sort((a,b)=>a.localeCompare(b));
  return {inGroup:sort(inGroup),others:sort(others)};
}

// A datalist rather than a select: the column is free text on purpose, so the
// existing values are offered as suggestions and anything new can still be typed.
// A select would make a new title impossible to enter without a code change.
function positionField(e){
  const {inGroup,others}=positionsForGroup(e.positionGroup);
  const opt=v=>`<option value="${esc(v)}"></option>`;
  return `
    <div class="form-group"><label class="form-label">Position</label>
      <input type="text" list="positionSuggestions" value="${esc(e.position||'')}"
        placeholder="Job title — type or pick"
        oninput="state.editing.position=this.value">
      <datalist id="positionSuggestions">
        ${inGroup.map(opt).join('')}
        ${others.map(opt).join('')}
      </datalist>
    </div>`;
}

// Read-only field. Renders an em dash rather than an empty cell so a blank reads
// as "nothing recorded" instead of as a rendering fault.
function pf(label,value,opts){
  const o=opts||{};
  const blank=value==null||String(value).trim()==='';
  const body=blank
    ? `<span style="color:var(--muted)">${esc(o.empty||'—')}</span>`
    : (o.html?value:esc(value));
  return `<div class="pf"><div class="pf-label">${esc(label)}</div><div class="pf-value">${body}</div></div>`;
}

function profileGroup(title,fields){
  return `
    <div class="pf-group">
      <div class="pf-group-title">${esc(title)}</div>
      <div class="pf-grid">${fields.join('')}</div>
    </div>`;
}

function renderProfile(){
  const idx=state.profile.idx;
  const person=state.employees[idx];
  if(!person){ return ''; }
  const editing=state.editing!==null;
  const e=editing?state.editing:person;

  const body=editing?profileEditBody(e):profileReadBody(e);

  return `
    <div class="modal-bg" onclick="if(event.target===this)closeProfile()">
      <div class="modal">
        <div class="modal-title" style="padding:20px 28px 0;flex-shrink:0">
          <span>${esc(person.name||'Employee')}${editing?' — editing':''}</span>
          <button class="close-btn" onclick="closeProfile()">×</button>
        </div>
        <div class="modal-body">${body}</div>
        <div class="modal-footer">
          ${editing
            ? `<button class="btn btn-outline" onclick="cancelProfileEdit()">Cancel</button>
               <button class="btn btn-primary" onclick="saveEdit()">Save</button>`
            : `<button class="btn btn-outline" onclick="closeProfile()">Close</button>
               <button class="btn btn-primary" onclick="startProfileEdit()">Edit</button>`}
        </div>
      </div>
    </div>`;
}

// The Drive folder.
//
// drive_folder_id is the stored fact and is authoritative: where it is set, the
// link is built from it and rendered immediately, with no network call. That is
// also why the card does NOT call loadDriveLink() in that case — loadDriveLink
// looks the folder up by NAME through /api/documents and overwrites
// #driveLinkArea with whatever it gets back, so on a person who already has an
// id it would replace a correct link with a second opinion, including replacing
// it with "No folder found" if the lookup disagreed.
//
// Where there is no id, the lookup is the only way to find or create one, so it
// runs — and its own wording covers the answer.
//
// A new hire with no folder yet is a real state, so it says so plainly. A dash
// would read as a rendering fault.
function needsDriveLookup(e){
  return !(e && e.driveFolderId);
}

function driveLinkBlock(e){
  if(e.driveFolderId){
    const url='https://drive.google.com/drive/folders/'+encodeURIComponent(e.driveFolderId);
    return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" class="btn btn-outline btn-sm" style="display:inline-flex;align-items:center;gap:6px;text-decoration:none">Open HR file in Drive</a>`;
  }
  return '<span style="color:var(--muted)">No folder yet — one is created for a new employee automatically, or on the first upload in Drive.</span>';
}

function profileReadBody(e){
  const bday=fmtBirthday(e.birthday);
  const addr=[e.addressStreet,e.addressCity,e.addressState,e.addressPostalCode]
    .map(v=>String(v==null?'':v).trim()).filter(Boolean);

  return `
    ${profileGroup('Identity',[
      pf('Name',e.name),
      pf('Employee #',e.empNum),
      pf('Status',`<span class="badge ${e.status==='Active'?'active':'inactive'}">${esc(e.status||'—')}</span>`,{html:true}),
      pf('Language',e.language)
    ])}
    ${profileGroup('Classification',[
      pf('Department',hasDepartment(e.department)?e.department:'',{empty:'not set'}),
      pf('Cost class',e.costClass,{empty:'not set'}),
      pf('Position group',e.positionGroup,{empty:'none — not mill floor staff'}),
      pf('Position',e.position,{empty:'not set'}),
      pf('Pay type',payTypeOf(e))
    ])}
    ${profileGroup('Contact',[
      pf('Phone',e.phone),
      pf('Email',e.email),
      pf('SMS',e.smsOptedOut?'Opted out':'Receiving texts')
    ])}
    ${profileGroup('Personal',[
      // Month and day only, because that is all the birthday notifier reads. A
      // value it cannot parse is called out rather than shown as blank: the
      // person would silently stop being announced and nothing else reports it.
      bday
        ? pf('Birthday',bday)
        : pf('Birthday',
            String(e.birthday||'').trim()
              ? `<span style="color:#b8860b;font-weight:700">Unreadable — ${esc(String(e.birthday))}</span>`
              : '',
            {html:true,empty:'not set'})
    ])}
    ${profileGroup('Address',[
      pf('Street',e.addressStreet),
      pf('City',e.addressCity),
      pf('State',e.addressState),
      pf('Postal code',e.addressPostalCode),
      pf('Full',addr.length?addr.join(', '):'',{empty:'no address on file'})
    ])}
    ${profileGroup('Files',[
      pf('HR file',`<span id="driveLinkArea">${driveLinkBlock(e)}</span>`,{html:true})
    ])}
    ${profileGroup('Schedule',[
      pf('Days',e.days),
      pf('Break 1',e.break1),
      pf('Break 2',e.break2)
    ])}
    ${profilePreApproved(e)}
    ${profileAllocation(e)}`;
}

// ============================================================
// PRE-APPROVED OT, on the profile card
// ============================================================
//
// This is where the standing allowance is assigned, and it is keyed on this
// employee's id. The old Pre-Approved Overtime tab typed a NAME into a free-text
// box; the roster has two people called Smith, so a name key silently attaches
// one person's allowance to another's record.
//
// IT SAVES ITSELF, one row at a time, and is deliberately NOT part of the card's
// Edit / Save / Cancel flow. Two reasons, and the first is the load-bearing one:
//
//   1. It writes to a different table through a different endpoint. One Save
//      button writing to two tables has to answer "what happens when the second
//      write fails", and every answer is worse than not asking — a half-saved
//      profile that reports as saved is the kind of thing nobody finds for weeks.
//   2. One row at a time is the whole point of the restructure. The old tab
//      saved by deleting the table and re-inserting it, which is how a
//      byte-identical duplicate row got in and stayed for months.
//
// So each category has its own Save. `unique(employee_id, ot_type)` in the
// database means saving twice updates rather than duplicating, whatever this
// code does.
function profilePreApproved(e){
  const id=String(e&&e.id||'');
  if(!id){
    // A new hire that has not been saved yet has no id to key an allowance on.
    return profileGroup('Pre-approved OT',[
      pf('','<span style="color:var(--muted)">Save this employee first — the allowance is keyed on their record.</span>',{html:true})
    ]);
  }

  if(!state.preLoaded&&!state.preLoading){
    // Loaded on demand, the same way the Reports tab loads it. Not fetched on
    // every page load: most profile views never look at it.
    setTimeout(()=>loadPreApproved(),0);
  }

  if(state.preTableMissing){
    return profileGroup('Pre-approved OT',[
      pf('','<span style="color:#b8860b">The per-employee table does not exist yet — run SCHEMA_PHASE_C_PREAPPROVED_OT.sql. Until then the allowance is still read from the old name-keyed table and cannot be edited here.</span>',{html:true})
    ]);
  }

  if(state.preLoading&&!state.preLoaded){
    return profileGroup('Pre-approved OT',[
      pf('','<span style="color:var(--muted)">Loading…</span>',{html:true})
    ]);
  }

  const mine=preApprovedFor(id);
  const total=PREAPPROVED_TYPES.reduce((t,k)=>t+(mine[k]?Number(mine[k].hours)||0:0),0);

  const rows=PREAPPROVED_TYPES.map(type=>{
    const row=mine[type]||null;
    const hours=row?Number(row.hours)||0:0;
    const desc=row?(row.description||''):'';
    const hid='pre-h-'+type.replace(/[^A-Za-z]/g,'');
    const did='pre-d-'+type.replace(/[^A-Za-z]/g,'');
    return `<div style="display:grid;grid-template-columns:104px 88px 1fr auto auto;gap:8px;align-items:center;padding:5px 0;border-bottom:1px solid var(--border)">
      <div style="font-size:11.5px;font-weight:600">${esc(type)}
        <div style="font-size:10px;color:var(--muted);font-weight:400">${esc(PREAPPROVED_TYPE_NOTE[type]||'')}</div></div>
      <input id="${hid}" type="number" value="${hours}" min="0" max="40" step="0.25"
        style="font-family:var(--font);font-size:12px;border:1px solid var(--border);border-radius:4px;padding:4px 8px;width:100%">
      <input id="${did}" type="text" value="${esc(desc)}" placeholder="what the work is"
        style="font-family:var(--font);font-size:12px;border:1px solid var(--border);border-radius:4px;padding:4px 8px;width:100%">
      <button class="btn btn-primary btn-sm" style="padding:2px 10px"
        onclick="profileSavePreApproved('${jsStr(id)}','${jsStr(type)}','${hid}','${did}')">Save</button>
      ${row
        ? `<button class="btn btn-outline btn-sm" style="padding:2px 8px"
             onclick="deletePreApproved('${jsStr(id)}','${jsStr(type)}','${jsStr(e.name||'')}')">✕</button>`
        : '<span style="width:26px"></span>'}
    </div>`;
  }).join('');

  const grace=graceHrs();
  return `<div class="pf-group">
    <div class="pf-group-title">Pre-approved OT — standing weekly allowance</div>
    <div style="font-size:11px;color:var(--muted);line-height:1.5;margin-bottom:8px">
      Hours per WEEK, not per day, and the same figure applies to every week — there is no week column.
      The category says when the overtime happens; the description says what the work is, and it is the
      part a manager can argue with. Each row saves on its own.
    </div>
    ${rows}
    <div style="display:flex;justify-content:space-between;font-size:11.5px;font-weight:700;padding-top:7px">
      <span>Standing total</span><span>${fmtHrs(total)} hrs/wk</span>
    </div>
    <div style="font-size:11px;color:var(--muted);line-height:1.5;margin-top:6px">
      On top of this, every active hourly employee carries the ${fmtHrs(grace)} hrs/wk timeclock grace
      allowance. That is policy for everyone and is not assigned here — it is a separate line item in the
      OT report and is configured on the Settings tab.
      ${(e.status&&e.status!=='Active')?'<br><strong style="color:#e67e22">This employee is not active, so any allowance here counts nowhere.</strong> An allowance is permission to work overtime, and somebody who has left cannot use it — crediting them would understate Net OT every week.':''}
    </div>
  </div>`;
}

// Reads the two inputs by id rather than threading values through the onclick
// attribute: an apostrophe in a description would otherwise have to survive
// being written into an HTML attribute AND parsed as a JS string literal, and
// this codebase has already been bitten twice by that.
async function profileSavePreApproved(employeeId, otType, hoursId, descId){
  const h=document.getElementById(hoursId);
  const d=document.getElementById(descId);
  await savePreApproved(employeeId, otType, h?h.value:'', d?d.value:'');
}

// Deep link from the Pre-Approved OT report: open this person's card.
function goToEmployeeProfile(employeeId){
  const idx=(state.employees||[]).findIndex(x=>String(x.id)===String(employeeId));
  if(idx<0){ toast('That employee is no longer on the roster','error'); return; }
  // The roster may be filtered to something that excludes them; the card reads
  // state.employees by index, not the filtered view, so it opens either way.
  goToTab('employees');
  openProfile(idx);
}
// The birthday input, shared by both edit surfaces so they cannot disagree about
// what happens to a value the picker cannot show. See profileEditBody for why
// blanking is not an option.
function birthdayField(e){
  const iso=birthdayInputValue(e.birthday);
  const raw=String(e.birthday==null?'':e.birthday).trim();
  if(raw!==''&&iso===''){
    return `<div class="form-group full"><label class="form-label">Birthday</label>
      <input type="text" value="${esc(raw)}" oninput="state.editing.birthday=this.value">
      <div style="font-size:11px;color:#b8860b;margin-top:4px;line-height:1.5">Not a date the picker can show, so it is left as text rather than blanked — the notifier still reads it, month and day are all it needs. Retype it as a full date to get a picker.</div>
    </div>`;
  }
  return `<div class="form-group"><label class="form-label">Birthday</label>
    <input type="date" value="${esc(iso)}" oninput="state.editing.birthday=this.value"></div>`;
}

// The same card, editable. Deliberately NOT a second field list: every group
// below matches profileReadBody() group for group, so a field cannot be readable
// and not editable, or the other way round.
//
// No wage input and no annual_salary input, in either mode. Hourly rates come
// from the daily payroll file and salary is Phase D; the roster's own Edit modal
// still has the wage field for the cases that need it.
function profileEditBody(e){
  const bdayInput=birthdayInputValue(e.birthday);
  const bdayRaw=String(e.birthday==null?'':e.birthday).trim();
  // A stored value the date input cannot represent must NOT be shown as an empty
  // picker: saving would write the blank over a real birthday, on a system that is
  // live and announcing to 66 people. It gets a text field and a warning instead,
  // and the notifier keeps reading it either way — it only needs month and day.
  const bdayUnreadable=bdayRaw!==''&&bdayInput==='';

  return `
    <div class="form-grid">
      <div class="form-group full"><label class="form-label">Full name</label>
        <input type="text" value="${esc(e.name||'')}" oninput="state.editing.name=this.value"></div>
      <div class="form-group"><label class="form-label">Employee # (payroll)</label>
        <input type="text" value="${esc(e.empNum||'')}" placeholder="0319"
          oninput="state.editing.empNum=this.value"
          onchange="this.value=normEmpNum(this.value);state.editing.empNum=this.value"></div>
      <div class="form-group"><label class="form-label">Status</label>
        <select onchange="state.editing.status=this.value">
          <option value="Active" ${e.status==='Active'?'selected':''}>Active</option>
          <option value="Inactive" ${e.status==='Inactive'?'selected':''}>Inactive</option>
        </select></div>
      <div class="form-group"><label class="form-label">Language</label>
        <select onchange="state.editing.language=this.value">
          <option value="English" ${e.language==='English'?'selected':''}>English</option>
          <option value="Spanish" ${e.language==='Spanish'?'selected':''}>Spanish</option>
        </select></div>

      <div class="form-group"><label class="form-label">Department</label>
        <select onchange="state.editing.department=this.value">
          <option value=""${hasDepartment(e.department)?'':' selected'}>— not set —</option>
          ${retiredOption(e.department,PAYROLL_DEPARTMENTS)}
          ${departmentOptions(e.department)}
        </select></div>
      <div class="form-group"><label class="form-label">Cost class</label>
        <select onchange="state.editing.costClass=this.value">
          <option value=""${e.costClass?'':' selected'}>— not set —</option>
          ${retiredOption(e.costClass,COST_CLASSES)}
          ${taxonomyOptions(COST_CLASSES,e.costClass)}
        </select></div>
      <!-- Changing the position group re-renders, so the position suggestions
           follow it. It does NOT clear the position: the stored title is a fact
           about the person and a group change is not a reason to discard it. -->
      <div class="form-group"><label class="form-label">Position group</label>
        <select onchange="state.editing.positionGroup=this.value;render()">
          <option value=""${e.positionGroup?'':' selected'}>— none —</option>
          ${retiredOption(e.positionGroup,POSITION_GROUPS)}
          ${taxonomyOptions(POSITION_GROUPS,e.positionGroup)}
        </select></div>
      ${positionField(e)}
      <div class="form-group"><label class="form-label">Pay type</label>
        <select onchange="setPayType(this.value)">
          ${PAY_TYPES.map(t=>`<option value="${esc(t)}" ${payTypeOf(e)===t?'selected':''}>${esc(t)}</option>`).join('')}
        </select></div>
      <div class="form-group full" style="margin-top:-6px"><div style="font-size:11px;color:var(--muted);line-height:1.5">Compensation is not editable here. Hourly rates come from the daily payroll file, and salary is entered on the Salaries &amp; Wages page, which does not exist yet. <b>Position group</b> is mill-floor only and is correctly “— none —” for office staff; <b>Position</b> applies to everyone.</div></div>

      <div class="form-group"><label class="form-label">Phone</label>
        <input type="text" value="${esc(e.phone||'')}" oninput="state.editing.phone=this.value;refreshSmsStatus()"></div>
      <div class="form-group full"><label class="form-label">Email</label>
        <input type="text" value="${esc(e.email||'')}" oninput="state.editing.email=this.value"></div>

      ${bdayUnreadable?`
      <div class="form-group full"><label class="form-label">Birthday</label>
        <input type="text" value="${esc(bdayRaw)}" oninput="state.editing.birthday=this.value">
        <div style="font-size:11px;color:#b8860b;margin-top:4px;line-height:1.5">This value is not a date the picker can show, so it is left as text rather than blanked. The birthday notifier still reads it — it only needs the month and day. Retype it as a full date to switch this field to a picker.</div>
      </div>`:`
      <div class="form-group"><label class="form-label">Birthday</label>
        <input type="date" value="${esc(bdayInput)}" oninput="state.editing.birthday=this.value">
      </div>`}

      <div class="form-group"><label class="form-label">Schedule days</label>
        <input type="text" value="${esc(e.days||'')}" oninput="state.editing.days=this.value"></div>

      <div class="form-group full"><label class="form-label">Street</label>
        <input type="text" value="${esc(e.addressStreet||'')}" oninput="state.editing.addressStreet=this.value"></div>
      <div class="form-group"><label class="form-label">City</label>
        <input type="text" value="${esc(e.addressCity||'')}" oninput="state.editing.addressCity=this.value"></div>
      <div class="form-group"><label class="form-label">State</label>
        <input type="text" value="${esc(e.addressState||'')}" oninput="state.editing.addressState=this.value"></div>
      <div class="form-group"><label class="form-label">Postal code</label>
        <input type="text" value="${esc(e.addressPostalCode||'')}" oninput="state.editing.addressPostalCode=this.value"></div>

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

      <div class="form-group full">
        <label class="form-label">HR file</label>
        <div id="driveLinkArea" style="font-size:12px">${driveLinkBlock(e)}</div>
      </div>
    </div>`;
}

const profileStyle=`<style>
  .emp-name-btn{background:none;border:none;padding:0;font:inherit;font-weight:600;color:var(--rust);cursor:pointer;text-align:left}
  .emp-name-btn:hover{text-decoration:underline}
  .pf-group{margin-bottom:18px}
  .pf-group-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--rust);margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid var(--border)}
  .pf-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px 18px}
  .pf-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin-bottom:2px}
  .pf-value{font-size:13px;color:var(--text);line-height:1.4;word-break:break-word}
</style>`;

function openEdit(idx){
  // The roster's own Edit modal. Kept alongside the profile card because it is
  // the only surface with the hourly wage field, and Add uses it too. The card's
  // Edit deliberately has no compensation field.
  state.profile=null;
  state.editing={...state.employees[idx],_idx:idx,_isNew:false};
  render();
  // Load Drive folder link after render
  setTimeout(()=>loadDriveLink(state.employees[idx].name), 50);
}

// Every taxonomy field starts BLANK on a new employee — no cost class implied by a
// department, no department implied by a position group. Each is a decision about a
// real person, and a default that follows from another field is the coupling the v2
// model exists to remove.
function openAdd(){state.profile=null;state.editing={name:'',wage:'',payType:'Hourly',empNum:'',department:'',costClass:'',positionGroup:'',position:'',status:'Active',days:'MON-THU',break1:'7:00 AM',break2:'12:45 PM',birthday:'',phone:'',language:'English',email:'',addressStreet:'',addressCity:'',addressState:'',addressPostalCode:'',smsOptedOut:false,_isNew:true};render();}
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
      // clock_in / clock_out are no longer written; see the note in the form.
      days:e.days,
      break_1:e.break1||'7:00 AM', break_2:e.break2||'12:45 PM',
      birthday:e.birthday, phone:e.phone, language:e.language,
      email:e.email, sms_opted_out:e.smsOptedOut===true,
      drive_folder_id:e.driveFolderId||null,
      employee_number:normEmpNum(e.empNum)||null, department:e.department||null,
      // The other two axes of the v2 model, each written from its own select and
      // neither derived from the other. Blank means "not decided" and is stored as
      // NULL, not as ''. Both are in OPTIONAL_EMPLOYEE_COLUMNS (data.js), so a
      // database without the columns still saves the rest of the row.
      cost_class:e.costClass||null, position_group:e.positionGroup||null,
      // Phase B. position applies to everyone; position_group does not. Blank is
      // stored as NULL rather than '', the same as the other nullable fields.
      position:e.position||null,
      address_street:e.addressStreet||null, address_city:e.addressCity||null,
      address_state:e.addressState||null, address_postal_code:e.addressPostalCode||null
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
          <div class="form-group"><label class="form-label">Position group</label><select onchange="state.editing.positionGroup=this.value;render()">
            <option value=""${e.positionGroup?'':' selected'}>— none —</option>
            ${retiredOption(e.positionGroup,POSITION_GROUPS)}
            ${taxonomyOptions(POSITION_GROUPS,e.positionGroup)}
          </select></div>
          ${positionField(e)}
          <div class="form-group full" style="margin-top:-6px"><div style="font-size:11px;color:var(--muted);line-height:1.5">Employee # and Department drive the daily hours import and the OT report. None of these three is ever filled in automatically — each is set here, one employee at a time. <b>Department</b> is the accounting line; the list is grouped by cost class only so twelve values stay readable. <b>Cost class</b> is a separate fact and must be chosen on its own: a salaried person can sit in Manufacturing and an hourly person in ${esc('SG&A')}. <b>Position group</b> describes where in the mill somebody stands; it is for manufacturing floor staff and is correctly left as “— none —” for everyone else.</div></div>
          <div class="form-group"><label class="form-label">Status</label><select onchange="state.editing.status=this.value"><option value="Active" ${e.status==='Active'?'selected':''}>Active</option><option value="Inactive" ${e.status==='Inactive'?'selected':''}>Inactive</option></select></div>
          <div class="form-group"><label class="form-label">Language</label><select onchange="state.editing.language=this.value"><option value="English" ${e.language==='English'?'selected':''}>English</option><option value="Spanish" ${e.language==='Spanish'?'selected':''}>Spanish</option></select></div>
          <div class="form-group"><label class="form-label">Schedule days</label><input type="text" value="${esc(e.days||'')}" oninput="state.editing.days=this.value"></div>
          <!-- Clock in and clock out are gone from this form. Audited across the
               frontend, every Netlify function and both report libraries: nothing
               read them. The Pre-Shift / Post-Shift OT categories are a stored
               label on the overtime table chosen by a human, not a comparison
               against a shift boundary, so removing these does not affect the OT
               report. The COLUMNS are still there and still projected — the
               stored values stay readable, the way dept was kept. -->
          ${birthdayField(e)}
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
        el.innerHTML = `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer" class="btn btn-outline btn-sm" style="display:inline-flex;align-items:center;gap:6px;text-decoration:none">
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
