// permissions — the access list, and the surface for changing it.
//
// Shares one global scope with the other files in src/js (see core.js).
//
// ------------------------------------------------------------------------
// ONE LIST, NO ROLES
// ------------------------------------------------------------------------
//
// Three tiers collapsed into one list on 2026-09-15. You are on it or you are
// not, and being on it means everything: sign in, every column, every setting,
// this list itself, and the weekly OT email. See netlify/functions/
// permissions-lib.js for why, and for what it costs.
//
// So there is almost nothing left for this file to gate. What it has instead is
// the EDITOR for the list, and the one refusal that survives — the last entry
// cannot be removed, because an empty list locks everybody out and nothing
// inside the app could put one back.
//
// ------------------------------------------------------------------------
// THIS FILE DOES NOT PROTECT ANYTHING
// ------------------------------------------------------------------------
//
// Read that literally. The enforcement is at SIGN-IN, in netlify/functions/
// auth.js, which checks the list against Google's answer and does not consult
// anything the browser says. Somebody editing state.perms in the console
// changes what this page draws and nothing else.

// Assumed until the server answers. Deny-by-default on this side too: an
// unloaded state must never look like access.
function defaultPerms(){
  return { list:[], hasAccess:false, email:'', unavailable:false, migrationPending:false,
           migrationDetail:'', loaded:false, loading:false, error:'', busy:false };
}

// Kept as a function rather than inlined at 20 call sites: it is the sentence
// "may this person see pay", and it now has one answer for everybody who got
// this far. A signed-in session IS the permission.
function canSeeSalaries(){ return true; }

async function loadPermissions(){
  if(state.perms.loading) return;
  state.perms.loading=true;
  try{
    const res=await fetch('/api/permissions');
    if(res.status===401){location.href='/';return;}
    const d=await res.json();
    if(!res.ok||!d.ok) throw new Error(d.error||('Request failed ('+res.status+')'));
    state.perms.list=Array.isArray(d.list)?d.list:[];
    state.perms.hasAccess=!!d.hasAccess;
    state.perms.email=d.caller||'';
    // The table does not exist yet. Not an error — the code can deploy before
    // the migration runs — but the list cannot be edited until it does, and the
    // page says so rather than showing an empty list that looks editable.
    state.perms.unavailable=!!d.unavailable;
    // The table exists but SCHEMA_ACCESS_LIST.sql has not run. The list READS
    // correctly in this state and neither write works, so the page shows it and
    // offers nothing — a form that 503s is worse than no form.
    state.perms.migrationPending=!!d.migrationPending;
    state.perms.migrationDetail=d.detail||'';
    state.perms.error='';
  }catch(err){
    state.perms.list=[];
    state.perms.hasAccess=false;
    state.perms.error=err.message;
  }finally{
    state.perms.loading=false;
    state.perms.loaded=true;
    render();
  }
}

// ------------------------------------------------------------------------
// when the list could not be read
// ------------------------------------------------------------------------
//
// FAILING CLOSED IS RIGHT. FAILING CLOSED SILENTLY IS NOT. This used to drop a
// reader to the base tier with no explanation anywhere, and the obvious reading
// of that — for somebody who could see salaries yesterday — was that they had
// been revoked.
//
// There is far less to lose now: nothing on the page is gated, so a failed read
// costs only the Access editor. The message says exactly that, because "your
// access could not be checked" would imply the rest of the app is degraded when
// it is not.
function renderPermsError(){
  if(!state.perms.error) return '';
  return `
    <div style="background:var(--surface);border:1px solid #b8860b;border-radius:8px;padding:20px;margin-bottom:24px">
      <div style="font-size:14px;font-weight:700;color:#b8860b;margin-bottom:8px">
        ⚠ The access list could not be read
      </div>
      <div style="font-size:12px;color:var(--muted);line-height:1.6">
        Nothing has been revoked and nothing else on the page is affected — you are signed in, which
        means you were on the list when you signed in. Only the editor below is missing.
        <b>Reload the page.</b> If it keeps happening, the error was:
        <div style="font-family:var(--mono,monospace);font-size:11px;color:var(--text);background:var(--surface2);border-radius:4px;padding:8px 10px;margin-top:8px;word-break:break-word">${esc(state.perms.error)}</div>
      </div>
    </div>`;
}

// ------------------------------------------------------------------------
// the editor — a section of Settings, not a tab
// ------------------------------------------------------------------------
//
// Not a tab because a tab is a place you go, and this is a thing you do twice a
// year. Visible to everybody, because everybody on the list may edit it: there
// is no audience left for whom hiding it would be correct.

