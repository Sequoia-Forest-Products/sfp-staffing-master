// permissions — what this signed-in user may see, and the admin surface for
// changing it.
//
// Shares one global scope with the other files in src/js (see core.js).
//
// ------------------------------------------------------------------------
// THIS FILE DOES NOT PROTECT ANYTHING
// ------------------------------------------------------------------------
//
// Read that literally. Every gate here is cosmetic: it stops the app OFFERING a
// control that the server would refuse, which is a courtesy to the user, not a
// control on them. The enforcement is in netlify/functions/data.js and
// netlify/functions/permissions.js, which resolve the caller's tiers themselves
// on every request and do not consult anything the browser says.
//
// So the failure mode to worry about is not "somebody edits state.perms in the
// console" — they can, and they will get a payload with no annual_salary in it
// and a 403 on any write. It is the opposite: a page that draws a Save button
// the server will refuse, which reads as a bug and wastes somebody's afternoon.
// That is what these checks are for.

const TIER_HOURLY_WAGES = 'hourly_wages';
const TIER_SALARIES     = 'salaries';
const TIER_ADMIN        = 'admin';

// The base tier, assumed until the server says otherwise. Deny-by-default on
// this side too: an unloaded permissions state must never look like access.
function defaultPerms(){
  return { tiers:[TIER_HOURLY_WAGES], isAdmin:false, grants:null, email:'',
           loaded:false, loading:false, error:'', busy:false };
}

function hasTier(tier){
  return (state.perms && state.perms.tiers || []).includes(tier);
}
function canSeeSalaries(){ return hasTier(TIER_SALARIES); }
function isPermAdmin(){ return hasTier(TIER_ADMIN); }

// Loaded once, on boot, before the roster paints — see bootstrap.js. A failure
// leaves the base tier in place and says so on the Settings page — see
// renderPermsError below — rather than anywhere the user is trying to work.
async function loadPermissions(){
  if(state.perms.loading) return;
  state.perms.loading=true;
  try{
    const res=await fetch('/api/permissions');
    if(res.status===401){location.href='/';return;}
    const d=await res.json();
    if(!res.ok||!d.ok) throw new Error(d.error||('Request failed ('+res.status+')'));
    state.perms.email=d.email||'';
    // Filtered against the tiers this build knows about. A tier the server has
    // and this bundle does not must unlock nothing here — an unrecognised
    // string in the list would otherwise sit in state looking meaningful.
    state.perms.tiers=(d.tiers||[]).filter(t=>[TIER_HOURLY_WAGES,TIER_SALARIES,TIER_ADMIN].includes(t));
    if(!state.perms.tiers.includes(TIER_HOURLY_WAGES)) state.perms.tiers.push(TIER_HOURLY_WAGES);
    state.perms.isAdmin=state.perms.tiers.includes(TIER_ADMIN);
    state.perms.grants=d.grants||null;
    state.perms.error='';
  }catch(err){
    // Base tier, and the roster still works. Losing the salaries tab because a
    // request failed is a nuisance; showing it and then 403ing every action
    // would be worse.
    state.perms.tiers=[TIER_HOURLY_WAGES];
    state.perms.isAdmin=false;
    state.perms.grants=null;
    state.perms.error=err.message;
  }finally{
    state.perms.loading=false;
    state.perms.loaded=true;
    applyTabVisibility();
    render();
  }
}

// Both tabs start hidden in app.html, because a tab that appears and then
// vanishes when permissions load is worse than one that appears a moment late.
// Which of them stays hidden is decided here.
//
// SALARIES & WAGES IS NO LONGER ONE OF THEM. It was, while the whole page was
// annual salaries; since 2026-08-22 its Hourly section is where every pay rate
// in the company is typed, and employees.wage is writable at the base tier. A
// supervisor who cannot set a rate anywhere is a worse failure than a page with
// one section they cannot see, so the tab opens for everybody and the salaried
// SECTION is what the tier gates — see renderSalaries.
//
// Listed rather than derived, so adding a gated tab is one edit in one place
// and forgetting it leaves the tab visible-but-empty rather than silently open.
const SALARIES_TABS=['economics'];

// Shown to everybody the moment permissions resolve, whatever they resolve to.
// Unhidden HERE rather than left visible in app.html: this function is the one
// place that decides, and a tab whose visibility is set in two places is a tab
// that will one day disagree with itself.
const OPEN_TABS=['salaries'];

