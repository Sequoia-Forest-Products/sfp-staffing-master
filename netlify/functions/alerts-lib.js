// Alerts: which conditions hold right now, and what that means for the alerts
// table. Pure — no network, no database. The clock is an argument.
//
// THE MODEL. An alert is a CONDITION with a key ("daily file missing for
// 2026-11-04", "employee number 3380 not on the roster"). evaluateConditions()
// reads the current state of the data and returns every condition that holds.
// planAlertChanges() compares that list with the live alerts (open or
// acknowledged) and decides:
//
//   * a condition with no live alert            -> insert (status open)
//   * a live alert whose condition still holds  -> keep; refresh its details
//   * a live alert whose condition has cleared  -> resolve, automatically
//
// The unique index alerts_one_live_per_condition (type, alert_key) WHERE status
// is open/acknowledged makes a duplicate impossible at the database too, not
// just here.
//
// WEEKLY VARIANCE IS THE EXCEPTION, and on purpose. It is not a standing
// condition that can "clear" — a reconciliation either moved the week's cost or
// it did not, and that stays true. So it is raised once, by the ingester, when
// the weekly file lands (varianceAlert below), and it resolves only when
// somebody acknowledges it. The evaluator never touches it.
//
// Every threshold is in timeclock-config.js. None is written here.

const { DAILY_FILE, WEEKLY_FILE, ALERT_THRESHOLDS, TIME_ZONE } = require('./timeclock-config');
const { normalizeEmpNumber } = require('./payroll-lib');
const { isSalaried, isActive } = require('./wage-sync');

const TYPES = {
  new_employee:        { label: 'New employee',        severity: 'warning'  },
  daily_file_missing:  { label: 'Daily file missing',  severity: 'critical' },
  weekly_file_missing: { label: 'Weekly file missing', severity: 'critical' },
  thin_day:            { label: 'Thin day',            severity: 'warning'  },
  zero_hour_rows:      { label: 'Zero-hour rows',      severity: 'warning'  },
  active_no_hours:     { label: 'Active, no hours',    severity: 'info'     },
  weekly_variance:     { label: 'Weekly variance',     severity: 'warning'  }
};

// Types the evaluator owns: it may open AND auto-resolve these.
const EVALUATED_TYPES = Object.keys(TYPES).filter(t => t !== 'weekly_variance');

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// ---- Pacific clock ----

function pacificParts(now, tz = TIME_ZONE) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short'
  }).formatToParts(now).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  const dow = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[p.weekday];
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hour: (+p.hour) % 24 + (+p.minute) / 60,
    dow
  };
}

