// Admin-only. Creates the broadcast record, then hands off actual sending
// to a background function (same pattern as certificate batches) so this
// request returns immediately instead of trying to send potentially
// hundreds of emails within one function's execution window.
//
// recipientUserIds is optional: when the admin selects specific users from
// the "All users" table, only those get the email. Omitted or empty means
// "send to everyone" (the original, still-default behavior).
const { getSupabaseAdmin, getUserFromRequest } = require('./lib/supabaseAdmin');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  try {
    const supabase = getSupabaseAdmin();
    const admin = await getUserFromRequest(event, supabase);
    if (!admin) return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated' }) };
    const { data: adminProfile } = await supabase.from('profiles').select('is_admin').eq('id', admin.id).single();
    if (!adminProfile?.is_admin) return { statusCode: 403, body: JSON.stringify({ error: 'Admin access required' }) };

    const { subject, body, recipientUserIds } = JSON.parse(event.body || '{}');
    if (!subject || !body) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Subject and message body are required' }) };
    }

    const hasSelection = Array.isArray(recipientUserIds) && recipientUserIds.length > 0;

    let count;
    if (hasSelection) {
      count = recipientUserIds.length;
    } else {
      const { count: allCount } = await supabase.from('profiles').select('id', { count: 'exact', head: true });
      count = allCount || 0;
    }

    const { data: broadcast, error: insertErr } = await supabase
      .from('admin_broadcasts')
      .insert({
        admin_id: admin.id,
        subject,
        body_html: body,
        recipient_count: count,
        status: 'pending',
        recipient_user_ids: hasSelection ? recipientUserIds : null,
      })
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
