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

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { id, text, visibility, password } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Missing id' });
    if (password !== process.env.WALL_PASSWORD) {
      return res.status(401).json({ error: 'Invalid password' });
    }

    // Build update payload
    const update = {};
    if (typeof text === 'string') update.text = text;
    if (visibility === 'public' || visibility === 'draft') update.visibility = visibility;

    // Try update with visibility (new schema)
    let { data, error } = await supabase
      .from('wall_entries')
      .update(update)
      .eq('id', id)
      .select();

    if (error) {
      // Fallback: if visibility not supported and we're not changing it, try without
      if (!('visibility' in update)) {
        const fb = await supabase
          .from('wall_entries')
          .update({ text: update.text })
          .eq('id', id)
          .select();
        if (fb.error) throw fb.error;
        data = fb.data;
      } else {
        throw error;
      }
    }

    res.status(200).json({ data: (data && data[0]) || null });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

