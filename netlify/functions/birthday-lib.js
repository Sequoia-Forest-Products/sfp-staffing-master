// Shared logic for birthday notifications.
//
// Kept separate from the handlers so the same code powers:
//   - birthday-notifications.js  (scheduled, sends for real)
//   - birthday-test.js           (manual/dry-run, gated behind a secret)
//   - tests/birthday.test.js     (unit tests, inject `now` and `employees`)
//
// Schema notes (employees table):
//   name       — full name
//   birthday   — month/day source. Stored as free text today ("3/15", "3/15/1990");
//                parseBirthday() also accepts a Postgres DATE ("1990-03-15").
//   text_bolt  — TextBolt email-to-SMS address, +1XXXXXXXXXX@sendemailtotext.com
//                Doubles as the SMS opt-out flag: the Employees tab writes the
//                literal string 'STOP' here when the toggle is switched on.
//   status     — 'Active' | 'Inactive'

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const GMAIL_USER   = process.env.GMAIL_USER;
const GMAIL_PASS   = process.env.GMAIL_APP_PASSWORD;

// The mill is in Mountain Time. Never trust the server's UTC clock for "today".
const TIME_ZONE = 'America/Boise';
const DIVIDER   = '--------------------------------------------------';
const SEND_DELAY_MS = 150;

// ============================================================
// DATE LOGIC
// ============================================================

// Calendar date as seen in Mountain Time, regardless of where the function runs.
function calendarDateInZone(now = new Date(), timeZone = TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});

  return { year: +parts.year, month: +parts.month, day: +parts.day };
}

// Look-ahead window, matching the legacy Apps Script exactly:
//   Mon-Wed  today only
//   Thursday today + 3 (covers Fri/Sat/Sun)
//   Friday   today + 2 (covers Sat/Sun)
//   Sat/Sun  no run
// Returns null on weekends. Day arithmetic runs on a UTC-anchored calendar date,
// so it is immune to DST shifts.
function buildTargetDates(base) {
  const anchor    = Date.UTC(base.year, base.month - 1, base.day);
  const dayOfWeek = new Date(anchor).getUTCDay();

  if (dayOfWeek === 0 || dayOfWeek === 6) return null;

  const daysToLookAhead = dayOfWeek === 4 ? 3 : dayOfWeek === 5 ? 2 : 0;
  const targets = [];

  for (let i = 0; i <= daysToLookAhead; i++) {
    const d = new Date(anchor + i * 86400000);
    targets.push({ month: d.getUTCMonth() + 1, date: d.getUTCDate(), isUpcoming: i > 0 });
  }

  return { dayOfWeek, daysToLookAhead, targets };
}

function validMonthDay(month, day) {
  if (!(month >= 1 && month <= 12)) return null;
  if (!(day >= 1 && day <= 31)) return null;
  return { month, day };
}

// Parse month/day out of the string directly — never via new Date(), which would
// read "1990-08-09" as UTC midnight and can land on Aug 8 in a negative-offset zone.
function parseBirthday(value) {
  if (!value) return null;

  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    return validMonthDay(value.getUTCMonth() + 1, value.getUTCDate());
  }

  const raw = String(value).trim();
  if (!raw || raw.toUpperCase().includes('ERROR')) return null;

  // Postgres DATE / ISO timestamp: YYYY-MM-DD
  let m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return validMonthDay(+m[2], +m[3]);

  // Free text as entered in the Employees tab: M/D, M/D/YY, M/D/YYYY
  m = raw.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/);
  if (m) return validMonthDay(+m[1], +m[2]);

  // Full JS date strings — what the live column actually holds, e.g.
  // "Mon Nov 12 1990 00:00:00 GMT-0800 (Pacific Standard Time)".
  // The numeric offset carries the meaning; Date.parse ignores the
  // parenthesised label, which is sometimes mislabelled in the data
  // (PDT written against a -0800 offset and vice versa).
  // Every value is midnight Pacific = 08:00 UTC the same calendar day, so
  // reading month/day in UTC cannot roll the date forward or back.
  const parsed = Date.parse(raw);
  if (!isNaN(parsed)) {
    const d = new Date(parsed);
    return validMonthDay(d.getUTCMonth() + 1, d.getUTCDate());
  }

  return null;
}

