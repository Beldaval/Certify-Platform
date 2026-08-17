// Background Function (the "-background" suffix tells Netlify to run this
// async, returning 202 to the caller almost instantly and continuing
// server-side for up to 15 minutes). Now ACTIVE as of the paid Netlify
// plan upgrade — create-batch.js fires this immediately after creating
// the batch + certificate rows and deducting tokens, without awaiting it.
const { getSupabaseAdmin } = require('./lib/supabaseAdmin');
const { processBatch } = require('./lib/batchProcessor');
exports.handler = async (event) => {
  const { batchId } = JSON.parse(event.body || '{}');
  if (!batchId) return { statusCode: 400, body: 'Missing batchId' };
  try {
    await processBatch(batchId);
    return { statusCode: 200, body: 'Batch processed' };
  } catch (err) {
    // This used to be caught in create-batch.js, which awaited processBatch
    // inline. Now that this runs in the background and create-batch.js
    // isn't watching, this function must set the failure status itself so
    // the batch doesn't sit stuck on 'generating' forever.
    try {
      const supabase = getSupabaseAdmin();
      await supabase.from('batches').update({ status: 'failed' }).eq('id', batchId);
    } catch (updateErr) {
      console.error('Failed to mark batch as failed:', updateErr);
    }
    return { statusCode: 500, body: err.message };
  }
};
