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
  tab:'employees', employees:[],
  // One entry per cost class, created on demand by costView(). Keyed by the
  // class itself so the Manufacturing Costs and Overhead tabs cannot render each
  // other's numbers.
  cost:{},
  points:[],
  // Pre-approved OT comes from /api/preapproved-ot now, keyed on employees.id.
  // state.ot — the {pre,post,weekend} arrays the old editable grid held — is
  // gone with it: it was a client-side copy of the whole table, which is what
  // made a replace-the-table save look reasonable.
  preRows:[], preLoaded:false, preLoading:false, preError:'',
  preTableMissing:false, preNote:'',
  // Cost allocations. allocDrafts is keyed by employee id so a half-finished
  // edit on one person is not disturbed by opening somebody else's card.
  allocations:[], allocDrafts:{}, allocLoaded:false, allocLoading:false,
  allocError:'', allocTableMissing:false, allocNote:'',
  filterName:'', filterDept:'all', filterStatus:'Active',
  editing:null, dirty:false, loading:true, ptEditing:false,
  // Which employee's profile card is open, as {idx}, or null. Separate from
  // `editing`: the card is read-only until Edit sets `editing` as well, and
  // saveEdit() clearing `editing` is what drops it back to read-only.
  profile:null,
  // Which sub-view the Reports tab is showing. Defaults to Pre-Approved OT
  // because it needs no network call — the OT Report loads on first open, the
  // way it did as a top-level tab.
  reportView:'preapproved',
  sortCol:'name', sortDir:'asc',
  burden:0.44, mhr:15.0,
  emailSettings:{...EMAIL_SETTINGS_DEFAULTS},
  otEmailSending:false,
  dailyWorkDate:'', dailyPreview:null, dailyPreviewFile:null, dailyDupAck:false, dailyLastImport:null,
  dailyDays:[], dailyFrom:'', dailyTo:'', dailyLoading:false, dailyLoaded:false,
  dailyBusy:false, dailyPending:null, restampFrom:'', restampTo:'', restampResult:null,
  otReport:null, otReportWeeks:[], otReportWeek:'', otReportLoading:false, otReportError:'',
  otReportTruncated:false, otReportWindow:null,
  otSortCol:'netOtDollars', otSortDir:'desc', otDayDept:'all', otOpenDays:{},
  // Phase D. Deny by default on this side too: the base tier until /api/permissions
  // answers, so an unloaded state can never look like access. defaultPerms() is in
  // permissions.js, which is loaded after this file — hence the literal here.
  perms:{tiers:['hourly_wages'],isAdmin:false,grants:null,email:'',loaded:false,loading:false,error:'',busy:false},
  // Salaries & Wages. Keyed by employee id, so a half-typed figure on one person
  // survives a re-render caused by somebody else's row.
  salaryDrafts:{}, salarySaving:false,
  // The same shape for hourly rates, which became editable on 2026-08-22 when
  // the daily file stopped carrying one. Two separate maps rather than one:
  // the two halves of the page save independently and refuse for different
  // reasons, and a shared map would let a refused salary hold back a rate.
  wageDrafts:{}, wageSaving:false,
  // Staffing Economics. Loaded on first open like the cost reports, not on every
  // page load: /api/data refuses the table to most of the roster, so fetching it
  // eagerly would 403 for almost everybody on every boot.
  economics:[], econLoaded:false, econLoading:false, econError:'', econNote:'',
  // The seat currently being saved, or null. One at a time: an assignment is a
  // single PATCH and there is no draft to hold, so this only stops a second
  // click landing while the first is in flight.
  econBusy:null
};

function fmt$(n){return n==null?'—':'$'+Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});}

