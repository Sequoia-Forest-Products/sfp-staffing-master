// The mill's overtime premium, in one named place.
//
// WHY THIS FILE EXISTS NOW. Until 2026-08-22 nothing here was needed: the daily
// payroll file carried Total Earnings, and ot_dollars was derived as the
// residual (total_earnings - regular_hours * pay_rate). That inherited the whole
// premium structure for free, without this system ever knowing what the tiers
// were.
//
// The file's money is no longer read. Timenet's pay rate was a human
// transcription from BBSI's payroll system into a hours-tracking tool, and its
// earnings were derived from that transcription — so it was a copy with
// authority it had not earned, silently overwriting ours every morning.
// employees.wage is the record of truth now, and every dollar this system
// reports is our rate times the file's hours. Which means the premium has to be
// computed here, deliberately, instead of arriving pre-baked.
//
// ------------------------------------------------------------------------
// THE RULE
// ------------------------------------------------------------------------
//
// California, 4x10 alternative workweek: 1.5x for hours 10 through 12 in a day,
// 2.0x above 12. Stated in SCHEMA_DAILY_HOURS.sql, which is also where the
// reason the old residual approach existed is recorded:
//
//   "ot_dollars is the residual ... not ot_hours * rate * 1.5: California 4x10
//    pays 1.5x from 10-12 hours and 2.0x above 12, and a flat 1.5x undercounts
//    the double-time tier by ~3%."
//
// That ~3% is why this file models the tiers rather than multiplying everything
// by 1.5. A flat rate would be simpler, consistently wrong in the same
// direction, and wrong in a figure managers act on.
//
// ------------------------------------------------------------------------
// WHAT IS OURS TO DECIDE, AND WHAT IS NOT
// ------------------------------------------------------------------------
//
// HOW MANY hours are overtime is the FILE's answer, not ours. It arrives split
// into regular_hours and ot_hours, and that split reflects rules this system
// does not model — most importantly California's seventh-consecutive-day rule.
// We take that classification as given.
//
// What this file decides is only the PREMIUM TIER for hours already classified
// as overtime: how the ot_hours divide between 1.5x and 2.0x.
//
// KNOWN LIMIT, stated rather than hidden. The tier split here is the DAILY one:
// hours past 12 in a day earn 2.0x. The seventh-consecutive-day rule (1.5x for
// the first 8 hours, 2.0x beyond) is not modelled, so overtime earned that way
// prices at 1.5x unless the day itself passed 12 hours. The mill runs MON-SUN
// and FRI-MON crews, so this is reachable. It understates rather than
// overstates, and only the premium — never the hours.

// The daily thresholds. Named, because a bare 10 and 12 in an arithmetic
// expression is exactly the kind of number that gets "tidied" by somebody who
// does not know it is law.
const DAILY_STRAIGHT_TIME_HOURS = 10;   // a full 4x10 shift
const DAILY_DOUBLE_TIME_AFTER   = 12;   // above this, 2.0x

const RATE_TIME_AND_HALF = 1.5;
const RATE_DOUBLE_TIME   = 2.0;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// One person, one day.
//
// Returns nulls for the money when there is no rate, rather than zeros. A
// person with hours and no rate on file is a data problem worth reporting by
// name, and a zero would fold silently into a total and understate it —
// which is the failure this system keeps finding and removing.
function dayPay(regularHours, otHours, rate) {
  const regular = Math.max(0, num(regularHours));
  const ot      = Math.max(0, num(otHours));

  // The split, before any rate is involved, so it is inspectable on its own and
  // is what the tests assert against.
  const total = regular + ot;
  // Hours past the double-time threshold — but never more OT than the file said
  // there was. If somebody's regular_hours alone exceed 12 (which would be the
  // file classifying oddly, not our business), the clamp keeps this from
  // inventing double time out of straight-time hours.
  //
  // Rounded to the cent-equivalent for hours, because the inputs are
  // numeric(10,2) and subtracting them produces float noise that would
  // otherwise be exposed in this return and in anything that displays it.
  const doubleTimeHours   = round2(Math.min(ot, Math.max(0, total - DAILY_DOUBLE_TIME_AFTER)));
  const timeAndHalfHours  = round2(ot - doubleTimeHours);

  const r = Number(rate);
  if (!Number.isFinite(r) || r <= 0) {
    return {
      regularHours: regular, otHours: ot,
      timeAndHalfHours, doubleTimeHours,
      regularDollars: null, otDollars: null, earnings: null, rate: null
    };
  }

  const regularDollars = round2(regular * r);
  const otDollars = round2(
    timeAndHalfHours * RATE_TIME_AND_HALF * r +
    doubleTimeHours  * RATE_DOUBLE_TIME   * r
  );

  return {
    regularHours: regular, otHours: ot,
    timeAndHalfHours, doubleTimeHours,
    regularDollars,
    otDollars,
    earnings: round2(regularDollars + otDollars),
    rate: r
  };
}

module.exports = {
  dayPay,
  DAILY_STRAIGHT_TIME_HOURS,
  DAILY_DOUBLE_TIME_AFTER,
  RATE_TIME_AND_HALF,
  RATE_DOUBLE_TIME
};
