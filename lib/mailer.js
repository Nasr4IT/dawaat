const nodemailer = require('nodemailer');

// Optional feature: if SMTP + a notify address aren't configured in .env,
// every function here is a silent no-op — the site works fine without it,
// same pattern as background music / stickers.
let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transporter;
}

async function notifyNewLead(order) {
  const to = process.env.ADMIN_NOTIFY_EMAIL;
  const t = getTransporter();
  if (!t || !to) return;

  const lines = [
    'وصل طلب جديد من نموذج الموقع.',
    '',
    `العريس: ${order.groom_name}`,
    `العروسة: ${order.bride_name}`,
    `الهاتف: ${order.phone || '—'}`,
    `الباقة: ${order.plan}`,
  ];
  if (order.event_date) lines.push(`تاريخ الحفل: ${order.event_date}`);
  if (order.note) lines.push(`ملاحظة: ${order.note}`);
  lines.push('', 'افتحوا لوحة التحكم لمتابعة الطلب.');

  try {
    await t.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject: `طلب جديد: ${order.groom_name} و${order.bride_name}`,
      text: lines.join('\n'),
    });
  } catch (err) {
    console.error('تعذر إرسال إشعار البريد الإلكتروني لطلب جديد:', err.message);
  }
}

module.exports = { notifyNewLead };
