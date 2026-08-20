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

function renderEmployees(){
  const active=state.employees.filter(e=>e.status==='Active');
  const en=active.filter(e=>e.language==='English').length;
  const es=active.filter(e=>e.language==='Spanish').length;
  // Staffed PRODUCTION departments, out of the six — not out of all seven assignable
  // values. A card reading "5 of 7" while two production departments sit empty would
  // be misleading if SG&A were silently making up the difference, so the
  // non-production bucket is counted and labelled on its own instead.
  const deptCount=PRODUCTION_DEPARTMENTS.filter(d=>state.employees.some(e=>e.department===d)).length;
  const nonProd=active.filter(e=>e.department===NON_PRODUCTION_DEPARTMENT).length;
  // SG&A is assigned, so it is not in this number.
  const noDept=active.filter(e=>!hasDepartment(e.department)).length;
  const filtered=getFiltered();
  return `
    <div class="stat-row">
      <div class="stat-card"><div class="stat-label">Active headcount</div><div class="stat-value">${active.length}</div><div class="stat-sub">of ${state.employees.length} total</div></div>
      <div class="stat-card"><div class="stat-label">English speakers</div><div class="stat-value">${en}</div><div class="stat-sub">${es} Spanish</div></div>
      <div class="stat-card"><div class="stat-label">Departments staffed</div><div class="stat-value">${deptCount}</div><div class="stat-sub">of ${PRODUCTION_DEPARTMENTS.length} production · ${nonProd} active in ${esc(NON_PRODUCTION_DEPARTMENT)} · ${noDept} active unassigned</div></div>
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
      <!-- The assignable set, so SG&A is filterable: it is a real assignment people
           will want to pull up, and it is NOT the same thing as unassigned. Both the
           option value and its label go through esc() — SG&A has an ampersand in it,
           and the value that comes back off this select is the raw 'SG&A'. -->
      <select onchange="state.filterDept=this.value;renderEmployeeList()">
        <option value="all" ${state.filterDept==='all'?'selected':''}>All departments</option>
        ${PAYROLL_DEPARTMENTS.map(d=>`<option value="${esc(d)}" ${state.filterDept===d?'selected':''}>${esc(d)}</option>`).join('')}
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
          ${['name','wage','department','status','language','days','phone'].map(col=>{
            const labels={name:'Name',wage:'Wage/hr',department:'Department',status:'Status',language:'Lang',days:'Schedule',phone:'Phone'};
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
              <td>${fmtWage(e.wage)}</td>
              <td${e.department?'':' style="color:var(--muted)"'}>${e.department?esc(e.department):'—'}</td>
              <td><span class="badge ${e.status==='Active'?'active':'inactive'}">${e.status||'—'}</span></td>
              <td><span class="badge ${e.language==='Spanish'?'es':'en'}">${e.language==='Spanish'?'ES':'EN'}</span></td>
              <td style="color:var(--muted);font-size:11px">${e.days||'—'}</td>
              <td style="color:var(--muted);font-size:11px">${e.phone||'—'}</td>
              <td>${smsCell(e)}</td>
              <td><button class="btn btn-outline btn-sm" onclick="openEdit(${state.employees.indexOf(e)})">Edit</button></td>
            </tr>`).join(''):
            '<tr><td colspan="9" style="text-align:center;color:var(--muted);padding:32px">No employees match</td></tr>'}
        </tbody>
      </table>
    </div>
    ${state.editing!==null?renderModal():''}
  `;
}

function formatWageInput(input) {
  const val = input.value.trim();
  if (!val || val.toLowerCase() === 'salary') {
    input.value = 'Salary';
    state.editing.wage = 'Salary';
    return;
  }
  const num = parseFloat(val.replace(/[$,]/g, ''));
  if (!isNaN(num)) {
    const formatted = '$' + num.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
    input.value = formatted;
    state.editing.wage = num;
  }
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
  const depts = [...new Set(active.map(e => e.department).filter(Boolean))].length;
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
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--muted);padding:32px">No employees match</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(e => {
    const idx = state.employees.indexOf(e);
    return `<tr>
      <td style="font-weight:600">${e.name}</td>
      <td>${e.wage||'—'}</td>
      <td style="color:${e.department?'var(--text)':'var(--muted)'}">${e.department?esc(e.department):'—'}</td>
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

function openAdd(){state.editing={name:'',wage:'',empNum:'',department:'',status:'Active',days:'MON-THU',clockIn:'4:55 AM',clockOut:'3:35 PM',break1:'7:00 AM',break2:'12:45 PM',birthday:'',phone:'',language:'English',email:'',smsOptedOut:false,_isNew:true};render();}
function closeModal(){state.editing=null;render();}


async function saveEdit(){
  const e={...state.editing};const idx=e._idx;const isNew=e._isNew;
  delete e._idx;delete e._isNew;

  setSyncStatus('saving');
  try{
    // Normalize wage: convert formatted string to number if needed
    let wage = e.wage;
    if(typeof wage === 'string'){
      if(wage.toLowerCase() === 'salary'){
        wage = 'Salary';
      } else {
        wage = parseFloat(wage.replace(/[$,]/g,'')) || wage;
      }
    }
    e.wage = wage; // Update the editing object with normalized wage

    const row={
      name:e.name, wage:wage, status:e.status,
      days:e.days, clock_in:e.clockIn, clock_out:e.clockOut,
      break_1:e.break1||'7:00 AM', break_2:e.break2||'12:45 PM',
      birthday:e.birthday, phone:e.phone, language:e.language,
      email:e.email, sms_opted_out:e.smsOptedOut===true,
      drive_folder_id:e.driveFolderId||null,
      employee_number:normEmpNum(e.empNum)||null, department:e.department||null
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
          <div class="form-group"><label class="form-label">Wage ($/hr or Salary)</label><input type="text" value="${e.wage}" id="wageInput"
            oninput="state.editing.wage=this.value"
            onblur="formatWageInput(this)"></div>
          <div class="form-group"><label class="form-label">Employee # (payroll)</label><input type="text" value="${e.empNum||''}" placeholder="0319" oninput="state.editing.empNum=this.value" onchange="this.value=normEmpNum(this.value);state.editing.empNum=this.value"></div>
          <div class="form-group"><label class="form-label">Department</label><select onchange="state.editing.department=this.value">
            <option value="" ${e.department?'':'selected'}>— not set —</option>
            ${PAYROLL_DEPARTMENTS.map(d=>`<option value="${esc(d)}" ${e.department===d?'selected':''}>${esc(d)}</option>`).join('')}
          </select></div>
          <div class="form-group full" style="margin-top:-6px"><div style="font-size:11px;color:var(--muted);line-height:1.5">Employee # and Department drive the daily hours import and the OT report. Department is never filled in automatically — it is set here, one employee at a time. Office, admin and other salaried staff belong in ${esc(NON_PRODUCTION_DEPARTMENT)}: it is a real assignment, not a blank, and it is never filled in for you.</div></div>
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
