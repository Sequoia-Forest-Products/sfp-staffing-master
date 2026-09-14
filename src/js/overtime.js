// overtime — the Overtime tab, which is a container and nothing more.
//
// It consolidates four tabs that were top-level until Phase C and Phase E —
// Daily Hours, Pre-Approved Overtime, the OT Report and Points — plus SG&A
// Overtime, which was never a tab: it arrived on 2026-09-14 as the one thing
// still tracked about a cost class this app otherwise stopped analysing.
//
// Each renders through its own function — renderDailyHours(),
// renderPreApproved(), renderOTReport(), renderSgaOT(), renderPoints() — and
// this file adds no reporting logic of its own. That is deliberate: the OT report carries the scheduled/weekend
// split, department Net OT, completeness tracking and the truncation banner,
// and the way to not regress any of that is to not touch it.
//
// IT WAS CALLED 'Reports', and the rename is not cosmetic. Four of the five
// views are overtime and the fifth is the hours those four are computed from,
// so "Reports" named the shape of the container rather than its subject and
// left no room for a report about anything else. The state key, the file and
// every function moved with the label — a tab whose internal name disagrees
// with the one on screen is a tab somebody will eventually search for and not
// find.
//
// DAILY HOURS LEADS, and that is the order of work rather than of importance:
// the hours are imported here, then reported on by the views after it.
// It was a top-level tab next to Reports for exactly that reason, which is the
// argument for it being the first thing inside instead.
//
// Shares one global scope with the other files in src/js (see core.js).

// The sub-views, in the order they appear. `load` runs the first time a view is
// opened and is what preserves the lazy-load each of these had as a top-level
// tab: switchTab() used to call loadOTReport() when you opened 'otreport' and
// loadDailyDays() when you opened 'dailyhours', and those hooks have to move
// here — and be fired from switchTab() for the already-selected view — or the
// view silently never loads.
const OVERTIME_VIEWS = [
  {
    key: 'dailyhours',
    label: 'Daily Hours',
    render: () => renderDailyHours(),
    load: () => { if (!state.dailyLoaded && !state.dailyLoading) loadDailyDays(); }
  },
  {
    key: 'preapproved',
    label: 'Pre-Approved OT',
    render: () => renderPreApproved(),
    load: () => { if (!state.preLoaded && !state.preLoading) loadPreApproved(); }
  },
  {
    key: 'otreport',
    label: 'OT Report',
    render: () => renderOTReport(),
    load: () => { if (!state.otReport && !state.otReportLoading) loadOTReport(state.otReportWeek); }
  },
  {
    key: 'sgaot',
    label: 'SG&A Overtime',
    // Reads the SAME report as the view above it and issues no request of its
    // own, so its `load` is the OT Report's — opening either view loads the
    // week for both, and they can never show different weeks.
    //
    // It is here rather than in the OT Report because that report is about the
    // mill floor: departments, the scheduled/weekend split, Net OT against a
    // pre-approved allowance. Office overtime answers a different question for
    // a different reader. See the header of sga-ot.js.
    render: () => renderSgaOT(),
    load: () => { if (!state.otReport && !state.otReportLoading) loadOTReport(state.otReportWeek); }
  },
  { key: 'points', label: 'Points', render: () => renderPoints() }
];

function overtimeView(key) {
  return OVERTIME_VIEWS.find(v => v.key === key) || OVERTIME_VIEWS[0];
}

function switchOvertimeView(key) {
  const view = overtimeView(key);
  state.overtimeView = view.key;
  render();
  if (view.load) view.load();
}

// Deep link from elsewhere in the app: goToOvertime('otreport') opens the
// Overtime tab on that view. goToTab('otreport') and goToTab('dailyhours') no
// longer resolve to anything, so anything that used to jump straight to one of
// these views has to come through here.
function goToOvertime(key) {
  state.overtimeView = overtimeView(key).key;
  goToTab('overtime');
}

function renderOvertime() {
  const active = overtimeView(state.overtimeView);

  const nav = OVERTIME_VIEWS.map(v =>
    `<button class="doc-tab ${v.key === active.key ? 'active' : ''}"
             onclick="switchOvertimeView('${v.key}')">${esc(v.label)}</button>`
  ).join('');

  return `
    <div class="doc-tabs">${nav}</div>
    ${active.render()}`;
}
