// What a classification change means, decided purely.
//
// The four fields here — department, position, position_group, cost_class —
// decide which cost centre a person's hours land in, which line of the
// Manufacturing Costs report they appear on, and whether they show up in the
// Bullpen. Until now every change to them overwrote the row in place and left
// no trace, so "what was his department in March" had no answer anywhere.
//
// This decides WHAT to record. netlify/functions/data.js does the writing, and
// writes the history BEFORE it updates the employee — the same ordering
// wage_history uses, and for the same reason: a failure between the two leaves
// a record with no change rather than a change with no record. Only one of
// those is repairable.
//
// Pure, so the rules below are testable without a database anywhere near them.

const TRACKED_FIELDS = ['department', 'position', 'position_group', 'cost_class'];

// '' and null and '   ' are all "no value" and all normalise to null.
//
// This matters more than it looks. A <select> with no selection posts '', the
// database holds null, and comparing them raw makes every save of an
// unclassified person look like a change from null to '' — a history full of
// rows recording nothing, which is how a history stops being read.
function normalize(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

// `body` is what the caller is trying to write; `before` is the row as the
// DATABASE has it. A field ABSENT from the body is not a change to null — a
// PATCH that sends only { phone } says nothing about anybody's department — so
// only fields the body actually carries are considered.
//
// Returns one row per FIELD that moved, not one row per save. A transfer that
// changes department and cost_class together is two facts, and answering "when
// did he leave Production" should not mean unpacking a blob.
function planPositionHistory({ before, body, editorEmail = null, now = new Date(), note = null } = {}) {
  if (!before || !body) return [];

  const rows = [];
  for (const field of TRACKED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) continue;

    const previous = normalize(before[field]);
    const next = normalize(body[field]);
    if (previous === next) continue;

    rows.push({
      employee_id: before.id,
      // Denormalised deliberately: the history has to still say who it was
      // about when read next to a roster that has moved on.
      employee_name: before.name || null,
      employee_number: before.employee_number || null,
      field,
      previous_value: previous,
      new_value: next,
      changed_by: editorEmail || null,
      changed_at: now.toISOString(),
      note
    });
  }
  return rows;
}

// True when the body touches any tracked field at all — the cheap check that
// decides whether data.js needs to read the current row before writing.
function touchesTrackedField(body) {
  if (!body) return false;
  return TRACKED_FIELDS.some(f => Object.prototype.hasOwnProperty.call(body, f));
}

module.exports = { planPositionHistory, touchesTrackedField, normalize, TRACKED_FIELDS };
