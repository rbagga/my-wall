const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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

module.exports = async function handler(req, res) {
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
      // Do not leak draft content publicly
      res.statusCode = 403;
      res.setHeader('Content-Type', 'text/plain');
      return res.end('This note is not publicly shareable.');
    }

    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers.host;
    const viewHash = isFriend ? `#friends&entry=${encodeURIComponent(friendId)}` : `#entry=${encodeURIComponent(entryId)}`;
    const viewUrl = `${proto}://${host}/${viewHash}`;

    // For humans: perform a 302 redirect to the SPA
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
    :root {
      --bg: #1a1a1a;
      --fg: #e0e0e0;
      --panel: #2a2a2a;
      --border: #3a3a3a;
      --muted: #aaa;
      --btn-bg: #333;
      --btn-bg-hover: #555;
      --btn-fg: #fff;
    }
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