async function permsWrite(method,payload){
  if(state.perms.busy) return;
  state.perms.busy=true; render();
  try{
    const url=method==='DELETE'
      ? '/api/permissions?email='+encodeURIComponent(payload.email)
      : '/api/permissions';
    const res=await fetch(url,method==='DELETE'
      ? {method}
      : {method,headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const d=await res.json().catch(()=>({}));
    if(!res.ok||!d.ok) throw new Error(d.detail?`${d.error} ${d.detail}`:(d.error||('Request failed ('+res.status+')')));
    return d;
  }finally{
    state.perms.busy=false;
  }
}

async function grantAccess(){
  const emailEl=document.getElementById('grantEmail');
  const email=(emailEl?emailEl.value:'').trim();
  if(!email){toast('Enter the email address to give access to','error');return;}
  try{
    const d=await permsWrite('POST',{email});
    // Re-read rather than patching the local list. The server canonicalises the
    // address and may have decided it was already there; showing what it stored
    // beats showing what was typed.
    await loadPermissions();
    if(emailEl) emailEl.value='';
    toast(d.added?`${email} now has access and will receive the weekly OT email`
                 :`${email} already has access`,'success');
  }catch(err){
    toast(err.message,'error');
    render();
  }
}

async function revokeAccess(email){
  try{
    const d=await permsWrite('DELETE',{email});
    await loadPermissions();
    if(!d.removed){ toast(`${email} was not on the list`,'success'); return; }
    // Removing YOURSELF is allowed and is not a mistake to warn about — there
    // are no roles, so it is the same act as removing anybody else. It just
    // needs saying, because the app will keep working until the session expires
    // and the silence would read as "it did not work".
    toast(d.self
      ? 'You removed your own access — you will stay signed in until this session expires, then be locked out'
      : `${email} no longer has access`, d.self?'warning':'success');
  }catch(err){
    // The last-entry refusal arrives here with its detail, which says what to do
    // instead. Shown whole.
    toast(err.message,'error');
    render();
  }
}

function renderAccessSection(){
  const people=(state.perms.list||[]);
  const busy=state.perms.busy?' disabled':'';

  if(state.perms.migrationPending){
    return `
    <div style="background:var(--surface);border:1px solid #b8860b;border-radius:8px;padding:24px;margin-bottom:24px">
      <div style="font-size:16px;font-weight:700;margin-bottom:6px">🔑 Access — migration not run</div>
      <div style="font-size:12px;color:var(--muted);line-height:1.6;margin-bottom:16px">
        ${esc(state.perms.migrationDetail||'Run SCHEMA_ACCESS_LIST.sql in the Supabase SQL editor.')}
        <br><br>Sign-in is falling back to the <b>${esc('sequoiafp.com')}</b> domain rule meanwhile,
        so nobody is locked out — but this list is not deciding anything yet.
      </div>
      ${people.length?`
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin-bottom:8px">On the table today</div>
        <div class="table-wrap"><table><tbody>
          ${people.map(email=>`<tr><td style="font-size:13px;padding:10px 12px">${esc(email)}</td></tr>`).join('')}
        </tbody></table></div>`:''}
    </div>`;
  }

  if(state.perms.unavailable){
    return `
    <div style="background:var(--surface);border:1px solid #b8860b;border-radius:8px;padding:24px;margin-bottom:24px">
      <div style="font-size:16px;font-weight:700;margin-bottom:6px">🔑 Access</div>
      <div style="font-size:12px;color:var(--muted);line-height:1.6">
        The access list table does not exist yet — run <b>SCHEMA_ACCESS_LIST.sql</b>. Until it does,
        sign-in falls back to the ${esc('sequoiafp.com')} domain rule and this list cannot be edited.
      </div>
    </div>`;
  }

  return `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:24px;margin-bottom:24px">
      <div style="font-size:16px;font-weight:700;margin-bottom:6px">🔑 Access</div>
      <div style="font-size:12px;color:var(--muted);line-height:1.6;margin-bottom:20px">
        <b>This list is the whole permission system.</b> Everybody on it can sign in, see and edit
        everything including annual salaries, change these settings, and edit this list — there are
        no roles or levels. <b>Everybody on it also receives the Monday OT email</b>, which carries
        what every hourly employee was paid; there is no separate recipient list.
        A change takes effect the next time that person signs in.
      </div>

      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:12px">
        <div style="flex:1 1 260px">
          <label class="form-label">Email address</label>
          <input type="email" id="grantEmail" placeholder="first.last@sequoiafp.com"
                 style="width:100%" autocomplete="off"${busy}>
        </div>
        <button class="btn btn-primary" onclick="grantAccess()"${busy}>Give access</button>
      </div>

      <div style="font-size:11px;color:var(--muted);line-height:1.6;margin-bottom:16px">
        It must be the address they sign in to Google with. An entry on an address nobody signs in
        with looks exactly like one that works and nothing will ever report it — so if somebody says
        they cannot get in, check the spelling here first.
      </div>

      ${people.length?`
        <table>
          <thead><tr><th>Person</th><th style="width:1%"></th></tr></thead>
          <tbody>
            ${people.map(email=>`<tr>
              <td style="font-size:13px;padding:12px">${esc(email)}${
                email===state.perms.email?' <span style="color:var(--muted);font-size:11px">(you)</span>':''}</td>
              <td style="padding:12px;white-space:nowrap;text-align:right">
                <button class="btn btn-sm" style="background:none;border:1px solid var(--border);color:var(--muted);padding:4px 10px;cursor:pointer"
                  onclick="revokeAccess('${jsStr(email)}')"${busy}>Remove</button></td>
            </tr>`).join('')}
          </tbody>
        </table>
        <div style="font-size:11px;color:var(--muted);line-height:1.6;margin-top:12px">
          ${people.length===1
            ? 'This is the only entry and it cannot be removed — an empty list would lock every account out of the app, and nothing inside the app could put one back. Add somebody else first.'
            : 'Anybody here can remove anybody, including themselves. The last remaining entry cannot be removed.'}
        </div>
      `:`
        <div style="font-size:13px;color:var(--muted);padding:16px;background:var(--surface2);border-radius:4px;text-align:center">
          Nobody is on the access list. Sign-in is falling back to the ${esc('sequoiafp.com')} domain rule.
        </div>
      `}
    </div>
  `;
}
