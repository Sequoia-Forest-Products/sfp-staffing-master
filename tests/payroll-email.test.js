// Run with: npm test   (node --test, no extra dependencies)
//
// Every case drives runPayrollIngest()/runMissedDeliveryCheck() with injected
// messages and injected deps, so nothing touches IMAP, Supabase or Gmail —
// imapflow and nodemailer are never even loaded.

const test = require('node:test');
const assert = require('node:assert');
const { createHash } = require('node:crypto');

// Force the documented defaults regardless of what is in the shell environment.
for (const key of ['PAYROLL_IMAP_LABEL', 'PAYROLL_SENDER', 'PAYROLL_TIME_ZONE',
                   'PAYROLL_LOOKBACK_DAYS', 'PAYROLL_DRY_RUN']) {
  delete process.env[key];
}

const {
  deriveWorkDate,
  expectedPriorWorkDate,
  pickAttachment,
  isExpectedSender,
  dayInfo,
  runPayrollIngest,
  runMissedDeliveryCheck,
  XLSX_MIME,
  ATTACHMENT_NAME
} = require('../netlify/functions/payroll-email-lib');

const TZ = 'America/Los_Angeles';
const SENDER = 'no-reply@centralservers.com';

// 2026-08-19 is a Wednesday; 11:00 Pacific, i.e. after the morning delivery.
const NOW = new Date('2026-08-19T18:00:00Z');

const sha256 = buf => createHash('sha256').update(buf).digest('hex');

function workbook(tag = 'default') {
  return {
    filename: ATTACHMENT_NAME,
    contentType: XLSX_MIME,
    content: Buffer.from(`fake-xlsx-${tag}`)
  };
}

function message({
  id = '<msg-1@centralservers.com>',
  from = SENDER,
  subject = 'Work Summary Payroll',
  receivedAt = '2026-08-19T13:04:00Z',
  attachments
} = {}) {
  return {
    messageId: id,
    from,
    subject,
    receivedAt,
    attachments: attachments === undefined ? [workbook(id)] : attachments
  };
}

// A stand-in for payroll-lib.buildImport: it only has to return rows and a hash.
function fakeBuildImport(calls) {
  return (args) => {
    calls.push(args);
    return {
      workDate: args.workDate,
      fileHash: sha256(args.fileBuffer),
      uploadBatchId: args.uploadBatchId,
      rows: [
        { work_date: args.workDate, employee_number: '0101', total_hours: 10, flags: [] },
        { work_date: args.workDate, employee_number: '0202', total_hours: 8, flags: ['unknown_employee'] }
      ],
      counts: { totalRows: 2, imported: 2 },
      totals: { totalHours: 18 }
    };
  };
}

function harness(messages, overrides = {}, runOpts = {}) {
  const calls = { builds: [], upserts: [], ledger: [], alerts: [], fetchArgs: [] };
  const logs = [];

  const deps = Object.assign({
    fetchEmployees:       async () => [{ id: 'e1', employee_number: '0101', department: 'Production' }],
    fetchDailyHours:      async () => [],
    upsertDailyHours:     async rows => { calls.upserts.push(rows); return rows; },
    findRowsByFileHash:   async () => [],
    getProcessedEmail:    async () => null,
    upsertProcessedEmail: async rec => { calls.ledger.push(rec); return rec; },
    listProcessedEmails:  async () => [],
    buildImport:          fakeBuildImport(calls.builds),
    hashFile:             buf => sha256(buf),
    sendAlert:            async (subject, body) => { calls.alerts.push({ subject, body }); }
  }, overrides);

  return runPayrollIngest(Object.assign({
    now: NOW,
    timeZone: TZ,
    deps,
    log: (...a) => logs.push(a.join(' ')),
    fetchMessages: async (args) => { calls.fetchArgs.push(args); return messages; }
  }, runOpts)).then(result => ({ result, calls, logs }));
}

// ============================================================
// Work-date derivation
// ============================================================

test('the normal 6:04 AM Pacific arrival covers the previous Pacific day', () => {
  const d = deriveWorkDate('2026-08-19T13:04:00Z', TZ); // 06:04 PDT Wed Aug 19
  assert.strictEqual(d.workDate, '2026-08-18');
  assert.strictEqual(d.lateArrival, false);
  assert.strictEqual(d.receivedLocal.hour, 6);
});

