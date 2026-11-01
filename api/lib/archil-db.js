const crypto = require('crypto');
const YAML = require('yaml');
const { Archil } = require('disk');

const ENTRY_WALLS = Object.freeze({
  friend_entries: 'friend',
  tech_notes: 'tech',
  project_ideas: 'ideas',
  song_quotes: 'songs',
});
const ENTRY_TABLES = new Set(['wall_entries', ...Object.keys(ENTRY_WALLS)]);
const INTERNAL_FIELDS = new Set(['_path', '_series_id', '_source_type', '_wall_slug']);
const ENTRY_SUMMARY_INDEX = '_system/index/entry-summaries.json';
const ENTRY_EXCERPT_LENGTH = 280;

let diskPromise;

function getDisk() {
  if (!diskPromise) {
    const client = new Archil({
      apiKey: process.env.ARCHIL_API_KEY,
      region: process.env.ARCHIL_REGION || 'aws-us-west-2',
      baseUrl: process.env.ARCHIL_BASE_URL || undefined,
      s3BaseUrl: process.env.ARCHIL_S3_BASE_URL || undefined,
    });
    diskPromise = client.disks.get(process.env.ARCHIL_DISK_ID);
  }
  return diskPromise;
}

function safeSegment(value) {
  return encodeURIComponent(String(value)).replace(/%/g, '~');
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-') || 'series';
}

function publicRow(row) {
  if (!row) return row;
  return Object.fromEntries(Object.entries(row).filter(([key]) => !INTERNAL_FIELDS.has(key)));
}

function markdownFor(row) {
  const metadata = { ...row };
  delete metadata._path;
  const text = String(metadata.text || '');
  delete metadata.text;
  return `---\n${YAML.stringify(metadata).trimEnd()}\n---\n${text}`;
}

function parseMarkdown(contents, path) {
  const text = String(contents);
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?([\s\S]*)$/);
  if (!match) throw new Error(`Invalid entry file: ${path}`);
  const metadata = YAML.parse(match[1]) || {};
  return { ...metadata, text: match[2], _path: path };
}

async function readText(path) {
  const disk = await getDisk();
  const bytes = await disk.getObject(path);
  return new TextDecoder().decode(bytes);
}

async function readJson(path) {
  return JSON.parse(await readText(path));
}

async function writeJson(path, value) {
  const disk = await getDisk();
  await disk.putObject(path, `${JSON.stringify(publicRow(value), null, 2)}\n`, 'application/json');
}

async function listKeys(prefix, suffix) {
  const disk = await getDisk();
  const result = await disk.listObjects(prefix, { recursive: true });
  return (result.objects || [])
    .map((object) => object.key)
    .filter((key) => !suffix || key.endsWith(suffix));
}

async function readManyJson(prefix, filename) {
  const keys = await listKeys(prefix);
  const selected = filename
    ? keys.filter((key) => key.endsWith(`/${filename}`) || key === `${prefix}${filename}`)
    : keys.filter((key) => key.endsWith('.json'));
  return Promise.all(selected.map(async (path) => ({ ...(await readJson(path)), _path: path })));
}