// The timeclock grace allowance, in hours per active hourly employee per week.
// A policy number, so it is read from emailSettings rather than hardcoded, and
// the stated default stands in for anything unusable — including a negative,
// which is not a setting but a mistake. Zero IS a real setting: it switches the
// policy off, so this can never be a truthiness test.
//
// Lives here rather than in ot-report.js because the OT report and the employee
// profile card both state it, and a policy number two screens quote separately
// is a policy number they will eventually quote differently.
function graceHrs(){
  const v=Number(state.emailSettings.graceHoursPerEmployee);
  return isFinite(v)&&v>=0?v:EMAIL_SETTINGS_DEFAULTS.graceHoursPerEmployee;
}

// Takes the whole employee, not a bare wage, because 'is this person salaried'
// is no longer a fact about the wage column — see isSalaried below. A wage value
// is still accepted so a caller holding nothing else keeps the legacy reading.
//
// Everything routes through isSalaried so no two screens can disagree about the
// same employee: a lowercase 'salary' used to render as $NaN here while being
// correctly excluded from the costing report. A blank wage on an hourly
// person is unknown, not salaried — it used to display as 'Salary', which made a
// half-entered new hire look like staff they are not.
function fmtWage(empOrWage){
  const emp = (empOrWage&&typeof empOrWage==='object') ? empOrWage : {wage:empOrWage};
  if(isSalaried(emp))return 'Salary';
  const n=parseFloat(String(emp.wage==null?'':emp.wage).replace(/[$,]/g,''));
  return isNaN(n)?'—':('$'+n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}));
}

// THE one frontend answer to 'is this person salaried'. Every screen asks here.
//
// Pay type is its own column now: employees.pay_type holds 'Hourly' or
// 'Salaried' (SCHEMA_V2_MODEL.sql section 5b). Before that migration the marker
// lived inside employees.wage as the literal string 'Salary', and the migration
// NULLS wage for salaried people — so code that decides this by reading wage
// alone reads every salaried person as HOURLY the moment the migration runs,
// which puts them into the clock-grace headcount and silently inflates it.
//
// Hence the order: pay_type when it is present and recognised, the legacy wage
// marker only as a fallback. That is correct before AND after the migration, and
// a stale 'Salary' left in wage never overrides an explicit pay_type of Hourly.
// Trimmed and case-insensitive on both, because the edit form only normalises
// casing on blur and the database column is plain text.
//
// Mirrored by isSalaried() in netlify/functions/wage-sync.js and
// netlify/functions/ot-report-lib.js — three runtimes, one rule. Change all
// three together.
function isSalaried(emp){
  const pt=String((emp&&(emp.pay_type!=null?emp.pay_type:emp.payType))||'').trim().toLowerCase();
  if(pt==='salaried')return true;
  if(pt==='hourly')return false;
  return String((emp&&emp.wage)||'').trim().toLowerCase()==='salary';
}
const PAY_TYPES=['Hourly','Salaried'];
function payTypeOf(emp){return isSalaried(emp)?'Salaried':'Hourly';}

// ============================================================
// PAYROLL SHARED HELPERS
// ============================================================

