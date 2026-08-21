// reports — the Reports tab, which is a container and nothing more.
//
// It consolidates three tabs that were top-level until Phase C: Pre-Approved
// Overtime, the OT Report, and Points. Each renders through its own function —
// renderPreApproved(), renderOTReport(), renderPoints() — and this file adds no
// reporting logic of its own. That is deliberate: the OT report carries the
// scheduled/weekend split, department Net OT, completeness tracking and the
// truncation banner, and the way to not regress any of that is to not touch it.
//
// Pre-Approved OT was renderOT() until task 4 rebuilt it on top of
// /api/preapproved-ot. It now needs a `load` of its own for the same reason the
// OT Report does: it reads its own endpoint.
//
// Shares one global scope with the other files in src/js (see core.js).

// The sub-views, in the order they appear. `load` runs the first time a view is
// opened and is what preserves the lazy-load the OT Report tab had as a
// top-level tab: switchTab() used to call loadOTReport() when you opened
// 'otreport', and that hook has to move here or the report silently never loads.
const REPORT_VIEWS = [
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
  { key: 'points', label: 'Points', render: () => renderPoints() }
];

function reportView(key) {
  return REPORT_VIEWS.find(v => v.key === key) || REPORT_VIEWS[0];
}

function switchReportView(key) {
  const view = reportView(key);
  state.reportView = view.key;
  render();
  if (view.load) view.load();
}

// Deep link from elsewhere in the app: goToReport('otreport') opens the Reports
// tab on that view. goToTab('otreport') no longer resolves to anything, so
// anything that used to jump straight to one of these three has to come through
// here.
function goToReport(key) {
  state.reportView = reportView(key).key;
  goToTab('reports');
}

function renderReports() {
  const active = reportView(state.reportView);

  const nav = REPORT_VIEWS.map(v =>
    `<button class="doc-tab ${v.key === active.key ? 'active' : ''}"
             onclick="switchReportView('${v.key}')">${esc(v.label)}</button>`
  ).join('');

  return `
    <div class="doc-tabs">${nav}</div>
    ${active.render()}`;
}
