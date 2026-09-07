// Admin-only, read-only aggregate stats for the whole platform. Nothing here
// writes anything; everything is computed from data that already exists.
const { getSupabaseAdmin, getUserFromRequest } = require('./lib/supabaseAdmin');

exports.handler = async (event) => {
  try {
    const supabase = getSupabaseAdmin();
    const admin = await getUserFromRequest(event, supabase);
    if (!admin) return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated' }) };
    const { data: adminProfile } = await supabase.from('profiles').select('is_admin').eq('id', admin.id).single();
    if (!adminProfile?.is_admin) return { statusCode: 403, body: JSON.stringify({ error: 'Admin access required' }) };

    const { data: statsRows, error: statsErr } = await supabase.rpc('get_certificate_stats');
    if (statsErr) throw statsErr;
    const stats = statsRows?.[0] || { total_certificates: 0, successful: 0, failed: 0, pending: 0 };

    const { data: tokensBought, error: tokensErr } = await supabase.rpc('get_total_tokens_bought');
    if (tokensErr) throw tokensErr;

    const { data: popularity, error: popErr } = await supabase.rpc('get_template_popularity');
    if (popErr) throw popErr;

    // Failed-certificate drill-down: which user, and whether their token was
    // reversed. refund_token's own reason text always includes the literal
    // certificate id ("Generation failed for certificate <id>: ..."), so
    // matching against that text tells us precisely which failure was
    // refunded — more precise than matching on batch_id alone, since a
    // batch with multiple failures would otherwise be ambiguous.
    const { data: failedCerts, error: failedErr } = await supabase
      .from('certificates')
      .select('id, recipient_name, program_title, certificate_number, created_at, batch_id, batches!inner(user_id, profiles:user_id(email, full_name))')
      .eq('generation_status', 'failed')
      .order('created_at', { ascending: false })
      .limit(50);
    if (failedErr) throw failedErr;

    const { data: refundTxAll } = await supabase
      .from('token_transactions')
      .select('note')
      .eq('type', 'refund');
    const refundNotes = (refundTxAll || []).map((t) => t.note || '');

    const failedList = (failedCerts || []).map((c) => ({
      id: c.id,
      recipient_name: c.recipient_name,
      program_title: c.program_title,
      certificate_number: c.certificate_number,
      created_at: c.created_at,
      user_email: c.batches?.profiles?.email || null,
      user_name: c.batches?.profiles?.full_name || null,
      token_reversed: refundNotes.some((note) => note.includes(c.id)),
    }));

    return {
      statusCode: 200,
      body: JSON.stringify({
        stats,
        tokensBought: tokensBought || 0,
        templatePopularity: popularity || [],
        failedCertificates: failedList,
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
