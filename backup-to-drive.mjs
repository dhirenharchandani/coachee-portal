// Daily Coachee Portal backup to Google Drive.
// Dumps every row in public.coachees (folder, email, email_aliases, version, data)
// plus a storage object manifest, writes a date-stamped JSON to Google Drive,
// and prunes backups older than 30 days.
//
// Run manually:
//   SUPABASE_ACCESS_TOKEN=<pat> node coachees/backup-to-drive.mjs
//
// Designed to be run from a scheduled task once per day.

import fs from 'node:fs';
import path from 'node:path';

const PROJECT_REF = 'diiazuiyxxcecjnjmirt';
const PAT = process.env.SUPABASE_ACCESS_TOKEN;
const BACKUP_DIR = '/Users/dhiren/Library/CloudStorage/GoogleDrive-dhirenharchandani@gmail.com/My Drive/Coachee-Portal-Backups';
const RETENTION_DAYS = 30;

if (!PAT) { console.error('SUPABASE_ACCESS_TOKEN required (set in ~/.claude/settings.json)'); process.exit(1); }

async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${text}`);
  return JSON.parse(text);
}

async function storageList(prefix) {
  const sr = (await (await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/api-keys`, { headers:{Authorization:`Bearer ${PAT}`} })).json()).find(k=>k.name==='service_role').api_key;
  const r = await fetch(`https://${PROJECT_REF}.supabase.co/storage/v1/object/list/resources`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${sr}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix, limit: 500 }),
  });
  return r.json();
}

// 1. Fetch every coachee row
const rows = await sql(`SELECT folder, email, email_aliases, version, data FROM public.coachees ORDER BY folder;`);
console.log(`Fetched ${rows.length} coachee rows`);

// 2. Build a storage manifest per folder (filenames + sizes, not file contents)
const storageManifest = {};
for (const row of rows) {
  const files = await storageList(`${row.folder}/`);
  if (Array.isArray(files)) {
    storageManifest[row.folder] = files.map(f => ({ name: f.name, size: f.metadata?.size, mime: f.metadata?.mimetype, updated: f.updated_at }));
  }
}

const totalFiles = Object.values(storageManifest).reduce((s, arr) => s + arr.length, 0);
console.log(`Storage manifest: ${totalFiles} files across ${Object.keys(storageManifest).length} folders`);

// 3. Write the backup
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  console.log(`Created ${BACKUP_DIR}`);
}

const today = new Date().toISOString().slice(0, 10);
const backup = {
  backedUpAt: new Date().toISOString(),
  projectRef: PROJECT_REF,
  coacheeCount: rows.length,
  coachees: rows,
  storageManifest,
};
const json = JSON.stringify(backup, null, 2);
const datedPath = path.join(BACKUP_DIR, `coachees-${today}.json`);
const latestPath = path.join(BACKUP_DIR, 'coachees-latest.json');

fs.writeFileSync(datedPath, json);
fs.writeFileSync(latestPath, json);
console.log(`Wrote ${(json.length / 1e6).toFixed(2)}MB → ${datedPath}`);
console.log(`Updated ${latestPath}`);

// 4. Prune backups older than RETENTION_DAYS
const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
let pruned = 0;
for (const file of fs.readdirSync(BACKUP_DIR)) {
  const m = file.match(/^coachees-(\d{4}-\d{2}-\d{2})\.json$/);
  if (!m) continue;
  const fileDate = new Date(m[1] + 'T00:00:00Z').getTime();
  if (fileDate < cutoff) {
    fs.unlinkSync(path.join(BACKUP_DIR, file));
    pruned++;
  }
}
if (pruned) console.log(`Pruned ${pruned} backup(s) older than ${RETENTION_DAYS} days`);

console.log('\nBackup complete.');
