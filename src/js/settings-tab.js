// settings-tab — the Settings tab: a container with two views.
//
//   General      manager recipients, OT budget, clock grace, taxonomy values and
//                the admin Access section. The load/save of the settings row
//                itself lives in data.js.
//   Daily Hours  the payroll import — manual .xlsx upload with
//                preview-before-commit, imported-day history, department
//                re-stamping and the email pipeline's issue queue. It moved here
//                from the Overtime tab on 2026-09-15.
//
// WHY DAILY HOURS IS SETTINGS AND NOT A REPORT. It is the one screen that puts
// data IN rather than reading it out: a file arrives, a human checks a preview,
// and a day is committed or re-stamped. That is administration of the data the
// Overtime tab reports on. It led the Overtime sub-nav on the argument that it
// is the first step of the same job, and moving it here follows that argument
// rather than abandoning it — the step before the work is not the work.
//
// Nothing about the view itself changed. renderDailyHours() and its loaders are
// untouched in daily-hours.js; only the container that draws it moved, which is
// what keeps the upload path — the part with a commit in it — out of this
// change entirely.
//
// Shares one global scope with the other files in src/js (see core.js).

async function addManager(){
  const input=document.getElementById('newManagerEmail');
  const email=input.value.trim();
  if(!email){toast('Please enter a valid email','error');return;}
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){toast('Invalid email format','error');return;}
  if(state.emailSettings.managers.includes(email)){toast('This email is already added','warning');return;}
  state.emailSettings.managers.push(email);
  // The success toast is BEHIND the save, not beside it. This list is who
  // receives a report carrying per-person dollars; "Manager added and saved"
  // after a refusal is the worst sentence this page could produce.
  if(!await saveEmailSettings()) return;
  input.value='';
  render();
  toast('Manager added and saved','success');
}

// The clock-grace rate. Every hourly employee may clock in 7.5 minutes early and
// out 7.5 minutes late, which accrues to half an hour a week; that time is
// compensable under California law and cannot be rounded away, so it counts as
// pre-approved OT. It lives here rather than in the source because at ~54 hourly
// employees it is worth ~27 hrs/week — far too material to be a constant nobody
// can see. The report reads this value server-side from the same settings row.
async function setGraceHours(v){
  const n=Number(v);
  if(!isFinite(n)||n<0||n>8){toast('Enter the grace allowance in hours per employee per week, between 0 and 8','error');render();return;}
  state.emailSettings.graceHoursPerEmployee=Math.round(n*100)/100;
  if(!await saveEmailSettings()) return;
  if(state.otReportWeek) await loadOTReport(state.otReportWeek);
  render();
  toast('Timeclock grace saved','success');
}

async function setOTBudgetPercent(v){
  const n=Number(v);
  if(!isFinite(n)||n<0||n>100){toast('Enter the OT budget as a percentage between 0 and 100','error');render();return;}
  state.emailSettings.otBudgetPercent=Math.round(n*10)/10;
  if(!await saveEmailSettings()) return;
  render();
  toast('OT budget saved','success');
}

async function removeManager(idx){
  state.emailSettings.managers.splice(idx,1);
  if(!await saveEmailSettings()) return;
  render();
  toast('Manager removed','success');
}

// EVERY CONTROL BELOW IS ADMIN-ONLY, and the page does not offer the ones it
// cannot save.
//
// /api/settings refuses a POST from anybody without the admin tier, above any
// parsing or database access. That is the gate. This is the courtesy: a field
// that looks live and 403s on save teaches people the app is broken, and a
// checkbox that flips back is worse than one that never moved.
//
// So a non-admin sees the same figures, rendered as text with a line saying who
// can change them. The values are not hidden — they are on every report that
// uses them, and hiding the settings that produce them would make those reports
// less legible while protecting nothing.
const canEditSettings = () => isPermAdmin();

// A read-only figure, styled to sit where its input would have been.
const settingValue = (text) =>
  `<div style="padding:8px 0;font-size:13px;font-weight:600;color:var(--text)">${esc(String(text))}</div>`;

