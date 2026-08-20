// Admin-only user lookup by email (SEC-11 / FR-9). Reads only — never
// writes anything, and creates no new tables or logs. Everything shown
// here already exists in profiles/wallets/token_transactions/batches/
// certificates; this just assembles it into one readable view instead of
// requiring the admin to piece it together across several Supabase tables
// and a UUID copy-paste.
const { getSupabaseAdmin, getUserFromRequest } = require('./lib/supabaseAdmin');

const RECENT_TRANSACTIONS_LIMIT = 15;
const RECENT_CERTIFICATES_LIMIT = 10;

exports.handler = async (event) => {
  try {
    const supabase = getSupabaseAdmin();
    const admin = await getUserFromRequest(event, supabase);
    if (!admin) return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated' }) };

    const { data: adminProfile } = await supabase.from('profiles').select('is_admin').eq('id', admin.id).single();
    if (!adminProfile?.is_admin) return { statusCode: 403, body: JSON.stringify({ error: 'Admin access required' }) };

    const email = (event.queryStringParameters?.email || '').trim().toLowerCase();
    if (!email) return { statusCode: 400, body: JSON.stringify({ error: 'Missing email' }) };

    const { data: profile, error: profileErr } = await supabase
      .from('profiles')
      .select('id, email, full_name, organization_name, is_admin, created_at')
      .ilike('email', email)
      .maybeSingle();
    if (profileErr) throw profileErr;
    if (!profile) return { statusCode: 200, body: JSON.stringify({ found: false }) };

    const { data: wallet } = await supabase
      .from('wallets')
      .select('trial_tokens_remaining, purchased_tokens, updated_at')
      .eq('user_id', profile.id)
      .maybeSingle();

    const { data: transactionsRaw } = await supabase
      .from('token_transactions')
      .select('id, type, token_amount, balance_after, note, created_at')
      .eq('user_id', profile.id)
      .order('created_at', { ascending: false })
      .limit(RECENT_TRANSACTIONS_LIMIT);

    const transactions = (transactionsRaw || []).map((t) => ({
      ...t,
      balance_before: t.balance_after - t.token_amount,
    }));

    const { data: certificates } = await supabase
      .from('certificates')
      .select('id, recipient_name, program_title, certificate_number, generation_status, delivery_status, created_at, batches!inner(user_id)')
      .eq('batches.user_id', profile.id)
      .order('created_at', { ascending: false })
      .limit(RECENT_CERTIFICATES_LIMIT);

    return {
      statusCode: 200,
      body: JSON.stringify({
        found: true,
        profile,
        wallet: wallet
          ? { ...wallet, total: wallet.trial_tokens_remaining + wallet.purchased_tokens }
          : null,
        transactions,
        certificates: (certificates || []).map(({ batches, ...c }) => c),
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
