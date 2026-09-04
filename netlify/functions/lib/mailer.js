// Resend SMTP relay — replaces the earlier Gmail SMTP setup. Using the
// same Resend account (and the same verified certsift.com sending domain)
// that Supabase Auth's emails already go through, so every email the
// platform sends — signup confirmations, password resets, AND certificate
// delivery — comes from one consistent, properly SPF/DKIM-authenticated
// source instead of certificate emails looking like they come from a
// personal Gmail account while auth emails look like they come from the
// real domain.
const nodemailer = require('nodemailer');

function getTransport() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('Missing RESEND_API_KEY env var');
  return nodemailer.createTransport({
    host: 'smtp.resend.com',
    port: 465,
    secure: true, // port 465 = implicit SSL/TLS, per Resend's own docs
    auth: { user: 'resend', pass: apiKey }, // literal string "resend" as username — the API key is the password
  });
}

async function sendCertificateEmail({ to, subject, html, attachments }) {
  const transport = getTransport();
  return transport.sendMail({
    from: `"${process.env.SENDER_NAME || 'Certsift'}" <${process.env.SENDER_EMAIL || 'noreply@certsift.com'}>`,
    to,
    subject,
    html,
    attachments, // [{ filename, content: Buffer }]
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { sendCertificateEmail, sleep };