// THE SETTINGS ON THIS PAGE ARE NOT BEING SAVED — said on the page, because
// that is where somebody will read it.
//
// This banner exists because of a fault it would have caught in a day.
// public.settings was never created: /api/settings caught its own missing-table
// error and answered a cheerful 200, saveEmailSettings cached the write in
// localStorage and reported success, and loadEmailSettings read that copy back
// on the next load. So the page showed a manager list, said "saved", kept it
// across reloads — and the server had nothing, which meant the Monday OT email
// had no recipients and refused to send. For months. The only complaint in the
// whole system was that email's own alert.
//
// TWO DIFFERENT SENTENCES, because they need different actions:
//
//   unavailable   the settings row could not be READ. Nothing here can save
//                 until that is fixed, and the figures shown are defaults.
//   localOnly     it read, but what is on screen is a write the server never
//                 took. It lives in this browser and nowhere else.
//
// Both are warnings rather than refusals: the controls stay usable, because an
// outage is usually transient and re-typing a recipient list is worse than
// waiting. What must not happen is the page looking healthy while it is not.
function renderSettingsWarning(){
  if(state.settingsUnavailable){
    return `
      <div style="background:var(--surface);border:1px solid var(--brick);border-radius:8px;padding:20px;margin-bottom:24px">
        <div style="font-size:14px;font-weight:700;color:var(--brick);margin-bottom:8px">
          ⚠ These settings are not being saved — the settings row could not be read
        </div>
        <div style="font-size:12px;color:var(--muted);line-height:1.6">
          The values below are the app's defaults, not what is stored, and anything changed here
          will not reach the database. The weekly manager OT email reads the same row, so it will
          refuse to send until this is fixed. The reason given was:
          <div style="font-family:var(--mono,monospace);font-size:11px;color:var(--text);background:var(--surface2);border-radius:4px;padding:8px 10px;margin-top:8px;word-break:break-word">${esc(state.settingsUnavailableReason||'no reason given')}</div>
        </div>
      </div>`;
  }
  if(state.settingsLocalOnly){
    return `
      <div style="background:var(--surface);border:1px solid #b8860b;border-radius:8px;padding:20px;margin-bottom:24px">
        <div style="font-size:14px;font-weight:700;color:#b8860b;margin-bottom:8px">
          ⚠ Showing changes this browser holds and the server does not
        </div>
        <div style="font-size:12px;color:var(--muted);line-height:1.6">
          A save did not reach the database, so what you see below is kept locally on this machine.
          Nobody else's app has it, and the weekly manager OT email reads the server's copy, not this
          one. <b>Change any value and save again</b> to push it; a successful save clears this.
        </div>
      </div>`;
  }
  return '';
}

function renderSettings(){
  const editable=canEditSettings();
  return `
    <div style="max-width:800px;margin:0 auto;padding:20px">
      <h2 style="font-size:24px;font-weight:700;margin-bottom:32px;color:var(--text)">Settings</h2>

      ${renderSettingsWarning()}
      ${renderPermsError()}
      ${renderAccessSection()}

      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:24px;margin-bottom:24px">
        <div style="display:flex;align-items:baseline;gap:12px;margin-bottom:20px">
          <div style="font-size:16px;font-weight:700">📧 Email Notifications</div>
          ${editable?'':'<div style="font-size:12px;color:var(--muted)">read-only</div>'}
        </div>

        ${editable?'':`
        <div style="font-size:12px;color:var(--muted);line-height:1.6;margin-bottom:20px;padding:12px;background:var(--surface2);border-radius:4px">
          These settings decide what the weekly OT report says and who receives it, so only an
          administrator may change them. The recipient list is the one that matters most: that
          report carries what every hourly employee was paid.
        </div>`}

        <div style="margin-bottom:20px">
          ${editable?`
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none">
            <input type="checkbox" ${state.emailSettings.autoSend?'checked':''} onchange="state.emailSettings.autoSend=this.checked;saveEmailSettings();render()" style="width:18px;height:18px;cursor:pointer;accent-color:var(--accent)">
            <span style="font-size:14px;font-weight:600">Email the completed week to managers every Monday morning</span>
          </label>`:`
          <div style="font-size:14px;font-weight:600">Email the completed week to managers every Monday morning — ${
            state.emailSettings.autoSend?'<span style="color:#4A7C59">on</span>':'<span style="color:var(--muted)">off</span>'}</div>`}
          <div style="font-size:12px;color:var(--muted);margin-top:6px;${editable?'margin-left:26px':''}">Every Monday mid-morning, the Mon–Sun week that just finished is emailed to every manager below — after Sunday’s hours have arrived. A week missing a day is not sent at all; the alert address is told why instead. You can send any week by hand at any time from the OT Report tab.</div>
        </div>

        <div style="margin-bottom:20px">
          <div style="font-size:13px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">OT Budget</div>
          <div style="display:flex;align-items:center;gap:8px">
            ${editable?`<input type="number" min="0" max="100" step="0.1" value="${otBudgetPct()}" onchange="setOTBudgetPercent(this.value)" style="width:90px;font-family:var(--font);font-size:13px;border:1px solid var(--border);border-radius:4px;padding:8px 10px">`:settingValue(otBudgetPct())}
            <span style="font-size:13px;color:var(--muted)">% of hourly payroll</span>
          </div>
          <div style="font-size:12px;color:var(--muted);margin-top:6px">The emailed report flags all-in OT as over or under budget against this number. Default ${OT_BUDGET_DEFAULT}%.</div>
        </div>

        <div style="margin-bottom:20px">
          <div style="font-size:13px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Timeclock Grace</div>
          <div style="display:flex;align-items:center;gap:8px">
            ${editable?`<input type="number" min="0" max="8" step="0.05" value="${graceHrs()}" onchange="setGraceHours(this.value)" style="width:90px;font-family:var(--font);font-size:13px;border:1px solid var(--border);border-radius:4px;padding:8px 10px">`:settingValue(graceHrs())}
            <span style="font-size:13px;color:var(--muted)">hours per employee per week</span>
          </div>
          <div style="font-size:12px;color:var(--muted);margin-top:6px">Employees may clock in 7.5 minutes early and out 7.5 minutes late. That time is compensable and cannot be rounded away, so it is pre-approved OT and is added to the Overtime table's allowance on the OT Report. Counted for every active hourly employee on the roster, whether or not they worked. Default ${EMAIL_SETTINGS_DEFAULTS.graceHoursPerEmployee} hrs — at the current roster that is about ${fmtHrs(graceHrs()*(state.employees||[]).filter(e=>e.status==='Active'&&!isSalaried(e)).length)} hrs a week.</div>
        </div>

        <div style="margin-top:24px">
          <div style="font-size:13px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px">Manager Recipients</div>
          ${editable?`
          <div style="display:flex;gap:8px;margin-bottom:16px">
            <input type="email" id="newManagerEmail" placeholder="manager@company.com" style="flex:1;font-family:var(--font);font-size:13px;border:1px solid var(--border);border-radius:4px;padding:8px 12px">
            <button class="btn btn-primary btn-sm" onclick="addManager()" style="padding:8px 16px">+ Add Manager</button>
          </div>`:''}

          ${state.emailSettings.managers.length > 0 ? `
            <div class="table-wrap">
              <table>
                <thead><tr><th>Email Address</th><th style="width:50px">${editable?'Action':''}</th></tr></thead>
                <tbody>
                  ${state.emailSettings.managers.map((email,i)=>`<tr>
                    <td style="font-size:13px;padding:12px">${esc(email)}</td>
                    <td style="text-align:center;padding:12px">${editable?`<button class="btn btn-sm" style="background:none;border:1px solid var(--border);color:var(--muted);padding:4px 8px;cursor:pointer" onclick="removeManager(${i})">Remove</button>`:'<span style="font-size:12px;color:var(--muted)">—</span>'}</td>
                  </tr>`).join('')}
                </tbody>
              </table>
            </div>
          ` : `
            <div style="font-size:13px;color:var(--muted);padding:16px;background:var(--surface2);border-radius:4px;text-align:center">
              ${editable?'No managers configured yet. Add email addresses above to receive OT reports.':'Nobody is on the recipient list, so the weekly report is not being emailed to anyone.'}
            </div>
          `}
        </div>
      </div>
    </div>
  `;
}

