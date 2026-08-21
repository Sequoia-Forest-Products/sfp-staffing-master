// Automated ingestion of the daily payroll .xlsx that the payroll vendor emails
// to info@sequoiafp.com at ~6:04 AM Pacific.
//
// Kept separate from the handlers so the same code powers:
//   - payroll-email-ingest.js   (hourly, imports for real)
//   - payroll-missed-check.js   (daily, escalates a missed delivery)
//   - payroll-email-test.js     (manual/dry-run, gated behind a secret)
//   - tests/payroll-email.test.js (unit tests — inject messages and deps)
//
// Two boundaries are non-negotiable and everything below is shaped by them:
//
//   1. LABEL ISOLATION. info@ is a shared human inbox full of customer and
//      vendor mail. This code opens exactly one mailbox — the Gmail label named
//      by PAYROLL_IMAP_LABEL, used verbatim — and never INBOX, never All Mail.
//      If that exact mailbox does not exist the run fails loudly with the list
//      of mailboxes that do, because the alternative failure mode is a silent
//      "no messages found" forever.
//
//   2. READ-ONLY. Nothing here marks, flags, moves, archives or deletes
//      anything. Processing state lives in processed_emails, keyed by the
//      RFC822 Message-ID (stable across reconnects, unlike the IMAP UID).
//      Read/unread state carries no information at all: the Gmail filter marks
//      these read on arrival and humans read this inbox.
//
// The work date is INFERRED (the vendor's file has no date column anywhere), so
// every guardrail in deriveWorkDate()/classifyMessage() exists to make a wrong
// inference loud rather than silent. When in doubt this parks the message as
// pending_review and emails Peter; it never guesses a date onto real payroll.

const { createHash, randomUUID } = require('crypto');

// ============================================================
// CONFIG
// ============================================================

const DEFAULTS = {
  label:        'payroll import',              // note the space — quoted in IMAP, case-sensitive
  host:         'imap.gmail.com',
  sender:       'no-reply@centralservers.com',
  alertEmail:   'peter.stroble@sequoiafp.com',
  timeZone:     'America/Los_Angeles',
  lookbackDays: 7
};

const ATTACHMENT_NAME = 'Work Summary Payroll.xlsx';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// The vendor sends at ~6:04 AM Pacific. Anything outside this window still
// imports — the file is the file — but it is flagged and reported, because an
// arrival at an odd hour is the strongest available signal that the -1 day
// inference is about to land on the wrong date.
const EARLIEST_EXPECTED_HOUR = 4;
const LATEST_EXPECTED_HOUR   = 10;

const STALE_AFTER_DAYS = 7;
const MAX_MESSAGES     = 200;

// A ledger row that still needs a human. Everything else is terminal:
// 'imported' worked, 'duplicate_file' and 'rejected' are logged-and-fine (the
// ingest already decided not to import them and said so once), and 'resolved'
// is what /api/payroll-import stamps after somebody has dealt with a row by
// hand. Re-alerting on any of those is how the one alert that matters gets
// trained into background noise.
const ACTIONABLE_LEDGER_STATUSES = ['pending_review', 'error'];

// A row that is still unresolved is worth saying again — but once a day, not
// once per run, and with wording that ages rather than repeating verbatim.
const PENDING_RENOTIFY_HOURS = 24;

// Env is read per call, not at module load, so a test or a manual trigger can
// change it between runs.
function config() {
  const lookback = parseInt(process.env.PAYROLL_LOOKBACK_DAYS, 10);
  return {
    // Verbatim. Never slugified, lowercased or camel-cased: 'payroll import'
    // and 'Payroll Import' are different mailboxes to Gmail.
    label:        process.env.PAYROLL_IMAP_LABEL || DEFAULTS.label,
    host:         process.env.PAYROLL_IMAP_HOST  || DEFAULTS.host,
    user:         process.env.PAYROLL_IMAP_USER,
    password:     process.env.PAYROLL_IMAP_PASSWORD,
    senders:      String(process.env.PAYROLL_SENDER || DEFAULTS.sender)
                    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    alertEmail:   process.env.PAYROLL_ALERT_EMAIL || DEFAULTS.alertEmail,
    timeZone:     process.env.PAYROLL_TIME_ZONE   || DEFAULTS.timeZone,
    lookbackDays: Number.isFinite(lookback) && lookback > 0 ? lookback : DEFAULTS.lookbackDays,
    dryRun:       String(process.env.PAYROLL_DRY_RUN || '').toLowerCase() === 'true'
  };
}

// ============================================================
// DATE LOGIC
// ============================================================

// Wall-clock parts as seen in `timeZone`, regardless of where the function runs.
// Same shape as calendarDateInZone() in birthday-lib.js, plus the time of day.
function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});

  return {
    year:   +parts.year,
    month:  +parts.month,
    day:    +parts.day,
    hour:   (+parts.hour) % 24,   // some ICU builds render midnight as "24"
    minute: +parts.minute
  };
}

function isoFromParts({ year, month, day }) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function partsFromIso(iso) {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return { year: +m[1], month: +m[2], day: +m[3] };
}

