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

// The pay type select. It no longer touches the rate. There is no wage input to
// clear, and state.editing.wage is now only the value READ from the roster for
// display — blanking it would make the modal, and then the roster row behind it,
// show nothing for a rate the database still holds and the Salaries & Wages
// page owns.
//
// Flipping somebody to Salaried therefore leaves employees.wage exactly as the
// import left it. Nothing reads it for a salaried person: isSalaried() consults
// pay_type first and only falls back to the wage column when pay_type is absent,
// so the stale rate cannot resurface as a fact about them.
function setPayType(v) {
  state.editing.payType = v === 'Salaried' ? 'Salaried' : 'Hourly';
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
// either mode, and Phase D did not change that — it is a decision about where
// compensation lives, not a consequence of there being no tiers.
//
// Every signed-in sequoiafp.com account can open every profile. annual_salary is
// not in their payload at all unless they hold the salaries tier (the projection
// is built from the caller's tiers — see netlify/functions/data.js), and wage,
// although it is in the payload and on the roster, is not extended onto a new
// surface. Both live on Salaries & Wages, which is one page to look at and one
// place to change.
//
// state.profile is {idx} and is separate from state.editing. Edit mode sets BOTH:
// state.editing is what saveEdit() reads, and it clears it on success, which
// drops the card back to read-only with no extra plumbing.
function openProfile(idx){
  state.profile={idx:idx};
  state.editing=null;
  render();
  const person=state.employees[idx];
  // Fetched on open rather than with the roster: two extra tables per person
  // across 71 people, on every page load, to fill a panel most opens never
  // scroll to. Guarded inside loadEmployeeHistory so re-opening the same card
  // does not re-fetch.
  if(person&&person.id) setTimeout(()=>loadEmployeeHistory(person.id),0);
  if(needsDriveLookup(person)) setTimeout(()=>loadDriveLink(person.name),50);
}

function closeProfile(){
  state.profile=null;
  state.editing=null;
  render();
}

// ONE Edit button for the whole card.
//
// The card used to have three save mechanics on it: Edit/Save for the employee
// row, a per-category Save for pre-approved OT, and a Save/Revert pair for the
// allocation. Three buttons, and no way to tell from the screen which one
// committed what. Now Edit makes everything editable and Save commits all of it.
//
// What did NOT change is how the writes reach the database. Pre-approved OT is
// still one row per call and allocations still go through one transaction — see
// preApprovedCommit and allocCommit. Batching the calls behind one button is a
// UI change; changing the endpoints' shape would undo two bug fixes.
function startProfileEdit(){
  if(state.profile===null) return;
  const person=state.employees[state.profile.idx];
  state.editing={...person,_idx:state.profile.idx,_isNew:false};
  // Both drafts are seeded here so Cancel has something definite to throw away
  // and Save has something definite to compare against.
  if(person.id){
    state.editing._pre=preApprovedDraft(person.id);
    allocDraft(person.id, hasDepartment(person.department)?person.department:'');
  }
  render();
  if(needsDriveLookup(person)) setTimeout(()=>loadDriveLink(person.name),50);
}

// Cancel discards ALL of it — the employee fields, the allowance draft and the
// allocation draft. Leaving one behind is how a discarded edit reappears on the
// next Save.
function cancelProfileEdit(){
  const person=state.profile!==null?state.employees[state.profile.idx]:null;
  if(person&&person.id&&state.allocDrafts) delete state.allocDrafts[String(person.id)];
  state.editing=null;
  render();
  if(person&&needsDriveLookup(person)){
    setTimeout(()=>loadDriveLink(person.name),50);
  }
}

// True while this specific person's card is in edit mode. Both sections below
// ask this rather than reading state.editing directly, so the roster's own Edit
// modal — which renders neither section — cannot accidentally put them into edit
// mode for the wrong record.
function profileEditing(e){
  return state.profile!==null && state.editing!==null
    && !!e && !!e.id && String(state.editing.id)===String(e.id);
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

  // The two Phase C sections render in BOTH modes and are appended HERE rather
  // than inside either body — they were in profileReadBody only, so switching to
  // edit mode made them vanish entirely. Appending once is what stops the two
  // bodies from disagreeing about which sections exist.
  const body=(editing?profileEditBody(e):profileReadBody(e))
    + profileCompensation(e) + profilePreApproved(e) + profileAllocation(e)
    // History is read-only in both modes: it is a record, not a field.
    + profileHistory(e);
  // The database would refuse a partial allocation anyway; letting somebody
  // press Save to discover that is worse than not offering it. Gated here rather
  // than inside the allocation block so the one Save button owns the decision.
  const allocOk=!editing||!person.id||allocDraftValid(person.id);

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
            ? `${allocOk?'':'<span style="font-size:11px;color:var(--brick);margin-right:auto;line-height:1.4">The cost allocation must add up to 100% before this can be saved.</span>'}
               <button class="btn btn-outline" onclick="cancelProfileEdit()">Cancel</button>
               <button class="btn btn-primary" ${allocOk?'':'disabled'} onclick="saveEdit()">Save</button>`
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

// One break time, read-only. Three states, because a reader needs to tell them
// apart: a formatted time, nothing on file, and something on file that cannot be
// read. The last one used to render as the raw stored string —
// '1899-12-30T20:45:00.000Z' — which looked like a rendering fault rather than
// data worth fixing.
function breakField(label,value){
  const shown=fmtTime(value);
  if(shown) return pf(label,shown);
  const raw=String(value==null?'':value).trim();
  if(raw==='') return pf(label,'',{empty:'not set'});
  return pf(label,
    `<span style="color:#b8860b;font-weight:700">Unreadable — ${esc(raw)}</span>`,
    {html:true});
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
      pf('Days',e.days,{empty:'not set'}),
      breakField('Break 1',e.break1),
      breakField('Break 2',e.break2)
    ])}
