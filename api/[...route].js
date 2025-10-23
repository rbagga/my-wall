const { createClient } = require('@supabase/supabase-js');

// Shared Supabase client (service role for server-side ops)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Optional OpenAI moderation for friend notes
let openai = null;
if (process.env.OPENAI_API_KEY) {
  try {
    const OpenAI = require('openai');
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  } catch (_) {
    // Module missing or other issue – proceed without moderation
    openai = null;
  }
}

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization, *');
}

function parsePath(req) {
  const url = new URL(req.url, 'http://local');
  const query = Object.fromEntries(url.searchParams.entries());
  const raw = url.pathname.replace(/^\/?api\/?/, '');
  const parts = String(raw || '').split('/').filter(Boolean);
  return { parts, query };
}

function escapeHtml(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncate(s = '', n = 200) {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function isBot(req) {
  const ua = String(req.headers['user-agent'] || '').toLowerCase();
  return (
    ua.includes('bot') ||
    ua.includes('facebookexternalhit') ||
    ua.includes('twitterbot') ||
    ua.includes('slackbot') ||
    ua.includes('whatsapp') ||
    ua.includes('discordbot') ||
    ua.includes('linkedinbot')
  );
}

function randomCode(len = 6) {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

async function entriesHandler(req, res, parts) {
  if (req.method === 'GET') {
    try {
      // Prefer single filtered query (public or null visibility)
      const q = await supabase
        .from('wall_entries')
        .select('*')
        .or('visibility.is.null,visibility.eq.public')
        .order('is_pinned', { ascending: false })
        .order('pin_order', { ascending: true, nullsFirst: false })
        .order('timestamp', { ascending: false });
      if (!q.error) {
        return res.status(200).json({ data: q.data });
      }
      // Fallback path for environments without .or or column present
      const pub = await supabase
        .from('wall_entries')
        .select('*')
        .eq('visibility', 'public');
      const nul = await supabase
        .from('wall_entries')
        .select('*')
        .is('visibility', null);
      if (pub.error && nul.error) {
        // Final fallback (older schema with no visibility): return all
        const all = await supabase
          .from('wall_entries')
          .select('*');
        if (all.error) throw all.error;
        const sorted = (all.data || []).slice().sort((a, b) => {
          const ap = a.is_pinned ? 1 : 0;
          const bp = b.is_pinned ? 1 : 0;
          if (ap !== bp) return bp - ap;
          if (ap === 1 && bp === 1) {
            const ao = (a.pin_order ?? Number.MAX_SAFE_INTEGER);
            const bo = (b.pin_order ?? Number.MAX_SAFE_INTEGER);
            if (ao !== bo) return ao - bo;
          }
          const at = a.timestamp || '';
          const bt = b.timestamp || '';
          return (bt > at) ? 1 : (bt < at ? -1 : 0);
        });
        return res.status(200).json({ data: sorted });
      }
      // Merge pub + null and sort client-side to emulate server ordering
      const merged = [...(pub.data || []), ...(nul.data || [])];
      const seen = new Set();
      const unique = merged.filter(r => {
        const id = r && r.id;
        if (id == null || seen.has(id)) return false;
        seen.add(id); return true;
      });
      const sorted = unique.sort((a, b) => {
        const ap = a.is_pinned ? 1 : 0;
        const bp = b.is_pinned ? 1 : 0;
        if (ap !== bp) return bp - ap;
        if (ap === 1 && bp === 1) {
          const ao = (a.pin_order ?? Number.MAX_SAFE_INTEGER);
          const bo = (b.pin_order ?? Number.MAX_SAFE_INTEGER);
          if (ao !== bo) return ao - bo;
        }
        const at = a.timestamp || '';
        const bt = b.timestamp || '';
        return (bt > at) ? 1 : (bt < at ? -1 : 0);
      });
      return res.status(200).json({ data: sorted });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }
  if (req.method === 'POST') {
    try {
      const { text, password, visibility, title } = req.body || {};
      if (password !== process.env.WALL_PASSWORD) {
        return res.status(401).json({ error: 'Invalid password' });
      }
      const vis = visibility === 'draft' ? 'draft' : 'public';
      const cleanTitle = (typeof title === 'string' && title.trim().length > 0 && title.trim() !== '(optional)') ? title.trim() : null;
      const row = { text, timestamp: new Date().toISOString(), visibility: vis, title: cleanTitle };
      let ins = await supabase.from('wall_entries').insert([row]).select();
      if (ins.error) {
        if (vis !== 'public') {
          // Drafts depend on new schema; surface explicit guidance
          throw new Error('Drafts require DB migration. Please run supabase db push.');
        }
        // Fallback: insert minimal columns compatible with older schema
        const fb = await supabase
          .from('wall_entries')
          .insert([{ text, timestamp: new Date().toISOString() }])
          .select();
        if (fb.error) throw ins.error || fb.error;
        ins = fb;
      }
      return res.status(200).json({ data: ins.data[0] });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }
  return res.status(405).json({ error: 'Method not allowed' });
}

async function updateEntryHandler(req, res) {
  if (req.method !== 'POST' && req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { id, text, visibility, password, title } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Missing id' });
    if (password !== process.env.WALL_PASSWORD) return res.status(401).json({ error: 'Invalid password' });

    const update = {};
    if (typeof text === 'string') update.text = text;
    if (visibility === 'public' || visibility === 'draft') update.visibility = visibility;
    if (typeof title === 'string') {
      const cleanTitle = title.trim();
      update.title = cleanTitle && cleanTitle !== '(optional)' ? cleanTitle : null;
    }

    let { data, error } = await supabase.from('wall_entries').update(update).eq('id', id).select();
    if (error) {
      // Fallback: update only text for older schemas
      const fb = await supabase.from('wall_entries').update({ text: update.text }).eq('id', id).select();
      if (fb.error) throw error;
      data = fb.data;
    }
    return res.status(200).json({ data: (data && data[0]) || null });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

async function deleteEntryHandler(req, res) {
  if (req.method !== 'POST' && req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const body = req.body || {};
    const id = body.id || (req.query && req.query.id);
    const password = body.password || (req.query && req.query.password);
    if (!id) return res.status(400).json({ error: 'Missing id' });
    if (password !== process.env.WALL_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
    const { error } = await supabase.from('wall_entries').delete().eq('id', id);
    if (error) throw error;
    return res.status(200).json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

async function pinEntryHandler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { id, pin, password } = req.body || {};
    if (!id || typeof pin === 'undefined') return res.status(400).json({ error: 'id and pin are required' });
    if (password !== process.env.WALL_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
    if (pin) {
      const { data: maxRow, error: maxErr } = await supabase
        .from('wall_entries')
        .select('pin_order')
        .eq('is_pinned', true)
        .order('pin_order', { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();
      if (maxErr) throw maxErr;
      const nextOrder = (maxRow && typeof maxRow.pin_order === 'number') ? (maxRow.pin_order + 1) : 0;
      const { error: upErr } = await supabase.from('wall_entries').update({ is_pinned: true, pin_order: nextOrder }).eq('id', id);
      if (upErr) throw upErr;
    } else {
      const { error: upErr } = await supabase.from('wall_entries').update({ is_pinned: false, pin_order: null }).eq('id', id);
      if (upErr) throw upErr;
    }
    return res.status(200).json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

async function reorderPinsHandler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { orderedIds, password } = req.body || {};
    if (!Array.isArray(orderedIds)) return res.status(400).json({ error: 'orderedIds must be an array' });
    if (password !== process.env.WALL_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
    for (let i = 0; i < orderedIds.length; i++) {
      const id = orderedIds[i];
      const { error } = await supabase.from('wall_entries').update({ is_pinned: true, pin_order: i }).eq('id', id);
      if (error) throw error;
    }
    return res.status(200).json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

async function friendEntriesHandler(req, res) {
  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase.from('friend_entries').select('*').order('timestamp', { ascending: false });
      if (error) throw error;
      return res.status(200).json({ data });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }
  if (req.method === 'POST') {
    try {
      const { text, name, title } = req.body || {};
      if (!name || !text) return res.status(400).json({ error: 'Name and text are required' });
      if (openai) {
        try {
          const moderation = await openai.moderations.create({ model: 'omni-moderation-latest', input: [name, text] });
          const strict = { sexual: 0.03, harassment: 0.15, hate: 0.01, violence: 0.05, 'self-harm': 0.01 };
          const labels = ['name','text'];
          let anyFlagged = false;
          const analysis = (moderation.results || []).map((result, idx) => {
            const s = result.category_scores || {};
            const tripped = Object.entries(strict).filter(([k, th]) => (s[k] || 0) > th).map(([k]) => k);
            if (result.flagged || tripped.length) anyFlagged = true;
            return { input: labels[idx] || String(idx), flagged: !!result.flagged, tripped, scores: s };
          });
          if (anyFlagged) {
            return res.status(400).json({ error: 'Your message contains inappropriate content and cannot be posted.', analysis, thresholds: strict });
          }
        } catch (_) {
          // ignore moderation failures
        }
      }
      const cleanTitle = (typeof title === 'string' && title.trim().length > 0 && title.trim() !== '(optional)') ? title.trim() : null;
      const ins = await supabase
        .from('friend_entries')
        .insert([{ name, text, title: cleanTitle, timestamp: new Date().toISOString() }])
        .select();
      if (!ins.error) {
        return res.status(200).json({ data: ins.data[0] });
      }
      // Fallback without title for older schema
      const fb = await supabase
        .from('friend_entries')
        .insert([{ name, text, timestamp: new Date().toISOString() }])
        .select();
      if (fb.error) return res.status(500).json({ error: fb.error.message });
      return res.status(200).json({ data: fb.data[0] });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }
  return res.status(405).json({ error: 'Method not allowed' });
}

async function deleteFriendEntryHandler(req, res) {
  if (req.method !== 'POST' && req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const body = req.body || {};
    const id = body.id || (req.query && req.query.id);
    const password = body.password || (req.query && req.query.password);
    if (!id) return res.status(400).json({ error: 'Missing id' });
    if (password !== process.env.WALL_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
    const { error } = await supabase.from('friend_entries').delete().eq('id', id);
    if (error) throw error;
    return res.status(200).json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

async function verifyPasswordHandler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: 'Password is required' });
    if (password === process.env.WALL_PASSWORD) return res.status(200).json({ ok: true });
    return res.status(401).json({ error: 'Invalid password' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

async function draftsHandler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { password } = req.body || {};
    if (password !== process.env.WALL_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
    const { data, error } = await supabase
      .from('wall_entries')
      .select('*')
      .eq('visibility', 'draft')
      .order('timestamp', { ascending: false });
    if (error) throw error;
    return res.status(200).json({ data });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

async function techNotesHandler(req, res) {
  if (req.method === 'GET') {
    try {
      let q = await supabase.from('tech_notes').select('*').order('timestamp', { ascending: false });
      if (q.error) {
        if (String(q.error.code) === '42703' || /column\s+"?timestamp"?/i.test(String(q.error.message || ''))) {
          const fb = await supabase.from('tech_notes').select('*').order('id', { ascending: false });
          if (fb.error) {
            if (String(fb.error.code) === '42P01' || /tech_notes/i.test(String(fb.error.message || ''))) {
              return res.status(200).json({ data: [] });
            }
            throw fb.error;
          }
          return res.status(200).json({ data: fb.data });
        }
        if (String(q.error.code) === '42P01' || /tech_notes/i.test(String(q.error.message || ''))) {
          return res.status(200).json({ data: [] });
        }
        throw q.error;
      }
      return res.status(200).json({ data: q.data });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }
  if (req.method === 'POST') {
    try {
      const { text, password, title } = req.body || {};
      if (!text) return res.status(400).json({ error: 'Text is required' });
      if (password !== process.env.WALL_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
      const cleanTitle = (typeof title === 'string' && title.trim().length > 0 && title.trim() !== '(optional)') ? title.trim() : null;
      let ins = await supabase.from('tech_notes').insert([{ text, title: cleanTitle }]).select();
      if (ins.error) {
        if (String(ins.error.code) === '42P01' || /tech_notes/i.test(String(ins.error.message || ''))) {
          return res.status(400).json({ error: 'Tech notes require DB migration. Please run supabase db push.' });
        }
        const fb = await supabase.from('tech_notes').insert([{ text }]).select();
        if (fb.error) throw ins.error || fb.error;
        ins = fb;
      }
      return res.status(200).json({ data: ins.data[0] });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }
  return res.status(405).json({ error: 'Method not allowed' });
}

async function deleteTechNoteHandler(req, res) {
  if (req.method !== 'POST' && req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const body = req.body || {};
    const id = body.id || (req.query && req.query.id);
    const password = body.password || (req.query && req.query.password);
    if (!id) return res.status(400).json({ error: 'Missing id' });
    if (password !== process.env.WALL_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
    const { error } = await supabase.from('tech_notes').delete().eq('id', id);
    if (error) throw error;
    return res.status(200).json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

async function updateTechNoteHandler(req, res) {
  if (req.method !== 'POST' && req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { id, text, password, title } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Missing id' });
    if (password !== process.env.WALL_PASSWORD) return res.status(401).json({ error: 'Invalid password' });

    const update = {};
    if (typeof text === 'string') update.text = text;
    if (typeof title === 'string') {
      const cleanTitle = title.trim();
      update.title = cleanTitle && cleanTitle !== '(optional)' ? cleanTitle : null;
    }

    let { data, error } = await supabase.from('tech_notes').update(update).eq('id', id).select();
    if (error) throw error;
    return res.status(200).json({ data: (data && data[0]) || null });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

async function shortenHandler(req, res) {
  const configuredBase = process.env.PUBLIC_BASE_URL && String(process.env.PUBLIC_BASE_URL).trim();
  const host = String(req.headers.host || '');
  const origin = configuredBase || ((req.headers['x-forwarded-proto'] && req.headers['x-forwarded-proto'] + '://' + host) || '');
  const providerEnv = (process.env.SHORT_URL_PROVIDER || '').trim().toLowerCase();
  const isLocalHost = /^(localhost:\\d+|127\\.0\\.0\\.1(?::\\d+)?)/.test(host);
  const enforceExternal = !!providerEnv && !isLocalHost;

  async function maybeShortenExternal(longUrl) {
    try {
      const provider = (process.env.SHORT_URL_PROVIDER || '').toLowerCase();
      if (provider === 'bitly') {
        const token = (process.env.BITLY_TOKEN || process.env.BITLY_API_TOKEN || '').trim();
        if (!token) throw new Error('Missing BITLY_TOKEN');
        const resp = await fetch('https://api-ssl.bitly.com/v4/shorten', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ long_url: longUrl })
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error((data && data.message) || 'Bitly error');
        if (data && data.link) return String(data.link);
      } else if (provider === 'shortio' || provider === 'short.io') {
        const apiKey = (process.env.SHORTIO_API_KEY || process.env.SHORT_IO_API_KEY || '').trim();
        const domain = (process.env.SHORTIO_DOMAIN || process.env.SHORT_IO_DOMAIN || '').trim();
        if (!apiKey || !domain) throw new Error('Missing SHORTIO_API_KEY or SHORTIO_DOMAIN');
        const resp = await fetch('https://api.short.io/links', {
          method: 'POST',
          headers: { 'Authorization': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ originalURL: longUrl, domain })
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error((data && (data.message || data.description)) || 'Short.io error');
        if (data && (data.shortURL || data.secureShortURL)) return String(data.shortURL || data.secureShortURL);
      }
    } catch (_) {
      // ignore and fallback to internal
    }
    return null;
  }

  if (req.method === 'POST') {
    try {
      const { entryId, password, type } = req.body || {};
      if (!entryId) return res.status(400).json({ error: 'Missing entryId' });
      let authorized = false;
      if (password && password === process.env.WALL_PASSWORD) {
        authorized = true;
      } else {
        try {
          if (String(type).toLowerCase() === 'friend') {
            const fr = await supabase.from('friend_entries').select('id').eq('id', entryId).maybeSingle();
            if (fr && fr.data && !fr.error) authorized = true; else if (fr && fr.error) throw fr.error;
          } else {
            const visQ = await supabase.from('wall_entries').select('visibility').eq('id', entryId).maybeSingle();
            if (visQ && !visQ.error) {
              const visibility = visQ.data && visQ.data.visibility;
              if (!visibility || visibility === 'public') authorized = true; else return res.status(403).json({ error: 'Entry is not publicly shareable' });
            } else {
              authorized = true;
            }
          }
        } catch (_) {
          authorized = true;
        }
      }
      if (!authorized) return res.status(401).json({ error: 'Unauthorized' });

      const isFriend = String(type).toLowerCase() === 'friend';
      const existing = isFriend
        ? await supabase.from('short_links').select('*').eq('friend_entry_id', entryId).maybeSingle()
        : await supabase.from('short_links').select('*').eq('entry_id', entryId).maybeSingle();
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
        if (enforceExternal && !ext) return res.status(500).json({ error: 'External shortener failed' });
        const shortUrl = ext || (absolute || pathOnly);
        return res.status(200).json({ code, shortUrl, external: !!ext });
      }

      let code = randomCode(6);
      for (let i = 0; i < 5; i++) {
        const payload = isFriend ? { code, friend_entry_id: entryId } : { code, entry_id: entryId };
        const ins = await supabase.from('short_links').insert([payload]).select();
        if (!ins.error) {
          const pathOnly = `/s/${encodeURIComponent(code)}`;
          const absolute = origin ? `${origin}${pathOnly}` : null;
          const ext = absolute ? await maybeShortenExternal(absolute) : null;
          if (enforceExternal && !ext) return res.status(500).json({ error: 'External shortener failed' });
          const shortUrl = ext || (absolute || pathOnly);
          return res.status(200).json({ code, shortUrl, external: !!ext });
        }
        if (ins.error && /duplicate key/i.test(String(ins.error.message))) {
          code = randomCode(6 + i);
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
  return res.status(405).json({ error: 'Method not allowed' });
}

async function sResolveHandler(req, res) {
  const code = (req.query && (req.query.c || req.query.code)) || null;
  if (!code) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'text/plain');
    return res.end('Missing code');
  }
  try {
    const found = await supabase.from('short_links').select('entry_id, friend_entry_id').eq('code', code).maybeSingle();
    if (found.error) throw found.error;
    if (!found.data) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain');
      return res.end('Not found');
    }
    const entryId = found.data.entry_id;
    const friendId = found.data.friend_entry_id;
    let entry = null;
    let e2 = null;
    let isFriend = false;
    if (friendId) {
      isFriend = true;
      const q = await supabase.from('friend_entries').select('id, text, timestamp, name').eq('id', friendId).maybeSingle();
      entry = q.data; e2 = q.error || null;
    } else {
      const q = await supabase
        .from('wall_entries')
        .select('id, text, timestamp, visibility')
        .eq('id', entryId)
        .maybeSingle();
      entry = q.data; e2 = q.error || null;
    }
    if (e2) throw e2;
    if (!entry) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain');
      return res.end('Not found');
    }
    if (!isFriend && entry.visibility && entry.visibility !== 'public') {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'text/plain');
      return res.end('This note is not publicly shareable.');
    }

    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers.host;
    const viewHash = isFriend ? `#friends&entry=${encodeURIComponent(friendId)}` : `#entry=${encodeURIComponent(entryId)}`;
    const viewUrl = `${proto}://${host}/${viewHash}`;

    if (!isBot(req)) {
      res.statusCode = 302;
      res.setHeader('Location', viewUrl);
      return res.end();
    }

    const title = isFriend ? (entry.name ? `${escapeHtml(entry.name)}’s Note` : 'Friend Note') : 'Note on My Wall';
    const desc = truncate(String(entry.text || '').replace(/\s+/g, ' ').trim(), 200);
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <meta property="og:title" content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(desc)}" />
  <meta property="og:type" content="article" />
  <meta property="og:url" content="${escapeHtml(viewUrl)}" />
  <meta name="twitter:card" content="summary" />
  <meta name="twitter:title" content="${escapeHtml(title)}" />
  <meta name="twitter:description" content="${escapeHtml(desc)}" />
  <link rel="canonical" href="${escapeHtml(viewUrl)}" />
  <meta http-equiv="refresh" content="0;url=${escapeHtml(viewHash)}" />
  <style>
    :root { --bg: #1a1a1a; --fg: #e0e0e0; --panel: #2a2a2a; --border: #3a3a3a; --muted: #aaa; --btn-bg: #333; --btn-bg-hover: #555; --btn-fg: #fff; }
    * { box-sizing: border-box; }
    body { margin:0; background: var(--bg); color: var(--fg); font-family: "SUSE Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .wrap { padding: 24px; min-height: 100vh; display: grid; place-items: center; }
    .card { width: min(680px, 92%); background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
    h1 { margin: 0 0 8px 0; font-size: 18px; font-weight: 600; }
    .desc { white-space: pre-wrap; color: var(--fg); opacity: 0.9; }
    .actions { margin-top: 14px; display: flex; justify-content: flex-end; }
    a.btn { display:inline-block; padding:10px 14px; background: var(--btn-bg); color: var(--btn-fg); border-radius:6px; text-decoration:none; }
    a.btn:hover { background: var(--btn-bg-hover); }
  </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <h1>${escapeHtml(title)}</h1>
        <div class="desc">${escapeHtml(desc)}</div>
        <div class="actions"><a class="btn" href="/${escapeHtml(viewHash)}">Open</a></div>
      </div>
    </div>
    <script>location.replace(${JSON.stringify(viewHash)});</script>
  </body>
  </html>`;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(html);
  } catch (error) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain');
    return res.end('Error');
  }
}

module.exports = async function handler(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Parse JSON body when present
  if (req.headers['content-type'] && req.headers['content-type'].includes('application/json') && typeof req.body === 'string') {
    try { req.body = JSON.parse(req.body || '{}'); } catch (_) { req.body = {}; }
  }

  const { parts, query } = parsePath(req);
  req.query = Object.assign({}, req.query || {}, query);

  const head = (parts[0] || '').toLowerCase();

  // Route compatibility: support existing endpoints
  try {
    if (head === 'entries') return entriesHandler(req, res, parts);
    if (head === 'update-entry') return updateEntryHandler(req, res);
    if (head === 'delete-entry') return deleteEntryHandler(req, res);
    if (head === 'pin-entry') return pinEntryHandler(req, res);
    if (head === 'reorder-pins') return reorderPinsHandler(req, res);
    if (head === 'friend-entries') return friendEntriesHandler(req, res);
    if (head === 'delete-friend-entry') return deleteFriendEntryHandler(req, res);
    if (head === 'verify-password') return verifyPasswordHandler(req, res);
    if (head === 'drafts') return draftsHandler(req, res);
    if (head === 'tech-notes') return techNotesHandler(req, res);
    if (head === 'delete-tech-note') return deleteTechNoteHandler(req, res);
    if (head === 'update-tech-note') return updateTechNoteHandler(req, res);
    if (head === 'shorten') return shortenHandler(req, res);
    if (head === 's') return sResolveHandler(req, res);

    return res.status(404).json({ error: 'Not found' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