function addDays(iso, n) {
  return new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
}
function isoDow(iso) {
  const d = new Date(iso + 'T00:00:00Z').getUTCDay();
  return d === 0 ? 7 : d;
}
function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------
//
// Inputs (all already loaded by the caller):
//   now             Date
//   employees       the roster
//   heldUnknown     daily_hours_held rows with reason 'unknown' (after any
//                   re-attribution the caller has done)
//   dailyRows       daily_hours rows from (window start - 4 weeks) to yesterday
//   hoursDays       hours_days rows over the same range
//   deliveredDates  dates a payroll email was imported for (processed_emails)
//   weeklyImports   hours_imports with source 'weekly' created since the start
//                   of LAST week
//   liveAlerts      alerts with status open/acknowledged
function evaluateConditions({
  now = new Date(),
  tz = TIME_ZONE,
  employees = [],
  heldUnknown = [],
  dailyRows = [],
  hoursDays = [],
  deliveredDates = [],
  weeklyImports = [],
  liveAlerts = [],
  config = ALERT_THRESHOLDS
} = {}) {
  const clock = pacificParts(now, tz);
  const today = clock.date;
  const yesterday = addDays(today, -1);
  const windowStart = addDays(today, -config.evaluateLookbackDays);
  const conditions = [];

  const live = new Map(liveAlerts.map(a => [`${a.type}|${a.alert_key}`, a]));
  const dayStatus = new Map(hoursDays.map(d => [String(d.work_date).slice(0, 10), d.status]));

  // Counted rows per day (daily_hours holds counted, rostered rows only).
  const rowsByDay = new Map();
  for (const r of dailyRows) {
    const d = String(r.work_date).slice(0, 10);
    if (!rowsByDay.has(d)) rowsByDay.set(d, []);
    rowsByDay.get(d).push(r);
  }

  // ---- New employee: an unknown number with held hours ----
  const unknown = new Map();
  for (const h of heldUnknown) {
    const key = normalizeEmpNumber(h.employee_number);
    if (!unknown.has(key)) {
      unknown.set(key, { employeeNumber: key, name: [h.first_name, h.last_name].filter(Boolean).join(' ') || null,
        dates: [], hours: 0 });
    }
    const u = unknown.get(key);
    u.dates.push(String(h.work_date).slice(0, 10));
    u.hours = round2(u.hours + num(h.total_hours));
  }
  for (const u of unknown.values()) {
    if (u.hours <= 0) continue;
    u.dates.sort();
    conditions.push({
      type: 'new_employee', alert_key: u.employeeNumber, employee_number: u.employeeNumber,
      work_date: u.dates[0],
      title: `Employee #${u.employeeNumber}${u.name ? ' ' + u.name : ''} is not on the roster`,
      details: {
        name: u.name, hours: u.hours, firstDate: u.dates[0], lastDate: u.dates[u.dates.length - 1],
        days: u.dates.length,
        action: 'Add them to the roster with this employee number, a department and a pay rate — ' +
                'their held hours then move in automatically. If they are BBSI staff, mark them so.'
      }
    });
  }

  // ---- Daily file missing ----
  // A day is owed once it is over and, for yesterday, once it is past the
  // grace hour. A day is delivered if any import covers it (hours_days) or an
  // email for it was imported (a "nobody has any time" day writes no rows).
  const delivered = new Set([...dayStatus.keys(), ...deliveredDates.map(d => String(d).slice(0, 10))]);
  for (let d = windowStart; d <= yesterday; d = addDays(d, 1)) {
    if (d === yesterday && clock.hour < DAILY_FILE.missingAfterHour) continue;
    if (delivered.has(d)) continue;
    conditions.push({
      type: 'daily_file_missing', alert_key: d, work_date: d,
      title: `No daily file for ${d}`,
      details: { expectedBy: `${DAILY_FILE.missingAfterHour}:00 AM Pacific on ${addDays(d, 1)}`,
        action: 'Ask BBSI to re-send the daily Work Summary Payroll file for this day, or import it by hand on Daily Hours.' }
    });
  }

  // ---- Weekly file missing ----
  // Only for the week that has just finished: the brief's weekly file is new,
  // so weeks before it was promised are not alerted on retroactively.
  const thisMonday = addDays(today, -(clock.dow - WEEKLY_FILE.dayOfWeek));
  const lastMonday = addDays(thisMonday, -7);
  const pastGrace = clock.dow > WEEKLY_FILE.dayOfWeek ||
    (clock.dow === WEEKLY_FILE.dayOfWeek && clock.hour >= WEEKLY_FILE.missingAfterHour);
  if (pastGrace && lastMonday >= WEEKLY_FILE.firstWeekStart) {
    // Arrived = a weekly import created this week, or one covering last week.
    const arrived = weeklyImports.some(i =>
      (i.created_at && pacificParts(new Date(i.created_at), tz).date >= thisMonday) ||
      (String(i.work_date_from).slice(0, 10) <= lastMonday && String(i.work_date_to).slice(0, 10) >= addDays(lastMonday, 6)));
    if (!arrived) {
      conditions.push({
        type: 'weekly_file_missing', alert_key: lastMonday, work_date: lastMonday,
        title: `No weekly file for the week of ${lastMonday}`,
        details: { weekStart: lastMonday, weekEnd: addDays(lastMonday, 6),
          expectedBy: `${WEEKLY_FILE.missingAfterHour}:00 AM Pacific on ${thisMonday}`,
          action: 'Until it arrives, last week is provisional: open punches still read 0.00.' }
      });
    }
  }

  // ---- Thin day ----
  for (let d = windowStart; d <= yesterday; d = addDays(d, 1)) {
    const count = (rowsByDay.get(d) || []).length;
    const priors = [];
    for (let w = 1; w <= config.thinDayLookbackWeeks; w++) {
      const p = addDays(d, -7 * w);
      const n = (rowsByDay.get(p) || []).length;
      if (n > 0) priors.push(n);
    }
    if (priors.length < 2) continue;
    const med = median(priors);
    if (med < config.thinDayMinMedianRows) continue;
    const threshold = med * config.thinDayRatio;
    const thin = count < threshold;
    const wasLive = live.has(`thin_day|${d}`);
    // Fires when thin. Clears only once the day is reconciled AND above the
    // threshold — a provisional day that happens to fill up is not trusted.
    if (thin || (wasLive && dayStatus.get(d) !== 'reconciled')) {
      if (!thin && !wasLive) continue;
      if (!delivered.has(d) && count === 0) continue;   // that is Daily file missing, not thin
      conditions.push({
        type: 'thin_day', alert_key: d, work_date: d,
        title: `${d} has ${count} hourly row${count === 1 ? '' : 's'} against a usual ${med}`,
        details: { rows: count, median: med, threshold: round2(threshold), priorCounts: priors,
          status: dayStatus.get(d) || null,
          action: 'Likely missing people or open punches. The weekly file should correct it; until then the day is understated.' }
      });
    }
  }

  // ---- Zero-hour rows on a provisional day ----
  for (let d = windowStart; d <= yesterday; d = addDays(d, 1)) {
    if (dayStatus.get(d) === 'reconciled') continue;
    const zeros = (rowsByDay.get(d) || []).filter(r => num(r.total_hours) === 0);
    if (!zeros.length) continue;
    conditions.push({
      type: 'zero_hour_rows', alert_key: d, work_date: d,
      title: `${zeros.length} hourly employee${zeros.length === 1 ? '' : 's'} at 0.00 hours on ${d}`,
      details: {
        count: zeros.length,
        employees: zeros.map(r => ({ employeeNumber: r.employee_number,
          name: [r.first_name, r.last_name].filter(Boolean).join(' ') || null })),
        action: 'Likely open punches at snapshot time. Resolves when the weekly file reconciles the day.'
      }
    });
  }

  // ---- Active, no hours (moved here from the Manufacturing Costs page) ----
  const recentFrom = addDays(yesterday, -(config.noHoursLookbackDays - 1));
  const recentDays = [];
  for (let d = recentFrom; d <= yesterday; d = addDays(d, 1)) recentDays.push(d);
  // If the feed itself is down, everybody has no hours; that is Daily file
  // missing, and naming sixty people would bury it.
  const feedRunning = recentDays.some(d => (rowsByDay.get(d) || []).length >= config.thinDayMinMedianRows);
  if (feedRunning) {
    const worked = new Set();
    for (const d of recentDays) {
      for (const r of rowsByDay.get(d) || []) if (num(r.total_hours) > 0) worked.add(normalizeEmpNumber(r.employee_number));
    }
    for (const emp of employees) {
      if (!isActive(emp) || isSalaried(emp)) continue;
      if (String(emp.pay_type || '').toLowerCase() !== 'hourly') continue;
      const key = normalizeEmpNumber(emp.employee_number);
      if (key && worked.has(key)) continue;
      conditions.push({
        type: 'active_no_hours', alert_key: key || `id:${emp.id}`, employee_number: key || null,
        title: `${emp.name || 'An active employee'} has no hours since ${recentFrom}`,
        details: { name: emp.name || null, department: emp.department || null, from: recentFrom, to: yesterday,
          noEmployeeNumber: !key,
          action: key
            ? 'Either off the whole period, or missing from the timeclock report. Resolves when hours arrive or they are made inactive.'
            : 'No employee number on the roster, so no timeclock row can ever match them. Add one.' }
      });
    }
  }

  for (const c of conditions) c.severity = TYPES[c.type].severity;
  return conditions;
}

