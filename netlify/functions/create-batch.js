// FR-3, FR-6.1–6.4: validates the batch, atomically deducts tokens (via the
// deduct_tokens_for_batch DB function, which row-locks the wallet so two
// concurrent requests can't overspend the same balance — SEC-9/FR-6.3),
// writes the batch + certificate rows, then kicks off the background
// generation function and returns immediately so the UI isn't blocked.
const { getSupabaseAdmin, getUserFromRequest } = require('./lib/supabaseAdmin');
const { TOKENS_PER_CERTIFICATE } = require('./lib/pricing');

const MAX_BATCH_SIZE = 50;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  try {
    const supabase = getSupabaseAdmin();
    const user = await getUserFromRequest(event, supabase);
    if (!user) return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated' }) };

        const { templateId, sameEmail, copyToSelf, certificates, issuingOrganization } = JSON.parse(event.body || '{}');

    if (!templateId || !Array.isArray(certificates) || certificates.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'templateId and at least one certificate are required' }) };
    }
    if (certificates.length > MAX_BATCH_SIZE) {
      return { statusCode: 400, body: JSON.stringify({ error: `Batches are limited to ${MAX_BATCH_SIZE} certificates` }) };
    }
    for (const c of certificates) {
      if (!c.recipient_name || !c.program_title) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Each certificate needs at least recipient_name and program_title' }) };
      }
    }

    const { data: template, error: templateErr } = await supabase
      .from('templates')
      .select('*')
      .eq('id', templateId)
      .eq('active', true)
      .single();
    if (templateErr || !template) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Unknown template' }) };
    }

    const tokenCost = certificates.length * TOKENS_PER_CERTIFICATE;

    // 1) Create the batch row first (status pending) so we have an id to
    //    attach the deduction/refund transactions to.
    const { data: batch, error: batchErr } = await supabase
      .from('batches')
      .insert({ user_id: user.id, template_id: templateId, token_cost: tokenCost, same_email: !!sameEmail, copy_to_self: !!copyToSelf, status: 'pending' })
      .select()
      .single();
    if (batchErr) throw batchErr;

    // 2) Atomically check + deduct tokens. Insufficient balance -> exception,
    //    batch stays 'pending' with 0 certificates and the client is told to top up.
    const { error: deductErr } = await supabase.rpc('deduct_tokens_for_batch', {
      p_user_id: user.id,
      p_amount: tokenCost,
      p_batch_id: batch.id,
    });
    if (deductErr) {
      await supabase.from('batches').update({ status: 'failed' }).eq('id', batch.id);
      if (String(deductErr.message).includes('INSUFFICIENT_TOKENS')) {
        return { statusCode: 402, body: JSON.stringify({ error: 'Insufficient token balance — please top up.' }) };
      }
      throw deductErr;
    }

    // 3) Insert certificate rows (certificate_number is auto-assigned by a DB trigger).
    const rows = certificates.map((c) => ({
      batch_id: batch.id,
      template_id: templateId,
      // field_values carries every other template field for this recipient —
      // text strings, image fields as data: URIs, block-toggle booleans —
      // keyed by the template's own field ids (see public/assets/templates.json).
      field_values: c.field_values || {},
      recipient_name: c.recipient_name,
      recipient_email: c.recipient_email || null,
      program_title: c.program_title,
      issuing_organization: issuingOrganization || user.email,
      generation_status: 'pending',
      delivery_status: c.recipient_email ? 'pending' : 'skipped',
    }));
    const { error: certErr } = await supabase.from('certificates').insert(rows);
    if (certErr) throw certErr;

    await supabase.from('batches').update({ status: 'generating' }).eq('id', batch.id);

    // 4) Hand off rendering/upload/email to the Background Function (up to
    //    15 min — now usable since the site is on a paid Netlify plan)
    //    instead of awaiting processBatch() here. Awaiting processBatch()
    //    inline was the entire cause of the earlier 504s: regular
    //    functions have a hard ~10-26s ceiling no matter what plan you're
    //    on.
    //
    //    IMPORTANT: this trigger call itself MUST be awaited (even though
    //    the processing it kicks off is not). Netlify Functions run on
    //    Lambda — once this handler returns, its execution environment can
    //    freeze immediately, killing any in-flight request that wasn't
    //    awaited. A fire-and-forget fetch() here was silently never
    //    reaching generate-batch-background at all: the request got
    //    frozen mid-flight before it could error, so nothing ever showed
    //    up in that function's logs. Awaiting only costs the time it
    //    takes Netlify to ACCEPT the background invocation and hand back
    //    its 202 (milliseconds) — the actual 15 minutes of processing
    //    still happens async on the other side.
    const siteUrl = process.env.URL || `https://${event.headers.host}`;
    try {
      await fetch(`${siteUrl}/.netlify/functions/generate-batch-background`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchId: batch.id }),
      });
    } catch (err) {
      console.error('Failed to trigger generate-batch-background:', err);
      await supabase.from('batches').update({ status: 'failed' }).eq('id', batch.id);
      return { statusCode: 500, body: JSON.stringify({ error: 'Failed to start certificate generation. Please try again.' }) };
    }

    return { statusCode: 200, body: JSON.stringify({ batchId: batch.id, tokenCost }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
