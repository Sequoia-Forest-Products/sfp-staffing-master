const db = require('./db');
const { verifySession, getCookies } = require('./session-lib');

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_APP_PASSWORD;

// This endpoint sends mail *from* the company Gmail account, so an unauthenticated
// caller here is an open relay wearing Sequoia's return address. Session check first,
// then a recipient allowlist the server owns — the client only ever proposes.
const ALLOWED_DOMAIN = (process.env.ALLOWED_DOMAIN || 'sequoiafp.com').toLowerCase();
const MAX_RECIPIENTS = 25;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeAddress(v) {
  return String(v == null ? '' : v).trim().toLowerCase();
}

// Pure so tests can exercise the rule without a network or a database.
// `proposed` is whatever the client sent; `managers` is the saved list read
// server-side. An address passes only if it is a saved manager or sits on the
// company domain. Anything else names itself in the error.
function resolveRecipients(proposed, managers, opts) {
  const domain = ((opts && opts.allowedDomain) || ALLOWED_DOMAIN).toLowerCase();
  const max = (opts && opts.maxRecipients) || MAX_RECIPIENTS;
  const allowed = new Set((managers || []).map(normalizeAddress).filter(Boolean));

  const asked = Array.isArray(proposed) ? proposed.map(normalizeAddress).filter(Boolean) : [];
  // No proposal (or an empty one) means "whoever is configured" rather than "nobody".
  const list = asked.length ? asked : Array.from(allowed);
  if (!list.length) return { ok: false, error: 'No manager recipients are configured' };
  if (list.length > max) return { ok: false, error: `Too many recipients (${list.length}); the limit is ${max}` };

  const recipients = [];
  for (const addr of list) {
    if (!EMAIL_RE.test(addr)) return { ok: false, error: `Invalid email address: ${addr}` };
    if (!allowed.has(addr) && addr.slice(addr.lastIndexOf('@') + 1) !== domain) {
      return { ok: false, error: `Recipient not allowed: ${addr}` };
    }
    if (!recipients.includes(addr)) recipients.push(addr);
  }
  return { ok: true, recipients };
}

// settings.js writes this row two different ways (object on insert, JSON string on
// update), so accept either shape rather than trusting one of them.
function managersFromSettingsRow(row) {
  let value = row && row.value;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return []; }
  }
  return (value && Array.isArray(value.managers)) ? value.managers : [];
}

async function loadManagers() {
  const rows = await db.query('settings', '?key=eq.emailSettings');
  return managersFromSettingsRow(rows && rows[0]);
}

async function sendEmail(to, subject, htmlBody) {
  const nodemailer = require('nodemailer'); // lazy — see birthday-lib.js
  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: GMAIL_USER,
        pass: GMAIL_PASS
      }
    });

    const mailOptions = {
      from: `Sequoia Forest Products <${GMAIL_USER}>`,
      to: to,
      subject: subject,
      html: htmlBody
    };

    const result = await transporter.sendMail(mailOptions);
    return result;
  } catch (error) {
    console.error('Email send error:', error);
    throw error;
  }
}

