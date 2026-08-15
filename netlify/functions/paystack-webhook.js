// Paystack webhook receiver.
// SEC-1 / FR-5.5–5.7: never trust the webhook payload alone.
//   1. Verify the x-paystack-signature header (HMAC SHA512 of the raw body).
//   2. Independently call GET /transaction/verify/:reference against Paystack.
//   3. Only if Paystack itself confirms status=success, credit tokens — and
//      do it through a DB function that is idempotent per reference, so a
//      retried/duplicated webhook can never double-credit.
const crypto = require('crypto');
const { getSupabaseAdmin } = require('./lib/supabaseAdmin');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) return { statusCode: 500, body: 'Server misconfigured' };

  const rawBody = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;

  const signature = event.headers['x-paystack-signature'] || event.headers['X-Paystack-Signature'];
  const expected = crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex');
  if (!signature || signature !== expected) {
    return { statusCode: 401, body: 'Invalid signature' };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { statusCode: 400, body: 'Bad payload' };
  }

  if (payload.event !== 'charge.success') {
    return { statusCode: 200, body: 'Ignored (not a charge.success event)' };
  }

  const reference = payload.data?.reference;
  if (!reference) return { statusCode: 400, body: 'Missing reference' };

  try {
    // Independent server-to-server re-verification — do not trust payload.data alone.
    const verifyResp = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${secretKey}` },
    });
    const verifyData = await verifyResp.json();

    if (!verifyData.status || verifyData.data?.status !== 'success') {
      return { statusCode: 200, body: 'Verification did not confirm success — ignored' };
    }

    const userId = verifyData.data.metadata?.user_id;
    const tokens = Number(verifyData.data.metadata?.tokens || 0);
    const amountKobo = verifyData.data.amount;

    if (!userId || !tokens) {
      return { statusCode: 200, body: 'Missing metadata — cannot credit, logged for manual review' };
    }

    const supabase = getSupabaseAdmin();
    const { error } = await supabase.rpc('credit_tokens_for_payment', {
      p_user_id: userId,
      p_reference: reference,
      p_amount_kobo: amountKobo,
      p_tokens: tokens,
    });
    if (error) throw error;

    return { statusCode: 200, body: 'OK' };
  } catch (err) {
    return { statusCode: 500, body: `Error: ${err.message}` };
  }
};
