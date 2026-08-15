// Loaded after https://unpkg.com/@supabase/supabase-js@2 and after config.js.
const supabaseClient = window.supabase.createClient(
  window.APP_CONFIG.SUPABASE_URL,
  window.APP_CONFIG.SUPABASE_ANON_KEY
);

async function getAuthHeader() {
  const { data } = await supabaseClient.auth.getSession();
  const token = data?.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function requireSession(redirectTo = '/login.html') {
  const { data } = await supabaseClient.auth.getSession();
  if (!data?.session) {
    window.location.href = redirectTo;
    return null;
  }
  return data.session;
}