test('the zone conversion happens BEFORE the calendar date is taken', () => {
  // 07:30 UTC on Jan 20 is 23:30 PST on Jan 19. Reading the UTC date first would
  // give a work date of Jan 19; reading Pacific first gives Jan 18.
  const pst = deriveWorkDate('2026-01-20T07:30:00Z', TZ);
  assert.strictEqual(pst.receivedLocal.day, 19);
  assert.strictEqual(pst.workDate, '2026-01-18');

  // 07:30 UTC in summer is 00:30 PDT the same day — still the day before that.
  const pdt = deriveWorkDate('2026-08-19T07:30:00Z', TZ);
  assert.strictEqual(pdt.receivedLocal.hour, 0);
  assert.strictEqual(pdt.workDate, '2026-08-18');
});

test('a DST boundary does not shift the derived day', () => {
  // 2026-03-08 is the spring-forward Sunday. The Monday delivery covers it.
  const spring = deriveWorkDate('2026-03-09T13:04:00Z', TZ); // 06:04 PDT Mon Mar 9
  assert.strictEqual(spring.workDate, '2026-03-08');
  assert.strictEqual(spring.lateArrival, false);

  // 2026-11-01 is the fall-back Sunday; the same wall-clock arrival, a new offset.
  const fall = deriveWorkDate('2026-11-02T14:04:00Z', TZ); // 06:04 PST Mon Nov 2
  assert.strictEqual(fall.workDate, '2026-11-01');
  assert.strictEqual(fall.receivedLocal.hour, 6);
});

test('a Monday arrival resolves to Sunday, which is a legitimate work day', () => {
  const d = deriveWorkDate('2026-08-17T13:04:00Z', TZ); // Mon Aug 17
  assert.strictEqual(d.workDate, '2026-08-16');
  const info = dayInfo(d.workDate);
  assert.strictEqual(info.dayName, 'Sunday');
  assert.strictEqual(info.isScheduledDay, false); // classified, never rejected
});

test('arrival hour drives the late_arrival signal, not the date', () => {
  assert.strictEqual(deriveWorkDate('2026-08-19T11:00:00Z', TZ).lateArrival, false); // 04:00
  assert.strictEqual(deriveWorkDate('2026-08-19T16:59:00Z', TZ).lateArrival, false); // 09:59
  assert.strictEqual(deriveWorkDate('2026-08-19T17:00:00Z', TZ).lateArrival, true);  // 10:00
  assert.strictEqual(deriveWorkDate('2026-08-19T10:30:00Z', TZ).lateArrival, true);  // 03:30
});

test('an unusable timestamp yields no date at all rather than a guess', () => {
  assert.strictEqual(deriveWorkDate(null, TZ), null);
  assert.strictEqual(deriveWorkDate('not a date', TZ), null);
});

test('expectedPriorWorkDate is yesterday in Pacific', () => {
  assert.strictEqual(expectedPriorWorkDate(NOW, TZ), '2026-08-18');
  // 05:00 UTC is still the previous evening in Pacific.
  assert.strictEqual(expectedPriorWorkDate(new Date('2026-08-19T05:00:00Z'), TZ), '2026-08-17');
});

// ============================================================
// Message inspection
// ============================================================

test('the attachment is matched by name, then by xlsx MIME type', () => {
  const other = { filename: 'signature.png', contentType: 'image/png', content: Buffer.from('x') };
  const book = workbook('a');
  assert.strictEqual(pickAttachment([other, book]), book);

  const renamed = { filename: 'export(1).xlsx', contentType: XLSX_MIME, content: Buffer.from('y') };
  assert.strictEqual(pickAttachment([other, renamed]), renamed);

  assert.strictEqual(pickAttachment([other]), null);
  assert.strictEqual(pickAttachment([]), null);
  assert.strictEqual(pickAttachment(undefined), null);
});

test('only the configured sender is accepted', () => {
  assert.ok(isExpectedSender(SENDER));
  assert.ok(isExpectedSender(`Payroll <${SENDER.toUpperCase()}>`));
  assert.ok(!isExpectedSender('accounts@customer.example'));
  assert.ok(!isExpectedSender(''));
  assert.ok(!isExpectedSender(null));
});

// ============================================================
// Ingest
// ============================================================

test('only the configured label is ever asked for', async () => {
  const { calls } = await harness([]);
  assert.strictEqual(calls.fetchArgs.length, 1);
  assert.strictEqual(calls.fetchArgs[0].label, 'payroll import');
  assert.strictEqual(calls.fetchArgs[0].sinceDate, '2026-08-12'); // 7-day rolling window
});

