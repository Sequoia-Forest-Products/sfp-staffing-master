// overtime — the Overtime tab, which is a container and nothing more.
//
// TWO VIEWS NOW, and it has been four and five. What left, and why, is the
// shape of the tab:
//
//   Daily Hours   moved to Settings on 2026-09-15. It is the IMPORT — a file
//                 arrives and is committed — which is administration of the
//                 data this tab reports on, not a report. It led this sub-nav
//                 while it lived here, on the argument that it is the first
//                 step of the same job; putting it under Settings takes that
//                 argument to its conclusion.
//   Points        became a top-level tab the same day. Attendance points and
//                 disciplinary flags are not overtime and never were; they sat
//                 here because Phase C needed somewhere to put them.
//   SG&A Overtime lasted a day as a view and is now a SECTION of the OT
//                 Report, where it reads as one line of a weekly picture
//                 instead of a tab holding one table.
//
// THE OT REPORT LEADS, which is new. Daily Hours led on the order of work —
// hours are imported, then reported on — and with the import gone the report is
// both the first thing and the thing the tab is named for.
//
// Each view renders through its own function — renderOTReport(),
// renderPreApproved() — and this file adds no reporting logic of its own. That
// is deliberate: the OT report carries the scheduled/weekend split, department
// Net OT, completeness tracking and the truncation banner, and the way to not
// regress any of that is to not touch it.
//
// IT WAS CALLED 'Reports', and the rename is not cosmetic: every view in it is
// overtime, so "Reports" named the shape of the container rather than its
// subject and left no room for a report about anything else. The state key, the
// file and every function moved with the label — a tab whose internal name
// disagrees with the one on screen is a tab somebody will eventually search for
// and not find.
//
// Shares one global scope with the other files in src/js (see core.js).

// The sub-views, in the order they appear. `load` runs the first time a view is
// opened and is what preserves the lazy-load each of these had as a top-level
// tab: switchTab() used to call loadOTReport() when you opened 'otreport', and
// that hook has to live here — and be fired from switchTab() for the
// already-selected view — or the view silently never loads.
const OVERTIME_VIEWS = [
  {
    key: 'otreport',
    label: 'OT Report',
    render: () => renderOTReport(),
    load: () => { if (!state.otReport && !state.otReportLoading) loadOTReport(state.otReportWeek); }
  },
  {
    key: 'preapproved',
    label: 'Pre-Approved OT',
    render: () => renderPreApproved(),
    load: () => { if (!state.preLoaded && !state.preLoading) loadPreApproved(); }
  }
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
// Overtime tab on that view. goToTab('otreport') and goToTab('preapproved') do
// not resolve to anything, so anything jumping straight to one of these has to
// come through here. Daily Hours is no longer one of them — it is under
// Settings now, reached by goToSettings('dailyhours').
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