async function listEntries() {
  const series = await readManyJson('', '_series.json');
  const seriesByDirectory = new Map(series.map((row) => [row._path.replace(/\/_series\.json$/, ''), row]));
  const keys = (await listKeys('', '.md')).filter((path) => !path.startsWith('_system/'));
  const rows = await Promise.all(keys.map(async (path) => {
    const row = parseMarkdown(await readText(path), path);
    const directory = path.slice(0, path.lastIndexOf('/'));
    const nestedSeries = seriesByDirectory.get(directory);
    const wallMatch = path.match(/^([^/]+)\//);
    return {
      ...row,
      _wall_slug: wallMatch ? decodeSegment(wallMatch[1]) : null,
      _series_id: nestedSeries ? nestedSeries.id : null,
    };
  }));
  // A move writes the destination before deleting the source. Prefer the nested
  // copy if a concurrent read catches that short overlap.
  const byIdentity = new Map();
  for (const row of rows) {
    const key = `${row._table}:${row.id}`;
    const existing = byIdentity.get(key);
    if (!existing || (!existing._series_id && row._series_id)) byIdentity.set(key, row);
  }
  return [...byIdentity.values()];
}

function summarizeEntry(row) {
  const text = String(row.text || '');
  return {
    ...row,
    text: text.length > ENTRY_EXCERPT_LENGTH ? `${text.slice(0, ENTRY_EXCERPT_LENGTH).trimEnd()}…` : text,
    _summary: true,
  };
}

async function readEntrySummaryIndex() {
  try {
    const rows = await readJson(ENTRY_SUMMARY_INDEX);
    return Array.isArray(rows) ? rows : null;
  } catch (_) {
    return null;
  }
}

async function rebuildEntrySummaryIndex() {
  const rows = (await listEntries()).map(summarizeEntry);
  const disk = await getDisk();
  await disk.putObject(ENTRY_SUMMARY_INDEX, `${JSON.stringify(rows)}\n`, 'application/json');
  return rows;
}

async function listEntrySummaries() {
  return (await readEntrySummaryIndex()) || rebuildEntrySummaryIndex();
}

async function updateEntrySummaryIndex(row, deleted = false) {
  const rows = await readEntrySummaryIndex();
  if (!rows) return;
  const identity = (candidate) => `${candidate._table}:${candidate.id}`;
  const key = identity(row);
  const next = rows.filter((candidate) => identity(candidate) !== key);
  if (!deleted) next.push(summarizeEntry(row));
  const disk = await getDisk();
  await disk.putObject(ENTRY_SUMMARY_INDEX, `${JSON.stringify(next)}\n`, 'application/json');
}

function decodeSegment(value) {
  return decodeURIComponent(String(value).replace(/~/g, '%'));
}

async function listWalls() {
  return readManyJson('', '_wall.json');
}

async function wallSlugForId(wallId) {
  const walls = await listWalls();
  const wall = walls.find((candidate) => String(candidate.id) === String(wallId));
  return wall ? wall.slug : 'rishu';
}

async function seriesForId(seriesId) {
  const rows = await readManyJson('', '_series.json');
  return rows.find((row) => String(row.id) === String(seriesId)) || null;
}

function tableForSourceType(type) {
  return ({ rishu: 'wall_entries', friend: 'friend_entries', tech: 'tech_notes', songs: 'song_quotes', ideas: 'project_ideas' })[type];
}

function sourceTypeForTable(table) {
  return ({ wall_entries: 'rishu', friend_entries: 'friend', tech_notes: 'tech', song_quotes: 'songs', project_ideas: 'ideas' })[table];
}

async function pathForEntry(row, table, seriesId = row._series_id) {
  let wallSlug = ENTRY_WALLS[table];
  if (table === 'wall_entries') wallSlug = row._wall_slug || await wallSlugForId(row.wall_id);
  const file = `${safeSegment(row.id)}.md`;
  if (seriesId) {
    const series = await seriesForId(seriesId);
    if (!series) throw new Error(`Series ${seriesId} not found`);
    return `${series._path.replace(/\/_series\.json$/, '')}/${file}`;
  }
  return `${safeSegment(wallSlug)}/${file}`;
}

async function writeEntry(row, table, options = {}) {
  const disk = await getDisk();
  const normalized = {
    ...row,
    id: row.id == null ? crypto.randomUUID() : row.id,
    _table: table,
    _source_type: row._source_type || sourceTypeForTable(table),
  };
  const target = await pathForEntry(normalized, table, options.seriesId);
  await disk.putObject(target, markdownFor(normalized), 'text/markdown; charset=utf-8');
  if (normalized._path && normalized._path !== target) await disk.deleteObject(normalized._path);
  const written = { ...normalized, _path: target, _series_id: options.seriesId || null };
  await updateEntrySummaryIndex(written);
  return written;
}

async function removeSeries(series) {
  const entries = (await listEntries()).filter((row) => String(row._series_id) === String(series.id));
  for (const entry of entries) {
    await writeEntry(entry, entry._table, { seriesId: null });
  }
  const disk = await getDisk();
  const prefix = series._path.replace(/_series\.json$/, '');
  const keys = await listKeys(prefix);
  if (keys.length) await disk.deleteObjects(keys);
}

async function readTable(table, options = {}) {
  if (ENTRY_TABLES.has(table)) {
    const rows = options.summary ? await listEntrySummaries() : await listEntries();
    return rows.filter((row) => row._table === table);
  }
  if (table === 'walls') return listWalls();
  if (table === 'series') return readManyJson('', '_series.json');
  if (table === 'series_items') {
    const nested = (await listEntries())
      .filter((row) => row._series_id)
      .map((row) => ({
        series_id: row._series_id,
        source_type: row._source_type || sourceTypeForTable(row._table),
        source_id: row.id,
        position: row._series_position == null ? null : row._series_position,
        created_at: row._series_created_at || row.created_at || row.timestamp,
        _entry: row,
      }));
    const orphanKeys = (await listKeys('', '.json')).filter((path) => path.includes('/_orphans/'));
    const orphans = await Promise.all(orphanKeys.map(async (path) => ({ ...(await readJson(path)), _path: path })));
    return [...nested, ...orphans];
  }
  if (table === 'short_links') return readManyJson('_system/short-links/');
  return readManyJson(`_system/data/${safeSegment(table)}/`);
}

function defaultRow(table, input) {
  const now = new Date().toISOString();
  const row = { ...input };
  if (row.id == null && table !== 'series_items') row.id = crypto.randomUUID();
  if (table === 'walls') {
    row.created_at ||= now;
    if (typeof row.is_public !== 'boolean') row.is_public = true;
  } else if (table === 'series') {
    row.created_at ||= now;
    row.is_pinned = !!row.is_pinned;
    row.pin_order ??= null;
  } else if (ENTRY_TABLES.has(table)) {
    row.timestamp ||= now;
    row.created_at ||= row.timestamp;
    if (table === 'wall_entries') row.visibility ||= 'public';
    row.is_pinned = !!row.is_pinned;
    row.pin_order ??= null;
  } else if (table === 'series_items') {
    row.created_at ||= now;
  } else {
    row.created_at ||= now;
  }
  return row;
}

async function writeRow(table, input) {
  const row = defaultRow(table, input);
  if (ENTRY_TABLES.has(table)) return writeEntry(row, table, { seriesId: row._series_id });
  if (table === 'walls') {
    const path = `${safeSegment(row.slug)}/_wall.json`;
    await writeJson(path, row);
    if (row._path && row._path !== path) {
      const disk = await getDisk();
      await disk.deleteObject(row._path);
    }
    return { ...row, _path: path };
  }
  if (table === 'series') {
    const folder = `${slugify(row.title || 'series')}--${safeSegment(row.id)}`;
    const path = `${safeSegment(row.home_wall || 'rishu')}/${folder}/_series.json`;
    await writeJson(path, row);
    return { ...row, _path: path };
  }
  if (table === 'series_items') {
    const entryTable = tableForSourceType(row.source_type);
    if (!entryTable) throw new Error(`Unsupported series source type: ${row.source_type}`);
    const entry = (await readTable(entryTable)).find((candidate) => String(candidate.id) === String(row.source_id));
    if (!entry) {
      const series = await seriesForId(row.series_id);
      if (!series) throw new Error(`Series ${row.series_id} not found`);
      const path = `${series._path.replace(/\/_series\.json$/, '')}/_orphans/${safeSegment(row.source_type)}-${safeSegment(row.source_id)}.json`;
      await writeJson(path, row);
      return { ...row, _path: path };
    }
    entry._series_position = row.position;
    entry._series_created_at = row.created_at;
    return writeEntry(entry, entryTable, { seriesId: row.series_id });
  }
  const path = table === 'short_links'
    ? `_system/short-links/${safeSegment(row.code)}.json`
    : `_system/data/${safeSegment(table)}/${safeSegment(row.id)}.json`;
  await writeJson(path, row);
  return { ...row, _path: path };
}

async function deleteRow(table, row) {
  if (table === 'series_items') {
    const entry = row._entry;
    if (entry) {
      delete entry._series_position;
      delete entry._series_created_at;
      await writeEntry(entry, entry._table, { seriesId: null });
    } else if (row._path) {
      const disk = await getDisk();
      await disk.deleteObject(row._path);
    }
    return;
  }
  if (table === 'series') return removeSeries(row);
  if (!row._path) return;
  const disk = await getDisk();
  await disk.deleteObject(row._path);
  if (ENTRY_TABLES.has(table)) await updateEntrySummaryIndex(row, true);
}

function project(row, columns) {
  if (!columns || columns === '*') return publicRow(row);
  const names = String(columns).split(',').map((name) => name.trim()).filter(Boolean);
  return Object.fromEntries(names.map((name) => [name, row[name]]));
}

class Query {
  constructor(table) {
    this.table = table;
    this.filters = [];
    this.orders = [];
    this.columns = '*';
    this.max = null;
    this.single = false;
    this.operation = 'select';
    this.payload = null;
    this.conflict = null;
    this.summaryOnly = false;
  }

  select(columns = '*') { this.columns = columns; return this; }
  eq(field, value) { this.filters.push((row) => String(row[field] ?? '') === String(value ?? '')); return this; }
  is(field, value) { this.filters.push((row) => row[field] === value); return this; }
  in(field, values) { const set = new Set((values || []).map(String)); this.filters.push((row) => set.has(String(row[field]))); return this; }
  or(expression) {
    const clauses = String(expression).split(',').map((part) => part.trim());
    this.filters.push((row) => clauses.some((clause) => {
      const match = clause.match(/^([^.]+)\.(is|eq)\.(.+)$/);
      if (!match) return false;
      const [, field, op, raw] = match;
      const value = raw === 'null' ? null : raw;
      return op === 'is' ? row[field] === value : String(row[field]) === String(value);
    }));
    return this;
  }
  order(field, options = {}) { this.orders.push({ field, ...options }); return this; }
  limit(value) { this.max = Number(value); return this; }
  maybeSingle() { this.single = true; return this; }
  summaries() { this.summaryOnly = true; return this; }
  insert(rows) { this.operation = 'insert'; this.payload = Array.isArray(rows) ? rows : [rows]; return this; }
  update(values) { this.operation = 'update'; this.payload = values; return this; }
  delete() { this.operation = 'delete'; return this; }
  upsert(rows, options = {}) { this.operation = 'upsert'; this.payload = Array.isArray(rows) ? rows : [rows]; this.conflict = options.onConflict || 'id'; return this; }
  then(resolve, reject) { return this.execute().then(resolve, reject); }

  async execute() {
    try {
      if (this.operation === 'insert') {
        const written = [];
        for (const row of this.payload) written.push(await writeRow(this.table, row));
        return { data: written.map((row) => project(row, this.columns)), error: null };
      }

      let rows = await readTable(this.table, { summary: this.summaryOnly && this.operation === 'select' });
      const matching = rows.filter((row) => this.filters.every((filter) => filter(row)));

      if (this.operation === 'update') {
        const written = [];
        for (const row of matching) {
          if (this.table === 'series_items') {
            const entry = { ...row._entry };
            if (Object.prototype.hasOwnProperty.call(this.payload, 'position')) entry._series_position = this.payload.position;
            written.push(await writeEntry(entry, entry._table, { seriesId: row.series_id }));
          } else {
            written.push(await writeRow(this.table, { ...row, ...this.payload }));
          }
        }
        return { data: written.map((row) => project(row, this.columns)), error: null };
      }

      if (this.operation === 'delete') {
        for (const row of matching) await deleteRow(this.table, row);
        return { data: null, error: null };
      }

      if (this.operation === 'upsert') {
        const written = [];
        for (const candidate of this.payload) {
          const existing = rows.find((row) => String(row[this.conflict]) === String(candidate[this.conflict]));
          written.push(await writeRow(this.table, existing ? { ...existing, ...candidate } : candidate));
        }
        return { data: written.map((row) => project(row, this.columns)), error: null };
      }

      for (const order of [...this.orders].reverse()) {
        matching.sort((a, b) => {
          const av = a[order.field];
          const bv = b[order.field];
          if (av == null && bv == null) return 0;
          if (av == null) return order.nullsFirst ? -1 : 1;
          if (bv == null) return order.nullsFirst ? 1 : -1;
          const result = av < bv ? -1 : av > bv ? 1 : 0;
          return order.ascending === false ? -result : result;
        });
      }
      const limited = this.max == null ? matching : matching.slice(0, this.max);
      const data = limited.map((row) => project(row, this.columns));
      return { data: this.single ? (data[0] || null) : data, error: null };
    } catch (error) {
      return { data: this.single ? null : [], error: { message: error.message, code: error.code, status: error.status } };
    }
  }
}

const archilDb = {
  from(table) { return new Query(table); },
};

module.exports = {
  archilDb,
  getDisk,
  listEntries,
  readTable,
  writeRow,
  rebuildEntrySummaryIndex,
};
