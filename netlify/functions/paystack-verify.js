// Called by the dashboard right after the user is redirected back from
// Paystack, so the UI doesn't have to wait on the webhook. It re-runs the
// exact same server-side verification + idempotent credit as the webhook
// (FR-5.5–5.7), so whichever of the two arrives first does the crediting and
// the other is a harmless no-op.
const { getSupabaseAdmin, getUserFromRequest } = require('./lib/supabaseAdmin');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  try {
    const supabase = getSupabaseAdmin();
    const user = await getUserFromRequest(event, supabase);
    if (!user) return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated' }) };

    const { reference } = JSON.parse(event.body || '{}');
    if (!reference) return { statusCode: 400, body: JSON.stringify({ error: 'Missing reference' }) };

    const secretKey = process.env.PAYSTACK_SECRET_KEY;
    const verifyResp = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${secretKey}` },
    });
    const verifyData = await verifyResp.json();

    if (!verifyData.status || verifyData.data?.status !== 'success') {
      return { statusCode: 200, body: JSON.stringify({ credited: false, status: verifyData.data?.status || 'unknown' }) };
    }

    if (verifyData.data.metadata?.user_id !== user.id) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Reference does not belong to this user' }) };
    }

    const tokens = Number(verifyData.data.metadata?.tokens || 0);
    const { data: newBalance, error } = await supabase.rpc('credit_tokens_for_payment', {
      p_user_id: user.id,
      p_reference: reference,
      p_amount_kobo: verifyData.data.amount,
      p_tokens: tokens,
    });
    if (error) throw error;

    return { statusCode: 200, body: JSON.stringify({ credited: true, balance: newBalance }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
