// netlify/functions/process-batch-background.js
//
// The "-background" suffix is what tells Netlify to run this async: it
// returns 202 to the caller almost instantly and keeps executing
// server-side for up to 15 minutes (requires the paid plan you're now on).
//
// create-batch.js POSTs here right after creating the batch + certificate
// rows and deducting tokens. This file just runs the existing
// processBatch() — no logic changes to batchProcessor.js should be needed,
// only the fact that it's no longer awaited inline inside create-batch.

const { getSupabaseAdmin } = require('./lib/supabaseAdmin');
const { processBatch } = require('./lib/batchProcessor');

exports.handler = async (event) => {
  const { batchId } = JSON.parse(event.body || '{}');
  if (!batchId) return { statusCode: 400, body: 'batchId required' };

  const supabase = getSupabaseAdmin();

  try {
    await processBatch(batchId);
    // NOTE: confirm lib/batchProcessor.js does two things as it runs, since
    // batch-status.js depends on both:
    //   1. updates each certificate's generation_status/delivery_status as
    //      THAT certificate finishes (not all at once at the very end) —
    //      otherwise the progress bar will sit at 0% and then jump to 100%.
    //   2. flips the batch's own `status` to 'completed' (or something like
    //      'partially_failed') once every certificate is done.
    // If it doesn't already do #2, add it at the end of processBatch itself
    // rather than here, so it stays true regardless of how this function
    // is invoked.
  } catch (err) {
    await supabase.from('batches').update({ status: 'failed' }).eq('id', batchId);
  }

  return { statusCode: 200, body: 'done' };
};