`;
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
// ============================================================
// COMPENSATION ON THE PROFILE CARD
// ============================================================
//
// Phase B kept pay off this card deliberately, because there were no
// permissions yet and the card is opened by everybody. Phase D built the tiers
// and the Salaries & Wages page proved them; this finishes that job rather than
// undoing it, and the page is retired.
//
// THE SALARY RULE IS ABSENT, NOT MASKED. A caller without the salaries tier
// gets no `annual_salary` in the payload at all — the projection in
// netlify/functions/data.js is built from their tiers and never NAMES the
// column, and pickColumns re-filters the response against the same list. So
// this renders the word "Salaried" because it HAS no number, not because it was
// told to hide one. Printing a number and covering it with CSS would be
// readable in devtools, which is exactly what Phase B closed.
//
// Which means the check below is a rendering decision, never a security one.
// Deleting canSeeSalaries() from this file would change what the card says and
// would not expose a single dollar.

// The rate live-note is written STRAIGHT INTO ITS NODE and never through
// render(). render() does `el.innerHTML = renderEmployees()`, which destroys the
// input the cursor is in, taking the focus, the caret and anything half-typed
// with it. salaries.js solved this the same way (paySet -> #payFoot) and it is
// the reason typing a rate there never lost a keystroke.
function profileRateNote(){
  const e=state.editing;
  if(!e) return '';
  const parsed=parseRate(e.wage);
  if(parsed===undefined) return '<span style="color:#b8860b">Not a number</span>';
  if(parsed===null) return '<span style="color:#b8860b">A rate cannot be cleared, only corrected</span>';
  const pct=wageMovePct(e,parsed);
  if(pct==null) return '<span style="color:var(--muted)">First rate on file</span>';
  const flag=Math.abs(pct)>WAGE_FLAG_PCT;
  return `<span style="color:${flag?'#b8860b':'var(--muted)'}">${pct>0?'+':''}${pct}%`
    +`${flag?' — this will be flagged for review':''}</span>`;
}

function profileSalaryNote(){
  const e=state.editing;
  if(!e) return '';
  const parsed=parseSalary(e.annualSalary);
  if(parsed===undefined) return '<span style="color:#b8860b">Not a number</span>';
  if(parsed==null) return '<span style="color:var(--muted)">No salary on file — their cost cannot be computed</span>';
  return `<span style="color:var(--muted)">Hourly equivalent `
    +`${fmt$(Math.round(parsed/SALARY_HOURS_PER_YEAR*100)/100)}</span>`;
}

function setProfileRate(v){
  if(!state.editing) return;
  state.editing.wage=v;
  const el=document.getElementById('profileRateNote');
  if(el) el.innerHTML=profileRateNote();
}

function setProfileSalary(v){
  if(!state.editing) return;
  state.editing.annualSalary=v;
  const el=document.getElementById('profileSalaryNote');
  if(el) el.innerHTML=profileSalaryNote();
}

// ============================================================
// HISTORY ON THE PROFILE CARD
// ============================================================
//
// Two records, deliberately shown together and deliberately labelled
// differently.
//
// wage_history has been recording every rate change since the v2 model and
// nothing has ever displayed it. It covers the whole period it existed for.
//
// position_history was created on the day it shipped and covers NOTHING before
// that. Whatever anybody's department was beforehand is unrecoverable: the
// employees row was overwritten in place each time. The only surviving trace is
// daily_hours.department, a per-import snapshot that covers only days a person
// worked. So the list says where it starts, every time, rather than letting a
// short list read as a complete one — "he was always in Production" from a
// record that only proves "since September" is the failure this label prevents.
async function loadEmployeeHistory(employeeId){
  if(!employeeId) return;
  const key=String(employeeId);
  if(!state.history) state.history={};
  if(state.history[key]&&state.history[key].loading) return;
  state.history[key]={loading:true,wage:[],position:[],error:''};
  render();
  try{
    const res=await fetch('/api/employee-history?employeeId='+encodeURIComponent(key));
    if(res.status===401){location.href='/';return;}
    let json=null; try{json=await res.json();}catch(e){json=null;}
    if(!res.ok||!json||json.ok===false) throw new Error((json&&json.error)||('Request failed ('+res.status+')'));
    state.history[key]={
      loading:false, wage:json.wage||[], position:json.position||[],
      wageUnavailable:!!json.wageUnavailable,
      positionUnavailable:!!json.positionUnavailable,
      error:''
    };
  }catch(err){
    state.history[key]={loading:false,wage:[],position:[],error:err.message};
  }
  render();
}

function historyFieldLabel(f){
  return ({department:'Department',position:'Position',
           position_group:'Position group',cost_class:'Cost class'})[f]||f;
}

function profileHistory(e){
  if(!e||!e.id) return '';
  const h=(state.history||{})[String(e.id)];
  if(!h) return `<div class="pf-group"><div class="pf-group-title">History</div>
    <div style="font-size:12px;color:var(--muted)">Loading…</div></div>`;
  if(h.loading) return `<div class="pf-group"><div class="pf-group-title">History</div>
    <div style="font-size:12px;color:var(--muted)">Loading…</div></div>`;
  if(h.error) return `<div class="pf-group"><div class="pf-group-title">History</div>
    <div style="font-size:12px;color:var(--brick)">Could not load history: ${esc(h.error)}</div></div>`;

  const rate=(h.wage||[]).map(r=>`<tr>
      <td>${fmtDate(r.effective_date)}</td>
      <td>${r.previous_rate==null?'<span style="color:var(--muted)">first on file</span>':fmt$(r.previous_rate)}</td>
      <td style="font-weight:700">${fmt$(r.rate)}</td>
      <td>${r.change_pct==null?'—':((Number(r.change_pct)>0?'+':'')+Number(r.change_pct).toFixed(1)+'%')}${r.flagged?' <span style="color:#b8860b;font-weight:700">flagged</span>':''}</td>
      <td style="font-size:11px;color:var(--muted)">${esc(r.note||r.source||'')}</td>
    </tr>`).join('');

  const pos=(h.position||[]).map(r=>`<tr>
      <td>${fmtDate(String(r.changed_at||'').slice(0,10))}</td>
      <td>${esc(historyFieldLabel(r.field))}</td>
      <td>${r.previous_value?esc(r.previous_value):'<span style="color:var(--muted)">not set</span>'}</td>
      <td style="font-weight:700">${r.new_value?esc(r.new_value):'<span style="color:var(--muted)">cleared</span>'}</td>
      <td style="font-size:11px;color:var(--muted)">${esc(r.changed_by||'')}</td>
    </tr>`).join('');

  return `
    <div class="pf-group"><div class="pf-group-title">Rate history</div>
      ${h.wageUnavailable
        ? '<div style="font-size:12px;color:var(--brick)">Could not be read — this is not the same as "no changes".</div>'
        : rate
          ? `<div class="table-wrap" style="margin-bottom:0"><table>
              <thead><tr><th>Date</th><th>From</th><th>To</th><th>Change</th><th>Source</th></tr></thead>
              <tbody>${rate}</tbody></table></div>`
          : '<div style="font-size:12px;color:var(--muted)">No rate changes recorded.</div>'}
    </div>
    <div class="pf-group"><div class="pf-group-title">Classification history</div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:8px">
        <strong>Recorded from ${fmtDate(POSITION_HISTORY_FROM)} onwards only.</strong>
        Nothing tracked department, position, position group or cost class before then — the
        employee record was overwritten in place — so this list is not a full tenure and an absence
        here is not evidence that nothing changed.</div>
      ${h.positionUnavailable
        ? '<div style="font-size:12px;color:var(--brick)">Could not be read — run SCHEMA_POSITION_HISTORY.sql if it has not been applied.</div>'
        : pos
          ? `<div class="table-wrap" style="margin-bottom:0"><table>
              <thead><tr><th>Date</th><th>Field</th><th>From</th><th>To</th><th>Changed by</th></tr></thead>
              <tbody>${pos}</tbody></table></div>`
          : '<div style="font-size:12px;color:var(--muted)">No changes recorded since then.</div>'}
    </div>`;
}

function profileCompensation(e){
  const editing=profileEditing(e);
  const salaried=isSalaried(e);
  const tier=canSeeSalaries();

  // Salaried
  if(salaried){
    if(!tier){
      // No figure exists on this client to show. See the header above.
      return profileGroup('Compensation',[
        pf('Pay','Salaried'),
        pf('Amount','',{empty:'not visible to this account'})
      ]);
    }
    if(!editing){
      return profileGroup('Compensation',[
        pf('Pay','Salaried'),
        pf('Annual salary',e.annualSalary==null?'':fmtSalary(e.annualSalary),{empty:'none on file'}),
        pf('Hourly equivalent',e.annualSalary==null?'':fmt$(Math.round(Number(e.annualSalary)/SALARY_HOURS_PER_YEAR*100)/100),{empty:'—'})
      ]);
    }
    return `
      <div class="pf-group"><div class="pf-group-title">Compensation</div>
        <div class="form-grid">
          <div class="form-group"><label class="form-label">Annual salary</label>
            <input type="text" id="profileSalaryInput" value="${esc(e.annualSalary==null?'':String(e.annualSalary))}"
              placeholder="105000" oninput="setProfileSalary(this.value)"></div>
          <div class="form-group" style="display:flex;align-items:flex-end">
            <div id="profileSalaryNote" style="font-size:12px;padding-bottom:9px">${profileSalaryNote()}</div></div>
        </div>
      </div>`;
  }

  // Hourly. Editable by anybody with app access — hourly rates are base tier in
  // permissions-lib.js, in both directions, and have been since the feed stopped
  // overwriting them.
  const rate=currentRate(e);
  if(!editing){
    return profileGroup('Compensation',[
      pf('Pay','Hourly'),
      // Passed as the VALUE, not as `empty`: pf() escapes `empty`, so markup
      // there renders as literal text. The flag has to be loud — a person with
      // no rate has every hour they work costed at zero, silently, in every
      // report.
      pf('Hourly rate',
         rate==null
           ? '<span style="color:var(--brick);font-weight:700">No rate on file — their hours cost $0 in every report until one is set</span>'
           : fmt$(rate),
         {html:true})
    ]);
  }
  // wage_history.employee_number is NOT NULL, so a person with no employee
  // number cannot have a rate recorded. The server refuses it; saying so here
  // beats a box that fails on Save.
  if(!canEditRate(e)){
    return profileGroup('Compensation',[
      pf('Pay','Hourly'),
      pf('Hourly rate',rate==null?'—':fmt$(rate)),
      pf('','<span style="color:#b8860b">Give this person an employee number before setting a rate — every rate change is recorded against it.</span>',{html:true})
    ]);
  }
  return `
    <div class="pf-group"><div class="pf-group-title">Compensation</div>
      <div class="form-grid">
        <div class="form-group"><label class="form-label">Hourly rate</label>
          <input type="text" id="profileRateInput" value="${esc(e.wage==null?'':String(e.wage))}"
            placeholder="24.50" oninput="setProfileRate(this.value)"></div>
        <div class="form-group" style="display:flex;align-items:flex-end">
          <div id="profileRateNote" style="font-size:12px;padding-bottom:9px">${profileRateNote()}</div></div>
      </div>
      <div style="font-size:11px;color:var(--muted);margin-top:4px">Every change is recorded in the rate history below, with who made it.</div>
    </div>`;
}

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

  const editing=profileEditing(e);
  const draft=(editing&&state.editing._pre)?state.editing._pre:null;
  const mine=preApprovedFor(id);

  const hoursOf=(type)=>draft
    ? String(draft[type]?draft[type].hours:'' )
    : (mine[type]?String(mine[type].hours):'');
  const descOf=(type)=>draft
    ? String(draft[type]?draft[type].description:'')
    : (mine[type]?(mine[type].description||''):'');

  const total=PREAPPROVED_TYPES.reduce((t,k)=>t+(Number(hoursOf(k))||0),0);

  const rows=PREAPPROVED_TYPES.map(type=>{
    const hours=hoursOf(type);
    const desc=descOf(type);
    const label=`<div style="font-size:11.5px;font-weight:600">${esc(type)}
        <div style="font-size:10px;color:var(--muted);font-weight:400">${esc(PREAPPROVED_TYPE_NOTE[type]||'')}</div></div>`;

    if(!editing){
      // Read mode. An allowance of zero is shown as 0, not as a dash: it means
      // "recorded and switched off", which is a different statement from "none".
      return `<div style="display:grid;grid-template-columns:104px 88px 1fr;gap:8px;align-items:center;padding:5px 0;border-bottom:1px solid var(--border)">
        ${label}
        <div style="font-size:11.5px;text-align:right;font-variant-numeric:tabular-nums">${hours===''?'<span style="color:var(--muted)">none</span>':fmtHrs(hours)}</div>
        <div style="font-size:11.5px;color:var(--muted)">${desc?esc(desc):(hours===''?'':'<em>no description</em>')}</div>
      </div>`;
    }

    return `<div style="display:grid;grid-template-columns:104px 88px 1fr;gap:8px;align-items:center;padding:5px 0;border-bottom:1px solid var(--border)">
      ${label}
      <input type="number" value="${esc(hours)}" min="0" max="40" step="0.25" placeholder="none"
        oninput="preDraftSet('${jsStr(type)}','hours',this.value)"
        style="font-family:var(--font);font-size:12px;border:1px solid var(--border);border-radius:4px;padding:4px 8px;width:100%">
      <input type="text" value="${esc(desc)}" placeholder="what the work is"
        oninput="preDraftSet('${jsStr(type)}','description',this.value)"
        style="font-family:var(--font);font-size:12px;border:1px solid var(--border);border-radius:4px;padding:4px 8px;width:100%">
    </div>`;
  }).join('');

  const grace=graceHrs();
  return `<div class="pf-group">
    <div class="pf-group-title">Pre-approved OT — standing weekly allowance</div>
    <div style="font-size:11px;color:var(--muted);line-height:1.5;margin-bottom:8px">
      Hours per WEEK, not per day, and the same figure applies to every week — there is no week column.
      The category says when the overtime happens; the description says what the work is, and it is the
      part a manager can argue with.
      ${editing?'<br><strong>Blank removes the allowance. Zero keeps it and switches it off</strong> — those are different statements, and the report counts them differently.':''}
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

