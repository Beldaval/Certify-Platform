// Records that the authenticated user has accepted the current Terms of
// Service / Privacy Policy version. Called from the signup flow (after a
// successful scroll-gated acceptance) and from the one-time re-acceptance
// prompt shown to existing users who signed up before this feature existed.
const { getSupabaseAdmin, getUserFromRequest } = require('./lib/supabaseAdmin');
const { CURRENT_POLICY_VERSION } = require('./lib/policy');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  try {
    const supabase = getSupabaseAdmin();
    const user = await getUserFromRequest(event, supabase);
    if (!user) return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated' }) };

    const { error } = await supabase.from('policy_acceptances').insert({
      user_id: user.id,
      policy_version: CURRENT_POLICY_VERSION,
    });
    if (error) throw error;

    return { statusCode: 200, body: JSON.stringify({ ok: true, version: CURRENT_POLICY_VERSION }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