// The employee taxonomy (Architecture v2, SCHEMA_V2_MODEL.sql). THREE independent
// axes, and none of them is derived from another — not here, not in the UI, and not
// by a default that follows from a neighbouring field:
//
//   cost_class      which accounting bucket   Manufacturing / Mill Overhead / SG&A
//   department      which line within it      twelve values, grouped below
//   position_group  where in the mill         nine values, planning only, often null
//
// A salaried person can be Manufacturing (Eduardo Rivera) and an hourly person can be
// SG&A (Axeri Ramirez), so neither cost class nor department can be read off pay type
// or off each other. Some department and position-group names coincide (Maintenance,
// Saw Filing, Log Yard, Shipping) and the match is NOT a mapping: Supervisors spans
// departments, so one exception already makes it not a rule.
//
// TWO department lists, deliberately different sizes — do not "fix" them into one:
//   MANUFACTURING_DEPARTMENTS — the six production cost centres, i.e. the departments
//     of the Manufacturing cost class. This is the list to COUNT and compare against
//     ("N of 6 departments staffed"), which is a question about production only.
//     Clean-up is ordinary production labour: it belongs here.
//   PAYROLL_DEPARTMENTS — what a person can be ASSIGNED to: all twelve, which is
//     exactly what the employees.department CHECK constraint allows once
//     SCHEMA_V2_TIGHTEN_DEPARTMENTS.sql has run, and nothing else.
// Rule of thumb: assign from PAYROLL_DEPARTMENTS, count against
// MANUFACTURING_DEPARTMENTS. Collapsing them would either make the stat card claim
// office staff as production, or stop half the roster from being assignable.
//
// 'SG&A' is RETIRED as a department value — it is a cost class now, with five
// departments of its own (Sales & Marketing, Procurement, Accounting, HR, Corporate),
// and it is deliberately absent from PAYROLL_DEPARTMENTS. Rows that still hold it are
// real data until they are reassigned, so the edit modal still DISPLAYS the value it
// no longer offers (see renderModal) rather than blanking a good value on save.
//
// 'Sales & Marketing' and the 'SG&A' cost class both carry an ampersand, so both have
// to survive a round trip: everything that lands in HTML — option text, option value,
// optgroup label — goes through esc(), and nothing re-encodes on the way back out.
// The value read off a <select> and PATCHed to the API is the raw 'Sales & Marketing'.
const MANUFACTURING_DEPARTMENTS=['Log Yard','Clean-up','Shipping','Maintenance','Production','Saw Filing'];
const MILL_OVERHEAD_DEPARTMENTS=['Mill Overhead'];
const SGA_DEPARTMENTS=['Sales & Marketing','Procurement','Accounting','HR','Corporate'];
const COST_CLASSES=['Manufacturing','Mill Overhead','SG&A'];

// Grouping for READABILITY only — twelve flat options are unreadable, so the dropdown
// groups them by cost class. Picking a department must never set the cost class, and
// picking a cost class must never filter or set the department: they are separate
// fields on the form and separate columns in the database.
const DEPARTMENTS_BY_COST_CLASS={
  'Manufacturing':MANUFACTURING_DEPARTMENTS,
  'Mill Overhead':MILL_OVERHEAD_DEPARTMENTS,
  'SG&A':SGA_DEPARTMENTS
};

// The twelve assignable department values, in cost-class order.
const PAYROLL_DEPARTMENTS=COST_CLASSES.reduce((all,cc)=>all.concat(DEPARTMENTS_BY_COST_CLASS[cc]),[]);

// The planning layer. Nullable for everyone, and legitimately null for anybody who is
// not manufacturing floor staff — that is NOT enforced against cost class here or in
// the database, so the form offers a blank and leaves it blank.
// 'Clean-up' is the tenth. It came in with the classification load and two people
// hold it; the dropdown did not offer it, so opening either of their records and
// saving would have written the value away — retiredOption() shows it and keeps it,
// but only a real entry in this list stops it reading as retired.
const POSITION_GROUPS=['Supervisors','Maintenance','Saw Filing','Log Yard','Sawmill Operators',
  'Bakerville','Green Chain','Extras','Shipping','Clean-up'];