test('a good message imports and stamps the email provenance on every row', async () => {
  const { result, calls } = await harness([message()]);

  assert.strictEqual(result.status, 'ok');
  assert.strictEqual(result.checked, 1);
  assert.strictEqual(result.imported, 1);
  assert.strictEqual(result.results[0].status, 'imported');
  assert.strictEqual(result.results[0].workDate, '2026-08-18');
  assert.strictEqual(result.results[0].rowsImported, 2);

  const built = calls.builds[0];
  assert.strictEqual(built.source, 'email');
  assert.strictEqual(built.dateSource, 'email_received');
  assert.strictEqual(built.sourceSubject, 'Work Summary Payroll');
  assert.strictEqual(built.emailReceivedAt, '2026-08-19T13:04:00.000Z');
  assert.strictEqual(built.timeZone, TZ);
  assert.ok(built.uploadBatchId);

  assert.strictEqual(calls.upserts.length, 1);
  assert.strictEqual(calls.alerts.length, 0);

  const record = calls.ledger[0];
  assert.strictEqual(record.status, 'imported');
  assert.strictEqual(record.work_date, '2026-08-18');
  assert.strictEqual(record.rows_imported, 2);
  assert.strictEqual(record.from_address, SENDER);
  assert.strictEqual(record.notified_at, null);
});

test('a message from the wrong sender is rejected and never parsed', async () => {
  const { result, calls } = await harness([
    message({ id: '<spam-1@example.com>', from: 'Accounts <billing@customer.example>' })
  ]);

  assert.strictEqual(result.results[0].status, 'rejected');
  assert.ok(result.results[0].flags.includes('wrong_sender'));
  assert.strictEqual(calls.builds.length, 0, 'buildImport must never run for a foreign sender');
  assert.strictEqual(calls.upserts.length, 0);
  assert.strictEqual(calls.alerts.length, 1);
  assert.strictEqual(calls.ledger[0].status, 'rejected');
  assert.ok(calls.ledger[0].notified_at);
});

test('a file already imported under a different work date is not re-imported', async () => {
  const { result, calls } = await harness([message()], {
    findRowsByFileHash: async () => [{ work_date: '2026-08-11', file_hash: 'whatever' }]
  });

  assert.strictEqual(result.results[0].status, 'duplicate_file');
  assert.strictEqual(result.imported, 0);
  assert.strictEqual(calls.upserts.length, 0);
  assert.strictEqual(calls.alerts.length, 1);
  assert.match(result.results[0].error, /2026-08-11/);
});

test('the same file re-delivered for the same date is ignored quietly', async () => {
  const { result, calls } = await harness([message()], {
    findRowsByFileHash: async () => [{ work_date: '2026-08-18', file_hash: 'same' }]
  });

  assert.strictEqual(result.results[0].status, 'duplicate_file');
  assert.strictEqual(calls.upserts.length, 0);
  assert.strictEqual(calls.alerts.length, 0, 'a harmless re-delivery must not page anyone');
});

test('two different files resolving to the same work date are both parked', async () => {
  const messages = [
    message({ id: '<a@centralservers.com>', receivedAt: '2026-08-19T13:04:00Z',
              attachments: [workbook('first')] }),
    message({ id: '<b@centralservers.com>', receivedAt: '2026-08-19T13:40:00Z',
              attachments: [workbook('second')] })
  ];
  const { result, calls } = await harness(messages);

  assert.strictEqual(result.checked, 2);
  assert.strictEqual(result.imported, 0);
  assert.strictEqual(result.flagged, 2);
  for (const r of result.results) {
    assert.strictEqual(r.status, 'pending_review');
    assert.ok(r.flags.includes('duplicate_day'));
  }
  assert.strictEqual(calls.upserts.length, 0, 'neither file may be imported');
  assert.strictEqual(calls.alerts.length, 1);
});

test('a date already holding rows from a different file is not overwritten', async () => {
  const { result, calls } = await harness([message()], {
    // A manual import: real rows, no file hash.
    fetchDailyHours: async () => [{ work_date: '2026-08-18', file_hash: null }]
  });

  assert.strictEqual(result.results[0].status, 'pending_review');
  assert.ok(result.results[0].flags.includes('duplicate_day'));
  assert.strictEqual(calls.upserts.length, 0);
  assert.strictEqual(calls.alerts.length, 1);
});

