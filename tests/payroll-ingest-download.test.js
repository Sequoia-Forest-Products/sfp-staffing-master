// Run with: npm test
//
// The ingest re-downloaded every attachment in the lookback window on every
// run. Listing the window is one IMAP FETCH; downloading is a round trip per
// message, and the processed_emails ledger was only consulted afterwards, in
// the classify phase. So the cost grew with the SIZE OF THE WINDOW rather than
// with the number of new messages: with a seven-day window and daily delivery
// that settles at seven downloads an hour, for ever, to import one file.
//
// Dry runs took 18, 33 and 37 seconds with a SINGLE message in the window, and
// the synchronous test endpoint already 502s past its wall, so the growth was
// worth removing before the window filled rather than after.
//
// These tests drive fetchLabeledMessages with a fake ImapFlow, because the one
// thing worth pinning is a negative -- that download() is never called for a
// message already in the ledger -- and that is invisible from outside.

const test = require('node:test');
const assert = require('node:assert');
const { Readable } = require('node:stream');

const {
  fetchLabeledMessages, knownMessageIds, runPayrollIngest, ATTACHMENT_NAME
} = require('../netlify/functions/payroll-email-lib');

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PART = '2';

// A mailbox of messages, and a record of every download asked for.
function fakeImap(messageIds, downloads) {
  return class FakeImapFlow {
    async connect() {}
    async logout() {}
    close() {}
    async list() { return [{ path: 'payroll import' }]; }
    async getMailboxLock() { return { release() {} }; }
    async mailboxOpen() { this.mailbox = { path: 'payroll import' }; return this.mailbox; }

    async *fetch() {
      let uid = 100;
      for (const id of messageIds) {
        yield {
          uid: uid++,
          envelope: {
            messageId: id,
            subject: 'Your Report Work Summary Payroll is ready',
            from: [{ address: 'no-reply@centralservers.com' }]
          },
          internalDate: new Date('2026-08-20T13:04:59Z'),
          bodyStructure: {
            childNodes: [
              { part: '1', type: 'text/html' },
              {
                part: PART,
                type: XLSX,
                dispositionParameters: { filename: ATTACHMENT_NAME },
                parameters: { name: ATTACHMENT_NAME }
              }
            ]
          }
        };
      }
    }

    async download(uid, part) {
      downloads.push({ uid, part });
      return { content: Readable.from([Buffer.from('PK fake workbook bytes')]) };
    }
  };
}

function read(messageIds, opts = {}) {
  const downloads = [];
  return fetchLabeledMessages(Object.assign({
    label: 'payroll import',
    sinceDate: '2026-08-14',
    host: 'imap.test',
    user: 'info@sequoiafp.com',
    password: 'x',
    imapFlow: fakeImap(messageIds, downloads),
    log: () => {}
  }, opts)).then(messages => ({ messages, downloads }));
}

const ID = n => '<msg-' + n + '@centralservers.com>';
const workbookOf = m => m.attachments.find(a => a.filename === ATTACHMENT_NAME);

// ---------------------------------------------------------------------------
// The fix
// ---------------------------------------------------------------------------

test('an attachment already in the ledger is not downloaded', async () => {
  const { messages, downloads } = await read([ID(1), ID(2), ID(3)], {
    alreadyProcessed: async () => [ID(1), ID(2)]
  });

  assert.strictEqual(downloads.length, 1, 'only the one new message should be fetched');
  assert.strictEqual(downloads[0].uid, 102, 'and it should be the third message');

  // The skipped ones still come back as messages -- the classify phase needs to
  // see them to report them as skipped. They just carry no bytes.
  assert.strictEqual(messages.length, 3);
  assert.strictEqual(workbookOf(messages[0]).downloadSkipped, true);
  assert.strictEqual(workbookOf(messages[0]).content, null);
  assert.ok(Buffer.isBuffer(workbookOf(messages[2]).content), 'the new one has its bytes');
  assert.strictEqual(workbookOf(messages[2]).downloadSkipped, undefined);
});

test('the pre-check is asked about every listed message, once', async () => {
  const asked = [];
  await read([ID(1), ID(2), ID(3)], {
    alreadyProcessed: async ids => { asked.push(ids); return []; }
  });

  assert.strictEqual(asked.length, 1, 'one batch, not one call per message');
  assert.deepStrictEqual(asked[0], [ID(1), ID(2), ID(3)]);
});