// Any department is an assignment, so a row carrying one is DONE and must never be
// counted as still needing a department. Every "is this row complete?" test goes
// through here so the screens cannot drift apart on what "unassigned" means. A row on
// the retired 'SG&A' still counts as assigned: it holds a value somebody chose.
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
// ---------------------------------------------------------------------------
// Birthdays.
//
// The column holds free text and has held three shapes: the full JS date string
// the old form wrote ("Mon Nov 12 1990 00:00:00 GMT-0800 (Pacific Standard
// Time)"), M/D/YYYY typed by hand, and YYYY-MM-DD. netlify/functions/
// birthday-lib.js parseBirthday() already reads all three, and only ever uses
// the MONTH AND DAY — the year is never read.
//
// This is the client-side twin of that parser and it exists for one reason: the
// edit surface now uses <input type="date">, which shows nothing at all for a
// value it cannot parse. Rendering an empty date picker over a stored birthday
// and then saving would silently erase it, for a system that is live and
// announcing to 66 people. So an unparseable value must be detectable HERE,
// before the field is drawn, and shown as text instead.
//
// Deliberately not exhaustive: it accepts what the server parser accepts, and
// nothing else. Anything it returns null for gets the text fallback.
function parseBirthdayParts(value){
  if(value==null) return null;
  const raw=String(value).trim();
  if(!raw||raw.toUpperCase().includes('ERROR')) return null;

  // Already a plain date, which is where everything is headed.
  let m=raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if(m) return validBirthday(+m[1],+m[2],+m[3]);

  // Hand-typed M/D/YYYY or M-D-YYYY. A 2-digit or absent year cannot be turned
  // into a date input value, so those take the text fallback rather than having
  // a century guessed for them.
  m=raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if(m) return validBirthday(+m[3],+m[1],+m[2]);

  // The full JS date string. Read in UTC, exactly as the server parser does:
  // every stored value is midnight Pacific, which is 08:00 UTC the SAME calendar
  // day, so reading UTC parts cannot roll the date across midnight.
  //
  // GATED ON A 4-DIGIT YEAR BEING PRESENT IN THE TEXT, and that guard is
  // load-bearing. Date.parse is not a validator, it is a guesser:
  // Date.parse('3/15') returns March 15 2001 in V8. A bare 'M/D' is a real
  // stored shape — the server parser reads it correctly, because it only ever
  // wants month and day — but there is no year in it to put in a date input. If
  // this trusted Date.parse, that record would render as 2001-03-15 and the next
  // save would write an invented year into somebody's HR file as fact. A missing
  // year is not an error to be filled in; it takes the text fallback.
  if(/\b\d{4}\b/.test(raw)){
    const t=Date.parse(raw);
    if(!isNaN(t)){
      const d=new Date(t);
      return validBirthday(d.getUTCFullYear(),d.getUTCMonth()+1,d.getUTCDate());
    }
  }
  return null;
}

function validBirthday(y,mo,da){
  if(!(y>=1900&&y<=2200)) return null;
  if(!(mo>=1&&mo<=12)) return null;
  if(!(da>=1&&da<=31)) return null;
  // Reject Feb 30 and friends by round-tripping through a UTC date.
  const d=new Date(Date.UTC(y,mo-1,da));
  if(d.getUTCMonth()+1!==mo||d.getUTCDate()!==da) return null;
  return {year:y,month:mo,day:da};
}

// What <input type="date"> needs: YYYY-MM-DD, or '' when the stored value cannot
// be represented as one.
function birthdayInputValue(value){
  const p=parseBirthdayParts(value);
  if(!p) return '';
  return p.year+'-'+String(p.month).padStart(2,'0')+'-'+String(p.day).padStart(2,'0');
}

// For DISPLAY, and deliberately more permissive than parseBirthdayParts.
//
// The notifier only ever reads month and day, so a value stored as '3/15' —
// no year at all — is announced perfectly well. parseBirthdayParts rejects it
// because a date input cannot represent it, and if the profile card reused that
// stricter answer it would show "not set" for somebody the system announces
// every year. The card has to agree with the notifier, not with the widget.
//
// This mirrors netlify/functions/birthday-lib.js parseBirthday(): month and day,
// year optional and unused.
function parseBirthdayMonthDay(value){
  const full=parseBirthdayParts(value);
  if(full) return {month:full.month,day:full.day};

  const raw=String(value==null?'':value).trim();
  if(!raw||raw.toUpperCase().includes('ERROR')) return null;

  // M/D, M/D/YY — the shapes with no usable year.
  const m=raw.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/);
  if(!m) return null;
  const mo=+m[1], da=+m[2];
  if(!(mo>=1&&mo<=12)||!(da>=1&&da<=31)) return null;
  // Leap year is the permissive answer: Feb 29 is a real birthday.
  if(!validBirthday(2000,mo,da)) return null;
  return {month:mo,day:da};
}

