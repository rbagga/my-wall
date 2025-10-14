const { createClient } = require('@supabase/supabase-js');

// Use service role key for server-side operations (bypasses RLS)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async function handler(req, res) {
  // CORS
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
    const { id, pin, password } = req.body || {};
    if (!id || typeof pin === 'undefined') {
      return res.status(400).json({ error: 'id and pin are required' });
    }

    if (password !== process.env.WALL_PASSWORD) {
      return res.status(401).json({ error: 'Invalid password' });
    }

    if (pin) {
      // Determine next order index for pinned items
      const { data: maxRow, error: maxErr } = await supabase
        .from('wall_entries')
        .select('pin_order')
        .eq('is_pinned', true)
        .order('pin_order', { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();
      if (maxErr) throw maxErr;
      const nextOrder = (maxRow && typeof maxRow.pin_order === 'number') ? (maxRow.pin_order + 1) : 0;

      const { error: upErr } = await supabase
        .from('wall_entries')
        .update({ is_pinned: true, pin_order: nextOrder })
        .eq('id', id);
      if (upErr) throw upErr;
    } else {
      const { error: upErr } = await supabase
        .from('wall_entries')
        .update({ is_pinned: false, pin_order: null })
        .eq('id', id);
      if (upErr) throw upErr;
    }

    res.status(200).json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
