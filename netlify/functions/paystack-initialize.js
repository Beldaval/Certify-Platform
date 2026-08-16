// Starts a Paystack transaction for a wallet top-up.
// The PAYSTACK_SECRET_KEY never leaves this server-side function (SEC-3).
const { getSupabaseAdmin, getUserFromRequest } = require('./lib/supabaseAdmin');
const { MIN_TOPUP_NAIRA, nairaToTokens } = require('./lib/pricing');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  try {
    const supabase = getSupabaseAdmin();
    const user = await getUserFromRequest(event, supabase);
    if (!user) return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated' }) };

    const { amountNaira } = JSON.parse(event.body || '{}');
    const amount = Number(amountNaira);
    if (!amount || amount < MIN_TOPUP_NAIRA) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: `Minimum top-up is ₦${MIN_TOPUP_NAIRA}` }),
      };
    }

    const secretKey = process.env.PAYSTACK_SECRET_KEY;
    if (!secretKey) throw new Error('Missing PAYSTACK_SECRET_KEY env var');

   const tokens = nairaToTokens(amount);
    const resp = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: user.email,
        amount: Math.round(amount * 100), // kobo
        metadata: { user_id: user.id, tokens },
        callback_url: process.env.PUBLIC_SITE_URL
          ? `${process.env.PUBLIC_SITE_URL}/dashboard.html?topup=pending`
          : undefined,
      }),
    });
    const data = await resp.json();
    if (!data.status) {
      return { statusCode: 502, body: JSON.stringify({ error: data.message || 'Paystack init failed' }) };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        authorization_url: data.data.authorization_url,
        reference: data.data.reference,
        tokens,
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
