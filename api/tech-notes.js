const { createClient } = require('@supabase/supabase-js');

// Use service role key for server-side operations (bypasses RLS)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method === 'GET') {
    try {
      // First try ordering by timestamp (expected schema)
      let q = await supabase
        .from('tech_notes')
        .select('*')
        .order('timestamp', { ascending: false });

      if (q.error) {
        // If column missing, fallback to ordering by id
        if (String(q.error.code) === '42703' || /column\s+"?timestamp"?/i.test(String(q.error.message || ''))) {
          const fb = await supabase
            .from('tech_notes')
            .select('*')
            .order('id', { ascending: false });
          if (fb.error) {
            // If table missing, return empty list so UI can show empty state
            if (String(fb.error.code) === '42P01' || /tech_notes/i.test(String(fb.error.message || ''))) {
              return res.status(200).json({ data: [] });
            }
            throw fb.error;
          }
          return res.status(200).json({ data: fb.data });
        }
        // If table missing, return empty list so UI can show empty state
        if (String(q.error.code) === '42P01' || /tech_notes/i.test(String(q.error.message || ''))) {
          return res.status(200).json({ data: [] });
        }
        throw q.error;
      }

      res.status(200).json({ data: q.data });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  } else if (req.method === 'POST') {
    try {
      const { text, password } = req.body || {};

      if (!text) {
        return res.status(400).json({ error: 'Text is required' });
      }

      // Verify password (owner-managed notes)
      if (password !== process.env.WALL_PASSWORD) {
        return res.status(401).json({ error: 'Invalid password' });
      }

      // Insert minimal fields; rely on DB defaults for timestamp when present
      const ins = await supabase
        .from('tech_notes')
        .insert([{ text }])
        .select();

      if (ins.error) {
        // Table missing => hint to run migration
        if (String(ins.error.code) === '42P01' || /tech_notes/i.test(String(ins.error.message || ''))) {
          return res.status(400).json({ error: 'Tech notes require DB migration. Please run supabase db push.' });
        }
        throw ins.error;
      }

      res.status(200).json({ data: ins.data[0] });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  } else {
    res.status(405).json({ error: 'Method not allowed' });
  }
}
