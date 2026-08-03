const nodemailer = require('nodemailer');

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_APP_PASSWORD;

async function sendEmail(to, subject, htmlBody) {
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
          otBudgetPercent, exceededEmployees, reportLink, totalPayroll,
          totalOTHours, totalRegularHours, totalPreApprovedHours, netOTHours,
          employeeCount, uploadTime } = data;

  const budgetVariance = (totalOTPercent - otBudgetPercent).toFixed(1);

  // Build exceeded employees table rows
  const employeeRows = exceededEmployees.map(emp => `
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
  <!-- Gmail preview text -->
  <div style="display:none;font-size:1px;color:#fefefe;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">
    OT Report ${dateRange} • Extra OT: ${netOTPercent}% • Pre-Approved: ${preApprovedOTPercent}% • Budget: ${totalOTPercent}% / ${otBudgetPercent}%
  </div>
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
              <div class="stat-sub">Base + assignments</div>
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
              <div class="stat-sub">Unapproved overtime</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">Pre-Approved OT %</div>
              <div class="stat-value">${preApprovedOTPercent}%</div>
              <div class="stat-sub">Approved hours</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">OT Budget</div>
              <div class="stat-value ${budgetVariance > 0 ? 'over-budget' : 'under-budget'}">${totalOTPercent}% / ${otBudgetPercent}%</div>
              <div class="stat-sub">Net: ${netOTPercent}%</div>
            </div>
          </div>
        </div>

        ${exceededEmployees.length > 0 ? `
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
        </div>
        ` : ''}

        <div class="cta-box">
          <p><strong>View the full detailed report:</strong></p>
          <a href="${reportLink}" class="cta-link">Open OT Report →</a>
        </div>

        <div class="section" style="background: #F9F9F9; padding: 12px; border-radius: 6px; margin-bottom: 0;">
          <p style="margin: 0; font-size: 12px; color: #666; line-height: 1.5;">
            <strong>Generated:</strong> ${uploadTime}<br>
            <strong>Employees:</strong> ${employeeCount} · <strong>Hours:</strong> ${totalRegularHours} reg + ${totalOTHours} OT
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

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { to, subject, data } = JSON.parse(event.body);

    if (!Array.isArray(to) || to.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No recipients specified' }) };
    }

    if (!GMAIL_USER || !GMAIL_PASS) {
      console.warn('Email credentials not configured');
      return { statusCode: 500, body: JSON.stringify({ error: 'Email service not configured' }) };
    }

    const htmlBody = generateEmailHTML(data);
    const results = [];

    for (const email of to) {
      try {
        const result = await sendEmail(email, subject, htmlBody);
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
      body: JSON.stringify({
        sent: successCount,
        failed: failCount,
        results: results
      })
    };

  } catch (error) {
    console.error('send-ot-email error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};
