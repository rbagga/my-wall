const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function randomCode(len = 6) {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', '*, Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const configuredBase = process.env.PUBLIC_BASE_URL && String(process.env.PUBLIC_BASE_URL).trim();
  const host = String(req.headers.host || '');
  const origin = configuredBase || ((req.headers['x-forwarded-proto'] && req.headers['x-forwarded-proto'] + '://' + host) || '');
  const providerEnv = (process.env.SHORT_URL_PROVIDER || '').trim().toLowerCase();
  const isLocalHost = /^(localhost:\d+|127\.0\.0\.1(?::\d+)?)/.test(host);
  const enforceExternal = !!providerEnv && !isLocalHost; // don't force external shortener during local dev

  async function maybeShortenExternal(longUrl) {
    try {
      const provider = (process.env.SHORT_URL_PROVIDER || '').toLowerCase();
      if (provider === 'bitly') {
        const token = (process.env.BITLY_TOKEN || process.env.BITLY_API_TOKEN || '').trim();
        if (!token) throw new Error('Missing BITLY_TOKEN');
        const resp = await fetch('https://api-ssl.bitly.com/v4/shorten', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ long_url: longUrl })
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data && data.message || 'Bitly error');
        if (data && data.link) return String(data.link);
      } else if (provider === 'shortio' || provider === 'short.io') {
        const apiKey = (process.env.SHORTIO_API_KEY || process.env.SHORT_IO_API_KEY || '').trim();
        const domain = (process.env.SHORTIO_DOMAIN || process.env.SHORT_IO_DOMAIN || '').trim();
        if (!apiKey || !domain) throw new Error('Missing SHORTIO_API_KEY or SHORTIO_DOMAIN');
        const resp = await fetch('https://api.short.io/links', {
          method: 'POST',
          headers: {
            'Authorization': apiKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ originalURL: longUrl, domain })
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data && (data.message || data.description) || 'Short.io error');
        if (data && (data.shortURL || data.secureShortURL)) return String(data.shortURL || data.secureShortURL);
      }
    } catch (e) {
      // fall through to internal short link if external provider fails
    }
    return null;
  }

  if (req.method === 'POST') {
    try {
      const { entryId, password } = req.body || {};
      if (!entryId) return res.status(400).json({ error: 'Missing entryId' });
      if (password !== process.env.WALL_PASSWORD) return res.status(401).json({ error: 'Invalid password' });

      // Check if already exists
      const existing = await supabase.from('short_links').select('*').eq('entry_id', entryId).maybeSingle();
      if (existing.error) {
        const msg = String(existing.error.message || '');
        if (/relation .*short_links.* does not exist/i.test(msg)) {
          throw new Error('Short links require DB migration. Please run supabase db push.');
        }
        throw existing.error;
      }
      if (existing.data) {
        const code = existing.data.code;
        const pathOnly = `/s/${encodeURIComponent(code)}`;
        const absolute = origin ? `${origin}${pathOnly}` : null;
        const ext = absolute ? await maybeShortenExternal(absolute) : null;
        if (enforceExternal && !ext) {
          return res.status(500).json({ error: 'External shortener failed' });
        }
        const shortUrl = ext || (absolute || pathOnly);
        return res.status(200).json({ code, shortUrl, external: !!ext });
      }

      // Create new code with retries
      let code = randomCode(6);
      for (let i = 0; i < 5; i++) {
        const ins = await supabase.from('short_links').insert([{ code, entry_id: entryId }]).select();
        if (!ins.error) {
          const pathOnly = `/s/${encodeURIComponent(code)}`;
          const absolute = origin ? `${origin}${pathOnly}` : null;
          const ext = absolute ? await maybeShortenExternal(absolute) : null;
          if (enforceExternal && !ext) {
            return res.status(500).json({ error: 'External shortener failed' });
          }
          const shortUrl = ext || (absolute || pathOnly);
          return res.status(200).json({ code, shortUrl, external: !!ext });
        }
        if (ins.error && /duplicate key/i.test(String(ins.error.message))) {
          code = randomCode(6 + i); // try longer on collision
          continue;
        }
        if (ins.error && /relation .*short_links.* does not exist/i.test(String(ins.error.message))) {
          throw new Error('Short links require DB migration. Please run supabase db push.');
        }
        throw ins.error;
      }
      throw new Error('Failed to generate short code');
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  if (req.method === 'GET') {
    // Resolve to target (debug JSON)
    try {
      const code = (req.query && (req.query.c || req.query.code)) || null;
      if (!code) return res.status(400).json({ error: 'Missing code' });
      const { data, error } = await supabase.from('short_links').select('entry_id').eq('code', code).maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Not found' });
      return res.status(200).json({ entryId: data.entry_id });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
}