function fmtBirthday(value){
  const p=parseBirthdayMonthDay(value);
  if(!p) return null;
  return MONTH_NAMES[p.month-1]+' '+p.day;
}

// ---------------------------------------------------------------------------
// TIME OF DAY — break_1 and break_2
// ---------------------------------------------------------------------------
//
// The column holds a break time and nothing else, but it has been written by
// several things over the years and holds several shapes:
//
//   '1899-12-30T20:45:00.000Z'   a spreadsheet time-only serialisation. The
//                                1899-12-30 epoch is Excel/Sheets' zero date;
//                                the DATE PART IS MEANINGLESS and only the
//                                clock time matters.
//   '8:45 PM'                    what the roster's own Add form writes.
//   '20:45'                      what <input type="time"> produces.
//
// This was rendering the raw stored string on the profile card, so somebody's
// afternoon break read as '1899-12-30T20:45:00.000Z'. Same class of bug as the
// birthday column: a stored value shown without formatting.
//
// THE ISO VALUES ARE SHIFTED BY EIGHT HOURS AND THE TEXT ONES ARE NOT.
//
// Audited against all 74 rows. break_1 is '15:00' on 68 of them; break_2 is
// '20:45' on 64. The four rows in each column that hold TEXT read '7:00 AM' and
// '12:45 PM' — the mill's standard breaks, and what openAdd() defaults a new hire
// to. 15:00 - 8h is 07:00 and 20:45 - 8h is 12:45: two independent values both
// landing exactly on the known break times under the same offset.
//
// Read as written instead, 68 people's 7:00 AM break displays as 3:00 PM and 64
// people's lunch as 8:45 PM, and the ISO rows would describe a different mill
// from the text rows in the same column. Under the shift the whole roster reads
// as one place: 7:00 AM and 12:45 PM for the bulk, a 1:00/1:30 PM lunch for four
// people, and one later shift of two on 4:30 PM and 8:45 PM — the same two rows
// in both columns. It also explains the 1899-12-31 dates: a time-only value
// cannot roll past its own epoch day unless something shifted it.
//
// So the offset is applied to the ISO shape ONLY. Applying it to the text rows
// would shift already-correct values a second time.
//
// PARSED, NOT CAST, and the offset is FIXED. `new Date(...)` then reading local
// hours would shift by the VIEWER's offset — a different break time in
// California, Berlin and on a UTC build server, none of them the stored one. And
// no DST: 15:00 - 8 matching the text exactly means the export used a flat -8,
// not a date-aware conversion. 1899 predates US DST anyway. There is no instant
// here to convert, only digits to correct.
const SPREADSHEET_UTC_OFFSET_MINUTES=-8*60;