// ============================================================
// ROSTER SELECTION
// ============================================================

// An address is sendable unless it is missing, opted out ('STOP'), a spreadsheet
// error value, or not an address at all.
function isSendableAddress(value) {
  const v = String(value || '').trim();
  if (!v) return false;
  if (v.toUpperCase() === 'STOP') return false;
  if (v.toUpperCase().includes('ERROR')) return false;
  return v.includes('@');
}

// Birthday people need a name and a parseable birthday — nothing else.
// An address is required to *receive* the message, never to be named in it:
// employees with no text_bolt at all, and opted-out employees ('STOP'), are
// both announced to everyone else and simply receive nothing themselves.
function selectBirthdayPeople(employees, targets, log = console.log) {
  const todayPeople = [];
  const upcomingPeople = [];

  for (const emp of employees) {
    const name = String(emp.name || '').trim();
    if (!name) continue;

    const rawBirthday = emp.birthday instanceof Date
      ? emp.birthday
      : String(emp.birthday || '').trim();
    if (!rawBirthday) continue; // no birthday on file — not a parse failure

    const bday = parseBirthday(rawBirthday);
    if (!bday) {
      log(`WARNING: unparseable birthday for ${name}: ${JSON.stringify(String(rawBirthday))}`);
      continue;
    }

    const match = targets.find(t => t.month === bday.month && t.date === bday.day);
    if (!match) continue;

    const person = {
      full: name,
      first: name.split(' ')[0],
      address: String(emp.text_bolt || '').trim()
    };
    (match.isUpcoming ? upcomingPeople : todayPeople).push(person);
  }

  return { todayPeople, upcomingPeople };
}

// Everyone with a live, opted-in address — minus the birthday people themselves.
function buildRecipients(employees, birthdayPeople) {
  // Birthday people with no address on file contribute nothing to exclude.
  const excluded = new Set(
    birthdayPeople
      .map(p => String(p.address || '').trim().toLowerCase())
      .filter(Boolean)
  );
  const seen = new Set();
  const recipients = [];

  for (const emp of employees) {
    const textBolt = String(emp.text_bolt || '').trim();
    if (!isSendableAddress(textBolt)) continue;

    const key = textBolt.toLowerCase();
    if (excluded.has(key) || seen.has(key)) continue;

    seen.add(key);
    recipients.push(textBolt);
  }

  return recipients;
}

// ============================================================
// MESSAGE COMPOSITION  (text preserved verbatim from the Apps Script)
// ============================================================

function composeMessage(todayPeople, upcomingPeople) {
  const allPeople     = [...todayPeople, ...upcomingPeople];
  const allFirstNames = allPeople.map(p => p.first);
  const pronounEN     = allPeople.length === 1 ? allPeople[0].first : 'them';
  const pronounES     = allPeople.length === 1 ? 'desearle' : 'desearles';

  const englishParts = [];
  const spanishParts = [];

  if (todayPeople.length > 0) {
    const names = todayPeople.map(p => p.full).join(' & ');
    englishParts.push(`It is ${names}'s Birthday today!`);
    spanishParts.push(`¡Hoy es el cumpleaños de ${names}!`);
  }

  if (upcomingPeople.length > 0) {
    const names = upcomingPeople.map(p => p.full).join(' & ');
    englishParts.push(`We also have ${names} celebrating over the upcoming weekend!`);
    spanishParts.push(`¡También tenemos a ${names} celebrando durante el próximo fin de semana!`);
  }

  const subject = `Happy Birthday / ¡Feliz Cumpleaños! - ${allFirstNames.join(' & ')}`;

  const body =
    `${englishParts.join(' ')} Please join us in wishing ${pronounEN} a HAPPY BIRTHDAY if you have the chance! 🎂\n\n` +
    `${DIVIDER}\n\n` +
    `${spanishParts.join(' ')} Por favor, únete a nosotros para ${pronounES} un ¡FELIZ CUMPLEAÑOS! si tienes la oportunidad. 🎂`;

  return { subject, body };
}

