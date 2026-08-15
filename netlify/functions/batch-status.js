const { getSupabaseAdmin, getUserFromRequest } = require('./lib/supabaseAdmin');

exports.handler = async (event) => {
  try {
    const supabase = getSupabaseAdmin();
    const user = await getUserFromRequest(event, supabase);
    if (!user) return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated' }) };

    const batchId = event.queryStringParameters?.batchId;
    if (!batchId) return { statusCode: 400, body: JSON.stringify({ error: 'Missing batchId' }) };

    const { data: batch, error: batchErr } = await supabase
      .from('batches')
      .select('*')
      .eq('id', batchId)
      .eq('user_id', user.id)
      .single();
    if (batchErr || !batch) return { statusCode: 404, body: JSON.stringify({ error: 'Not found' }) };

    const { data: certs, error: certsErr } = await supabase
      .from('certificates')
      .select('id, certificate_number, recipient_name, program_title, generation_status, delivery_status, pdf_path')
      .eq('batch_id', batchId);
    if (certsErr) throw certsErr;

    return { statusCode: 200, body: JSON.stringify({ batch, certificates: certs }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