// Day arithmetic runs on a UTC-anchored calendar date, so DST can never shift
// it: the zone conversion happens first, then the date math is pure integers.
function addDays(iso, days) {
  const p = partsFromIso(iso);
  if (!p) return null;
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day) + days * 86400000);
  return isoFromParts({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
}

function daysBetween(fromIso, toIso) {
  const a = partsFromIso(fromIso);
  const b = partsFromIso(toIso);
  if (!a || !b) return null;
  return Math.round(
    (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86400000
  );
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function dayInfo(iso) {
  const p = partsFromIso(iso);
  if (!p) return { isoDow: null, dayName: null, isScheduledDay: false };
  const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  const isoDow = dow === 0 ? 7 : dow;
  // Mon-Thu is the scheduled 4x10 week. Fri/Sat/Sun are legitimate work days
  // (maintenance) — classified, never rejected and never warned about.
  return { isoDow, dayName: DAY_NAMES[dow], isScheduledDay: isoDow >= 1 && isoDow <= 4 };
}

function todayInZone(now, timeZone) {
  return isoFromParts(zonedParts(now, timeZone));
}

// The whole inference, in one place: the file that arrives this morning covers
// YESTERDAY's work. Convert to Pacific FIRST, then subtract a day — taking the
// UTC calendar date would be wrong for every arrival before 5 PM Pacific... and
// right for the 6 AM delivery only by luck of the offset.
function deriveWorkDate(receivedAt, timeZone = DEFAULTS.timeZone) {
  // new Date(null) is the epoch, not an invalid date — an absent timestamp must
  // never quietly become 1969-12-31.
  if (receivedAt === null || receivedAt === undefined || receivedAt === '') return null;
  const received = receivedAt instanceof Date ? receivedAt : new Date(receivedAt);
  if (isNaN(received.getTime())) return null;

  const local = zonedParts(received, timeZone);
  const receivedDate = isoFromParts(local);
  const workDate = addDays(receivedDate, -1);
  const arrivalHour = local.hour + local.minute / 60;

  return {
    workDate,
    receivedDate,
    receivedLocal: local,
    arrivalHour,
    lateArrival: !(arrivalHour >= EARLIEST_EXPECTED_HOUR && arrivalHour < LATEST_EXPECTED_HOUR)
  };
}

// The work day the delivery that should have arrived this morning covers.
function expectedPriorWorkDate(now = new Date(), timeZone = DEFAULTS.timeZone) {
  return addDays(todayInZone(now, timeZone), -1);
}

// A future work date is refused outright — it means the arrival timestamp, and
// therefore the inference, is wrong. An old one is imported but flagged.
function checkWorkDateSanity(workDate, now, timeZone) {
  const today = todayInZone(now, timeZone);
  const errors = [];
  const flags = [];

  if (workDate > today) {
    errors.push(`derived work date ${workDate} is in the future (today is ${today} in ${timeZone})`);
  } else {
    const age = daysBetween(workDate, today);
    if (age !== null && age > STALE_AFTER_DAYS) flags.push('stale_date');
  }

  return { errors, flags };
}

// ============================================================
// MESSAGE INSPECTION
// ============================================================

function emailAddress(from) {
  if (!from) return '';
  if (typeof from === 'object') return String(from.address || from.email || '').trim().toLowerCase();
  const raw = String(from).trim();
  const angled = raw.match(/<([^>]+)>/);
  return (angled ? angled[1] : raw).trim().toLowerCase();
}

// Sender validation lives here, not only in the Gmail filter. A filter can be
// edited, and a labelled message from anyone else must never be parsed.
function isExpectedSender(fromAddress, senders = null) {
  const allowed = senders || config().senders;
  const addr = emailAddress(fromAddress);
  return !!addr && allowed.includes(addr);
}

function baseName(filename) {
  return String(filename || '').trim().split(/[\\/]/).pop();
}

// The payroll mail is not guaranteed to carry exactly one attachment, so match
// deliberately: the exact filename first, then the xlsx MIME type. Anything
// else on the message is ignored rather than hopefully parsed.
function pickAttachment(attachments) {
  const list = Array.isArray(attachments) ? attachments : [];

  const named = list.find(
    a => baseName(a && a.filename).toLowerCase() === ATTACHMENT_NAME.toLowerCase()
  );
  if (named) return named;

  const typed = list.find(
    a => String((a && a.contentType) || '').trim().toLowerCase().split(';')[0] === XLSX_MIME
  );
  if (typed) return typed;

  return null;
}

// True when an attachment descriptor also carries usable bytes.
function hasContent(att) {
  return !!att && Buffer.isBuffer(att.content) && att.content.length > 0;
}

function normalizeMessageId(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  return raw.startsWith('<') && raw.endsWith('>') ? raw : `<${raw.replace(/^<|>$/g, '')}>`;
}

// A message with no Message-ID cannot be de-duplicated by the header, so it gets
// a deterministic surrogate: the same message seen next hour hashes identically
// and is skipped rather than imported twice.
function surrogateMessageId(msg) {
  const seed = [
    msg && msg.subject, emailAddress(msg && msg.from), toIsoString(msg && msg.receivedAt)
  ].join('|');
  return `<no-message-id-${createHash('sha256').update(seed).digest('hex').slice(0, 32)}@sfp.local>`;
}

function toIsoString(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// ============================================================
// DEPENDENCIES
// ============================================================

// payroll-lib and payroll-db are required lazily, per call, and only when the
// caller has not injected a replacement — so tests and dry runs never load them
// (and never reach Supabase).
function resolveDeps(deps = {}) {
  const lib = () => require('./payroll-lib');
  const db  = () => require('./payroll-db');
  const wage = () => require('./wage-sync');
  const from = (loader, name) => (...args) => loader()[name](...args);

  return {
    fetchEmployees:       deps.fetchEmployees       || from(db, 'fetchEmployees'),
    fetchDailyHours:      deps.fetchDailyHours      || from(db, 'fetchDailyHours'),
    upsertDailyHours:     deps.upsertDailyHours     || from(db, 'upsertDailyHours'),
    findRowsByFileHash:   deps.findRowsByFileHash   || from(db, 'findRowsByFileHash'),
    getProcessedEmail:    deps.getProcessedEmail    || from(db, 'getProcessedEmail'),
    upsertProcessedEmail: deps.upsertProcessedEmail || from(db, 'upsertProcessedEmail'),
    listProcessedEmails:  deps.listProcessedEmails  || from(db, 'listProcessedEmails'),
    buildImport:          deps.buildImport          || from(lib, 'buildImport'),
    // The wage sync: planWageSync decides (pure), applyWageSync writes. Both
    // injectable, and applyWageSync makes no request at all for a plan with
    // nothing in it, so a run whose file carried no usable rate touches nothing.
    planWageSync:         deps.planWageSync         || from(wage, 'planWageSync'),
    applyWageSync:        deps.applyWageSync        || from(db, 'applyWageSync'),
    hashFile:             deps.hashFile             || defaultHashFile,
    sendAlert:            deps.sendAlert            || sendAlert
  };
}

// payroll-lib owns the canonical hash (it is what lands in daily_hours.file_hash),
// so duplicate detection has to agree with it. The local fallback is the same
// algorithm, and exists so a dry run or a unit test does not need payroll-lib.
function defaultHashFile(buf) {
  try {
    const hashFile = require('./payroll-lib').hashFile;
    if (typeof hashFile === 'function') return hashFile(buf);
  } catch { /* not loadable here — fall through */ }
  return createHash('sha256').update(buf).digest('hex');
}

// ============================================================
// MAIL FETCH (imapflow)
// ============================================================

// Flatten an imapflow bodyStructure into attachment descriptors. Only parts that
// could be the payroll workbook are downloaded; the rest are listed and ignored.
function collectAttachmentParts(node, out = []) {
  if (!node || typeof node !== 'object') return out;

  const params = node.parameters || {};
  const dispositionParams = node.dispositionParameters || {};
  const filename = dispositionParams.filename || params.name || null;
  const contentType = String(node.type || '').toLowerCase();
  const isAttachment = String(node.disposition || '').toLowerCase() === 'attachment' || !!filename;

  if (isAttachment && node.part) {
    out.push({ filename, contentType, part: node.part });
  }

  for (const child of node.childNodes || []) collectAttachmentParts(child, out);
  return out;
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

// The default fetchMessages implementation. Exported so payroll-email-test.js
// can exercise the real IMAP path on demand.
//
// Read-only throughout: getMailboxLock({readOnly:true}) plus an explicit
// mailboxOpen({readOnly:true}), no \Seen flag changes, no moves, no expunge.
//
// Returns an array of messages carrying two extra properties when the mailbox
// held more mail than the run examined: `truncated` and `totalAvailable`. The
// caller alerts on them — see runPayrollIngest(). They ride on the array so an
// injected fetchMessages can keep returning a plain array.
async function fetchLabeledMessages({
  label, sinceDate, host, user, password, alreadyProcessed,
  // The ImapFlow class itself, so a test can substitute a fake client and assert
  // what this function does and does not ask the server for. Nothing in
  // production passes it. It exists because the one thing worth pinning about
  // the ledger pre-check — that download() is never called for a message
  // already imported — is invisible from outside without it.
  imapFlow,
  log = console.log
} = {}) {
  const conf = config();
  const mailbox = label || conf.label;
  const imapHost = host || conf.host;
  const imapUser = user || conf.user;
  const imapPass = password || conf.password;

  if (!imapUser || !imapPass) {
    throw new Error('Missing PAYROLL_IMAP_USER or PAYROLL_IMAP_PASSWORD');
  }

  // Lazy, exactly like nodemailer in birthday-lib.js: dry runs and tests never
  // need the library present.
  const ImapFlow = imapFlow || require('imapflow').ImapFlow;

  const client = new ImapFlow({
    host: imapHost,
    port: 993,
    secure: true,
    auth: { user: imapUser, pass: imapPass },
    logger: false
  });

  const since = sinceDate instanceof Date
    ? sinceDate
    : new Date(`${String(sinceDate).slice(0, 10)}T00:00:00Z`);

  const messages = [];
  let truncated = false;
  let totalAvailable = 0;
  await client.connect();

  try {
    // Verify the label exists BEFORE selecting it. A typo (or a renamed Gmail
    // label) otherwise degrades into a permanent, silent "no messages found",
    // which is exactly the failure this whole design is built to avoid.
    const boxes = await client.list();
    const paths = boxes.map(b => b.path);
    if (!paths.includes(mailbox)) {
      // The full list of mailboxes is the single most useful thing for fixing a
      // label typo, and it is also a directory of every folder on a shared human
      // inbox. It goes to the function log, which only we can read; the thrown
      // message — which payroll-email-test.js hands straight back over HTTP —
      // names the label we looked for and points at the log.
      console.error(
        `IMAP: mailbox ${JSON.stringify(mailbox)} not found for ${imapUser}. Mailboxes present: ` +
        paths.map(p => JSON.stringify(p)).join(', ')
      );
      const err = new Error(
        `IMAP mailbox ${JSON.stringify(mailbox)} not found. Nested Gmail labels appear as paths ` +
        `("parent/child"). The mailboxes that do exist are in the function log for this run.`
      );
      err.mailboxes = paths;   // for callers that log; never serialized to a response
      throw err;
    }

    const lock = await client.getMailboxLock(mailbox, { readOnly: true });
    try {
      await client.mailboxOpen(mailbox, { readOnly: true });
      if (client.mailbox && client.mailbox.path !== mailbox) {
        throw new Error(`Refusing to read ${JSON.stringify(client.mailbox.path)} — expected ${JSON.stringify(mailbox)}`);
      }
      log(`IMAP: reading ${JSON.stringify(mailbox)} since ${since.toISOString().slice(0, 10)} (read-only)`);

      // Searched by date only. Read/unread state is deliberately not part of the
      // query: the Gmail filter marks these read on arrival.
      const descriptors = [];
      let matched = 0;
      for await (const msg of client.fetch({ since }, {
        uid: true, envelope: true, internalDate: true, bodyStructure: true
      })) {
        matched++;
        descriptors.push({
          uid: msg.uid,
          messageId: (msg.envelope && msg.envelope.messageId) || null,
          subject: (msg.envelope && msg.envelope.subject) || null,
          from: msg.envelope && msg.envelope.from && msg.envelope.from[0]
            ? msg.envelope.from[0].address
            : null,
          // INTERNALDATE is the arrival time at Gmail; the Date header is the
          // sender's clock and is only a fallback.
          receivedAt: msg.internalDate || (msg.envelope && msg.envelope.date) || null,
          parts: collectAttachmentParts(msg.bodyStructure)
        });
        // fetch() yields OLDEST first, so stopping at the cap would throw away
        // this morning's delivery and keep a week of mail already in the ledger
        // — exactly backwards. Drop from the front instead: memory stays bounded
        // at MAX_MESSAGES and what survives is the newest MAX_MESSAGES.
        if (descriptors.length > MAX_MESSAGES) descriptors.shift();
      }

      truncated = matched > descriptors.length;
      totalAvailable = matched;
      if (truncated) {
        log(`IMAP: ${matched} message(s) matched — examining only the newest ${descriptors.length}`);
      }

      // Ask the ledger which of these we have already imported, BEFORE
      // downloading anything. Listing is one FETCH for the whole window;
      // downloading is a round trip per message, and the window holds a week of
      // mail that is almost entirely already imported. Downloading it all and
      // then discovering that in the classify phase meant the cost grew with
      // the SIZE OF THE WINDOW instead of with the number of new messages —
      // seven downloads an hour, for ever, to import one file.
      //
      // Fails OPEN. If the ledger cannot be reached we download everything, the
      // way this ran before: a slow run that imports correctly beats a fast one
      // that skips a message it only assumed was already handled.
      let skipDownload = new Set();
      if (typeof alreadyProcessed === 'function') {
        const ids = descriptors.map(x => x.messageId).filter(Boolean);
        if (ids.length) {
          try {
            skipDownload = new Set(await alreadyProcessed(ids));
          } catch (err) {
            log(`IMAP: ledger pre-check failed (${err.message}) — downloading every attachment`);
            skipDownload = new Set();
          }
        }
      }

      for (const d of descriptors) {
        const attachments = [];
        const known = !!d.messageId && skipDownload.has(d.messageId);
        for (const part of d.parts) {
          const looksLikeWorkbook =
            baseName(part.filename).toLowerCase() === ATTACHMENT_NAME.toLowerCase() ||
            part.contentType === XLSX_MIME;

          if (!looksLikeWorkbook) {
            attachments.push({ filename: part.filename, contentType: part.contentType, content: null });
            continue;
          }

          // Already imported: name the part, fetch none of it. downloadSkipped
          // distinguishes "we chose not to read this" from "the message carried
          // no bytes", which is a real error and must not be reported as one
          // here.
          if (known) {
            attachments.push({
              filename: part.filename,
              contentType: part.contentType,
              content: null,
              downloadSkipped: true
            });
            continue;
          }

          // download() decodes base64/quoted-printable for us. The message body
          // is never fetched — only this part.
          const dl = await client.download(d.uid, part.part, { uid: true });
          attachments.push({
            filename: part.filename,
            contentType: part.contentType,
            content: await streamToBuffer(dl.content)
          });
        }

        messages.push({
          messageId: d.messageId,
          subject: d.subject,
          from: d.from,
          receivedAt: d.receivedAt,
          attachments
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => client.close());
  }

  messages.truncated = truncated;
  messages.totalAvailable = totalAvailable;
  return messages;
}

// Which of these message IDs the ledger already knows about.
//
// Deliberately N cheap point lookups through the existing getProcessedEmail
// rather than one message_id=in.(...) query. A batch filter would be one round
// trip instead of eight, but it needs message IDs — which carry <, > and @ —
// quoted and escaped correctly inside a PostgREST list, and this change goes
// straight to a live pipeline where I cannot test that query against the real
// database first. An untested filter that silently matches nothing, or matches
// too much, is exactly the class of mistake `from = "/*.sql"` was. The point
// lookup is already proven in the classify phase.
//
// Bounded concurrency because the descriptor list is capped at MAX_MESSAGES,
// not at a week: 200 sequential reads would be slower than the downloads this
// exists to avoid, and 200 at once is rude to Supabase.
const LEDGER_PROBE_CONCURRENCY = 8;

async function knownMessageIds(getProcessedEmail, messageIds) {
  const ids = [...new Set((messageIds || []).filter(Boolean))];
  const known = [];

  for (let i = 0; i < ids.length; i += LEDGER_PROBE_CONCURRENCY) {
    const chunk = ids.slice(i, i + LEDGER_PROBE_CONCURRENCY);
    const rows = await Promise.all(chunk.map(id => getProcessedEmail(id)));
    chunk.forEach((id, n) => { if (rows[n]) known.push(id); });
  }

  return known;
}

// fetchMessages may hand back a plain array (what the tests inject), an array
// carrying the truncation flags fetchLabeledMessages sets, or {messages,...}.
function unpackMessages(payload) {
  const list = Array.isArray(payload) ? payload
    : (payload && Array.isArray(payload.messages)) ? payload.messages
    : [];
  const meta = Array.isArray(payload) ? payload : (payload || {});
  const total = Number(meta.totalAvailable);
  return {
    list,
    truncated: !!meta.truncated,
    totalAvailable: Number.isFinite(total) && total > 0 ? total : list.length
  };
}

// ============================================================
// ALERTS
// ============================================================

// Alerts go out over the existing Gmail transport (GMAIL_USER/GMAIL_APP_PASSWORD).
// Those credentials are for sending only and are never used for IMAP.
async function sendAlert(subject, body, to = null) {
  const conf = config();
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) throw new Error('Missing GMAIL_USER or GMAIL_APP_PASSWORD');

  const nodemailer = require('nodemailer'); // lazy — see birthday-lib.js

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass }
  });

  return transporter.sendMail({
    from: `Sequoia Forest Products <${user}>`,
    to: to || conf.alertEmail,
    subject,
    text: body
  });
}

function describeItem(item) {
  const lines = [
    `- ${item.status.toUpperCase()}${item.workDate ? ` (work date ${item.workDate})` : ''}`,
    `  Subject : ${item.subject || '(none)'}`,
    `  From    : ${item.from || '(unknown)'}`,
    `  Received: ${item.receivedAt || '(unknown)'}`,
    `  Message : ${item.messageId}`
  ];
  if (item.flags.length) lines.push(`  Flags   : ${item.flags.join(', ')}`);
  if (item.error) lines.push(`  Detail  : ${item.error}`);
  lines.push(...describeWageSync(item.wageSync));
  return lines.join('\n');
}

// New arrivals and flagged rate changes ride in the same digest as everything
// else, because they are the two things about a wage sync that need a decision:
// somebody to classify, or a rate to confirm. Unchanged and skipped rows are
// counted and not listed.
function describeWageSync(sync) {
  if (!sync) return [];
  const lines = [];

  if (sync.failed || (sync.errors && sync.errors.length)) {
    lines.push(`  WAGE SYNC FAILED — the hours are imported, the rates are NOT:`);
    for (const err of sync.errors || [sync.error]) lines.push(`    ${err}`);
  }

  for (const create of sync.created || []) {
    lines.push(
      `  NEW EMPLOYEE — Emp # ${create.employeeNumber} ${create.name || '(no name)'} ` +
      `at ${Number(create.rate).toFixed(2)}/hr, created from the file with no department, ` +
      `cost class or position group. Their cost is landing nowhere until they are set up.`
    );
  }

  for (const change of sync.flagged || []) {
    lines.push(
      `  LARGE RATE CHANGE — Emp # ${change.employeeNumber} ${change.name || '(no name)'}: ` +
      `${change.from === null ? 'no rate' : Number(change.from).toFixed(2)} -> ` +
      `${Number(change.to).toFixed(2)}` +
      `${change.changePct === null ? '' : ` (${change.changePct > 0 ? '+' : ''}${change.changePct}%)`}` +
      ` — APPLIED and flagged. Confirm it is a real raise.`
    );
  }

  return lines;
}

// A pending row that has been sitting there for days should read louder each
// time, not identically — the same sentence every morning is what teaches
// people to filter the alert away.
function describePending(p) {
  const age = p.ageDays !== null && p.ageDays >= 1
    ? ` — UNRESOLVED SINCE ${p.unresolvedSince} (${p.ageDays} day${p.ageDays === 1 ? '' : 's'})`
    : '';
  const lines = [`  - ${p.status} ${p.workDate || '(no date)'} — ${p.subject || '(no subject)'}${age}`];
  if (p.error) lines.push(`      ${p.error}`);
  return lines;
}

function oldestSuffix(pending) {
  const ages = pending.map(p => p.ageDays).filter(n => Number.isFinite(n) && n >= 1);
  if (!ages.length) return '';
  const oldest = pending.find(p => p.ageDays === Math.max(...ages));
  return `, oldest unresolved since ${oldest.unresolvedSince}`;
}

// ============================================================
// INGEST
// ============================================================

function newItem(msg, messageId) {
  return {
    messageId,
    subject: msg.subject ? String(msg.subject) : null,
    from: emailAddress(msg.from) || null,
    receivedAt: toIsoString(msg.receivedAt),
    status: 'pending_review',
    workDate: null,
    rowsImported: 0,
    flags: [],
    error: null,
    fileHash: null,
    uploadBatchId: null,
    alert: false,
    ready: false
  };
}

function addFlag(item, flag) {
  if (!item.flags.includes(flag)) item.flags.push(flag);
}

function mergeRowFlags(rows, extraFlags) {
  if (!extraFlags.length) return rows;
  for (const row of rows) {
    const existing = Array.isArray(row.flags) ? row.flags : [];
    row.flags = [...new Set([...existing, ...extraFlags])];
  }
  return rows;
}

// The daily file is the source of truth for hourly wages, so importing a day's
// hours and not syncing its rates would leave the app holding yesterday's money
// for ever. Runs only after a successful import, never in a dry run.
//
// Three outcomes deserve a human's attention and each raises the item's alert:
// a person the app had never heard of (their cost is landing nowhere until
// somebody classifies them), a rate move past the threshold (either a raise or
// a vendor keying error, indistinguishable without looking) and a write that
// failed (the hours are in and the rates are not).
//
// `employees` is the roster snapshot the whole run shares, and it is MUTATED
// here on purpose — see the create loop at the bottom.
async function syncWages(item, rows, employees, d, log) {
  try {
    const plan = d.planWageSync({ fileRows: rows, employees, workDate: item.workDate });
    const applied = await d.applyWageSync(plan);
    item.wageSync = applied;

    const created = applied.created || [];
    const flagged = applied.flagged || [];
    const errors = applied.errors || [];

    if (created.length) {
      addFlag(item, 'new_employee');
      item.alert = true;
    }
    if (flagged.length) {
      addFlag(item, 'wage_change_flagged');
      item.alert = true;
    }
    if (errors.length) {
      addFlag(item, 'wage_sync_error');
      item.alert = true;
    }

    log(`Wage sync ${item.workDate}: ${applied.ratesUpdated} rate(s) updated, ` +
        `${created.length} employee(s) created, ${flagged.length} flagged, ` +
        `${errors.length} error(s).`);

    // A back-fill run imports several days from one roster read. Without this,
    // a person created from Monday's file is still unknown when Tuesday's file
    // is processed in the same run, and would be created a second time — two
    // employees rows for one employee number. Fold them into the shared
    // snapshot, carrying the wage just written so an unchanged rate the next
    // day reads as unchanged rather than as a fresh first observation.
    for (const person of created) {
      employees.push({
        id: person.employeeId,
        name: person.name,
        employee_number: person.employeeNumber,
        department: null,
        wage: Number(person.rate).toFixed(2),
        status: 'Active'
      });
    }
  } catch (err) {
    // The import itself stands — the hours are written and the status stays
    // 'imported'. This says, loudly, that the wages behind them did not move.
    item.wageSync = { failed: true, error: err.message, errors: [err.message] };
    addFlag(item, 'wage_sync_error');
    item.alert = true;
    log(`Wage sync failed for ${item.workDate}: ${err.message}`);
  }
}

function ledgerRecord(item, notifiedAt) {
  return {
    message_id: item.messageId,
    work_date: item.workDate,
    status: item.status,
    error: item.error,
    subject: item.subject,
    from_address: item.from,
    received_at: item.receivedAt,
    file_hash: item.fileHash,
    upload_batch_id: item.uploadBatchId,
    rows_imported: item.rowsImported,
    flags: item.flags,
    notified_at: item.alert ? notifiedAt : null
  };
}

async function runPayrollIngest({
  now = new Date(),
  dryRun,
  lookbackDays,
  timeZone,
  fetchMessages,
  deps,
  log = console.log
} = {}) {
  const conf = config();
  const tz = timeZone || conf.timeZone;
  const lookback = Number.isFinite(lookbackDays) && lookbackDays > 0 ? lookbackDays : conf.lookbackDays;
  const isDryRun = dryRun === undefined ? conf.dryRun : !!dryRun;
  const d = resolveDeps(deps);
  const getMessages = fetchMessages || (opts => fetchLabeledMessages({ ...opts, log }));

  const today = todayInZone(now, tz);
  const sinceDate = addDays(today, -lookback);

  // Handed to the fetcher so it can skip downloading what is already imported.
  // A throw here is caught inside the fetcher, which then downloads everything —
  // see the fail-open note there.
  const alreadyProcessed = ids => knownMessageIds(d.getProcessedEmail, ids);

  const messages = await getMessages({
    label: conf.label, sinceDate, lookbackDays: lookback, timeZone: tz, alreadyProcessed
  });
  const { list, truncated, totalAvailable } = unpackMessages(messages);

  // Oldest first, so that when two deliveries collide the earlier one is the one
  // treated as the original.
  const ordered = [...list].sort((a, b) => {
    const ta = Date.parse(toIsoString(a && a.receivedAt) || '') || 0;
    const tb = Date.parse(toIsoString(b && b.receivedAt) || '') || 0;
    return ta - tb;
  });

  const items = [];

  // ---- Phase 1: classify. Reads only, no writes and no parsing of anything
  // that fails the sender or attachment checks.
  for (const msg of ordered) {
    const messageId = normalizeMessageId(msg && msg.messageId) || surrogateMessageId(msg || {});
    const item = newItem(msg || {}, messageId);
    items.push(item);

    // Already in the ledger => already handled, whatever its outcome was. The
    // attachment is never re-parsed and nothing is re-notified; anything still
    // needing attention is surfaced by runMissedDeliveryCheck().
    let existing = null;
    try {
      existing = await d.getProcessedEmail(messageId);
    } catch (err) {
      item.status = 'error';
      item.error = `ledger lookup failed: ${err.message}`;
      item.alert = true;
      continue;
    }
    if (existing) {
      item.status = 'skipped';
      item.workDate = existing.work_date ? String(existing.work_date).slice(0, 10) : null;
      item.previousStatus = existing.status || null;
      continue;
    }

    if (!isExpectedSender(item.from, conf.senders)) {
      item.status = 'rejected';
      addFlag(item, 'wrong_sender');
      item.error = `sender ${item.from || '(unknown)'} is not ${conf.senders.join(' / ')} — not parsed`;
      item.alert = true;
      continue;
    }

    const attachment = pickAttachment(msg && msg.attachments);
    if (!attachment) {
      item.status = 'error';
      addFlag(item, 'no_attachment');
      item.error = `no ${ATTACHMENT_NAME} attachment on the message`;
      item.alert = true;
      continue;
    }
    // The ledger said this was already imported when the mailbox was read, so
    // its bytes were never fetched — and now the ledger says otherwise. The only
    // way that happens is a processed_emails row disappearing between the two
    // reads, which is not something the pipeline does to itself.
    //
    // It self-heals: the next hourly run lists the message, the pre-check finds
    // nothing, and it downloads and imports normally. Reported anyway, and
    // BEFORE the empty-attachment check, because "carried no bytes" would be a
    // lie about the vendor's file and would send somebody looking at the wrong
    // thing entirely.
    if (attachment.downloadSkipped) {
      item.status = 'error';
      addFlag(item, 'download_skipped');
      item.error =
        'the ledger reported this message as already imported when the mailbox was read, so its ' +
        'attachment was not downloaded — but it is not in the ledger now. Nothing was parsed. ' +
        'The next run will import it normally; if this repeats, something is deleting ' +
        'processed_emails rows.';
      item.alert = true;
      continue;
    }

    if (!hasContent(attachment)) {
      item.status = 'error';
      addFlag(item, 'empty_attachment');
      item.error = `attachment ${baseName(attachment.filename) || '(unnamed)'} carried no bytes`;
      item.alert = true;
      continue;
    }

    const derived = deriveWorkDate(msg.receivedAt, tz);
    if (!derived) {
      // No usable arrival timestamp means no defensible date. Never guess.
      item.status = 'pending_review';
      addFlag(item, 'unknown_received_time');
      item.error = 'no usable received timestamp — work date could not be determined';
      item.alert = true;
      continue;
    }

    item.workDate = derived.workDate;
    item.arrivalHour = Math.round(derived.arrivalHour * 100) / 100;
    item.receivedLocal = derived.receivedLocal;
    Object.assign(item, dayInfo(derived.workDate));

    if (derived.lateArrival) {
      addFlag(item, 'late_arrival');
      item.alert = true;
      item.error = `arrived ${String(derived.receivedLocal.hour).padStart(2, '0')}:` +
        `${String(derived.receivedLocal.minute).padStart(2, '0')} ${tz}, ` +
        `outside the expected ${EARLIEST_EXPECTED_HOUR}:00-${LATEST_EXPECTED_HOUR}:00 window — ` +
        `imported as ${derived.workDate}, please confirm the date`;
    }

    const sanity = checkWorkDateSanity(derived.workDate, now, tz);
    if (sanity.errors.length) {
      item.status = 'pending_review';
      addFlag(item, 'future_date');
      item.error = sanity.errors.join('; ');
      item.alert = true;
      continue;
    }
    for (const flag of sanity.flags) {
      addFlag(item, flag);
      item.alert = true;
    }

    item.fileHash = d.hashFile(attachment.content);
    item.attachment = attachment;
    item.ready = true;
  }

  // ---- Phase 1b: two messages in this run landing on the same work date.
  // Identical bytes are a harmless double-delivery (keep the first, mark the
  // rest duplicate_file). Different bytes are a real ambiguity: import neither.
  const byWorkDate = new Map();
  for (const item of items) {
    if (!item.ready) continue;
    if (!byWorkDate.has(item.workDate)) byWorkDate.set(item.workDate, []);
    byWorkDate.get(item.workDate).push(item);
  }
  for (const [workDate, group] of byWorkDate) {
    if (group.length < 2) continue;
    const hashes = new Set(group.map(i => i.fileHash));

    if (hashes.size === 1) {
      for (const dup of group.slice(1)) {
        dup.ready = false;
        dup.status = 'duplicate_file';
        addFlag(dup, 'duplicate_file');
        dup.error = `identical file also delivered as ${group[0].messageId}`;
      }
      continue;
    }

    for (const item of group) {
      item.ready = false;
      item.status = 'pending_review';
      addFlag(item, 'duplicate_day');
      item.error = `${group.length} different files resolve to ${workDate} — none imported, ` +
        `pick the right one and import it by hand`;
      item.alert = true;
    }
  }

  // ---- Phase 2: duplicate checks against what is already stored, then import.
  let employees = null;

  for (const item of items) {
    if (!item.ready) continue;

    try {
      // The same bytes already imported: a vendor re-send. Under a DIFFERENT
      // date it is the dangerous case — importing would duplicate a day's
      // payroll under a wrong date — so it never imports either way.
      const priorRows = await d.findRowsByFileHash(item.fileHash);
      if (Array.isArray(priorRows) && priorRows.length) {
        const dates = [...new Set(priorRows.map(r => String(r.work_date).slice(0, 10)))].sort();
        item.ready = false;
        item.status = 'duplicate_file';
        addFlag(item, 'duplicate_file');
        if (dates.length === 1 && dates[0] === item.workDate) {
          item.error = `identical file already imported for ${item.workDate} — re-delivery ignored`;
        } else {
          item.error = `identical file already imported under ${dates.join(', ')}, ` +
            `not re-imported as ${item.workDate} — re-send or vendor error`;
          item.alert = true;
        }
        continue;
      }

      // Someone (or something) else already owns this date with different bytes.
      // Manual rows carry a null hash and count as different: never silently
      // overwrite a day a human imported.
      const dayRows = await d.fetchDailyHours(item.workDate, item.workDate);
      if (Array.isArray(dayRows) && dayRows.length) {
        const hashes = [...new Set(dayRows.map(r => r.file_hash || null))];
        if (!(hashes.length === 1 && hashes[0] === item.fileHash)) {
          item.ready = false;
          item.status = 'pending_review';
          addFlag(item, 'duplicate_day');
          item.error = `${dayRows.length} row(s) already exist for ${item.workDate} from a different file ` +
            `(${hashes.map(h => h ? h.slice(0, 12) : 'manual/no hash').join(', ')}) — not imported`;
          item.alert = true;
          continue;
        }
      }

      // Mutated by syncWages() when the file creates somebody, so a multi-day
      // run does not create the same person twice off one stale snapshot.
      if (!employees) employees = (await d.fetchEmployees()) || [];

      const uploadBatchId = randomUUID();
      const built = d.buildImport({
        fileBuffer: item.attachment.content,
        workDate: item.workDate,
        source: 'email',
        sourceSubject: item.subject,
        emailReceivedAt: item.receivedAt,
        dateSource: 'email_received',
        employees: employees || [],
        uploadBatchId,
        timeZone: tz
      });

      const rows = mergeRowFlags(built.rows || [], item.flags);
      item.uploadBatchId = uploadBatchId;
      item.fileHash = built.fileHash || item.fileHash;
      item.counts = built.counts || null;
      item.totals = built.totals || null;

      if (isDryRun) {
        item.status = 'dry_run';
        item.rowsImported = rows.length;
        log(`DRY RUN: would import ${rows.length} row(s) for ${item.workDate} from ${item.subject || '(no subject)'}`);
      } else {
        await d.upsertDailyHours(rows);
        item.status = 'imported';
        item.rowsImported = rows.length;
        log(`Imported ${rows.length} row(s) for ${item.workDate} (batch ${uploadBatchId})`);

        // The wage sync, on the same terms as the manual commit in
        // payroll-import.js: after the hours are written, driven by the parsed
        // FILE rather than the roster, and never in a dry run. A failure here
        // does not un-import the day — it is reported and alerted on.
        await syncWages(item, rows, employees, d, log);
      }
    } catch (err) {
      item.ready = false;
      item.status = 'error';
      item.error = err.message;
      item.alert = true;
    }
  }

  // ---- Phase 3: one digest alert per run, sent BEFORE the ledger is written so
  // notified_at is only ever set on something that actually went out.
  const alerting = items.filter(i => i.alert);

  // Run-level problems that no individual message owns. A truncated scan is
  // one: the messages this run never looked at cannot report themselves, so a
  // bounded run would otherwise read exactly like a complete one.
  const notices = [];
  if (truncated) {
    notices.push(
      `Only the newest ${list.length} of ${totalAvailable} message(s) in the ${lookback}-day window ` +
      `were examined (cap ${MAX_MESSAGES} per run). The rest were NOT checked — this run is not a ` +
      `complete pass. Check the "${conf.label}" label for mail that does not belong there.`
    );
  }

  const shouldAlert = alerting.length > 0 || notices.length > 0;
  let notified = false;
  let notifiedAt = null;
  let alertError = null;

  if (shouldAlert && !isDryRun) {
    const subject = alerting.length
      ? `Payroll email import needs attention — ${alerting.length} item(s)`
      : 'Payroll email import: the mailbox scan was truncated';
    const body = [
      notices.join('\n\n'),
      alerting.length
        ? `The hourly payroll import found ${alerting.length} message(s) that need a look.\n\n` +
          alerting.map(describeItem).join('\n\n')
        : '',
      `Mailbox: ${conf.label} (read-only)\nRun at: ${now.toISOString()}\n` +
      `Nothing was imported for anything listed as pending_review, rejected, duplicate_file or error.`
    ].filter(Boolean).join('\n\n');
    try {
      await d.sendAlert(subject, body);
      notified = true;
      notifiedAt = new Date().toISOString();
    } catch (err) {
      alertError = err.message;
      log(`Alert email failed: ${err.message}`);
    }
  }

  // The alert IS the output of this function — a run that found something and
  // could not say so has failed, however clean the rest of it looks. The
  // handler turns this into a non-200 so Netlify's own function-error alerting
  // fires; a log line would just sit there unread.
  const alertFailed = shouldAlert && !isDryRun && !notified;

  // ---- Phase 4: the ledger. Only messages this run actually handled — a
  // 'skipped' message already has its row, and a dry run writes nothing at all.
  if (!isDryRun) {
    for (const item of items) {
      if (item.status === 'skipped' || item.status === 'dry_run') continue;
      try {
        await d.upsertProcessedEmail(ledgerRecord(item, notifiedAt));
      } catch (err) {
        log(`Failed to record ${item.messageId} in processed_emails: ${err.message}`);
      }
    }
  }

  const results = items.map(i => ({
    messageId: i.messageId,
    status: i.status,
    workDate: i.workDate,
    rowsImported: i.rowsImported,
    flags: i.flags,
    error: i.error,
    subject: i.subject,
    from: i.from,
    receivedAt: i.receivedAt,
    fileHash: i.fileHash,
    uploadBatchId: i.uploadBatchId,
    dayName: i.dayName || null,
    isScheduledDay: i.isScheduledDay === undefined ? null : i.isScheduledDay,
    arrivalHour: i.arrivalHour === undefined ? null : i.arrivalHour,
    previousStatus: i.previousStatus || null,
    wageSync: i.wageSync || null
  }));

  const imported = results.filter(r => r.status === 'imported' || r.status === 'dry_run').length;
  const skipped  = results.filter(r => r.status === 'skipped' || r.status === 'duplicate_file').length;
  const flagged  = results.filter(r => r.status === 'pending_review').length;
  const errors   = results.filter(r => r.status === 'error' || r.status === 'rejected').length;

  const status = isDryRun ? 'dry-run'
    : alertFailed ? 'alert-failed'
    : (errors || flagged || truncated) ? 'attention'
    : results.length === 0 ? 'no-messages'
    : 'ok';

  log(`Payroll ingest ${status}: ${results.length} checked, ${imported} imported, ` +
      `${skipped} skipped, ${flagged} pending review, ${errors} error(s).`);
  if (alertFailed) log(`Payroll ingest could not deliver its alert: ${alertError}`);

  return {
    status,
    dryRun: isDryRun,
    label: conf.label,
    timeZone: tz,
    sinceDate,
    checked: results.length,
    imported,
    skipped,
    flagged,
    errors,
    truncated,
    totalAvailable,
    notified,
    alertRequired: shouldAlert && !isDryRun,
    alertFailed,
    alertError,
    // One flag the handlers key their HTTP status off, so "this run could not
    // do its job" never depends on a caller re-deriving it.
    failed: alertFailed,
    results
  };
}

// ============================================================
// MISSED DELIVERY CHECK
// ============================================================

// Runs once a day, after the delivery window. Escalates only what is genuinely
// wrong: a missing Mon-Thu scheduled day (nobody may have worked Fri/Sat/Sun,
// so a missing one of those is reported, never alerted on), plus anything the
// ingester parked in pending_review or error.
//
// This is the only thing that surfaces a broken pipeline, which puts two
// obligations on it that ordinary code does not carry:
//   - it must never be quietly wrong. A Supabase failure or an undeliverable
//     alert returns `failed:true`, and the handler turns that into a non-200 so
//     Netlify's function-error alerting fires. A green scheduled run has to
//     mean the check actually ran.
//   - it must stay worth reading. Pending rows are re-reported once a day at
//     most, resolved ones never, and long-unresolved ones with wording that
//     ages — an alert everyone filters is the same as no alert.
async function runMissedDeliveryCheck({
  now = new Date(),
  timeZone,
  dryRun,
  lookbackDays,
  deps,
  log = console.log
} = {}) {
  const conf = config();
  const tz = timeZone || conf.timeZone;
  const window = Number.isFinite(lookbackDays) && lookbackDays > 0 ? lookbackDays : conf.lookbackDays;
  const isDryRun = dryRun === undefined ? conf.dryRun : !!dryRun;
  const d = resolveDeps(deps);

  const today = todayInZone(now, tz);
  const checkedDate = expectedPriorWorkDate(now, tz);
  const fromDate = addDays(checkedDate, -(window - 1));

  // The data read is inside the try on purpose. Supabase being down is exactly
  // when this check matters most, and letting it throw would take the watchdog
  // out with it: no alert attempted, and (before the handler change) an HTTP
  // 500 nobody reads. Instead we lose the ability to answer the question and
  // say so, loudly.
  let dataError = null;
  const haveData = new Set();
  try {
    const rows = await d.fetchDailyHours(fromDate, checkedDate);
    for (const r of Array.isArray(rows) ? rows : []) haveData.add(String(r.work_date).slice(0, 10));
  } catch (err) {
    dataError = err.message;
    log(`Could not read daily_hours: ${err.message}`);
  }

  const missing = [];
  if (!dataError) {
    for (let date = fromDate; date <= checkedDate; date = addDays(date, 1)) {
      if (haveData.has(date)) continue;
      const info = dayInfo(date);
      missing.push({
        date,
        dayName: info.dayName,
        isScheduledDay: info.isScheduledDay,
        // EVERY day is a promise. BBSI sends the report seven days a week, so a
        // day with no rows is a delivery that did not happen — not a quiet
        // weekend. isScheduledDay stays on the record because the OT report
        // still distinguishes scheduled from weekend hours, but it no longer
        // decides whether anyone hears about a missing day.
        escalate: true
      });
    }
  }

  // Anything the ingester could not resolve on its own. payroll-db's filter is
  // single-valued, so ask for "everything that is not imported" and narrow it
  // here — which also keeps this correct if the option shape is ignored.
  //
  // The narrowing is the important part: only ACTIONABLE_LEDGER_STATUSES land
  // in pendingReview, so a 'resolved' row (a human dealt with it via
  // /api/payroll-import) and the logged-and-fine 'duplicate_file' / 'rejected'
  // rows never drive an alert again.
  let ledgerError = null;
  let pendingReview = [];
  try {
    const ledger = await d.listProcessedEmails({ notStatus: 'imported', limit: 200 });
    pendingReview = (Array.isArray(ledger) ? ledger : [])
      .filter(r => r && ACTIONABLE_LEDGER_STATUSES.includes(r.status))
      .map(r => {
        // notified_at is when this row was last reported. Nothing clears a
        // pending row automatically, so without this a single ambiguous
        // delivery emails Peter every morning until the heat death of the
        // universe — and the day a real one arrives, it reads as more of the
        // same.
        const lastNotified = r.notified_at ? Date.parse(r.notified_at) : NaN;
        const hoursSinceNotified = Number.isFinite(lastNotified)
          ? (now.getTime() - lastNotified) / 3600000
          : null;
        const firstSeen = r.received_at || r.processed_at || null;
        const unresolvedSince = firstSeen ? String(firstSeen).slice(0, 10) : null;
        const ageDays = unresolvedSince ? daysBetween(unresolvedSince, today) : null;

        return {
          messageId: r.message_id,
          status: r.status,
          workDate: r.work_date ? String(r.work_date).slice(0, 10) : null,
          subject: r.subject || null,
          receivedAt: r.received_at || null,
          error: r.error || null,
          flags: r.flags || [],
          notifiedAt: r.notified_at || null,
          unresolvedSince,
          ageDays,
          dueForAlert: hoursSinceNotified === null || hoursSinceNotified >= PENDING_RENOTIFY_HOURS
        };
      });
  } catch (err) {
    ledgerError = err.message;
    log(`Could not read processed_emails: ${err.message}`);
  }

  const escalating = missing.filter(m => m.escalate);
  const duePending = pendingReview.filter(p => p.dueForAlert);
  const quietPending = pendingReview.filter(p => !p.dueForAlert);
  const shouldAlert = !!dataError || !!ledgerError || escalating.length > 0 || duePending.length > 0;

  let notified = false;
  let notifiedAt = null;
  let alertError = null;

  if (shouldAlert && !isDryRun) {
    const lines = [];
    if (dataError) {
      lines.push(`COULD NOT CHECK whether payroll arrived for ${fromDate} .. ${checkedDate}.`);
      lines.push(`Reading daily_hours failed: ${dataError}`);
      lines.push('');
      lines.push('Nothing below has been verified. Treat the pipeline as unconfirmed until this');
      lines.push('check runs cleanly — open the Daily Hours tab and look at the last few days.');
    }
    if (ledgerError) {
      lines.push('');
      lines.push(`Could not read the processed_emails ledger: ${ledgerError}`);
      lines.push('Emails waiting on a decision could not be listed this run.');
    }
    if (escalating.length) {
      if (lines.length) lines.push('');
      lines.push(`Day(s) with no payroll data (checked ${fromDate} .. ${checkedDate}):`);
      for (const m of escalating) lines.push(`  - ${m.date} (${m.dayName})`);
      lines.push('');
      lines.push('Either the vendor email never arrived, the Gmail label did not apply, or the');
      lines.push('import failed. Check the "payroll import" label in info@, then import by hand.');
    }
    if (duePending.length) {
      lines.push('');
      lines.push('Emails waiting on a decision:');
      for (const p of duePending) lines.push(...describePending(p));
      lines.push('');
      lines.push('Resolve each one from the Daily Hours tab (import it by hand, or mark it');
      lines.push('resolved). A resolved email is never reported again.');
    }
    if (quietPending.length) {
      lines.push('');
      lines.push(`${quietPending.length} other email(s) are still unresolved but were already ` +
        `reported in the last ${PENDING_RENOTIFY_HOURS}h — not repeated here.`);
    }

    const subject = dataError
      ? 'Payroll check FAILED — could not confirm whether payroll arrived'
      : escalating.length
        ? `Payroll data missing for ${escalating.map(m => m.date).join(', ')}`
        : duePending.length
          ? `Payroll import: ${duePending.length} email(s) waiting on review` + oldestSuffix(duePending)
          : 'Payroll check: the processed_emails ledger could not be read';

    try {
      await d.sendAlert(subject, lines.join('\n'));
      notified = true;
      notifiedAt = new Date().toISOString();
    } catch (err) {
      alertError = err.message;
      log(`Missed-delivery alert failed: ${err.message}`);
    }
  }

  // Stamp notified_at only on rows that were actually in an email that actually
  // went out — same rule as the ingest ledger. A failed stamp is logged and
  // left alone: the cost is one repeated alert tomorrow, which is the safe
  // direction to fail in.
  if (notified && notifiedAt && duePending.length) {
    for (const p of duePending) {
      try {
        // Deliberately a three-column patch. The row was read moments ago and
        // /api/payroll-import may be resolving it concurrently — sending the
        // whole row back would undo that.
        await d.upsertProcessedEmail({
          message_id: p.messageId,
          status: p.status,
          notified_at: notifiedAt
        });
        p.notifiedAt = notifiedAt;
      } catch (err) {
        log(`Could not stamp notified_at on ${p.messageId}: ${err.message}`);
      }
    }
  }

  const alertFailed = shouldAlert && !isDryRun && !notified;
  const failed = alertFailed || !!dataError || !!ledgerError;

  const status = isDryRun ? 'dry-run'
    : failed ? 'error'
    : shouldAlert ? 'attention'
    : 'ok';

  log(`Missed-delivery check ${status}: prior work day ${checkedDate}, ` +
      `${missing.length} day(s) without data (${escalating.length} scheduled), ` +
      `${pendingReview.length} email(s) pending review (${duePending.length} reported).`);
  if (alertFailed) log(`Missed-delivery check could not deliver its alert: ${alertError}`);

  return {
    status,
    dryRun: isDryRun,
    timeZone: tz,
    checkedDate,
    fromDate,
    missing,
    pendingReview,
    pendingAlerted: duePending.length,
    pendingSuppressed: quietPending.length,
    notified,
    alertRequired: shouldAlert && !isDryRun,
    alertFailed,
    alertError,
    dataError,
    ledgerError,
    failed
  };
}

module.exports = {
  // config / constants
  DEFAULTS,
  ATTACHMENT_NAME,
  XLSX_MIME,
  MAX_MESSAGES,
  ACTIONABLE_LEDGER_STATUSES,
  PENDING_RENOTIFY_HOURS,
  config,
  // date logic
  zonedParts,
  addDays,
  dayInfo,
  todayInZone,
  deriveWorkDate,
  expectedPriorWorkDate,
  checkWorkDateSanity,
  // message inspection
  emailAddress,
  isExpectedSender,
  pickAttachment,
  normalizeMessageId,
  // io
  fetchLabeledMessages,
  knownMessageIds,
  sendAlert,
  // runners
  runPayrollIngest,
  runMissedDeliveryCheck
};
