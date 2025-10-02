const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');

// Use service role key for server-side operations (bypasses RLS)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

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
      const { data, error } = await supabase
        .from('friend_entries')
        .select('*')
        .order('timestamp', { ascending: false });

      if (error) throw error;

      res.status(200).json({ data });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  } else if (req.method === 'POST') {
    try {
      const { text, name } = req.body;

      if (!name || !text) {
        return res.status(400).json({ error: 'Name and text are required' });
      }

      // Moderate content using OpenAI
      const moderation = await openai.moderations.create({
        input: `${name}: ${text}`
      });

      const result = moderation.results[0];

      if (result.flagged) {
        return res.status(400).json({
          error: 'Your message contains inappropriate content and cannot be posted.'
        });
      }

      const { data, error } = await supabase
        .from('friend_entries')
        .insert([
          {
            name: name,
            text: text,
            timestamp: new Date().toISOString()
          }
        ])
        .select();

      if (error) throw error;

      res.status(200).json({ data: data[0] });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  } else {
    res.status(405).json({ error: 'Method not allowed' });
  }
}