// The time part of any shape above, as {hour, minute} on a 24-hour clock, or
// null when the value cannot be read as a time at all.
function parseTimeParts(value){
  const raw=String(value==null?'':value).trim();
  if(raw==='') return null;

  // The 1899 spreadsheet shape. The date is ignored — it is the epoch, not a
  // date — and the time is corrected by the fixed offset above. Any zone marker
  // in the string is ignored too: the correction is the same either way, and
  // trusting a '+00:00' that the exporter wrote as boilerplate would be reading
  // meaning into punctuation.
  let m=/^\d{4}-\d{2}-\d{2}[T ](\d{1,2}):(\d{2})/.exec(raw);
  if(m){
    const h=+m[1], min=+m[2];
    if(h<0||h>23||min<0||min>59) return null;
    // Wrapped into the day. 00:30 - 8h is 16:30 the day before, which is 4:30 PM
    // — the point being that the DAY is meaningless and only the clock survives.
    const mins=((h*60+min)+SPREADSHEET_UTC_OFFSET_MINUTES+1440)%1440;
    return {hour:Math.floor(mins/60),minute:mins%60};
  }

  // A bare 'HH:MM'. Already local — this is what <input type="time"> emits and
  // what everything writes from now on — so it is NOT shifted.
  m=/^(\d{1,2}):(\d{2})(?::\d{2})?\s*$/.exec(raw);
  if(m){
    const h=+m[1], min=+m[2];
    if(h>=0&&h<=23&&min>=0&&min<=59) return {hour:h,minute:min};
    return null;
  }

  // 12-hour with a meridiem, e.g. '7:00 AM'. Already local — four rows per
  // column hold this shape and they are the reference the offset above was
  // derived FROM — so it is not shifted either.
  //
  // 12 AM is hour 0 and 12 PM is hour 12: the one pair of cases that a naive
  // (h % 12) + offset gets wrong in both directions.
  m=/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp])\.?[Mm]\.?\s*$/.exec(raw);
  if(m){
    let h=+m[1];
    const min=+m[2];
    const pm=m[3].toLowerCase()==='p';
    if(h<1||h>12||min<0||min>59) return null;
    if(h===12) h=0;
    return {hour:pm?h+12:h,minute:min};
  }

  // A bare number is a spreadsheet serial: the fraction of a day. 0.53125 is
  // 12:45. NOT shifted — a raw fraction has no zone applied to it, unlike the
  // ISO strings which were serialised through one.
  //
  // The audit found none of these in the column, so this branch is defensive
  // rather than load-bearing. Kept because the same export that produced the
  // ISO values produces this shape too, depending on the cell format.
  //
  // Only below 1: a value of 45000 is a full date serial, which is not a break
  // time and is more likely a column mix-up worth seeing as "unreadable".
  m=/^(\d?\.\d+|0)$/.exec(raw);
  if(m){
    const frac=parseFloat(m[1]);
    if(!(frac>=0&&frac<1)) return null;
    const total=Math.round(frac*24*60);
    // 0.9999 rounds to 1440, which is midnight the next day rather than an
    // invalid time. Wrap rather than reject.
    const mins=total%1440;
    return {hour:Math.floor(mins/60),minute:mins%60};
  }

  return null;
}

// '8:45 PM'. Null — not a dash, not the raw value — when it cannot be read, so
// the caller decides how to show a value it does not understand.
function fmtTime(value){
  const p=parseTimeParts(value);
  if(!p) return null;
  const pm=p.hour>=12;
  let h=p.hour%12;
  if(h===0) h=12;
  return h+':'+String(p.minute).padStart(2,'0')+' '+(pm?'PM':'AM');
}

// 'HH:MM' for <input type="time">, or '' when the value cannot be represented.
//
// The empty string is the dangerous case and the caller must handle it. A time
// input given '' renders blank, and the next save writes that blank back over
// a real value as though it were a deliberate clearing. That is exactly the
// trap the birthday date picker hit, which is why profileEditBody switches to a
// text field and a warning instead of showing an empty picker.
function timeInputValue(value){
  const p=parseTimeParts(value);
  if(!p) return '';
  return String(p.hour).padStart(2,'0')+':'+String(p.minute).padStart(2,'0');
}

// WHAT GETS STORED GOING FORWARD: 'HH:MM', 24-hour.
//
// Chosen over the other two shapes already in the column because it is what
// <input type="time"> emits (so the edit path needs no conversion), it sorts
// correctly as text, it is unambiguous without a meridiem, and it carries no
// fake 1899 date to be misread as an instant later. Existing values are NOT
// migrated — nothing parses this column except the display layer, so a
// migration would be risk without a reader to benefit. fmtTime reads all three
// shapes, so old and new rows render identically.
function timeStorageValue(value){
  const p=parseTimeParts(value);
  if(!p) return null;
  return String(p.hour).padStart(2,'0')+':'+String(p.minute).padStart(2,'0');
}

