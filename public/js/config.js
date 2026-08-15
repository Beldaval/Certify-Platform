// ============================================================================
// PUBLIC, CLIENT-SAFE CONFIG ONLY.
// The Supabase URL and "anon" key below are DESIGNED to be public — every
// Supabase project ships them to the browser, and Row Level Security (see
// supabase/schema.sql) is what actually protects the data, not secrecy of
// this key. Do NOT put the service role key, Paystack secret key, or Gmail
// app password here or anywhere under /public — those live only in Netlify's
// server-side environment variables and are read by netlify/functions/*.
// ============================================================================
window.APP_CONFIG = {
  SUPABASE_URL: 'https://ykabvpsmticdbvoxabio.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_K6XdXu-EcnVkbk0IEpq5cg_znKRa-38',
  PAYSTACK_PUBLIC_KEY: 'sk_test_09bb9fd5819f405ff46c16d34884f68abd5ce25e 
};
