// Background Function (note the "-background" suffix — Netlify gives this
// up to 15 minutes instead of the ~10s normal limit). Triggered by
// create-batch.js right after tokens are deducted and certificate rows are
// written with generation_status='pending'.
//
// For each certificate: render SVG->PNG/PDF, upload to the private
// "certificates" Storage bucket, mark generated, then (paced) email it if a
// recipient address was given. Any failure refunds that certificate's token
// (FR-6.9) and marks it 'failed' rather than aborting the whole batch
// (FR-7.4).
const { getSupabaseAdmin } = require('./lib/supabaseAdmin');
const { renderCertificate } = require('./lib/render');
const { sendCertificateEmail, sleep } = require('./lib/mailer');

const EMAIL_PACING_MS = 3000; // FR-7.2 — space sends out to reduce spam-flagging
const SIGNED_URL_EXPIRY_SECONDS = 60 * 60 * 24 * 30; // 30 days, matches the 1-month retention window (FR-8.3)

exports.handler = async (event) => {
  const { batchId } = JSON.parse(event.body || '{}');
  if (!batchId) return { statusCode: 400, body: 'Missing batchId' };

  const supabase = getSupabaseAdmin();

  const { data: batch, error: batchErr } = await supabase.from('batches').select('*').eq('id', batchId).single();
  if (batchErr || !batch) return { statusCode: 404, body: 'Batch not found' };

  const { data: template, error: templateErr } = await supabase
    .from('templates')
    .select('*')
    .eq('id', batch.template_id)
    .single();
  if (templateErr || !template) return { statusCode: 404, body: 'Template not found' };

  const { data: certs, error: certsErr } = await supabase
    .from('certificates')
    .select('*')
    .eq('batch_id', batchId)
    .eq('generation_status', 'pending');
  if (certsErr) return { statusCode: 500, body: certsErr.message };

  const sameEmailAttachments = []; // used only if batch.same_email is true
  let anyFailures = false;

  for (const cert of certs) {
    try {
      // cert.field_values already holds every template field the client
      // collected (text, image data URIs, block-toggle booleans), keyed by
      // that template's own field ids. We overlay the four fields that are
      // always driven by dedicated top-level columns instead of the dynamic
      // form, so they can't be spoofed to mismatch the batch's own records.
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
      anyFailures = true;
      await supabase.from('certificates').update({ generation_status: 'failed' }).eq('id', cert.id);
      // FR-6.9 — refund the token for this specific certificate
      await supabase.rpc('refund_token', {
        p_user_id: batch.user_id,
        p_batch_id: batchId,
        p_reason: `Generation failed for certificate ${cert.id}: ${err.message}`,
      });
    }
  }

  // If the batch was set to "one email, multiple attachments" mode, send it now.
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

  await supabase.from('batches').update({ status: anyFailures ? 'completed' : 'completed' }).eq('id', batchId);

  return { statusCode: 200, body: 'Batch processed' };
};
