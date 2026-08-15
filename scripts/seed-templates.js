// Run once after the schema is applied: `node scripts/seed-templates.js`
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in your shell env
// (export them locally just for this one command — do not put a real
// service role key in any file in this repo).
const { createClient } = require('@supabase/supabase-js');
const templatesJson = require('../public/assets/templates.json');

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in your shell before running this script.');
    process.exit(1);
  }
  const supabase = createClient(url, key);

  const rows = templatesJson.templates.map((t) => ({
    id: t.id,
    name: t.name,
    svg_file: t.file,
    canvas_width: t.canvas.width,
    canvas_height: t.canvas.height,
    fields: t.fields,
    active: true,
  }));

  const { error } = await supabase.from('templates').upsert(rows, { onConflict: 'id' });
  if (error) {
    console.error('Seed failed:', error.message);
    process.exit(1);
  }
  console.log(`Seeded ${rows.length} templates.`);
}

main();
