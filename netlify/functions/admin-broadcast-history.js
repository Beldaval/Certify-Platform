const { getSupabaseAdmin, getUserFromRequest } = require('./lib/supabaseAdmin');

exports.handler = async (event) => {
  try {
    const supabase = getSupabaseAdmin();
    const admin = await getUserFromRequest(event, supabase);
    if (!admin) return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated' }) };
    const { data: adminProfile } = await supabase.from('profiles').select('is_admin').eq('id', admin.id).single();
    if (!adminProfile?.is_admin) return { statusCode: 403, body: JSON.stringify({ error: 'Admin access required' }) };

    const { data, error } = await supabase
      .from('admin_broadcasts')
      .select('id, subject, recipient_count, status, created_at')
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) throw error;

    return { statusCode: 200, body: JSON.stringify({ broadcasts: data }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
