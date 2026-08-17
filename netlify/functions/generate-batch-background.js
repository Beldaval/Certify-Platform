// Kept for a future paid Netlify plan where true Background Functions
// (the "-background" suffix, up to 15 minutes) make sense for very large
// batches. As of this build, create-batch.js does NOT call this — it calls
// processBatch() directly in-process instead, since Background Functions
// require a paid plan and silently never run on the free tier. See the
// comment at the top of lib/batchProcessor.js for the full explanation.
const { processBatch } = require('./lib/batchProcessor');

exports.handler = async (event) => {
  const { batchId } = JSON.parse(event.body || '{}');
  if (!batchId) return { statusCode: 400, body: 'Missing batchId' };

  try {
    await processBatch(batchId);
    return { statusCode: 200, body: 'Batch processed' };
  } catch (err) {
    return { statusCode: 500, body: err.message };
  }
};
