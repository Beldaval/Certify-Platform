// FR-9.4 / FR-9.5 / SEC-10: admin-only, always logged as an auditable
// 'manual_adjustment' token transaction — never a silent balance edit.
const { getSupabaseAdmin, getUserFromRequest } = require('./lib/supabaseAdmin');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  try {
    const supabase = getSupabaseAdmin();
    const admin = await getUserFromRequest(event, supabase);
    if (!admin) return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated' }) };

    const { data: profile } = await supabase.from('profiles').select('is_admin').eq('id', admin.id).single();
    if (!profile?.is_admin) return { statusCode: 403, body: JSON.stringify({ error: 'Admin access required' }) };

    const { targetUserId, amount, reason } = JSON.parse(event.body || '{}');
    if (!targetUserId || !amount || !reason) {
      return { statusCode: 400, body: JSON.stringify({ error: 'targetUserId, amount, and reason are all required' }) };
    }

    const { data: newBalance, error } = await supabase.rpc('manual_credit_tokens', {
      p_user_id: targetUserId,
      p_amount: Number(amount),
      p_admin_id: admin.id,
      p_reason: reason,
    });
    if (error) throw error;

    return { statusCode: 200, body: JSON.stringify({ newBalance }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
