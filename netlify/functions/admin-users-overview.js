// Admin-only. Separate from admin-export-emails.js (which stays unchanged
// and keeps powering the CSV export button) so adding new columns here
// never risks changing that CSV's shape. Read-only.
const { getSupabaseAdmin, getUserFromRequest } = require('./lib/supabaseAdmin');

exports.handler = async (event) => {
  try {
    const supabase = getSupabaseAdmin();
    const admin = await getUserFromRequest(event, supabase);
    if (!admin) return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated' }) };
    const { data: adminProfile } = await supabase.from('profiles').select('is_admin').eq('id', admin.id).single();
    if (!adminProfile?.is_admin) return { statusCode: 403, body: JSON.stringify({ error: 'Admin access required' }) };

    const { data: profiles, error: profilesErr } = await supabase
      .from('profiles')
      .select('id, email, full_name, organization_name, phone_country_code, phone_number, created_at');
    if (profilesErr) throw profilesErr;

    const { data: batchCerts, error: certsErr } = await supabase
      .from('certificates')
      .select('id, batches!inner(user_id)');
    if (certsErr) throw certsErr;

    const countByUser = {};
    for (const c of batchCerts || []) {
      const uid = c.batches?.user_id;
      if (!uid) continue;
      countByUser[uid] = (countByUser[uid] || 0) + 1;
    }

    const users = (profiles || []).map((p) => ({
      ...p,
      certificates_generated: countByUser[p.id] || 0,
    }));

    return { statusCode: 200, body: JSON.stringify({ users }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
