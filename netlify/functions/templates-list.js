const { getSupabaseAdmin } = require('./lib/supabaseAdmin');

exports.handler = async () => {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('templates')
      .select('id, name, canvas_width, canvas_height, fields, active')
      .eq('active', true)
      .order('name');
    if (error) throw error;
    return { statusCode: 200, body: JSON.stringify({ templates: data }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
