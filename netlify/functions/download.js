// FR-8: expiring signed URLs only (SEC-7) — never permanent public links.
// ?certificateId=... -> one signed URL
// ?batchId=...        -> a zip of every generated certificate in the batch
const archiver = require('archiver');
const { getSupabaseAdmin, getUserFromRequest } = require('./lib/supabaseAdmin');

const SIGNED_URL_TTL_SECONDS = 60 * 10; // 10 minutes — plenty for one click-through

exports.handler = async (event) => {
  try {
    const supabase = getSupabaseAdmin();
    const user = await getUserFromRequest(event, supabase);
    if (!user) return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated' }) };

    const { certificateId, batchId } = event.queryStringParameters || {};

    if (certificateId) {
      const { data: cert, error } = await supabase
        .from('certificates')
        .select('pdf_path, batch_id, batches!inner(user_id)')
        .eq('id', certificateId)
        .single();
      if (error || !cert || cert.batches.user_id !== user.id) {
        return { statusCode: 404, body: JSON.stringify({ error: 'Not found' }) };
      }
      const { data: signed, error: signErr } = await supabase.storage
        .from('certificates')
        .createSignedUrl(cert.pdf_path, SIGNED_URL_TTL_SECONDS);
      if (signErr) throw signErr;
      return { statusCode: 200, body: JSON.stringify({ url: signed.signedUrl }) };
    }

    if (batchId) {
      const { data: batch } = await supabase.from('batches').select('id').eq('id', batchId).eq('user_id', user.id).single();
      if (!batch) return { statusCode: 404, body: JSON.stringify({ error: 'Not found' }) };

      const { data: certs } = await supabase
        .from('certificates')
        .select('pdf_path, recipient_name')
        .eq('batch_id', batchId)
        .not('pdf_path', 'is', null);

      // Netlify Functions can return base64 binary bodies.
      const chunks = [];
      const archive = archiver('zip', { zlib: { level: 9 } });
      archive.on('data', (c) => chunks.push(c));
      const done = new Promise((resolve, reject) => {
        archive.on('end', resolve);
        archive.on('error', reject);
      });

      for (const c of certs) {
        const { data: fileData, error: dlErr } = await supabase.storage.from('certificates').download(c.pdf_path);
        if (dlErr) continue;
        const buf = Buffer.from(await fileData.arrayBuffer());
        archive.append(buf, { name: `${c.recipient_name}.pdf`.replace(/[^a-zA-Z0-9-_. ]/g, '') });
      }
      archive.finalize();
      await done;

      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="certificates-${batchId}.zip"`,
        },
        body: Buffer.concat(chunks).toString('base64'),
        isBase64Encoded: true,
      };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Provide certificateId or batchId' }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
