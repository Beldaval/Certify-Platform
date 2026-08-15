// FR-10 / SEC-5: public, no-login lookup. This function uses the service
// role key server-side, but it is hand-written to select ONLY the four
// public-safe columns — token, payment, delivery-email and account data are
// never touched here, so there is nothing sensitive to leak even if this
// function's query changes later.
const { getSupabaseAdmin } = require('./lib/supabaseAdmin');

exports.handler = async (event) => {
  try {
    const number = (event.queryStringParameters?.number || '').trim();
    if (!number) return { statusCode: 400, body: JSON.stringify({ error: 'Missing certificate number' }) };

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('certificates')
      .select('recipient_name, program_title, issuing_organization, issue_date, certificate_number')
      .eq('certificate_number', number)
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return { statusCode: 200, body: JSON.stringify({ found: false }) };
    }
    return { statusCode: 200, body: JSON.stringify({ found: true, certificate: data }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
