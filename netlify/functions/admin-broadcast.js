// Admin-only. Creates the broadcast record, then hands off actual sending
// to a background function (same pattern as certificate batches) so this
// request returns immediately instead of trying to send potentially
// hundreds of emails within one function's execution window.
const { getSupabaseAdmin, getUserFromRequest } = require('./lib/supabaseAdmin');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  try {
    const supabase = getSupabaseAdmin();
    const admin = await getUserFromRequest(event, supabase);
    if (!admin) return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated' }) };
    const { data: adminProfile } = await supabase.from('profiles').select('is_admin').eq('id', admin.id).single();
    if (!adminProfile?.is_admin) return { statusCode: 403, body: JSON.stringify({ error: 'Admin access required' }) };

    const { subject, body } = JSON.parse(event.body || '{}');
    if (!subject || !body) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Subject and message body are required' }) };
    }

    const { count } = await supabase.from('profiles').select('id', { count: 'exact', head: true });

    const { data: broadcast, error: insertErr } = await supabase
      .from('admin_broadcasts')
      .insert({ admin_id: admin.id, subject, body_html: body, recipient_count: count || 0, status: 'pending' })
      .select()
      .single();
    if (insertErr) throw insertErr;

    const siteUrl = process.env.URL || `https://${event.headers.host}`;
    try {
      await fetch(`${siteUrl}/.netlify/functions/send-broadcast-background`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ broadcastId: broadcast.id }),
      });
    } catch (triggerErr) {
      await supabase.from('admin_broadcasts').update({ status: 'failed' }).eq('id', broadcast.id);
      return { statusCode: 500, body: JSON.stringify({ error: 'Failed to start sending. Please try again.' }) };
    }

    return { statusCode: 200, body: JSON.stringify({ broadcastId: broadcast.id, recipientCount: count || 0 }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
