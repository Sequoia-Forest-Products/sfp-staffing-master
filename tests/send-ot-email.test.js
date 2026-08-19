// Run with: npm test   (node --test, no extra dependencies)
//
// /api/send-ot-email sends from the company Gmail account, so the recipient rule is a
// security boundary rather than a convenience. resolveRecipients() is pure, so it is
// exercised directly here — nothing loads nodemailer's transport or touches Supabase.

const test = require('node:test');
const assert = require('node:assert');

const { resolveRecipients, managersFromSettingsRow } =
  require('../netlify/functions/send-ot-email');

const MANAGERS = ['boss@sequoiafp.com', 'Outside.Auditor@example.com'];
const OPTS = { allowedDomain: 'sequoiafp.com', maxRecipients: 25 };

test('a saved manager off the company domain is still allowed', () => {
  const r = resolveRecipients(['outside.auditor@example.com'], MANAGERS, OPTS);
  assert.deepStrictEqual(r, { ok: true, recipients: ['outside.auditor@example.com'] });
});

test('an unsaved address on the company domain is allowed', () => {
  const r = resolveRecipients(['newhire@sequoiafp.com'], MANAGERS, OPTS);
  assert.strictEqual(r.ok, true);
});

test('an unsaved address off the company domain is refused and named', () => {
  const r = resolveRecipients(['attacker@evil.test'], MANAGERS, OPTS);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /attacker@evil\.test/);
});

test('one bad address poisons the whole call rather than being dropped quietly', () => {
  const r = resolveRecipients(['boss@sequoiafp.com', 'attacker@evil.test'], MANAGERS, OPTS);
  assert.strictEqual(r.ok, false);
});

test('a lookalike domain does not pass as the company domain', () => {
  for (const bad of ['x@notsequoiafp.com', 'x@sequoiafp.com.evil.test', 'x@sub.sequoiafp.com']) {
    assert.strictEqual(resolveRecipients([bad], MANAGERS, OPTS).ok, false, bad);
  }
});

test('addresses are compared case- and whitespace-insensitively', () => {
  const r = resolveRecipients(['  BOSS@SequoiaFP.com '], MANAGERS, OPTS);
  assert.deepStrictEqual(r.recipients, ['boss@sequoiafp.com']);
});

test('duplicates collapse to one send', () => {
  const r = resolveRecipients(['boss@sequoiafp.com', 'BOSS@sequoiafp.com'], MANAGERS, OPTS);
  assert.deepStrictEqual(r.recipients, ['boss@sequoiafp.com']);
});

test('no proposal falls back to the saved manager list', () => {
  assert.deepStrictEqual(resolveRecipients(undefined, MANAGERS, OPTS).recipients,
    ['boss@sequoiafp.com', 'outside.auditor@example.com']);
  assert.deepStrictEqual(resolveRecipients([], MANAGERS, OPTS).recipients,
    ['boss@sequoiafp.com', 'outside.auditor@example.com']);
});

test('an empty manager list sends to nobody rather than to the domain at large', () => {
  const r = resolveRecipients([], [], OPTS);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /No manager recipients/);
});

test('the recipient count is capped so a malformed call cannot fan out', () => {
  const many = Array.from({ length: 26 }, (_, i) => `p${i}@sequoiafp.com`);
  const r = resolveRecipients(many, MANAGERS, OPTS);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Too many recipients \(26\)/);
  assert.strictEqual(resolveRecipients(many.slice(0, 25), MANAGERS, OPTS).ok, true);
});

test('something that is not an email address at all is refused', () => {
  assert.strictEqual(resolveRecipients(['not-an-address'], MANAGERS, OPTS).ok, false);
});

test('the settings row is read whether it holds an object or a JSON string', () => {
  assert.deepStrictEqual(managersFromSettingsRow({ value: { managers: ['a@b.co'] } }), ['a@b.co']);
  assert.deepStrictEqual(managersFromSettingsRow({ value: '{"managers":["a@b.co"]}' }), ['a@b.co']);
});

test('a missing or unreadable settings row yields no managers, never a crash', () => {
  for (const row of [undefined, null, {}, { value: null }, { value: 'not json' }, { value: {} }]) {
    assert.deepStrictEqual(managersFromSettingsRow(row), []);
  }
});
