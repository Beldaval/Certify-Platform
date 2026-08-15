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
  SUPABASE_URL: 'https://YOUR-PROJECT-REF.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR_SUPABASE_ANON_PUBLIC_KEY',
  PAYSTACK_PUBLIC_KEY: 'YOUR_PAYSTACK_PUBLIC_KEY', // pk_test_... or pk_live_...
};