function applyTabVisibility(){
  const allowed=canSeeSalaries();
  for(const name of SALARIES_TABS){
    const tab=document.querySelector('.sfp-tab[data-tab="'+name+'"]');
    if(tab) tab.hidden=!allowed;
  }
  for(const name of OPEN_TABS){
    const tab=document.querySelector('.sfp-tab[data-tab="'+name+'"]');
    if(tab) tab.hidden=false;
  }
  // If they were looking at one when a grant was revoked in another window, do
  // not leave them on a tab that no longer has anything to show.
  if(!allowed&&SALARIES_TABS.includes(state.tab)) goToTab('employees');
}

// ------------------------------------------------------------------------
// when the permissions read itself failed
// ------------------------------------------------------------------------
//
// FAILING CLOSED IS RIGHT. FAILING CLOSED SILENTLY IS NOT.
//
// state.perms.error was set here from the day this file was written and read by
// nothing. The comment above loadPermissions said a failure "says so on the
// Settings page"; no such surface existed, so what actually happened was that a
// transient /api/permissions failure dropped somebody to the base tier with no
// explanation anywhere. The Access section vanishes, Staffing Economics
// vanishes, salaried figures stop rendering — and the obvious reading of that,
// for an admin, is that somebody revoked them.
//
// It is on Settings rather than as a global banner because that is where the
// consequences are visible and where the fix is: an admin whose tiers failed to
// load has lost the Access section they would otherwise use.
function renderPermsError(){
  if(!state.perms.error) return '';
  return `
    <div style="background:var(--surface);border:1px solid #b8860b;border-radius:8px;padding:20px;margin-bottom:24px">
      <div style="font-size:14px;font-weight:700;color:#b8860b;margin-bottom:8px">
        ⚠ Your access could not be checked, so you are seeing the base level only
      </div>
      <div style="font-size:12px;color:var(--muted);line-height:1.6">
        Nothing has been revoked and nothing is broken in the data — the request that asks what
        you may see did not come back, so the app assumed the least. Salaried figures and
        Staffing Economics will be missing until it succeeds, and if you are an administrator the
        Access section below is missing too. <b>Reload the page.</b> If it keeps happening, the
        error was:
        <div style="font-family:var(--mono,monospace);font-size:11px;color:var(--text);background:var(--surface2);border-radius:4px;padding:8px 10px;margin-top:8px;word-break:break-word">${esc(state.perms.error)}</div>
      </div>
    </div>`;
}

// ------------------------------------------------------------------------
// the admin surface — a section of Settings, not a tab
// ------------------------------------------------------------------------
//
// Not a tab because a tab is a place you go, and this is a thing you do twice a
// year. It sits under Settings with the other administrative controls, and it
// is absent rather than disabled for everybody else: a greyed-out control that
// manages who can see salaries is an invitation to ask why.

const TIER_LABELS={
  [TIER_SALARIES]:'Salaries — may see and edit annual salary',
  [TIER_ADMIN]:'Administrator — may grant and revoke access'
};