// ------------------------------------------------------------------------
// the container
// ------------------------------------------------------------------------
//
// Same shape as OVERTIME_VIEWS: a list, each entry owning its own lazy `load`,
// fired both by the sub-nav switcher and by switchTab() for the view that is
// already selected. A load hook that lived in switchTab() keyed on a tab name
// stops firing the moment that tab becomes a sub-view, which is the bug this
// shape exists to prevent — Daily Hours has now been on both sides of it.
//
// NO TIER ON EITHER VIEW, and that is not an oversight. The General page is
// already self-gating: /api/settings refuses a write from anybody without the
// admin tier and the page renders read-only for them, while the Access section
// is absent rather than disabled. Daily Hours is open to everybody signed in,
// exactly as it was under Overtime — moving a screen must not quietly change
// who may open it.
const SETTINGS_VIEWS = [
  { key: 'general', label: 'General', render: () => renderSettings() },
  {
    key: 'dailyhours',
    label: 'Daily Hours',
    render: () => renderDailyHours(),
    load: () => { if (!state.dailyLoaded && !state.dailyLoading) loadDailyDays(); }
  }
];

function settingsSubView(key) {
  return SETTINGS_VIEWS.find(v => v.key === key) || SETTINGS_VIEWS[0];
}

function switchSettingsView(key) {
  const view = settingsSubView(key);
  state.settingsView = view.key;
  render();
  if (view.load) view.load();
}

// Deep link: goToSettings('dailyhours') opens Settings on the import. This is
// what the OT Report's "Daily Hours" and "Re-stamp departments" buttons call —
// they used goToOvertime('dailyhours') until the view moved, and a deep link
// left pointing at a view that no longer exists resolves to the first one in
// the list, which would have been a silent wrong answer rather than an error.
function goToSettings(key) {
  state.settingsView = settingsSubView(key).key;
  goToTab('settings');
}

function renderSettingsTab() {
  const active = settingsSubView(state.settingsView);
  const nav = SETTINGS_VIEWS.map(v =>
    `<button class="doc-tab ${v.key === active.key ? 'active' : ''}"
             onclick="switchSettingsView('${v.key}')">${esc(v.label)}</button>`
  ).join('');
  return `<div class="doc-tabs">${nav}</div>${active.render()}`;
}
