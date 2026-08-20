// core — shared state, constants, formatting/DOM helpers and the tab dispatcher.
//
// Every file in src/js is a plain classic script, not an ES module. They are
// concatenated in manifest order by netlify/functions/session.js and served as
// ONE inline script tag, so they share a single global scope: the inline on*
// handlers throughout app.html call these functions by bare name, and module
// scope would break every one of them. Nothing here is exported or imported.
//
// This file comes first in the manifest and holds everything the feature files
// share, so nothing is duplicated: `state`, the department taxonomy, the date
// and money formatters, esc/jsStr, toast, and switchTab/goToTab/render.

const user = window.__SFP_USER__ || {};
document.getElementById('userName').textContent = user.name || user.email || '';
if (user.picture) document.getElementById('userAvatar').src = user.picture;

// The full shape of the emailSettings row. loadEmailSettings merges the stored
// row over these rather than replacing state wholesale: settings.js stores one
// JSON blob, so a row written before a field existed simply lacks it, and a
// straight assignment would drop the field from state — after which the next
// save writes the row back without it. That is how editing the manager list
// would silently wipe the configured grace hours and revert the report to its
// default without saying anything.
const EMAIL_SETTINGS_DEFAULTS={managers:[], autoSend:false, otBudgetPercent:10, graceHoursPerEmployee:0.5};

// settings.js writes value as a raw object on insert and as a JSON string on
// update, so both shapes come back from the same key.
function parseSettingsValue(v){
  if(typeof v==='string'){try{return JSON.parse(v);}catch{return null;}}
  return v&&typeof v==='object'?v:null;
}

let state = {
  tab:'employees', employees:[], economics:[],
  ot:{post:[],weekend:[],pre:[]}, points:[],
  filterName:'', filterDept:'all', filterStatus:'Active',
  editing:null, dirty:false, loading:true, otEditing:false, ptEditing:false,
  sortCol:'name', sortDir:'asc',
  burden:0.44, mhr:15.0,
  emailSettings:{...EMAIL_SETTINGS_DEFAULTS},
  otEmailSending:false,
  dailyWorkDate:'', dailyPreview:null, dailyPreviewFile:null, dailyDupAck:false, dailyLastImport:null,
  dailyDays:[], dailyFrom:'', dailyTo:'', dailyLoading:false, dailyLoaded:false,
  dailyBusy:false, dailyPending:null, restampFrom:'', restampTo:'', restampResult:null,
  otReport:null, otReportWeeks:[], otReportWeek:'', otReportLoading:false, otReportError:'',
  otReportTruncated:false, otReportWindow:null,
  otSortCol:'netOtDollars', otSortDir:'desc', otDayDept:'all', otOpenDays:{}
};

function fmt$(n){return n==null?'—':'$'+Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});}
// Reads the salaried marker through isSalaried so the roster and Staffing
// Economics cannot disagree about the same employee: a lowercase 'salary'
// used to render as $NaN here while being correctly excluded there. A blank
// wage is unknown, not salaried — it used to display as 'Salary', which made a
// half-entered new hire look like staff they are not.
function fmtWage(w){
  if(isSalaried({wage:w}))return 'Salary';
  const n=parseFloat(String(w==null?'':w).replace(/[$,]/g,''));
  return isNaN(n)?'—':('$'+n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}));
}

// employees.wage holds the literal 'Salary' for salaried staff instead of a rate
// — the same literal fmtWage and formatWageInput key on. Compared trimmed and
// case-insensitively because the edit form only normalizes casing on blur.
function isSalaried(emp){return String((emp&&emp.wage)||'').trim().toLowerCase()==='salary';}

// ============================================================
// PAYROLL SHARED HELPERS
// ============================================================

// The department taxonomy, used by both the roster and payroll reporting. The
// legacy employees.dept column (Sawmill / Filing Room / Log Yard / SG&A) is retired;
// department is assigned by hand per employee on the Employees tab.
//
// TWO lists, deliberately different sizes — do not "fix" them into one:
//   PRODUCTION_DEPARTMENTS — the six production cost centres. This is the list to
//     count and compare against ("N of 6 departments staffed"), which is a question
//     about production only. Clean-up is ordinary production labour: it belongs here.
//   PAYROLL_DEPARTMENTS — what a person can be ASSIGNED to: those six plus the one
//     non-production bucket, which is exactly the seven values the
//     employees.department CHECK constraint allows and nothing else.
// Rule of thumb: assign from PAYROLL_DEPARTMENTS, count against PRODUCTION_DEPARTMENTS.
//
// NON_PRODUCTION_DEPARTMENT names a ROLE, not a label. The role: the single home for
// office / admin / salaried staff who belong to no production department — a real
// assignment rather than a blank, counted as assigned, and never part of the
// production count. The label carrying that role is now 'SG&A' (it was previously
// the literal string 'Non-Production'; the database renamed the bucket, the role did
// not change). So read this as "the non-production department", NOT as "the
// department named Non-Production" — the name is deliberately about the job it does.
// Without such a value those ~dozen people could only be left blank, and blank is
// indistinguishable from "nobody has got to this row yet".
//
// 'SG&A' carries an ampersand, so it has to survive a round trip: every place it
// lands in HTML goes through esc(), and nothing re-encodes it on the way back out —
// the value read off a <select> and PATCHed to the API is the raw 'SG&A'.
const PRODUCTION_DEPARTMENTS=['Maintenance','Saw Filing','Shipping','Production','Log Yard','Clean-up'];
const NON_PRODUCTION_DEPARTMENT='SG&A';
const PAYROLL_DEPARTMENTS=PRODUCTION_DEPARTMENTS.concat([NON_PRODUCTION_DEPARTMENT]);

