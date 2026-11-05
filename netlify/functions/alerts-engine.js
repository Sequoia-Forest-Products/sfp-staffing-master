// The alerts engine: load, re-attribute, evaluate, write. All decisions are in
// alerts-lib.js; this file only moves data, so `db` is injectable and the
// tests drive it with an in-memory stand-in.
//
// Run from three places, all of them idempotent:
//   * alerts-evaluate   hourly scheduled function (missing-file alerts need a
//                       clock, not an event)
//   * payroll-email-lib after every ingest run
//   * /api/alerts       when the Alerts tab is opened or refreshed

const {
  evaluateConditions, planAlertChanges, varianceAlert, pacificParts, addDays
} = require('./alerts-lib');
const { ALERT_THRESHOLDS, WEEKLY_FILE, TIME_ZONE } = require('./timeclock-config');
const { normalizeEmpNumber } = require('./payroll-lib');
const { isSalaried } = require('./wage-sync');

// A held 'unknown' number that has since been added to the roster (or marked
// as BBSI staff) is moved to where it now belongs BEFORE conditions are read,
// which is what makes the New employee alert resolve itself:
//   on the roster, hourly   -> rows move into daily_hours (counted)
//   on the roster, salaried -> rows stay held, reason 'salaried'
//   BBSI staff              -> rows stay held, reason 'external'
async function reattribute({ db, employees, exclusions, heldUnknown, log }) {
  const roster = new Map();
  for (const e of employees) {
    const k = normalizeEmpNumber(e && e.employee_number);
    if (k && !roster.has(k)) roster.set(k, e);
  }
  const excluded = new Set(exclusions.map(x => normalizeEmpNumber(x.employee_number)));
  const numbers = [...new Set(heldUnknown.map(h => normalizeEmpNumber(h.employee_number)))];
  const moved = [];

  for (const n of numbers) {
    if (excluded.has(n)) {
      await db.markHeldExternal(n);
      moved.push({ employeeNumber: n, to: 'external' });
      continue;
    }
    const emp = roster.get(n);
    if (!emp) continue;
    if (isSalaried(emp)) {
      await db.updateHeldReason(n, 'unknown', 'salaried');
      moved.push({ employeeNumber: n, to: 'salaried' });
    } else {
      const count = await db.reattributeHeld(n, emp.department || null);
      moved.push({ employeeNumber: n, to: 'counted', rows: count });
      log(`Re-attributed ${count} held row(s) for #${n} (${emp.name || 'unnamed'}) into daily_hours`);
    }
  }
  return moved;
}

async function applyPlan(db, plan) {
  let inserted = 0;
  for (const row of plan.insert) {
    try {
      await db.insertAlert(row);
      inserted++;
    } catch (err) {
      // Two runs racing on the same condition: the unique index refused the
      // second insert, which is the point of it. Anything else is real.
      if (!/23505|duplicate key/.test(err.message)) throw err;
    }
  }
  for (const u of plan.update) {
    await db.updateAlert(u.id, { title: u.title, details: u.details, severity: u.severity });
  }
  for (const r of plan.resolve) {
    await db.updateAlert(r.id, { status: 'resolved', resolved_at: r.resolved_at, resolved_reason: r.resolved_reason });
  }
  return { inserted, updated: plan.update.length, resolved: plan.resolve.length };
}

async function runAlertEvaluation({ now = new Date(), db = require('./payroll-db'), log = () => {} } = {}) {
  const today = pacificParts(now, TIME_ZONE).date;
  const yesterday = addDays(today, -1);
  const windowStart = addDays(today, -ALERT_THRESHOLDS.evaluateLookbackDays);
  // Four extra weeks before the window, for the thin-day medians.
  const readFrom = addDays(windowStart, -7 * ALERT_THRESHOLDS.thinDayLookbackWeeks);

  const [employees, exclusions] = await Promise.all([db.fetchEmployees(), db.fetchExclusions()]);
  let heldUnknown = await db.fetchHeldRows({ reason: 'unknown' });

  const moved = await reattribute({ db, employees: employees || [], exclusions: exclusions || [],
    heldUnknown: heldUnknown || [], log });
  if (moved.length) heldUnknown = await db.fetchHeldRows({ reason: 'unknown' });

  const clock = pacificParts(now, TIME_ZONE);
  const thisMonday = addDays(today, -(clock.dow - WEEKLY_FILE.dayOfWeek));

  const [dailyRows, hoursDays, deliveries, weeklyImports, liveAlerts] = await Promise.all([
    db.fetchDailyHoursAll(readFrom, yesterday),
    db.fetchHoursDays(readFrom, yesterday),
    db.fetchDeliveriesForDates(windowStart, yesterday),
    db.fetchImports({ source: 'weekly', from: addDays(thisMonday, -7) }),
    db.fetchAlerts({ statuses: ['open', 'acknowledged'] })
  ]);

  const conditions = evaluateConditions({
    now, tz: TIME_ZONE,
    employees: employees || [],
    heldUnknown: heldUnknown || [],
    dailyRows: dailyRows || [],
    hoursDays: hoursDays || [],
    deliveredDates: (deliveries || []).filter(d => d.status === 'imported').map(d => d.work_date),
    weeklyImports: weeklyImports || [],
    liveAlerts: liveAlerts || []
  });
  const plan = planAlertChanges({ conditions, liveAlerts: liveAlerts || [], now });
  const applied = await applyPlan(db, plan);
  log(`Alerts: ${conditions.length} condition(s); ${applied.inserted} opened, ` +
      `${applied.updated} refreshed, ${applied.resolved} resolved; ${moved.length} held number(s) re-attributed.`);
  return { conditions: conditions.length, ...applied, reattributed: moved };
}

// Raised once by the ingester when a weekly file is applied.
async function raiseVarianceAlert({ variance, importId, db = require('./payroll-db') }) {
  const row = varianceAlert(variance, { importId });
  if (!row) return null;
  try {
    return await db.insertAlert({ ...row, status: 'open' });
  } catch (err) {
    if (/23505|duplicate key/.test(err.message)) return null;
    throw err;
  }
}

module.exports = { runAlertEvaluation, raiseVarianceAlert, reattribute, applyPlan };
