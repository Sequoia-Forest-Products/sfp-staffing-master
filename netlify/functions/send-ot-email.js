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
  <style>
    body { font-family: 'Montserrat', Arial, sans-serif; line-height: 1.6; color: #27211E; max-width: 700px; margin: 0 auto; }
    .container { background: #F5F5F5; padding: 20px; }
    .email { background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 8px rgba(0,0,0,0.1); }
    .header { background: #27211E; color: white; padding: 32px 24px; text-align: center; }
    .logo { font-size: 28px; font-weight: 900; letter-spacing: 2px; margin-bottom: 16px; color: #EE7425; }
    .header h1 { margin: 0; font-size: 26px; font-weight: 700; }
    .header p { margin: 12px 0 0 0; font-size: 15px; opacity: 0.9; color: #EAD9CA; }
    .content { padding: 32px; }
    .date-range { background: #27211E; color: white; padding: 12px 16px; border-radius: 6px; margin-bottom: 24px; text-align: center; font-weight: 600; font-size: 14px; }
    .section { margin-bottom: 32px; }
    .section-title { font-size: 13px; font-weight: 900; text-transform: uppercase; letter-spacing: 1px; color: #27211E; margin-bottom: 16px; border-bottom: 3px solid #AD4C25; padding-bottom: 8px; }
    .stats { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; margin-bottom: 24px; }
    .stat-box { background: #F9F9F9; padding: 16px; border-radius: 6px; border-left: 5px solid #27211E; }
    .stat-label { font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; margin-bottom: 6px; }
    .stat-value { font-size: 24px; font-weight: 900; color: #27211E; }
    .stat-sub { font-size: 12px; color: #999; margin-top: 4px; }
    .stat-value.over-budget { color: #902423; }
    .stat-value.under-budget { color: #2a7a47; }
    .employee-list { width: 100%; border-collapse: collapse; }
    .employee-list thead { background: #27211E; color: white; border-bottom: 2px solid #27211E; }
    .employee-list th { padding: 12px; text-align: left; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }
    .employee-list td { padding: 10px 12px; border-bottom: 1px solid #EEE; font-size: 13px; }
    .employee-list tbody tr:hover { background: #F9F9F9; }
    .employee-list .hours { text-align: right; font-weight: 700; color: #902423; }
    .cta-box { background: #27211E; border: 2px solid #27211E; border-radius: 6px; padding: 20px; text-align: center; margin-bottom: 24px; }
    .cta-box p { color: white; }
    .cta-link { display: inline-block; background: #EE7425; color: white; padding: 12px 28px; border-radius: 4px; text-decoration: none; font-weight: 700; font-size: 14px; }
    .cta-link:hover { background: #AD4C25; }
    .footer { background: #27211E; color: #EAD9CA; padding: 24px 32px; text-align: center; font-size: 12px; }
    .footer p { margin: 6px 0; }
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
        <div class="date-range">
          📅 ${dateRange}
        </div>

        <div class="section">
          <div class="section-title">Summary</div>
          <div class="stats">
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
          <table class="employee-list">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Unapproved Hours</th>
              </tr>
            </thead>
            <tbody>
              ${employeeRows}
            </tbody>
          </table>
        </div>
        ` : ''}

        <div class="cta-box">
          <p style="margin: 0 0 16px 0; font-size: 14px;">
            <strong>View the full detailed report:</strong>
          </p>
          <a href="${reportLink}" class="cta-link">Open OT Report →</a>
        </div>

        <div class="section" style="background: #F9F9F9; padding: 16px; border-radius: 6px; margin-bottom: 0;">
          <p style="margin: 0; font-size: 13px; color: #666;">
            <strong>Generated:</strong> ${uploadTime}<br>
            <strong>Employees:</strong> ${employeeCount} · <strong>Hours:</strong> ${totalRegularHours} reg + ${totalOTHours} OT
          </p>
        </div>
      </div>

      <div class="footer">
        <p>Sequoia Forest Products — Staffing Master</p>
        <p style="font-size: 11px; margin-top: 12px; opacity: 0.8;">Automated report — do not reply</p>
        <p style="font-size: 11px; opacity: 0.6;">© 2026 Sequoia Forest Products</p>
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
