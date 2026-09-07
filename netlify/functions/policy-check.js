// Called right after login (existing users) to decide whether to show the
// one-time re-acceptance prompt. New signups already accept inline during
// signup, so this mainly matters for accounts created before this feature
// existed, or after a future policy version bump.
const { getSupabaseAdmin, getUserFromRequest } = require('./lib/supabaseAdmin');
const { CURRENT_POLICY_VERSION } = require('./lib/policy');

exports.handler = async (event) => {
  try {
    const supabase = getSupabaseAdmin();
    const user = await getUserFromRequest(event, supabase);
    if (!user) return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated' }) };

    const { data, error } = await supabase
      .from('policy_acceptances')
      .select('id')
      .eq('user_id', user.id)
      .eq('policy_version', CURRENT_POLICY_VERSION)
      .maybeSingle();
    if (error) throw error;

    return { statusCode: 200, body: JSON.stringify({ accepted: !!data, version: CURRENT_POLICY_VERSION }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
