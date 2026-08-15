// Gmail SMTP sender using an App Password (Phase 1 — see BRD/FRD 9/10).
// GMAIL_USER and GMAIL_APP_PASSWORD are read from Netlify environment
// variables only. Never hardcode these or commit them to any file.
const nodemailer = require('nodemailer');

function getTransport() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) throw new Error('Missing GMAIL_USER or GMAIL_APP_PASSWORD env vars');
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
}

async function sendCertificateEmail({ to, subject, html, attachments }) {
  const transport = getTransport();
  return transport.sendMail({
    from: `"${process.env.SENDER_NAME || 'Certify'}" <${process.env.GMAIL_USER}>`,
    to,
    subject,
    html,
    attachments, // [{ filename, content: Buffer }]
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { sendCertificateEmail, sleep };