function generateEmailHTML(data) {
  const { dateRange, totalOTPercent, preApprovedOTPercent, netOTPercent,
          otBudgetPercent, exceededEmployees, exceededOmitted, reportLink, totalPayroll,
          totalOTHours, totalRegularHours, totalPreApprovedHours, netOTHours,
          employeeCount, uploadTime } = data;

  const budgetVariance = (totalOTPercent - otBudgetPercent).toFixed(1);

  // Build exceeded employees table rows
  const shown = Array.isArray(exceededEmployees) ? exceededEmployees : [];
  const omitted = Number(exceededOmitted) || 0;
  const employeeRows = shown.map(emp => `
    <tr>
      <td>${emp.name}</td>
      <td class="hours">${emp.unapprovedHours} hrs</td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Montserrat', Arial, sans-serif; line-height: 1.6; color: #27211E; background: #F5F5F5; }
    .container { max-width: 600px; margin: 0 auto; background: #F5F5F5; padding: 16px; }
    .email { background: white; border-radius: 8px; overflow: hidden; }
    .header { background: #27211E; color: white; padding: 24px 16px; text-align: center; }
    .logo { font-size: 24px; font-weight: 900; letter-spacing: 2px; margin-bottom: 12px; color: #EE7425; }
    .header h1 { margin: 0; font-size: 22px; font-weight: 700; }
    .header p { margin: 8px 0 0 0; font-size: 13px; opacity: 0.9; color: #EAD9CA; }
    .content { padding: 20px; }
    .date-range { background: #27211E; color: white; padding: 12px; border-radius: 6px; margin-bottom: 20px; text-align: center; font-weight: 600; font-size: 13px; }
    .section { margin-bottom: 24px; }
    .section-title { font-size: 12px; font-weight: 900; text-transform: uppercase; letter-spacing: 1px; color: #27211E; margin-bottom: 12px; border-bottom: 3px solid #AD4C25; padding-bottom: 6px; }
    .stat-row { margin-bottom: 12px; }
    .stat-box { background: #F9F9F9; padding: 12px; border-radius: 6px; border-left: 4px solid #27211E; margin-bottom: 12px; display: inline-block; width: calc(33.333% - 8px); margin-right: 12px; vertical-align: top; }
    .stat-box:nth-child(3n) { margin-right: 0; }
    .stat-label { font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; margin-bottom: 4px; }
    .stat-value { font-size: 20px; font-weight: 900; color: #27211E; }
    .stat-sub { font-size: 11px; color: #999; margin-top: 2px; }
    .stat-value.over-budget { color: #902423; }
    .stat-value.under-budget { color: #2a7a47; }
    table { width: 100%; border-collapse: collapse; }
    thead { background: #27211E; color: white; }
    th { padding: 10px 8px; text-align: left; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }
    td { padding: 8px; border-bottom: 1px solid #EEE; font-size: 12px; }
    .hours { text-align: right; font-weight: 700; color: #902423; }
    .cta-box { background: #27211E; padding: 16px; text-align: center; margin-bottom: 20px; border-radius: 6px; }
    .cta-box p { color: white; margin: 0 0 12px 0; font-size: 13px; }
    .cta-link { display: inline-block; background: #EE7425; color: white; padding: 10px 24px; border-radius: 4px; text-decoration: none; font-weight: 700; font-size: 13px; }
    .footer { background: #27211E; color: #EAD9CA; padding: 16px; text-align: center; font-size: 11px; }
    .footer p { margin: 4px 0; }
    @media (max-width: 480px) {
      .container { padding: 8px; }
      .content { padding: 12px; }
      .header { padding: 16px 12px; }
      .logo { font-size: 20px; }
      .header h1 { font-size: 18px; }
      .stat-box { width: 100%; margin-right: 0; margin-bottom: 10px; }
      .stat-box:nth-child(3n) { margin-right: 0; }
      .stat-value { font-size: 18px; }
      th, td { padding: 6px 4px; font-size: 11px; }
      .cta-link { padding: 8px 20px; font-size: 12px; }
    }
  </style>
</head>
<body>
  <!-- Gmail preview -->
  <div style="font-size:0;color:#f5f5f5;display:none;max-height:0;max-width:0;overflow:hidden;">
    Extra OT ${netOTPercent}% • Pre-Approved ${preApprovedOTPercent}% • Budget ${totalOTPercent}%/${otBudgetPercent}% of hourly payroll
  </div>
  <div class="container">
    <div class="email">
      <div class="header">
        <div class="logo">SEQUOIA</div>
        <h1>Overtime Report</h1>
        <p>Staffing Master</p>
      </div>

      <div class="content">
        <div class="date-range">📅 ${dateRange}</div>

        <div class="section">
          <div class="section-title">Summary</div>
          <div class="stat-row">
            <div class="stat-box">
              <div class="stat-label">All OT (hours)</div>
              <div class="stat-value">${totalOTHours}</div>
              <div class="stat-sub">Total overtime</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">Pre-Approved OT</div>
              <div class="stat-value">${totalPreApprovedHours}</div>
              <div class="stat-sub">Standing weekly allowance</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">Net OT (hours)</div>
              <div class="stat-value">${netOTHours}</div>
              <div class="stat-sub">Unapproved overtime</div>
            </div>
          </div>
          <div class="stat-row">
            <div class="stat-box">
              <div class="stat-label">Extra OT</div>
              <div class="stat-value">${netOTPercent}%</div>
              <div class="stat-sub">Of hourly payroll</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">Pre-Approved OT %</div>
              <div class="stat-value">${preApprovedOTPercent}%</div>
              <div class="stat-sub">Of hourly payroll</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">OT Budget (% of hourly payroll)</div>
              <div class="stat-value ${budgetVariance > 0 ? 'over-budget' : 'under-budget'}">${totalOTPercent}% / ${otBudgetPercent}%</div>
              <div class="stat-sub">Net: ${netOTPercent}%</div>
            </div>
          </div>
        </div>

        ${shown.length > 0 ? `
        <div class="section">
          <div class="section-title">Employees Exceeding Pre-Approved Limits</div>
          <table>
            <thead>
              <tr>
                <th>Employee</th>
                <th class="hours">Unapproved Hours</th>
              </tr>
            </thead>
            <tbody>
              ${employeeRows}
            </tbody>
          </table>
          ${omitted > 0 ? `<p style="margin-top:8px;font-size:11px;color:#666">…and ${omitted} more. Open the full report for the rest.</p>` : ''}
        </div>
        ` : ''}

        <div class="cta-box">
          <p><strong>View the full detailed report:</strong></p>
          <a href="${reportLink}" class="cta-link">Open OT Report →</a>
        </div>

        <div class="section" style="background: #F9F9F9; padding: 12px; border-radius: 6px; margin-bottom: 0;">
          <p style="margin: 0; font-size: 12px; color: #666; line-height: 1.5;">
            <strong>Generated:</strong> ${uploadTime}<br>
            <strong>Total hourly payroll:</strong> $${totalPayroll}<br>
            <strong>Hourly employees:</strong> ${employeeCount} · <strong>Hours:</strong> ${totalRegularHours} reg + ${totalOTHours} OT<br>
            <span style="font-size:11px">Hourly payroll only — salaried staff are excluded at import, so every percentage above is a share of hourly payroll.</span>
          </p>
        </div>
      </div>

      <div class="footer">
        <p>Sequoia Forest Products — Staffing Master</p>
        <p style="font-size: 10px; margin-top: 8px; opacity: 0.8;">Automated report — do not reply</p>
        <p style="font-size: 10px; opacity: 0.6;">© 2026 Sequoia Forest Products</p>
      </div>
    </div>
  </div>
</body>
</html>`;
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  const session = verifySession(getCookies(event).sfp_session || '');
  if (!session) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { to, subject, data } = JSON.parse(event.body || '{}');

    if (!data || typeof data !== 'object') {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'No report data supplied' }) };
    }

    let managers = [];
    try {
      managers = await loadManagers();
    } catch (err) {
      console.error('Could not read the manager list:', err.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not read the manager list' }) };
    }

    const resolved = resolveRecipients(to, managers);
    if (!resolved.ok) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: resolved.error }) };
    }

    if (!GMAIL_USER || !GMAIL_PASS) {
      console.warn('Email credentials not configured');
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Email service not configured' }) };
    }

    const htmlBody = generateEmailHTML(data);
    const results = [];

    for (const email of resolved.recipients) {
      try {
        const result = await sendEmail(email, subject || 'OT Report', htmlBody);
        results.push({ email, success: true, messageId: result.messageId });
        console.log(`Email sent to ${email}`);
      } catch (err) {
        results.push({ email, success: false, error: err.message });
        console.error(`Failed to send to ${email}:`, err.message);
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failCount = results.length - successCount;

    return {
      statusCode: successCount > 0 ? 200 : 500,
      headers,
      body: JSON.stringify({
        sent: successCount,
        failed: failCount,
        results: results
      })
    };

  } catch (error) {
    console.error('send-ot-email error:', error.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message })
    };
  }
};

// Exported for tests — the allowlist rule is the security boundary, so it is
// checked directly rather than through the handler.
module.exports.resolveRecipients = resolveRecipients;
module.exports.managersFromSettingsRow = managersFromSettingsRow;
module.exports.generateEmailHTML = generateEmailHTML;
module.exports.ALLOWED_DOMAIN = ALLOWED_DOMAIN;
module.exports.MAX_RECIPIENTS = MAX_RECIPIENTS;