// SG&A is an assignment like any other, so a row carrying it is DONE and must never
// be counted as still needing a department — that is the entire point of having a
// non-production value at all. Every "is this row complete?" test goes through here
// so the screens cannot drift apart on what "unassigned" means.
function hasDepartment(v){return !!String(v==null?'':v).trim();}
const DAY_NAMES=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MONTH_ABBR=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Dates come back as plain YYYY-MM-DD. new Date('2026-08-17') is parsed as UTC
// and renders as the previous day in Pacific time, so split the string instead
// of letting Date do it.
function dateParts(s){const p=String(s||'').slice(0,10).split('-');return (p.length===3&&p[0])?[+p[0],+p[1],+p[2]]:null;}
function fmtDate(s){const p=dateParts(s);return p?MONTH_ABBR[p[1]-1]+' '+p[2]+', '+p[0]:'—';}
function fmtDateShort(s){const p=dateParts(s);return p?MONTH_ABBR[p[1]-1]+' '+p[2]:'—';}
function isoDow(s){const p=dateParts(s);if(!p)return 0;const d=new Date(p[0],p[1]-1,p[2]).getDay();return d===0?7:d;}
function dayNameOf(s){const p=dateParts(s);return p?DAY_NAMES[new Date(p[0],p[1]-1,p[2]).getDay()]:'';}
function isScheduledDate(s){const d=isoDow(s);return d>=1&&d<=4;}
function isoToday(){const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function isoShift(s,days){const p=dateParts(s);if(!p)return s;const d=new Date(p[0],p[1]-1,p[2]+days);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function fmtStamp(ts){if(!ts)return '—';const d=new Date(ts);return isNaN(d.getTime())?String(ts):d.toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});}
function fmtHrs(n){return (Number(n)||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});}
function fmtCount(n){return n==null?'—':Number(n).toLocaleString('en-US');}

// Whole calendar days between a stored timestamp and today. Both ends go through
// dateParts for the same reason everything else here does: new Date('2026-08-11')
// is UTC midnight, which is the 10th in Pacific, and an item that arrived this
// morning would read as a day stale.
function daysSince(ts){const a=dateParts(ts),b=dateParts(isoToday());if(!a||!b)return null;
  return Math.round((Date.UTC(b[0],b[1]-1,b[2])-Date.UTC(a[0],a[1]-1,a[2]))/86400000);}
function waitedLabel(ts){const d=daysSince(ts);
  return d==null?'unresolved — arrival time unknown':d<=0?'unresolved, arrived today':d===1?'unresolved for 1 day':'unresolved for '+d+' days';}
function waitedColor(ts){const d=daysSince(ts);return (d==null||d>=3)?'var(--brick)':d>=1?'#9a600a':'var(--muted)';}

// Vendor message ids land inside a single-quoted JS string inside a double-quoted
// HTML attribute, so they have to survive both layers — JS first, then HTML.
function jsStr(v){return esc(String(v==null?'':v).replace(/\\/g,'\\\\').replace(/'/g,"\\'"));}
function fmtPct(f){return f==null?'—':(Number(f)*100).toFixed(1)+'%';}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);}

// Fri/Sat/Sun work is normal here — maintenance crews run weekends — so this
// labels the day, it never warns about it.
function schedBadge(isSched){return isSched?'<span class="badge active">Scheduled Mon–Thu</span>':'<span class="badge en">Non-scheduled Fri–Sun</span>';}

// Every /api/payroll-import call goes through here so a failed request raises
// instead of leaving a panel spinning on nothing.
async function payrollPost(body){
  const res=await fetch('/api/payroll-import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(res.status===401){location.href='/';throw new Error('Session expired');}
  let json=null;
  try{json=await res.json();}catch(e){json=null;}
  if(!res.ok||!json||json.ok===false) throw new Error((json&&json.error)||('Request failed ('+res.status+')'));
  return json;
}

function goToTab(tab){
  const btn=document.querySelector('.sfp-tab[data-tab="'+tab+'"]');
  switchTab(tab,btn);
}


function switchTab(tab,el){
  state.tab=tab;
  document.querySelectorAll('.sfp-tab').forEach(t=>t.classList.remove('active'));
  const pill=el||document.querySelector('.sfp-tab[data-tab="'+tab+'"]');
  if(pill) pill.classList.add('active');
  render();
  // The payroll tabs read their own endpoints, so they load on first open
  // rather than on every page load.
  if(tab==='otreport'&&!state.otReport&&!state.otReportLoading) loadOTReport(state.otReportWeek);
  if(tab==='dailyhours'&&!state.dailyLoaded&&!state.dailyLoading) loadDailyDays();
}

function render(){
  const el=document.getElementById('tabContent');
  if(state.loading){el.innerHTML='<div class="loading-state">Loading…</div>';return;}
  if(state.tab==='employees')el.innerHTML=renderEmployees();
  else if(state.tab==='economics')el.innerHTML=renderEcon();
  else if(state.tab==='overtime')el.innerHTML=renderOT();
  else if(state.tab==='points')el.innerHTML=renderPoints();
  else if(state.tab==='dailyhours')el.innerHTML=renderDailyHours();
  else if(state.tab==='otreport')el.innerHTML=renderOTReport();
  else if(state.tab==='settings')el.innerHTML=renderSettings();
}


function toast(msg,type){
  const el=document.getElementById('toast');
  el.textContent=msg;el.className=`toast ${type} show`;
  setTimeout(()=>{el.className='toast';},4000);
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
