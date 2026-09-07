// Runs once a day via Netlify's Scheduled Functions (available on all
// plans — no upgrade needed). Two jobs, both bounded per run so this stays
// well inside a normal function's execution window even with a large backlog:
//
//   1. Reminder: certificates whose PDF expires within REMINDER_DAYS_BEFORE
//      days get ONE reminder email per batch (not per certificate) to the
//      account owner, then are marked so they're never reminded twice.
//   2. Cleanup: certificates whose PDF has actually expired get their file
//      deleted from Storage and pdf_path cleared. The certificate's row —
//      recipient name, program, organization, date, certificate number —
//      is never touched, so public verification keeps working forever.
//      Clearing pdf_path also makes the dashboard's "Download" button
//      disappear automatically (it only renders when pdf_path is truthy),
//      with no separate frontend change needed.
const { schedule } = require('@netlify/functions');
const { getSupabaseAdmin } = require('./lib/supabaseAdmin');
const { sendCertificateEmail } = require('./lib/mailer');

const BATCH_LIMIT_PER_RUN = 150;
const REMINDER_DAYS_BEFORE = 3;

async function runCleanup() {
  const supabase = getSupabaseAdmin();
  const now = new Date();

  // ---- 1. Reminders ----
  const reminderThreshold = new Date(now.getTime() + REMINDER_DAYS_BEFORE * 24 * 60 * 60 * 1000);
  const { data: needingReminder } = await supabase
    .from('certificates')
    .select('id, batch_id, recipient_name, program_title, pdf_expires_at, batches!inner(user_id, profiles:user_id(email, full_name))')
    .not('pdf_path', 'is', null)
    .is('reminder_sent_at', null)
    .lte('pdf_expires_at', reminderThreshold.toISOString())
    .gte('pdf_expires_at', now.toISOString())
    .limit(BATCH_LIMIT_PER_RUN);

  const byBatch = {};
  for (const c of needingReminder || []) {
    if (!byBatch[c.batch_id]) byBatch[c.batch_id] = { certs: [], owner: c.batches?.profiles };
    byBatch[c.batch_id].certs.push(c);
  }

  let remindersSent = 0;
  for (const [batchId, group] of Object.entries(byBatch)) {
    const owner = group.owner;
    if (!owner?.email) continue;
    const expiresAt = group.certs[0].pdf_expires_at;
    const list = group.certs.map((c) => `${c.recipient_name} — ${c.program_title}`).join('<br>');
    try {
      await sendCertificateEmail({
        to: owner.email,
        subject: `Reminder: ${group.certs.length} certificate(s) expiring soon`,
        html: `<p>Dear ${owner.full_name || owner.email},</p>
               <p>The following certificate(s) will no longer be downloadable after <strong>${new Date(expiresAt).toLocaleDateString()}</strong>. Please download them now if you haven't already — this doesn't affect public verification, which stays available forever, only the downloadable file.</p>
               <p>${list}</p>`,
        attachments: [],
      });
      const certIds = group.certs.map((c) => c.id);
      await supabase.from('certificates').update({ reminder_sent_at: new Date().toISOString() }).in('id', certIds);
      remindersSent++;
    } catch (err) {
      console.error(`Reminder email failed for batch ${batchId}:`, err.message);
    }
  }

  // ---- 2. Cleanup ----
  const { data: expired } = await supabase
    .from('certificates')
    .select('id, pdf_path')
    .not('pdf_path', 'is', null)
    .lt('pdf_expires_at', now.toISOString())
    .order('pdf_expires_at', { ascending: true })
    .limit(BATCH_LIMIT_PER_RUN);

  let filesDeleted = 0;
  for (const cert of expired || []) {
    try {
      await supabase.storage.from('certificates').remove([cert.pdf_path]);
      await supabase.from('certificates').update({ pdf_path: null, pdf_deleted_at: new Date().toISOString() }).eq('id', cert.id);
      filesDeleted++;
    } catch (err) {
      console.error(`Failed to delete expired certificate ${cert.id}:`, err.message);
    }
  }

  return { remindersSent, filesDeleted };
}

const handler = async () => {
  const result = await runCleanup();
  return { statusCode: 200, body: JSON.stringify(result) };
};

module.exports.handler = schedule('@daily', handler);
