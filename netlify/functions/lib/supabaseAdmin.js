// Server-side Supabase client using the SERVICE ROLE key.
// This file only ever runs inside a Netlify Function (server), never in the
// browser bundle — the service role key must NEVER be referenced from
// anything under /public. Netlify Functions read it from an environment
// variable set in the Netlify dashboard (Site settings → Environment
// variables), never from a committed file.
const { createClient } = require('@supabase/supabase-js');

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars');
  }
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Verifies the bearer token from an Authorization header against Supabase
// Auth and returns the user, so functions can trust who is calling them
// instead of taking a user id from the request body.
async function getUserFromRequest(event, supabaseAdmin) {
  const authHeader = event.headers.authorization || event.headers.Authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

module.exports = { getSupabaseAdmin, getUserFromRequest };