test('nothing is downloaded when the whole window is already imported', async () => {
  // The steady state this change exists for: seven days in the window, all
  // imported, one file arriving. Before, that was seven downloads an hour.
  const ids = Array.from({ length: 7 }, (_, i) => ID(i));
  const { downloads } = await read(ids, { alreadyProcessed: async () => ids });
  assert.strictEqual(downloads.length, 0);
});

test('every attachment is still downloaded when no pre-check is supplied', async () => {
  // An injected fetchMessages, and every existing caller that predates this.
  const { downloads } = await read([ID(1), ID(2)]);
  assert.strictEqual(downloads.length, 2);
});

// ---------------------------------------------------------------------------
// Failing open
// ---------------------------------------------------------------------------

test('a ledger failure downloads everything rather than skipping blind', async () => {
  // A slow run that imports correctly beats a fast one that skips a message it
  // only assumed was handled. Supabase being unreachable must not cost a day of
  // payroll.
  const logged = [];
  const { downloads } = await read([ID(1), ID(2)], {
    alreadyProcessed: async () => { throw new Error('supabase unreachable'); },
    log: m => logged.push(String(m))
  });

  assert.strictEqual(downloads.length, 2, 'both attachments fetched');
  assert.ok(logged.some(m => /ledger pre-check failed/.test(m)), 'and it says so in the log');
});

test('a pre-check naming an unknown id skips nothing by accident', async () => {
  const { downloads } = await read([ID(1), ID(2)], {
    alreadyProcessed: async () => ['<not-in-this-mailbox@x>']
  });
  assert.strictEqual(downloads.length, 2);
});

// ---------------------------------------------------------------------------
// knownMessageIds
// ---------------------------------------------------------------------------

test('knownMessageIds returns only the ids the ledger has, de-duplicated', async () => {
  const asked = [];
  const getProcessedEmail = async id => {
    asked.push(id);
    return id === ID(2) ? { message_id: id, status: 'imported' } : null;
  };

  const known = await knownMessageIds(getProcessedEmail, [ID(1), ID(2), ID(3), ID(2), null, '']);
  assert.deepStrictEqual(known, [ID(2)]);
  assert.deepStrictEqual(asked, [ID(1), ID(2), ID(3)], 'no repeats, no empties');
});

test('knownMessageIds stays inside its concurrency bound', async () => {
  let inFlight = 0;
  let peak = 0;
  const getProcessedEmail = async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise(r => setImmediate(r));
    inFlight--;
    return null;
  };

  await knownMessageIds(getProcessedEmail, Array.from({ length: 40 }, (_, i) => ID(i)));
  assert.ok(peak <= 8, 'expected at most 8 concurrent ledger reads, saw ' + peak);
});

// ---------------------------------------------------------------------------
// The classify-phase safety net
// ---------------------------------------------------------------------------

test('a skipped download is never reported as an empty attachment', async () => {
  // Only reachable if a processed_emails row disappears between the pre-check
  // and the classify phase. "carried no bytes" would be a lie about the
  // vendor's file and would send somebody looking at the wrong thing.
  const result = await runPayrollIngest({
    now: new Date('2026-08-20T14:00:00Z'),
    timeZone: 'America/Los_Angeles',
    dryRun: true,
    fetchMessages: async () => ([{
      messageId: ID(9),
      subject: 'Your Report Work Summary Payroll is ready',
      from: 'no-reply@centralservers.com',
      receivedAt: '2026-08-20T13:04:59Z',
      attachments: [{
        filename: ATTACHMENT_NAME,
        contentType: 'application/vnd.ms-excel',
        content: null,
        downloadSkipped: true
      }]
    }]),
    deps: {
      getProcessedEmail: async () => null,          // the ledger has changed its mind
      listProcessedEmails: async () => [],
      upsertProcessedEmail: async r => r,
      fetchEmployees: async () => [],
      sendAlert: async () => {}
    },
    log: () => {}
  });

  const item = result.results[0];
  assert.strictEqual(item.status, 'error');
  assert.ok(item.flags.includes('download_skipped'), 'flags were ' + JSON.stringify(item.flags));
  assert.doesNotMatch(item.error, /carried no bytes/);
  assert.match(item.error, /not downloaded/);
  assert.match(item.error, /next run will import it/);
});
