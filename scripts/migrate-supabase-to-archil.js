#!/usr/bin/env node

const { createClient } = require('@supabase/supabase-js');
const { getDisk, readTable, writeRow } = require('../api/lib/archil-db');

const APPLY = process.argv.includes('--apply');
const PAGE_SIZE = 500;

const TABLES = [
  'walls',
  'series',
  'wall_entries',
  'friend_entries',
  'tech_notes',
  'project_ideas',
  'song_quotes',
  'short_links',
  'strava_connections',
  'strava_runs',
  'series_items',
];

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function fetchAll(client, table) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const result = await client.from(table).select('*').range(from, from + PAGE_SIZE - 1);
    if (result.error) {
      if (result.error.code === '42P01' || /does not exist/i.test(result.error.message || '')) return [];
      throw new Error(`${table}: ${result.error.message}`);
    }
    rows.push(...(result.data || []));
    if (!result.data || result.data.length < PAGE_SIZE) return rows;
  }
}

async function migrateResume(client) {
  const bucket = String(process.env.RESUME_STORAGE_BUCKET || 'resume');
  const filename = String(process.env.RESUME_STORAGE_PATH || 'rishu-bagga-resume-2026.pdf');
  const result = await client.storage.from(bucket).download(filename);
  if (result.error || !result.data) return false;
  const disk = await getDisk();
  await disk.putObject(`_system/assets/${filename}`, Buffer.from(await result.data.arrayBuffer()), 'application/pdf');
  return true;
}

async function main() {
  const source = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'));
  await getDisk();

  const sourceRows = {};
  for (const table of TABLES) {
    sourceRows[table] = await fetchAll(source, table);
    console.log(`${table}: ${sourceRows[table].length} source records`);
  }

  if (!APPLY) {
    console.log('\nDry run only. Re-run with --apply to write these records to Archil.');
    return;
  }

  for (const table of TABLES) {
    for (const row of sourceRows[table]) await writeRow(table, row);
    console.log(`${table}: written`);
  }

  const resumeMigrated = await migrateResume(source);
  console.log(`resume: ${resumeMigrated ? 'written' : 'not present in Supabase storage'}`);

  let valid = true;
  console.log('\nValidation');
  for (const table of TABLES) {
    const targetCount = (await readTable(table)).length;
    const sourceCount = sourceRows[table].length;
    const matches = targetCount === sourceCount;
    if (!matches) valid = false;
    console.log(`${table}: source=${sourceCount} archil=${targetCount} ${matches ? 'OK' : 'MISMATCH'}`);
  }

  if (!valid) throw new Error('Migration validation failed');
  console.log('\nMigration completed successfully. Supabase was not modified.');
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