// Updates the draft in place. Deliberately does NOT re-render: re-rendering on
// every keystroke would rebuild the inputs and move the caret to the end, which
// makes a description field unusable to type in. The draft is read at Save.
function preDraftSet(otType, field, value){
  if(!state.editing||!state.editing._pre) return;
  if(!state.editing._pre[otType]) state.editing._pre[otType]={hours:'',description:'',existed:false};
  state.editing._pre[otType][field]=value;
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
// A break time input.
//
// A <input type="time"> given a value it cannot represent renders BLANK, and the
// next save writes that blank back as though somebody had deliberately cleared
// the field. That is precisely the trap the birthday date picker hit on a live
// system, so the same escape hatch applies: an unreadable value gets a text box
// and a warning, and is preserved until a human retypes it.
//
// A readable value is shown in a time picker and comes back as 'HH:MM', which is
// exactly what gets stored — so the edit path needs no conversion at all.
function breakInput(label,field,value){
  const picker=timeInputValue(value);
  const raw=String(value==null?'':value).trim();
  const unreadable=raw!==''&&picker==='';

  if(unreadable){
    return `<div class="form-group full"><label class="form-label">${esc(label)}</label>
      <input type="text" value="${esc(raw)}" oninput="state.editing.${field}=this.value">
      <div style="font-size:11px;color:#b8860b;margin-top:4px;line-height:1.5">Not a time the picker can show, so it is left as text rather than blanked — blanking it would write the emptiness back as fact on the next save. Retype it as a time to get a picker.</div>
    </div>`;
  }
  return `<div class="form-group"><label class="form-label">${esc(label)}</label>
    <input type="time" value="${esc(picker)}" oninput="state.editing.${field}=this.value">
    <div style="font-size:11px;color:var(--muted);margin-top:4px">Leave blank for no break time on file. Blank is stored as nothing, not as a default.</div>
  </div>`;
}

// Schedule days.
//
// A select if the roster agrees on a small set of values, free text otherwise —
// decided from the DATA rather than assumed, because a select silently drops any
// value not in its option list, and on this field that would rewrite somebody's
// schedule the first time their profile was saved. SCHEDULE_DAYS holds the
// values found in the column; anything else keeps a text box and is offered as
// a suggestion via the datalist so the common values are still one click away.
function daysField(e){
  const current=String(e.days==null?'':e.days).trim();
  const known=SCHEDULE_DAYS.includes(current);
  const list=SCHEDULE_DAYS.map(d=>`<option value="${esc(d)}">`).join('');
  return `<div class="form-group"><label class="form-label">Schedule days</label>
    <input type="text" list="sched-days" value="${esc(current)}" oninput="state.editing.days=this.value">
    <datalist id="sched-days">${list}</datalist>
    ${(current!==''&&!known)?`<div style="font-size:11px;color:var(--muted);margin-top:4px">Not one of the values already on the roster. Kept as typed.</div>`:''}
  </div>`;
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
// No wage input and no annual_salary input, in either mode — and as of Phase D
// the roster's Edit modal has none either, so there is no longer anywhere in the
// app that types an hourly rate. That was the modal's last reason to exist as a
// separate field list; collapsing the two surfaces is what remains.
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
      <div class="form-group full" style="margin-top:-6px"><div style="font-size:11px;color:var(--muted);line-height:1.5">Compensation is not editable here. Both hourly rates and salaries are set on the <b>Salaries &amp; Wages</b> page, where every rate change is recorded. <b>Position group</b> is mill-floor only and is correctly “— none —” for office staff; <b>Position</b> applies to everyone.</div></div>

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

      ${daysField(e)}
      ${breakInput('Break 1','break1',e.break1)}
      ${breakInput('Break 2','break2',e.break2)}

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

// THE TWO EDIT SURFACES ARE NOW ONE. The roster's Edit opens the profile card
// in edit mode; it no longer opens a modal with its own field list.
//
// The modal existed because it was the only place an hourly wage could be set.
// Phase D removed that input, and with it the modal's last reason to be a second
// field list. The rate is editable again since 2026-08-22, but on Salaries &
// Wages — one surface, where the change is recorded, rather than back here.
//
// NOTHING IS LOST IN THE COLLAPSE, which was checked field by field rather than
// assumed. The card is a strict superset: it has everything the modal had, plus
// break times, the four address fields and the HR file link, and it offers the
// schedule as a select where the modal had a free-text box.
//
// The modal survives for ADD ALONE. A person who does not exist yet has no
// profile card to open, and the card reads state.employees by index.
function openEdit(idx){
  openProfile(idx);
  startProfileEdit();
}

// Every taxonomy field starts BLANK on a new employee — no cost class implied by a
// department, no department implied by a position group. Each is a decision about a
// real person, and a default that follows from another field is the coupling the v2
// model exists to remove.
// The one remaining caller of renderModal. state.profile stays null, which is
// what routes this to the modal rather than the card — see renderEmployees.
function openAdd(){state.profile=null;state.editing={name:'',wage:'',payType:'Hourly',empNum:'',department:'',costClass:'',positionGroup:'',position:'',status:'Active',days:'MON-THU',break1:'7:00 AM',break2:'12:45 PM',birthday:'',phone:'',language:'English',email:'',addressStreet:'',addressCity:'',addressState:'',addressPostalCode:'',smsOptedOut:false,_isNew:true};render();}
function closeModal(){state.editing=null;render();}


async function saveEdit(){
  const e={...state.editing};const idx=e._idx;const isNew=e._isNew;
  delete e._idx;delete e._isNew;

  setSyncStatus('saving');
  try{
    // WAGE IS WRITTEN FROM HERE NOW, and that is a reversal of the note this
    // comment replaced. It said the rate belonged on Salaries & Wages because
    // that was the one surface recording the change in wage_history. That page
    // is retired and this card is that surface — /api/data writes the history
    // row before it touches employees.wage, so the guarantee moved with the
    // input rather than being dropped with the page.
    //
    // Pay type still decides which figure is sent. Flipping to Salaried does not
    // null the rate: isSalaried() reads pay_type first, so a leftover value
    // cannot be mistaken for theirs.
    const payType = isSalaried(e) ? 'Salaried' : 'Hourly';
    e.payType = payType;

    const row={
      name:e.name, pay_type:payType, status:e.status,
      // clock_in / clock_out are no longer written; see the note in the form.
      days:e.days,
      // Normalized, preserved or null — never a fabricated default. See
      // breakStorageValue in core.js.
      break_1:breakStorageValue(e.break1), break_2:breakStorageValue(e.break2),
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

    // ---- compensation, added to the row only when this save may set it ----
    //
    // An hourly rate goes only for an hourly person, and only when it parses to
    // a real number. An unparseable or cleared box is left OUT of the request
    // rather than sent: the server refuses both (409, see wage-edit-lib) and
    // sending them would fail the whole save — including the name change the
    // person actually came here to make. The live note beside the input already
    // says why nothing will be written.
    //
    // Sending an UNCHANGED rate is harmless and deliberate: planWageEdit
    // compares against the database row and drops it, so no history row is
    // written for a rate that did not move.
    if(payType==='Hourly'&&canEditRate(e)){
      const rate=parseRate(e.wage);
      if(typeof rate==='number') row.wage=String(rate);
    }

    // The salary goes only for an account holding the tier. This is the
    // COSMETIC half of that gate and is documented as such: data.js returns 403
    // naming the column for anybody else, whatever the browser sends. It is here
    // so a non-tier user's save of a salaried person's phone number does not
    // fail on a column they were never shown.
    if(payType==='Salaried'&&canSeeSalaries()){
      const salary=parseSalary(e.annualSalary);
      if(salary!==undefined) row.annual_salary=salary;
    }

    if(e.id){
      const res=await writeEmployeeRow('/api/data?table=employees&id='+e.id,'PATCH',row);
      if(!res.ok) throw new Error(`Save failed with status ${res.status}`);
    } else {
      const res=await writeEmployeeRow('/api/data?table=employees','POST',row);
      if(!res.ok) throw new Error(`Save failed with status ${res.status}`);
      const d=await res.json();
      if(d.data?.[0]?.id) e.id=d.data[0].id;
    }

    // ---- the employee row is committed. Now the two other tables. ----
    //
    // ONE BUTTON, THREE WRITES, so partial failure is possible where it was not
    // before. It is reported precisely: the card stays open, the message names
    // which part did not commit, and nothing claims success. Silently reporting
    // "Saved" after two of three writes landed is how somebody walks away
    // believing an allowance was recorded.
    //
    // The employee row goes first because it is what the card is about, and
    // because the allocation's foreign key needs a saved employee to point at.
    // Its failure aborts before anything else is attempted (the throw above).
    const problems=[];
    if(state.profile!==null && e.id){
      if(state.editing&&state.editing._pre){
        const pre=await preApprovedCommit(e.id, state.editing._pre);
        if(!pre.ok) problems.push('Pre-approved OT — '+pre.failures.join('; '));
      }
      const alloc=await allocCommit(e.id);
      if(!alloc.ok) problems.push('Cost allocation — '+alloc.error);
      // Re-read both, so the card shows what the database now holds rather than
      // what the draft hoped for. Done even on failure, for the same reason.
      await loadPreApproved();
      await loadAllocations();
    }

    if(isNew)state.employees.push(e);else state.employees[idx]=e;

    if(problems.length){
      // The employee row DID save. Say so, then say what did not — the opposite
      // order would read as a total failure and invite a retry that re-writes
      // the part that already worked.
      setSyncStatus('error');
      toast('Employee details saved. NOT saved: '+problems.join(' | '),'error');
      render();
      return;
    }

    state.editing=null;
    if(e.id&&state.allocDrafts) delete state.allocDrafts[String(e.id)];
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

// THE ADD FORM. Not an edit surface any more: openEdit() opens the profile card,
// so this is reached only from openAdd(). The title is fixed rather than
// conditional, because the branch that said "Edit — <name>" had no way of being
// reached and a dead branch reads as a live one.
//
// It is deliberately NOT the card. A person who does not exist yet has no card
// to open — the card reads state.employees by index — and the three sections
// the card carries beyond the roster row (pre-approved OT, cost allocation, the
// HR file link) all need a saved employee id to point at.
function renderModal(){
  const e=state.editing;
  // Asked once, through the shared predicate, so the disabled state of the wage
  // field and the note under it cannot disagree with the select above them.
  const salariedHere=isSalaried(e);
  return `
    <div class="modal-bg" onclick="if(event.target===this)closeModal()">
      <div class="modal">
        <div class="modal-title" style="padding:20px 28px 0;flex-shrink:0">
          <span>Add employee</span>
          <button class="close-btn" onclick="closeModal()">×</button>
        </div>

        <div class="modal-body">
        <div id="modal-details-pane">
        <div class="form-grid">
          <div class="form-group full"><label class="form-label">Full name</label><input type="text" value="${e.name}" oninput="state.editing.name=this.value"></div>
          <div class="form-group"><label class="form-label">Pay type</label><select onchange="setPayType(this.value)">
            ${PAY_TYPES.map(t=>`<option value="${t}" ${payTypeOf(e)===t?'selected':''}>${t}</option>`).join('')}
          </select></div>
          <!-- READ-ONLY, and deliberately not an input. The column IS writable now, by
               anybody signed in — but on Salaries & Wages, which is the surface that
               records every change in wage_history. A second box here would let a rate
               move as a side effect of editing somebody's phone number, and the history
               row would say it was a rate change. The value is still SHOWN, because
               "what is this person paid" is a fair question to ask of an employee
               record. -->
          <div class="form-group"><label class="form-label">Hourly wage ($/hr)</label>
            <div style="padding:8px 0;font-size:13px;color:var(--text)">${esc(fmtWage(e))}</div></div>
          <div class="form-group full" style="margin-top:-6px"><div style="font-size:11px;color:var(--muted);line-height:1.5">${salariedHere?'A salaried person has no hourly rate. Their salary is entered on the Salaries &amp; Wages page.':'Hourly rates are not editable here. They are set on the <b>Salaries &amp; Wages</b> page, where every change is recorded in wage history.'}</div></div>
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