async function permsWrite(method,payload){
  if(state.perms.busy) return;
  state.perms.busy=true; render();
  try{
    const url=method==='DELETE'
      ? '/api/permissions?email='+encodeURIComponent(payload.email)+'&tier='+encodeURIComponent(payload.tier)
      : '/api/permissions';
    const res=await fetch(url,method==='DELETE'
      ? {method}
      : {method,headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const d=await res.json().catch(()=>({}));
    if(!res.ok||!d.ok) throw new Error(d.error||('Request failed ('+res.status+')'));
    return d;
  }finally{
    state.perms.busy=false;
  }
}

async function grantTier(){
  const emailEl=document.getElementById('grantEmail');
  const tierEl=document.getElementById('grantTier');
  const email=(emailEl?emailEl.value:'').trim();
  const tier=(tierEl?tierEl.value:'')||'';
  if(!email){toast('Enter the email address to grant access to','error');return;}
  try{
    const d=await permsWrite('POST',{email,tier});
    // Re-read rather than patching the local list. The server canonicalises the
    // address and may have decided it was already held; showing what it stored
    // beats showing what was typed.
    await loadPermissions();
    if(emailEl) emailEl.value='';
    toast(d.alreadyHeld
      ? `${d.email} already has ${tier}`
      : `Granted ${tier} to ${d.email}`,'success');
  }catch(err){
    toast(err.message,'error');
    render();
  }
}

async function revokeTier(email,tier){
  try{
    const d=await permsWrite('DELETE',{email,tier});
    await loadPermissions();
    toast(d.notHeld?`${email} did not have ${tier}`:`Revoked ${tier} from ${email}`,'success');
  }catch(err){
    // The last-admin refusal arrives here with the database's own wording,
    // which says what to do instead. Shown whole.
    toast(err.message,'error');
    render();
  }
}

// One row per PERSON, tiers listed, rather than one row per grant. The question
// somebody opens this to answer is "who can see salaries", and a table with
// Peter twice makes that harder to read, not easier.
function grantsByPerson(){
  const by=new Map();
  for(const g of (state.perms.grants||[])){
    if(!by.has(g.email)) by.set(g.email,{email:g.email,tiers:[],grantedBy:g.granted_by||''});
    by.get(g.email).tiers.push(g.tier);
  }
  return Array.from(by.values()).sort((a,b)=>a.email.localeCompare(b.email));
}

function renderAccessSection(){
  if(!isPermAdmin()) return '';
  const people=grantsByPerson();
  const busy=state.perms.busy?' disabled':'';
  return `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:24px;margin-bottom:24px">
      <div style="font-size:16px;font-weight:700;margin-bottom:6px">🔑 Access</div>
      <div style="font-size:12px;color:var(--muted);line-height:1.6;margin-bottom:20px">
        Everybody signed in can already see the roster and hourly rates. These tiers add to that.
        A grant takes effect the next time that person loads the app — there is nothing to deploy.
      </div>

      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:20px">
        <div style="flex:1 1 260px">
          <label class="form-label">Email address</label>
          <input type="email" id="grantEmail" placeholder="first.last@sequoiafp.com"
                 style="width:100%" autocomplete="off"${busy}>
        </div>
        <div style="flex:0 1 320px">
          <label class="form-label">Tier</label>
          <select id="grantTier" style="width:100%"${busy}>
            ${[TIER_SALARIES,TIER_ADMIN].map(t=>`<option value="${t}">${esc(TIER_LABELS[t])}</option>`).join('')}
          </select>
        </div>
        <button class="btn btn-primary" onclick="grantTier()"${busy}>Grant</button>
      </div>

      <div style="font-size:11px;color:var(--muted);line-height:1.6;margin-bottom:16px">
        The address must be the one they sign in with. A grant on an address nobody logs in with
        looks exactly like a grant that works, and nothing will ever report it — so if somebody
        says they still cannot see salaries, check the spelling here first.
      </div>

      ${people.length?`
        <table>
          <thead><tr><th>Person</th><th>Access</th><th style="width:1%"></th></tr></thead>
          <tbody>
            ${people.map(p=>`<tr>
              <td style="font-size:13px;padding:12px">${esc(p.email)}${
                p.email===state.perms.email?' <span style="color:var(--muted);font-size:11px">(you)</span>':''}</td>
              <td style="font-size:13px;padding:12px">${p.tiers.slice().sort().map(t=>
                `<span style="display:inline-block;background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:1px 9px;margin-right:6px;font-size:11px">${esc(t)}</span>`
              ).join('')}</td>
              <td style="padding:12px;white-space:nowrap">${p.tiers.slice().sort().map(t=>
                `<button class="btn btn-sm" style="background:none;border:1px solid var(--border);color:var(--muted);padding:4px 8px;cursor:pointer;margin-left:6px"
                  onclick="revokeTier('${jsStr(p.email)}','${jsStr(t)}')"${busy}>Revoke ${esc(t)}</button>`
              ).join('')}</td>
            </tr>`).join('')}
          </tbody>
        </table>
        <div style="font-size:11px;color:var(--muted);line-height:1.6;margin-top:12px">
          The last administrator cannot be revoked — the database refuses it, because with no admin
          nobody could grant one back. To hand over, grant the new administrator first.
        </div>
      `:`
        <div style="font-size:13px;color:var(--muted);padding:16px;background:var(--surface2);border-radius:4px;text-align:center">
          Nobody holds an additional tier.
        </div>
      `}
    </div>
  `;
}