// ---------------------------------------------------------------------------
// Weekly variance — raised by the ingester when a weekly file lands.
// ---------------------------------------------------------------------------

function varianceAlert(variance, { importId, config = ALERT_THRESHOLDS } = {}) {
  if (!variance || !variance.totals) return null;
  const t = variance.totals;
  const change = Math.abs(num(t.dollarsChange));
  const pct = t.dollarsBefore > 0 ? (change / t.dollarsBefore) * 100 : (change > 0 ? Infinity : 0);
  if (!(change > config.weeklyVarianceDollars || pct > config.weeklyVariancePct)) return null;
  return {
    type: 'weekly_variance',
    alert_key: `${variance.from}..${variance.to}${importId ? '|' + importId : ''}`,
    work_date: variance.from,
    severity: TYPES.weekly_variance.severity,
    title: `Reconciliation moved ${variance.from}–${variance.to} labor cost by ` +
           `${t.dollarsChange >= 0 ? '+' : '−'}$${Math.abs(round2(t.dollarsChange)).toLocaleString('en-US')}` +
           (Number.isFinite(pct) ? ` (${round2(pct)}%)` : ''),
    details: {
      importId: importId || null, from: variance.from, to: variance.to,
      dollarsBefore: t.dollarsBefore, dollarsAfter: t.dollarsAfter, dollarsChange: t.dollarsChange,
      hoursChange: t.hoursChange, pct: Number.isFinite(pct) ? round2(pct) : null,
      changedDays: variance.changedDays, fixedPunches: variance.fixedPunches.length,
      action: 'Review the variance summary, then acknowledge.'
    }
  };
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

function planAlertChanges({ conditions = [], liveAlerts = [], now = new Date() } = {}) {
  const want = new Map(conditions.map(c => [`${c.type}|${c.alert_key}`, c]));
  const insert = [];
  const update = [];
  const resolve = [];

  const liveKeys = new Set();
  for (const a of liveAlerts) {
    const key = `${a.type}|${a.alert_key}`;
    liveKeys.add(key);
    if (!EVALUATED_TYPES.includes(a.type)) continue;     // weekly_variance: hands off
    const c = want.get(key);
    if (!c) {
      resolve.push({ id: a.id, type: a.type, alert_key: a.alert_key,
        resolved_reason: 'condition cleared', resolved_at: now.toISOString() });
    } else if (JSON.stringify(c.details) !== JSON.stringify(a.details) || c.title !== a.title) {
      update.push({ id: a.id, title: c.title, details: c.details, severity: c.severity });
    }
  }
  for (const [key, c] of want) {
    if (liveKeys.has(key)) continue;
    insert.push({
      type: c.type, alert_key: c.alert_key, severity: c.severity,
      work_date: c.work_date || null, employee_number: c.employee_number || null,
      title: c.title, details: c.details || {}, status: 'open'
    });
  }
  return { insert, update, resolve };
}

module.exports = {
  TYPES,
  EVALUATED_TYPES,
  evaluateConditions,
  varianceAlert,
  planAlertChanges,
  pacificParts,
  addDays
};