// ============================================================
// DATA + SENDING
// ============================================================

async function fetchActiveEmployees() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  }

  const url = `${SUPABASE_URL}/rest/v1/employees` +
    `?status=eq.Active&select=name,birthday,text_bolt,status&order=name.asc`;

  const res = await fetch(url, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
  if (!res.ok) throw new Error(`Supabase error ${res.status}: ${await res.text()}`);

  return res.json();
}

// TextBolt gateways behave better with individual plain-text sends than with BCC,
// which is also what the legacy script did.
function createGmailSender() {
  if (!GMAIL_USER || !GMAIL_PASS) {
    throw new Error('Missing GMAIL_USER or GMAIL_APP_PASSWORD');
  }

  // Required lazily so dry runs and tests never need the mail library loaded.
  const nodemailer = require('nodemailer');

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_PASS }
  });

  return (to, subject, body) => transporter.sendMail({
    from: `Sequoia Forest Products <${GMAIL_USER}>`,
    to,
    subject,
    text: body
  });
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// ============================================================
// RUNNER
// ============================================================

// `now`, `employees` and `send` are injectable so tests and the dry-run path can
// drive this without touching Supabase or Gmail.
async function runBirthdayNotifications({
  now = new Date(),
  dryRun = false,
  employees = null,
  send = null,
  log = console.log
} = {}) {
  const today = calendarDateInZone(now);
  const stamp = `${today.year}-${String(today.month).padStart(2, '0')}-${String(today.day).padStart(2, '0')}`;

  // Cron is already Mon-Fri; this also protects manual invocations on a weekend.
  const window = buildTargetDates(today);
  if (!window) {
    log(`Birthday run skipped: ${stamp} is a weekend in ${TIME_ZONE}.`);
    return { status: 'weekend', date: stamp, sent: 0, failed: 0, recipients: 0, people: [] };
  }

  const roster = employees || await fetchActiveEmployees();
  const { todayPeople, upcomingPeople } = selectBirthdayPeople(roster, window.targets, log);

  if (todayPeople.length === 0 && upcomingPeople.length === 0) {
    log(`No birthdays for ${stamp} (looking ahead ${window.daysToLookAhead} day(s)).`);
    return { status: 'no-birthdays', date: stamp, sent: 0, failed: 0, recipients: 0, people: [] };
  }

  const allPeople = [...todayPeople, ...upcomingPeople];
  const names     = allPeople.map(p => p.first);
  const { subject, body } = composeMessage(todayPeople, upcomingPeople);
  const recipients = buildRecipients(roster, allPeople);

  if (dryRun) {
    log(`DRY RUN ${stamp} — would send to ${recipients.length} recipient(s).`);
    log(`Subject: ${subject}`);
    log(`Body:\n${body}`);
    log(`Recipients: ${recipients.join(', ') || '(none)'}`);
    return {
      status: 'dry-run', date: stamp, sent: 0, failed: 0,
      recipients: recipients.length, recipientList: recipients,
      people: names, subject, body
    };
  }

  const sender = send || createGmailSender();
  let sent = 0;
  let failed = 0;

  // Sequential, with a small gap, to stay friendly with Gmail rate limits.
  // One bad address must never abort the run.
  for (const recipient of recipients) {
    try {
      await sender(recipient, subject, body);
      sent++;
    } catch (err) {
      failed++;
      log(`Failed to send to ${recipient}: ${err.message}`);
    }
    await delay(SEND_DELAY_MS);
  }

  log(`Sent to ${sent} recipients (${failed} failed). Birthday people: ${names.join(', ')}`);

  return {
    status: 'sent', date: stamp, sent, failed,
    recipients: recipients.length, people: names, subject
  };
}

module.exports = {
  TIME_ZONE,
  calendarDateInZone,
  buildTargetDates,
  parseBirthday,
  isSendableAddress,
  selectBirthdayPeople,
  buildRecipients,
  composeMessage,
  fetchActiveEmployees,
  createGmailSender,
  runBirthdayNotifications
};
