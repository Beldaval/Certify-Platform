// Triggered by admin-broadcast.js, not called directly. Fires "Dear
// [registered name]," followed by the admin's message body, individually
// per user, paced to avoid hammering Resend's rate limits.
//
// If the broadcast row has recipient_user_ids set (the admin selected
// specific users), only those get emailed; otherwise every user does —
// same as the original "send to all" behavior.
const { getSupabaseAdmin } = require('./lib/supabaseAdmin');
const { sendCertificateEmail, sleep } = require('./lib/mailer');

const SEND_PACING_MS = 1000;

exports.handler = async (event) => {
  const { broadcastId } = JSON.parse(event.body || '{}');
  if (!broadcastId) return { statusCode: 400, body: 'Missing broadcastId' };

  const supabase = getSupabaseAdmin();
  const { data: broadcast, error: bErr } = await supabase.from('admin_broadcasts').select('*').eq('id', broadcastId).single();
  if (bErr || !broadcast) return { statusCode: 404, body: 'Broadcast not found' };

  await supabase.from('admin_broadcasts').update({ status: 'sending' }).eq('id', broadcastId);

  const hasSelection = Array.isArray(broadcast.recipient_user_ids) && broadcast.recipient_user_ids.length > 0;
  const usersQuery = supabase.from('profiles').select('email, full_name');
  const { data: users, error: usersErr } = hasSelection
    ? await usersQuery.in('id', broadcast.recipient_user_ids)
    : await usersQuery;
  if (usersErr) {
    await supabase.from('admin_broadcasts').update({ status: 'failed' }).eq('id', broadcastId);
    return { statusCode: 500, body: usersErr.message };
  }

  let sentCount = 0;
  for (const u of users || []) {
    if (!u.email) continue;
    try {
      await sendCertificateEmail({
        to: u.email,
        subject: broadcast.subject,
        html: `<p>Dear ${u.full_name || u.email},</p>${broadcast.body_html}`,
        attachments: [],
      });
      sentCount++;
    } catch (err) {
      console.error(`Broadcast email failed for ${u.email}:`, err.message);
    }
    await sleep(SEND_PACING_MS);
  }

  await supabase.from('admin_broadcasts').update({ status: 'completed', recipient_count: sentCount }).eq('id', broadcastId);

  return { statusCode: 200, body: `Sent to ${sentCount} users` };
};
