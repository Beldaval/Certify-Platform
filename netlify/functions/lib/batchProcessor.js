// Shared certificate-batch processing logic.
//
// This used to live only inside generate-batch-background.js, invoked as a
// separate fire-and-forget HTTP call from create-batch.js. That relies on
// Netlify Background Functions, which are a paid-plan feature — on the free
// tier the trigger call fails silently (caught and ignored), so the batch
// is created, tokens are deducted, certificate rows are written as
// 'pending'... and then nothing ever processes them. They sit at "pending"
// forever with no error surfaced anywhere.
//
// create-batch.js now calls processBatch() directly, in-process, and awaits
// it before responding — no separate function invocation, no paid-plan
// requirement. generate-batch-background.js is kept as a thin wrapper in
// case a future paid-plan deployment wants to go back to true background
// processing for very large batches.
//
// Trade-off: because this now runs inside the same request/response cycle
// as create-batch, very large batches (approaching the 50-certificate max)
// with default 3s-per-email pacing could take a few minutes — long enough
// to hit a normal (non-background) function's execution limit on some
// plans. If large batches start timing out, lower EMAIL_PACING_MS below,
// or split large batches into a few smaller ones for now.
const { getSupabaseAdmin } = require('./supabaseAdmin');
const { renderCertificate } = require('./render');
const { sendCertificateEmail, sleep } = require('./mailer');
const { TOKENS_PER_CERTIFICATE } = require('./pricing');

const EMAIL_PACING_MS = 1500; // FR-7.2 — space sends out to reduce spam-flagging, kept short since this now runs inline

async function processBatch(batchId) {
  const supabase = getSupabaseAdmin();

  const { data: batch, error: batchErr } = await supabase.from('batches').select('*').eq('id', batchId).single();
  if (batchErr || !batch) throw new Error('Batch not found');

  const { data: template, error: templateErr } = await supabase
    .from('templates')
    .select('*')
    .eq('id', batch.template_id)
    .single();
  if (templateErr || !template) throw new Error('Template not found');

  const { data: certs, error: certsErr } = await supabase
    .from('certificates')
    .select('*')
    .eq('batch_id', batchId)
    .eq('generation_status', 'pending');
  if (certsErr) throw certsErr;

  const sameEmailAttachments = []; // used only if batch.same_email is true
  const allAttachments = []; // every generated certificate, regardless of same_email — used for the optional "copy me" email
  let anyFailures = false;

  for (const cert of certs) {
    try {
      const fieldValues = {
        ...cert.field_values,
        'recipient-name': cert.recipient_name,
        'course-title': cert.program_title,
        'institution-name': cert.issuing_organization,
        'certificate-number': cert.certificate_number,
      };

      const { pdfBytes } = await renderCertificate({ templateDef: template, fieldValues });

      const safeName = `${cert.recipient_name}-${cert.program_title}`.replace(/[^a-zA-Z0-9-_ ]/g, '').trim().replace(/\s+/g, '_');
      const pdfPath = `${batch.user_id}/${batchId}/${cert.id}_${safeName}.pdf`;

      const { error: uploadErr } = await supabase.storage
        .from('certificates')
        .upload(pdfPath, Buffer.from(pdfBytes), { contentType: 'application/pdf', upsert: true });
      if (uploadErr) throw uploadErr;

      await supabase
        .from('certificates')
        .update({ generation_status: 'generated', pdf_path: pdfPath })
        .eq('id', cert.id);

      allAttachments.push({ filename: `${safeName}.pdf`, content: Buffer.from(pdfBytes) });

      if (cert.recipient_email && cert.delivery_status !== 'skipped') {

      if (cert.recipient_email && cert.delivery_status !== 'skipped') {
        if (batch.same_email) {
          sameEmailAttachments.push({ filename: `${safeName}.pdf`, content: Buffer.from(pdfBytes) });
        } else {
          try {
            await sendCertificateEmail({
              to: cert.recipient_email,
              subject: `Your certificate: ${cert.program_title}`,
              html: `<p>Dear ${cert.recipient_name},</p><p>Please find attached your certificate for <strong>${cert.program_title}</strong>.</p><p>Certificate No: ${cert.certificate_number}</p>`,
              attachments: [{ filename: `${safeName}.pdf`, content: Buffer.from(pdfBytes) }],
            });
            await supabase.from('certificates').update({ delivery_status: 'sent' }).eq('id', cert.id);
          } catch (mailErr) {
            await supabase.from('certificates').update({ delivery_status: 'failed' }).eq('id', cert.id);
          }
          await sleep(EMAIL_PACING_MS);
        }
      }
} catch (err) {
  // Log the real error — without this, a failed certificate shows up
  // in the UI as just "failed" with no way to tell why. This shows up
  // in Netlify's generate-batch-background function logs.
  console.error(`Certificate ${cert.id} (${cert.recipient_name}) failed:`, err);
  anyFailures = true;
  await supabase.from('certificates').update({ generation_status: 'failed' }).eq('id', cert.id);
  await supabase.rpc('refund_token', {
    p_user_id: batch.user_id,
    p_amount: TOKENS_PER_CERTIFICATE,
    p_batch_id: batchId,
    p_reason: `Generation failed for certificate ${cert.id}: ${err.message}`,
  });
}
  }

  if (batch.same_email && sameEmailAttachments.length > 0) {
    const firstWithEmail = certs.find((c) => c.recipient_email);
    if (firstWithEmail) {
      try {
        await sendCertificateEmail({
          to: firstWithEmail.recipient_email,
          subject: `Your certificates — ${template.name}`,
          html: `<p>Please find attached ${sameEmailAttachments.length} certificate(s).</p>`,
          attachments: sameEmailAttachments,
        });
        await supabase.from('certificates').update({ delivery_status: 'sent' }).eq('batch_id', batchId).eq('recipient_email', firstWithEmail.recipient_email);
      } catch {
        await supabase.from('certificates').update({ delivery_status: 'failed' }).eq('batch_id', batchId);
      }
    }
  }

  // "Copy me" — additive, independent of same_email: sends every generated
  // certificate as one bundled email to the account's own registered
  // email, regardless of how recipients themselves were emailed. Lets the
  // sender keep a complete set to print, without changing recipient delivery.
  if (batch.copy_to_self && allAttachments.length > 0) {
    const { data: ownerProfile } = await supabase.from('profiles').select('email').eq('id', batch.user_id).single();
    if (ownerProfile?.email) {
      try {
        await sendCertificateEmail({
          to: ownerProfile.email,
          subject: `Your copy — ${template.name} batch (${allAttachments.length} certificate(s))`,
          html: `<p>Attached is a copy of all ${allAttachments.length} certificate(s) generated in this batch.</p>`,
          attachments: allAttachments,
        });
      } catch (copyErr) {
        console.error(`copy_to_self email failed for batch ${batchId}:`, copyErr.message);
      }
    }
  }

  await supabase.from('batches').update({ status: 'completed' }).eq('id', batchId);

  return { anyFailures };
}

module.exports = { processBatch };