test('an already-processed Message-ID is skipped without re-parsing', async () => {
  const { result, calls } = await harness([message()], {
    getProcessedEmail: async () => ({
      message_id: '<msg-1@centralservers.com>', status: 'imported', work_date: '2026-08-18'
    })
  });

  assert.strictEqual(result.results[0].status, 'skipped');
  assert.strictEqual(result.results[0].previousStatus, 'imported');
  assert.strictEqual(calls.builds.length, 0);
  assert.strictEqual(calls.upserts.length, 0);
  assert.strictEqual(calls.ledger.length, 0, 'a skipped message must not rewrite its ledger row');
  assert.strictEqual(calls.alerts.length, 0);
});

test('a message with no matching attachment is recorded as an error and alerts', async () => {
  const { result, calls } = await harness([
    message({ attachments: [{ filename: 'note.pdf', contentType: 'application/pdf', content: Buffer.from('x') }] })
  ]);

  assert.strictEqual(result.results[0].status, 'error');
  assert.ok(result.results[0].flags.includes('no_attachment'));
  assert.strictEqual(result.errors, 1);
  assert.strictEqual(calls.builds.length, 0);
  assert.strictEqual(calls.alerts.length, 1);
  assert.strictEqual(calls.ledger[0].status, 'error');
});

test('a late arrival still imports, but carries the late_arrival flag', async () => {
  const { result, calls } = await harness([
    message({ receivedAt: '2026-08-19T18:20:00Z' }) // 11:20 Pacific
  ]);

  const r = result.results[0];
  assert.strictEqual(r.status, 'imported');
  assert.strictEqual(r.workDate, '2026-08-18');
  assert.ok(r.flags.includes('late_arrival'));
  assert.strictEqual(calls.upserts.length, 1);
  // The flag lands on the batch as well as on the ledger row.
  for (const row of calls.upserts[0]) assert.ok(row.flags.includes('late_arrival'));
  assert.ok(calls.ledger[0].flags.includes('late_arrival'));
  assert.strictEqual(calls.alerts.length, 1);
});

test('a future work date is refused outright', async () => {
  const { result, calls } = await harness([
    message({ receivedAt: '2026-08-21T13:04:00Z' }) // work date 2026-08-20, now is the 19th
  ]);

  assert.strictEqual(result.results[0].status, 'pending_review');
  assert.ok(result.results[0].flags.includes('future_date'));
  assert.strictEqual(calls.builds.length, 0);
  assert.strictEqual(calls.upserts.length, 0);
  assert.strictEqual(calls.alerts.length, 1);
});

test('a message with no usable timestamp is parked, never dated by guesswork', async () => {
  const { result, calls } = await harness([message({ receivedAt: null })]);

  assert.strictEqual(result.results[0].status, 'pending_review');
  assert.strictEqual(result.results[0].workDate, null);
  assert.ok(result.results[0].flags.includes('unknown_received_time'));
  assert.strictEqual(calls.upserts.length, 0);
});

test('a dry run writes nothing at all', async () => {
  const { result, calls } = await harness(
    [message(), message({ id: '<bad@x.example>', from: 'someone@else.example' })],
    {},
    { dryRun: true }
  );

  assert.strictEqual(result.status, 'dry-run');
  assert.strictEqual(result.dryRun, true);
  assert.strictEqual(result.results[0].status, 'dry_run');
  assert.strictEqual(result.results[0].rowsImported, 2);
  assert.strictEqual(calls.upserts.length, 0, 'daily_hours must not be written in a dry run');
  assert.strictEqual(calls.ledger.length, 0, 'processed_emails must not be written in a dry run');
  assert.strictEqual(calls.alerts.length, 0, 'a dry run must not email anyone');
});

test('PAYROLL_DRY_RUN=true suppresses writes even without an explicit flag', async () => {
  process.env.PAYROLL_DRY_RUN = 'true';
  try {
    const { result, calls } = await harness([message()]);
    assert.strictEqual(result.dryRun, true);
    assert.strictEqual(calls.upserts.length, 0);
    assert.strictEqual(calls.ledger.length, 0);
  } finally {
    delete process.env.PAYROLL_DRY_RUN;
  }
});

test('a failure on one message does not stop the others', async () => {
  let call = 0;
  const written = [];
  const messages = [
    message({ id: '<x1@centralservers.com>', receivedAt: '2026-08-18T13:04:00Z' }),
    message({ id: '<x2@centralservers.com>', receivedAt: '2026-08-19T13:04:00Z' })
  ];
  const { result, calls } = await harness(messages, {
    upsertDailyHours: async rows => {
      if (++call === 1) throw new Error('supabase exploded');
      written.push(rows);
      return rows;
    }
  });

  assert.strictEqual(result.results[0].status, 'error');
  assert.match(result.results[0].error, /supabase exploded/);
  assert.strictEqual(result.results[1].status, 'imported');
  assert.strictEqual(result.imported, 1);
  assert.strictEqual(written.length, 1);
  assert.strictEqual(calls.alerts.length, 1);
});

