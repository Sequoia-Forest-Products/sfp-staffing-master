// settings-tab — the Settings tab: manager recipients, OT budget and clock grace.
// The load/save of the settings row itself lives in data.js.
//
// Shares one global scope with the other files in src/js (see core.js).

async function addManager(){
  const input=document.getElementById('newManagerEmail');
  const email=input.value.trim();
  if(!email){toast('Please enter a valid email','error');return;}
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){toast('Invalid email format','error');return;}
  if(state.emailSettings.managers.includes(email)){toast('This email is already added','warning');return;}
  state.emailSettings.managers.push(email);
  await saveEmailSettings();
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
  await saveEmailSettings();
  if(state.otReportWeek) await loadOTReport(state.otReportWeek);
  render();
  toast('Timeclock grace saved','success');
}

async function setOTBudgetPercent(v){
  const n=Number(v);
  if(!isFinite(n)||n<0||n>100){toast('Enter the OT budget as a percentage between 0 and 100','error');render();return;}
  state.emailSettings.otBudgetPercent=Math.round(n*10)/10;
  await saveEmailSettings();
  render();
  toast('OT budget saved','success');
}

async function removeManager(idx){
  state.emailSettings.managers.splice(idx,1);
  await saveEmailSettings();
  render();
  toast('Manager removed','success');
}

function renderSettings(){
  return `
    <div style="max-width:800px;margin:0 auto;padding:20px">
      <h2 style="font-size:24px;font-weight:700;margin-bottom:32px;color:var(--text)">Settings</h2>

      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:24px;margin-bottom:24px">
        <div style="font-size:16px;font-weight:700;margin-bottom:20px">📧 Email Notifications</div>

        <div style="margin-bottom:20px">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none">
            <input type="checkbox" ${state.emailSettings.autoSend?'checked':''} onchange="state.emailSettings.autoSend=this.checked;saveEmailSettings();render()" style="width:18px;height:18px;cursor:pointer;accent-color:var(--accent)">
            <span style="font-size:14px;font-weight:600">Auto-send the weekly OT report after a Daily Hours import</span>
          </label>
          <div style="font-size:12px;color:var(--muted);margin-top:6px;margin-left:26px">When a day is imported on the Daily Hours tab, the whole Mon–Sun week it belongs to is reloaded and emailed to every manager below. You can also send it by hand from the OT Report tab.</div>
        </div>

        <div style="margin-bottom:20px">
          <div style="font-size:13px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">OT Budget</div>
          <div style="display:flex;align-items:center;gap:8px">
            <input type="number" min="0" max="100" step="0.1" value="${otBudgetPct()}" onchange="setOTBudgetPercent(this.value)" style="width:90px;font-family:var(--font);font-size:13px;border:1px solid var(--border);border-radius:4px;padding:8px 10px">
            <span style="font-size:13px;color:var(--muted)">% of hourly payroll</span>
          </div>
          <div style="font-size:12px;color:var(--muted);margin-top:6px">The emailed report flags all-in OT as over or under budget against this number. Default ${OT_BUDGET_DEFAULT}%.</div>
        </div>

        <div style="margin-bottom:20px">
          <div style="font-size:13px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Timeclock Grace</div>
          <div style="display:flex;align-items:center;gap:8px">
            <input type="number" min="0" max="8" step="0.05" value="${graceHrs()}" onchange="setGraceHours(this.value)" style="width:90px;font-family:var(--font);font-size:13px;border:1px solid var(--border);border-radius:4px;padding:8px 10px">
            <span style="font-size:13px;color:var(--muted)">hours per employee per week</span>
          </div>
          <div style="font-size:12px;color:var(--muted);margin-top:6px">Employees may clock in 7.5 minutes early and out 7.5 minutes late. That time is compensable and cannot be rounded away, so it is pre-approved OT and is added to the Overtime table's allowance on the OT Report. Counted for every active hourly employee on the roster, whether or not they worked. Default ${EMAIL_SETTINGS_DEFAULTS.graceHoursPerEmployee} hrs — at the current roster that is about ${fmtHrs(graceHrs()*(state.employees||[]).filter(e=>e.status==='Active'&&!isSalaried(e)).length)} hrs a week.</div>
        </div>

        <div style="margin-top:24px">
          <div style="font-size:13px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px">Manager Recipients</div>
          <div style="display:flex;gap:8px;margin-bottom:16px">
            <input type="email" id="newManagerEmail" placeholder="manager@company.com" style="flex:1;font-family:var(--font);font-size:13px;border:1px solid var(--border);border-radius:4px;padding:8px 12px">
            <button class="btn btn-primary btn-sm" onclick="addManager()" style="padding:8px 16px">+ Add Manager</button>
          </div>

          ${state.emailSettings.managers.length > 0 ? `
            <div class="table-wrap">
              <table>
                <thead><tr><th>Email Address</th><th style="width:50px">Action</th></tr></thead>
                <tbody>
                  ${state.emailSettings.managers.map((email,i)=>`<tr>
                    <td style="font-size:13px;padding:12px">${email}</td>
                    <td style="text-align:center;padding:12px"><button class="btn btn-sm" style="background:none;border:1px solid var(--border);color:var(--muted);padding:4px 8px;cursor:pointer" onclick="removeManager(${i})">Remove</button></td>
                  </tr>`).join('')}
                </tbody>
              </table>
            </div>
          ` : `
            <div style="font-size:13px;color:var(--muted);padding:16px;background:var(--surface2);border-radius:4px;text-align:center">
              No managers configured yet. Add email addresses above to receive OT reports.
            </div>
          `}
        </div>
      </div>
    </div>
  `;
}