// What a WRITE puts in break_1 / break_2. Three outcomes, and each one is a
// deliberate choice about somebody's record:
//
//   readable      -> normalized to 'HH:MM'
//   absent        -> null. NOT a default. `break_1: e.break1 || '7:00 AM'` used
//                    to sit in two writers, one of which re-writes every row on
//                    the roster, so a single Sync gave a fabricated 7:00 AM
//                    break to everybody who had none on file. A person with no
//                    break time recorded is a fact, not a gap to fill in.
//   unreadable    -> kept exactly as it was found. Normalizing it is impossible
//                    and nulling it would destroy the only copy — which is the
//                    same mistake as inventing one, pointed the other way. The
//                    edit surface shows it as text with a warning so a human can
//                    correct it; until then it is preserved.
function breakStorageValue(value){
  const normalized=timeStorageValue(value);
  if(normalized!==null) return normalized;
  const raw=String(value==null?'':value).trim();
  return raw===''?null:raw;
}

// The schedule-day values present on the roster. Drives the suggestion list on
// the profile card, NOT a validation list — a value not in here is kept as typed,
// because a select that silently drops an unrecognised value would rewrite
// somebody's schedule the first time their profile was saved.
//
// AUDITED 2026-08-21 against the live roster, 74 rows:
//   MON-THU   71
//   FRI-MON    1
//   MON-SUN    1
//   (blank)    1
//
// Three distinct values, two of them held by one person each. That is why this
// is a datalist on a text input and not a select: a select offering only these
// three would silently drop the next one-off somebody types, and 'FRI-MON' shows
// that one-offs are real here. The provisional list guessed 'MON-FRI', which
// does not exist, and missed 'FRI-MON', which does.
const SCHEDULE_DAYS=['MON-THU','FRI-MON','MON-SUN'];

const MONTH_NAMES=['January','February','March','April','May','June','July',
  'August','September','October','November','December'];

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
  //
  // The OT Report's hook used to live here, keyed on tab==='otreport'. It is now
  // a sub-view of Reports, so the hook moved to switchReportView() — and it also
  // has to fire when Reports is opened while that sub-view is already the
  // selected one, or a deep link from goToReport('otreport') would render the
  // report shell and never load anything into it.
  if(tab==='reports'){
    const view=reportView(state.reportView);
    if(view.load) view.load();
  }
  if(tab==='dailyhours'&&!state.dailyLoaded&&!state.dailyLoading) loadDailyDays();
  // Same rule as the payroll tabs: the cost report is its own endpoint, so it
  // loads on first open rather than on every page load.
  if(tab==='costs') loadCostsOnce([COST_CLASS_MANUFACTURING]);
  if(tab==='overhead') loadCostsOnce(OVERHEAD_CLASSES);
  // Same rule, and here it also matters for a reason the cost tabs do not have:
  // /api/data refuses the economics table without the salaries tier, so loading
  // it on boot would 403 for most of the roster on every page load.
  if(tab==='economics'&&!state.econLoaded&&!state.econLoading) loadEconomics();
}

function render(){
  const el=document.getElementById('tabContent');
  if(state.loading){el.innerHTML='<div class="loading-state">Loading…</div>';return;}
  if(state.tab==='employees')el.innerHTML=renderEmployees();
  else if(state.tab==='costs')el.innerHTML=renderCosts();
  else if(state.tab==='overhead')el.innerHTML=renderOverhead();
  // 'overtime', 'points' and 'otreport' are no longer tabs; they are sub-views
  // of 'reports'. Their render functions are unchanged and are called from
  // renderReports().
  else if(state.tab==='reports')el.innerHTML=renderReports();
  else if(state.tab==='dailyhours')el.innerHTML=renderDailyHours();
  // Phase D. renderSalaries() refuses to draw without the tier as well — the
  // hidden tab button is a courtesy, not the gate, and a deep link or a
  // hand-typed switchTab() in the console has to land somewhere honest.
  else if(state.tab==='salaries')el.innerHTML=renderSalaries();
  else if(state.tab==='economics')el.innerHTML=renderEconomics();
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
