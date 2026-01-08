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

function slugify(name = '') {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    || 'wall';
}

async function getDefaultWallId() {
  try {
    const r = await supabase.from('walls').select('id').eq('slug', 'rishu').maybeSingle();
    if (r && r.data && r.data.id) return r.data.id;
  } catch (_) {}
  return null;
}

async function entriesHandler(req, res, parts) {
  if (req.method === 'GET') {
    try {
      // Optional wall scoping
      const url = new URL(req.url, 'http://local');
      const wallId = url.searchParams.get('wall_id');
      const wallSlug = url.searchParams.get('wall');
      const pwd = url.searchParams.get('password');

      let resolvedWallId = wallId;
      if (!resolvedWallId && wallSlug) {
        try {
          const r = await supabase.from('walls').select('id').eq('slug', wallSlug).maybeSingle();
          if (r.data && r.data.id) resolvedWallId = String(r.data.id);
        } catch (_) {}
      }

      // If a specific wall is requested and it is private, require password
      if (resolvedWallId) {
        try {
          const wr = await supabase.from('walls').select('is_public').eq('id', resolvedWallId).maybeSingle();
          if (wr && wr.data && wr.data.is_public === false) {
            if (pwd !== process.env.WALL_PASSWORD) {
              return res.status(401).json({ error: 'Unauthorized' });
            }
          }
        } catch (_) {}
      }

      // Build query dynamically to include wall filter when possible
      let q2 = supabase
        .from('wall_entries')
        .select('*')
        .or('visibility.is.null,visibility.eq.public')
        .order('is_pinned', { ascending: false })
        .order('pin_order', { ascending: true, nullsFirst: false })
        .order('timestamp', { ascending: false });
      if (resolvedWallId) {
        try { q2 = q2.eq('wall_id', resolvedWallId); } catch (_) {}
      }
      const qres = await q2;
      if (!qres.error) {
        return res.status(200).json({ data: qres.data });
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
      let merged = [...(pub.data || []), ...(nul.data || [])];
      if (resolvedWallId) {
        merged = merged.filter(r => String(r.wall_id || '') === String(resolvedWallId));
      }
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
      const { text, password, visibility, title, wall_id, wall } = req.body || {};
      if (password !== process.env.WALL_PASSWORD) {
        return res.status(401).json({ error: 'Invalid password' });
      }
      let targetWallId = wall_id || null;
      if (!targetWallId && wall) {
        try {
          const r = await supabase.from('walls').select('id').eq('slug', String(wall)).maybeSingle();
          if (r.data && r.data.id) targetWallId = r.data.id;
        } catch (_) {}
      }
      if (!targetWallId) {
        targetWallId = await getDefaultWallId();
      }
      const vis = visibility === 'draft' ? 'draft' : 'public';
      const cleanTitle = (typeof title === 'string' && title.trim().length > 0 && title.trim() !== '(optional)') ? title.trim() : null;
      const row = { text, timestamp: new Date().toISOString(), visibility: vis, title: cleanTitle, wall_id: targetWallId };
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

// Walls: list/create/delete walls for scoping wall_entries
async function wallsHandler(req, res) {
  if (req.method === 'GET') {
    try {
      const url = new URL(req.url, 'http://local');
      const pwd = url.searchParams.get('password');
      const selectCols = 'id, name, slug, created_at, is_public';
      let q = supabase.from('walls').select(selectCols).order('created_at', { ascending: false });
      if (pwd !== process.env.WALL_PASSWORD) {
        try { q = q.eq('is_public', true); } catch (_) {}
      }
      q = await q;
      if (q.error) {
        // Table missing: return default virtual wall
        if (String(q.error.code) === '42P01') return res.status(200).json({ data: [] });
        throw q.error;
      }
      return res.status(200).json({ data: q.data || [] });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }
  if (req.method === 'POST') {
    try {
      const { name, password, is_public } = req.body || {};
      if (password !== process.env.WALL_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
      if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required' });
      const base = slugify(String(name).trim());
      let s = base;
      // ensure unique slug by retrying with suffix up to a few times
      for (let i = 0; i < 10; i++) {
        const check = await supabase.from('walls').select('id').eq('slug', s).maybeSingle();
        if (!check.data) break;
        s = `${base}-${i+2}`; // base, base-2, base-3, ...
      }
      const payload = { name: String(name).trim(), slug: s };
      if (typeof is_public === 'boolean') payload.is_public = is_public;
      const ins = await supabase.from('walls').insert([payload]).select();
      if (ins.error) throw ins.error;
      return res.status(200).json({ data: ins.data && ins.data[0] });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }
  if (req.method === 'PATCH' || (req.method === 'POST' && req.body && req.body._action === 'update')) {
    try {
      const { id, name, is_public, password } = req.body || {};
      if (!id) return res.status(400).json({ error: 'Missing id' });
      if (password !== process.env.WALL_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
      const update = {};
      if (typeof name === 'string') {
        const clean = name.trim();
        if (!clean) return res.status(400).json({ error: 'Name cannot be empty' });
        update.name = clean;
      }
      if (typeof is_public === 'boolean') update.is_public = is_public;
      if (!Object.keys(update).length) return res.status(400).json({ error: 'No changes provided' });
      const up = await supabase.from('walls').update(update).eq('id', id).select();
      if (up.error) throw up.error;
      return res.status(200).json({ data: up.data && up.data[0] });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }
  if (req.method === 'DELETE' || (req.method === 'POST' && req.body && req.body._action === 'delete')) {
    try {
      const url = new URL(req.url, 'http://local');
      const id = (req.body && req.body.id) || url.searchParams.get('id');
      const password = (req.body && req.body.password) || url.searchParams.get('password');
      if (!id) return res.status(400).json({ error: 'Missing id' });
      if (password !== process.env.WALL_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
      // Prevent deleting default rishu wall by slug
      const w = await supabase.from('walls').select('id, slug').eq('id', id).maybeSingle();
      if (w.error) throw w.error;
      if (!w.data) return res.status(404).json({ error: 'Not found' });
      if ((w.data.slug || '').toLowerCase() === 'rishu') return res.status(400).json({ error: "Cannot delete the default wall" });
      // Delete wall entries first, then wall
      const delEntries = await supabase.from('wall_entries').delete().eq('wall_id', id);
      if (delEntries.error) throw delEntries.error;
      const delWall = await supabase.from('walls').delete().eq('id', id);
      if (delWall.error) throw delWall.error;
      return res.status(200).json({ ok: true });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }
  return res.status(405).json({ error: 'Method not allowed' });
}

// Series: collections of wall entries
// Tables expected (for full functionality):
// - series (id, title, created_at)
// - series_items (series_id, entry_id, position, created_at)
// Handlers degrade gracefully: GET returns [] if tables missing; POST replies with actionable error.
async function seriesHandler(req, res) {
  if (req.method === 'GET') {
    try {
      const url = new URL(req.url, 'http://local');
      const wall = (url.searchParams.get('wall') || '').toLowerCase();
      const allowed = new Set(['rishu','friend','tech','songs','ideas']);
      let q;
      if (wall && allowed.has(wall)) {
        q = await supabase.from('series').select('*').eq('home_wall', wall)
          .order('is_pinned', { ascending: false })
          .order('pin_order', { ascending: true, nullsFirst: false })
          .order('created_at', { ascending: false });
        if (q.error && String(q.error.code) === '42703') {
          // Column home_wall missing – fallback to no filter
          q = await supabase.from('series').select('*')
            .order('created_at', { ascending: false });
        }
      } else {
        q = await supabase.from('series').select('*')
          .order('is_pinned', { ascending: false })
          .order('pin_order', { ascending: true, nullsFirst: false })
          .order('created_at', { ascending: false });
      }
      if (q.error) {
        // Table likely missing; return empty list so UI can still render
        if (String(q.error.code) === '42P01' || /series/i.test(String(q.error.message || ''))) {
          return res.status(200).json({ data: [] });
        }
        throw q.error;
      }
      return res.status(200).json({ data: q.data || [] });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }
  if (req.method === 'DELETE' || (req.method === 'POST' && req.body && req.body._action === 'delete')) {
    try {
      const body = req.body || {};
      const url = new URL(req.url, 'http://local');
      const id = body.id || url.searchParams.get('id');
      const password = body.password || url.searchParams.get('password');
      if (!id) return res.status(400).json({ error: 'Missing id' });
      if (password !== process.env.WALL_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
      const del = await supabase.from('series').delete().eq('id', id);
      if (del.error) throw del.error;
      return res.status(200).json({ ok: true });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }
  if (req.method === 'POST') {
    try {
      const { _action } = req.body || {};
      // Extended actions for pin/unpin and reorder within the same endpoint
      if (_action === 'pin') {
        const { id, pin, password } = req.body || {};
        if (!id || typeof pin === 'undefined') return res.status(400).json({ error: 'id and pin are required' });
        if (password !== process.env.WALL_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
        if (pin) {
          const maxRow = await supabase
            .from('series')
            .select('pin_order')
            .eq('is_pinned', true)
            .order('pin_order', { ascending: false, nullsFirst: false })
            .limit(1)
            .maybeSingle();
          if (maxRow.error && String(maxRow.error.code) === '42703') {
            return res.status(400).json({ error: 'Series pinning requires DB migration. Please add is_pinned and pin_order columns.' });
          }
          const nextOrder = (maxRow && maxRow.data && typeof maxRow.data.pin_order === 'number') ? (maxRow.data.pin_order + 1) : 0;
          const { error: upErr } = await supabase.from('series').update({ is_pinned: true, pin_order: nextOrder }).eq('id', id);
          if (upErr) throw upErr;
        } else {
          const { error: upErr } = await supabase.from('series').update({ is_pinned: false, pin_order: null }).eq('id', id);
          if (upErr) throw upErr;
        }
        return res.status(200).json({ ok: true });
      }
      if (_action === 'reorder') {
        const { ids, password } = req.body || {};
        if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids are required' });
        if (password !== process.env.WALL_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
        for (let i = 0; i < ids.length; i++) {
          const id = ids[i];
          const { error } = await supabase.from('series').update({ is_pinned: true, pin_order: i }).eq('id', id);
          if (error) {
            if (String(error.code) === '42703') return res.status(400).json({ error: 'Series pin ordering requires DB migration.' });
            throw error;
          }
        }
        return res.status(200).json({ ok: true });
      }
      const { title, password, wall, home_wall } = req.body || {};
      if (!title || !String(title).trim()) return res.status(400).json({ error: 'Title is required' });
      if (password !== process.env.WALL_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
      const preferred = (home_wall || wall || 'rishu').toLowerCase();
      const allowed = new Set(['rishu','friend','tech','songs','ideas']);
      const hw = allowed.has(preferred) ? preferred : 'rishu';
      let ins = await supabase.from('series').insert([{ title: String(title).trim(), home_wall: hw }]).select();
      if (ins.error) {
        const msg = String(ins.error.message || '');
        const code = String(ins.error.code || '');
        if (code === '42703' || /home_wall/i.test(msg)) {
          // home_wall column missing; fallback insert without it
          const fb = await supabase.from('series').insert([{ title: String(title).trim() }]).select();
          if (fb.error) throw fb.error;
          const row = fb.data && fb.data[0] ? { ...fb.data[0], home_wall: hw } : null;
          return res.status(200).json({ data: row });
        }
        if (code === '42P01') {
          return res.status(400).json({ error: 'Series require DB migration. Please run supabase db push.' });
        }
        throw ins.error;
      }
      return res.status(200).json({ data: (ins.data && ins.data[0]) || null });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }
  return res.status(405).json({ error: 'Method not allowed' });
}

async function seriesItemsHandler(req, res) {
  if (req.method === 'GET') {
    try {
      const url = new URL(req.url, 'http://local');
      const seriesId = url.searchParams.get('series_id');
      if (!seriesId) return res.status(400).json({ error: 'series_id is required' });
      // Fetch items for this series ordered by position then created_at
      const items = await supabase
        .from('series_items')
        .select('source_type, source_id, position, created_at')
        .eq('series_id', seriesId)
        .order('position', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: true });
      if (items.error) {
        if (String(items.error.code) === '42P01' || /series_items/i.test(String(items.error.message || ''))) {
          return res.status(200).json({ data: [] });
        }
        throw items.error;
      }
      const rows = items.data || [];
      if (!rows.length) return res.status(200).json({ data: [] });
      // Group by type for batch fetches
      const groups = rows.reduce((acc, r) => { (acc[r.source_type] ||= []).push(r.source_id); return acc; }, {});
      const results = {};
      // Helper to run a query and stash by type
      async function fetchType(t, table, select = '*') {
        const ids = Array.from(new Set(groups[t] || []));
        if (!ids.length) { results[t] = new Map(); return; }
        const q = await supabase.from(table).select(select).in('id', ids);
        if (q.error) throw q.error;
        results[t] = new Map((q.data || []).map(e => [String(e.id), e]));
      }
      // Fetch each present group
      const tasks = [];
      if (groups.rishu && groups.rishu.length) tasks.push(fetchType('rishu', 'wall_entries'));
      if (groups.friend && groups.friend.length) tasks.push(fetchType('friend', 'friend_entries'));
      if (groups.tech && groups.tech.length) tasks.push(fetchType('tech', 'tech_notes'));
      if (groups.songs && groups.songs.length) tasks.push(fetchType('songs', 'song_quotes'));
      if (groups.ideas && groups.ideas.length) tasks.push(fetchType('ideas', 'project_ideas'));
      await Promise.all(tasks);
      // Build ordered output preserving original ordering
      const out = rows.map(r => {
        const m = (results[r.source_type] || new Map());
        const obj = m.get(String(r.source_id));
        if (!obj) return null;
        return { ...obj, _type: r.source_type };
      }).filter(Boolean);
      return res.status(200).json({ data: out });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }
  if (req.method === 'PATCH' || req.method === 'PUT') {
    try {
      const { series_id, ordered_ids, password } = req.body || {};
      if (!series_id || !Array.isArray(ordered_ids)) return res.status(400).json({ error: 'series_id and ordered_ids are required' });
      if (password !== process.env.WALL_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
      // Update positions to match new order (0..n-1)
      for (let i = 0; i < ordered_ids.length; i++) {
        const source_id = ordered_ids[i];
        const { error } = await supabase
          .from('series_items')
          .update({ position: i })
          .eq('series_id', series_id)
          .eq('source_id', source_id);
        if (error) throw error;
      }
      return res.status(200).json({ ok: true });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }
  if (req.method === 'POST') {
    // add item
    try {
      const { series_id, source_type, source_id, password } = req.body || {};
      if (!series_id || !source_id || !source_type) return res.status(400).json({ error: 'series_id, source_type and source_id are required' });
      const allowed = new Set(['rishu','friend','tech','songs','ideas']);
      if (!allowed.has(source_type)) return res.status(400).json({ error: 'Invalid source_type' });
      if (password !== process.env.WALL_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
      // Next position
      const max = await supabase
        .from('series_items')
        .select('position')
        .eq('series_id', series_id)
        .order('position', { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();
      let next = 0;
      if (max && max.data && typeof max.data.position === 'number') next = max.data.position + 1;
      const ins = await supabase
        .from('series_items')
        .insert([{ series_id, source_type, source_id, position: next }])
        .select();
      if (ins.error) {
        if (String(ins.error.code) === '42P01' || /series_items/i.test(String(ins.error.message || ''))) {
          return res.status(400).json({ error: 'Series items require DB migration. Please run supabase db push.' });
        }
        throw ins.error;
      }
      return res.status(200).json({ ok: true });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }
  if (req.method === 'DELETE') {
    try {
      const body = req.body || {};
      const url = new URL(req.url, 'http://local');
      const series_id = body.series_id || url.searchParams.get('series_id');
      const source_type = body.source_type || url.searchParams.get('source_type');
      const source_id = body.source_id || url.searchParams.get('source_id');
      const password = body.password || url.searchParams.get('password');
      if (!series_id || !source_type || !source_id) return res.status(400).json({ error: 'series_id, source_type and source_id are required' });
      if (password !== process.env.WALL_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
      const del = await supabase.from('series_items').delete().eq('series_id', series_id).eq('source_type', source_type).eq('source_id', source_id);
      if (del.error) throw del.error;
      return res.status(200).json({ ok: true });
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
    const { password, wall_id, wall } = req.body || {};
    if (password !== process.env.WALL_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
    let targetWallId = wall_id || null;
    if (!targetWallId && wall) {
      try {
        const r = await supabase.from('walls').select('id').eq('slug', wall).maybeSingle();
        if (r.data && r.data.id) targetWallId = r.data.id;
      } catch (_) {}
    }
    if (!targetWallId) targetWallId = await getDefaultWallId();
    let q = supabase.from('wall_entries').select('*').eq('visibility', 'draft').order('timestamp', { ascending: false });
    if (targetWallId) { try { q = q.eq('wall_id', targetWallId); } catch (_) {} }
    const { data, error } = await q;
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

// Project Ideas API (similar to tech_notes)
async function projectIdeasHandler(req, res) {
  // POST without text -> list (auth required)
  if (req.method === 'POST' && (!req.body || typeof req.body.text === 'undefined')) {
    try {
      const { password } = req.body || {};
      if (password !== process.env.WALL_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
      let q = await supabase.from('project_ideas').select('*').order('timestamp', { ascending: false });
      if (q.error) {
        if (String(q.error.code) === '42703' || /column\s+"?timestamp"?/i.test(String(q.error.message || ''))) {
          const fb = await supabase.from('project_ideas').select('*').order('id', { ascending: false });
          if (fb.error) {
            if (String(fb.error.code) === '42P01' || /project_ideas/i.test(String(fb.error.message || ''))) {
              return res.status(200).json({ data: [] });
            }
            throw fb.error;
          }
          return res.status(200).json({ data: fb.data });
        }
        if (String(q.error.code) === '42P01' || /project_ideas/i.test(String(q.error.message || ''))) {
          return res.status(200).json({ data: [] });
        }
        throw q.error;
      }
      return res.status(200).json({ data: q.data });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }
  // Create idea (auth required)
  if (req.method === 'POST') {
    try {
      const { text, password, title } = req.body || {};
      if (!text) return res.status(400).json({ error: 'Text is required' });
      if (password !== process.env.WALL_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
      const cleanTitle = (typeof title === 'string' && title.trim().length > 0 && title.trim() !== '(optional)') ? title.trim() : null;
      let ins = await supabase.from('project_ideas').insert([{ text, title: cleanTitle }]).select();
      if (ins.error) {
        if (String(ins.error.code) === '42P01' || /project_ideas/i.test(String(ins.error.message || ''))) {
          return res.status(400).json({ error: 'Ideas require DB migration. Please run supabase db push.' });
        }
        const fb = await supabase.from('project_ideas').insert([{ text }]).select();
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

async function deleteProjectIdeaHandler(req, res) {
  if (req.method !== 'POST' && req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const body = req.body || {};
    const id = body.id || (req.query && req.query.id);
    const password = body.password || (req.query && req.query.password);
    if (!id) return res.status(400).json({ error: 'Missing id' });
    if (password !== process.env.WALL_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
    const { error } = await supabase.from('project_ideas').delete().eq('id', id);
    if (error) throw error;
    return res.status(200).json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

async function updateProjectIdeaHandler(req, res) {
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

    let { data, error } = await supabase.from('project_ideas').update(update).eq('id', id).select();
    if (error) throw error;
    return res.status(200).json({ data: (data && data[0]) || null });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
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

// Song Quotes API (similar to tech_notes)
async function songQuotesHandler(req, res) {
  if (req.method === 'GET') {
    try {
      let q = await supabase.from('song_quotes').select('*').order('timestamp', { ascending: false });
      if (q.error) {
        if (String(q.error.code) === '42703' || /column\s+"?timestamp"?/i.test(String(q.error.message || ''))) {
          const fb = await supabase.from('song_quotes').select('*').order('id', { ascending: false });
          if (fb.error) {
            if (String(fb.error.code) === '42P01' || /song_quotes/i.test(String(fb.error.message || ''))) {
              return res.status(200).json({ data: [] });
            }
            throw fb.error;
          }
          return res.status(200).json({ data: fb.data });
        }
        if (String(q.error.code) === '42P01' || /song_quotes/i.test(String(q.error.message || ''))) {
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
      const { text, password, title, spotify_url } = req.body || {};
      if (!text) return res.status(400).json({ error: 'Text is required' });
      if (password !== process.env.WALL_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
      const cleanTitle = (typeof title === 'string' && title.trim().length > 0 && title.trim() !== '(optional)') ? title.trim() : null;
      const row = { text, title: cleanTitle, spotify_url: (typeof spotify_url === 'string' && spotify_url.trim()) ? spotify_url.trim() : null, timestamp: new Date().toISOString() };
      let ins = await supabase.from('song_quotes').insert([row]).select();
      if (ins.error) {
        if (String(ins.error.code) === '42P01' || /song_quotes/i.test(String(ins.error.message || ''))) {
          return res.status(400).json({ error: 'Song quotes require DB migration. Please run supabase db push.' });
        }
        // Fallback without extra columns
        const fb = await supabase.from('song_quotes').insert([{ text }]).select();
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

async function deleteSongQuoteHandler(req, res) {
  if (req.method !== 'POST' && req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const body = req.body || {};
    const id = body.id || (req.query && req.query.id);
    const password = body.password || (req.query && req.query.password);
    if (!id) return res.status(400).json({ error: 'Missing id' });
    if (password !== process.env.WALL_PASSWORD) return res.status(401).json({ error: 'Invalid password' });
    const { error } = await supabase.from('song_quotes').delete().eq('id', id);
    if (error) throw error;
    return res.status(200).json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

async function updateSongQuoteHandler(req, res) {
  if (req.method !== 'POST' && req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { id, text, password, title, spotify_url } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Missing id' });
    if (password !== process.env.WALL_PASSWORD) return res.status(401).json({ error: 'Invalid password' });

    const update = {};
    if (typeof text === 'string') update.text = text;
    if (typeof title === 'string') {
      const cleanTitle = title.trim();
      update.title = cleanTitle && cleanTitle !== '(optional)' ? cleanTitle : null;
    }
    if (typeof spotify_url === 'string') {
      const clean = spotify_url.trim();
      update.spotify_url = clean ? clean : null;
    }

    let { data, error } = await supabase.from('song_quotes').update(update).eq('id', id).select();
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
      const { entryId, password, type, longUrl } = req.body || {};

      // If a longUrl is provided (e.g., tech/songs hash links), just shorten externally
      if (longUrl) {
        const ext = await maybeShortenExternal(String(longUrl));
        if (enforceExternal && !ext) return res.status(500).json({ error: 'External shortener failed' });
        const shortUrl = ext || String(longUrl);
        return res.status(200).json({ shortUrl, external: !!ext });
      }

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
    if (head === 'walls') return wallsHandler(req, res);
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
  if (head === 'series') return seriesHandler(req, res);
  if (head === 'series-items') return seriesItemsHandler(req, res);
    if (head === 'song-quotes') return songQuotesHandler(req, res);
    if (head === 'delete-song-quote') return deleteSongQuoteHandler(req, res);
    if (head === 'update-song-quote') return updateSongQuoteHandler(req, res);
    if (head === 'shorten') return shortenHandler(req, res);
    if (head === 'project-ideas') return projectIdeasHandler(req, res);
    if (head === 'delete-project-idea') return deleteProjectIdeaHandler(req, res);
    if (head === 'update-project-idea') return updateProjectIdeaHandler(req, res);
    if (head === 's') return sResolveHandler(req, res);

    return res.status(404).json({ error: 'Not found' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
