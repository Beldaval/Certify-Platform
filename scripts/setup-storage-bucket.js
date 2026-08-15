// Run once: `node scripts/setup-storage-bucket.js`
// Creates a PRIVATE "certificates" bucket. Files inside are only ever
// reached through short-lived signed URLs minted by netlify/functions/download.js
// (SEC-7) — the bucket itself is never public.
const { createClient } = require('@supabase/supabase-js');

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in your shell before running this script.');
    process.exit(1);
  }
  const supabase = createClient(url, key);

  const { error } = await supabase.storage.createBucket('certificates', {
    public: false,
    fileSizeLimit: '10MB',
  });

  if (error && !String(error.message).includes('already exists')) {
    console.error('Bucket creation failed:', error.message);
    process.exit(1);
  }
  console.log('Bucket "certificates" is ready (private).');
}

main();