// ============================================================
// Missed-delivery check
// ============================================================

function missedHarness(now, overrides = {}, runOpts = {}) {
  const calls = { alerts: [], ranges: [], ledgerOpts: [] };
  const deps = Object.assign({
    fetchDailyHours: async (from, to) => { calls.ranges.push([from, to]); return []; },
    listProcessedEmails: async (opts) => { calls.ledgerOpts.push(opts); return []; },
    sendAlert: async (subject, body) => { calls.alerts.push({ subject, body }); }
  }, overrides);

  return runMissedDeliveryCheck(Object.assign({
    now: new Date(now), timeZone: TZ, lookbackDays: 1, deps, log: () => {}
  }, runOpts)).then(result => ({ result, calls }));
}

test('a missing Monday escalates', async () => {
  // 2026-08-17 is a Monday; the check runs on Tuesday the 18th.
  const { result, calls } = await missedHarness('2026-08-18T18:00:00Z');

  assert.strictEqual(result.checkedDate, '2026-08-17');
  assert.strictEqual(result.missing.length, 1);
  assert.strictEqual(result.missing[0].dayName, 'Monday');
  assert.strictEqual(result.missing[0].escalate, true);
  // payroll-db's status filter is single-valued — ask for "not imported".
  assert.deepStrictEqual(calls.ledgerOpts[0], { notStatus: 'imported', limit: 200 });
  assert.strictEqual(result.notified, true);
  assert.strictEqual(result.status, 'attention');
  assert.match(calls.alerts[0].subject, /2026-08-17/);
});

test('a missing Saturday is reported but does not alert', async () => {
  // 2026-08-15 is a Saturday; the check runs on Sunday the 16th.
  const { result, calls } = await missedHarness('2026-08-16T18:00:00Z');

  assert.strictEqual(result.checkedDate, '2026-08-15');
  assert.strictEqual(result.missing.length, 1);
  assert.strictEqual(result.missing[0].dayName, 'Saturday');
  assert.strictEqual(result.missing[0].escalate, false);
  assert.strictEqual(result.notified, false);
  assert.strictEqual(result.status, 'ok');
  assert.strictEqual(calls.alerts.length, 0);
});

test('a day that has rows is not missing', async () => {
  const { result, calls } = await missedHarness('2026-08-18T18:00:00Z', {
    fetchDailyHours: async () => [{ work_date: '2026-08-17', employee_number: '0101' }]
  });

  assert.deepStrictEqual(result.missing, []);
  assert.strictEqual(result.notified, false);
  assert.strictEqual(calls.alerts.length, 0);
});

test('emails parked in pending_review or error are surfaced and escalated', async () => {
  const { result, calls } = await missedHarness('2026-08-18T18:00:00Z', {
    fetchDailyHours: async () => [{ work_date: '2026-08-17' }],
    listProcessedEmails: async () => [
      { message_id: '<a@x>', status: 'pending_review', work_date: null, subject: 'Work Summary Payroll',
        error: 'two files resolve to 2026-08-16' },
      { message_id: '<b@x>', status: 'imported', work_date: '2026-08-17' }
    ]
  });

  assert.strictEqual(result.pendingReview.length, 1, 'imported rows must not be surfaced');
  assert.strictEqual(result.pendingReview[0].messageId, '<a@x>');
  assert.strictEqual(result.notified, true);
  assert.strictEqual(calls.alerts.length, 1);
});

test('the missed check scans the whole lookback window', async () => {
  const { result, calls } = await missedHarness('2026-08-19T18:00:00Z', {}, { lookbackDays: 4 });

  assert.deepStrictEqual(calls.ranges[0], ['2026-08-15', '2026-08-18']);
  assert.deepStrictEqual(result.missing.map(m => m.date),
    ['2026-08-15', '2026-08-16', '2026-08-17', '2026-08-18']);
  assert.deepStrictEqual(result.missing.filter(m => m.escalate).map(m => m.dayName),
    ['Monday', 'Tuesday']);
});

test('a dry-run missed check sends nothing', async () => {
  const { result, calls } = await missedHarness('2026-08-18T18:00:00Z', {}, { dryRun: true });

  assert.strictEqual(result.status, 'dry-run');
  assert.strictEqual(result.notified, false);
  assert.strictEqual(calls.alerts.length, 0);
});
