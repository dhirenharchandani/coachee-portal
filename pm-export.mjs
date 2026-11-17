// Export what a person-model pass needs to read, to a local folder:
//   <out>/transcripts/<session_id>.md   every stored transcript for the source folder, date order
//   <out>/sessions.json                 session list from the dashboard row (id, date, title, hasTranscript)
//   <out>/findings.json                 existing findings for the target coachee, ALL statuses
//                                       (rejected ones too, so the same reading is not proposed again)
//
// Usage: SUPABASE_ACCESS_TOKEN=<pat> node pm-export.mjs <sourceFolder> <targetFolder> <outDir>
// e.g.   node pm-export.mjs olivia olivia-lab ~/tmp/pm-olivia

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PAT = process.env.SUPABASE_ACCESS_TOKEN;
const [source, target, out] = process.argv.slice(2);
if (!PAT || !source || !target || !out) {
  console.error('Usage: SUPABASE_ACCESS_TOKEN=<pat> node pm-export.mjs <sourceFolder> <targetFolder> <outDir>');
  process.exit(1);
}
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
async function sql(query) {
  const r = await fetch('https://api.supabase.com/v1/projects/diiazuiyxxcecjnjmirt/database/query', {
    method: 'POST', headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${text}`);
  return JSON.parse(text);
}

const transcripts = await sql(`SELECT session_id, source, word_count, transcript_md FROM public.session_transcripts WHERE folder = ${lit(source)}`);
const [row] = await sql(`SELECT id, data->'sessions' AS sessions FROM public.coachees WHERE folder = ${lit(target)}`);
if (!row) throw new Error(`No coachee row for folder='${target}'`);
const sessions = (row.sessions || []).map(s => ({ id: s.id, date: s.date, title: s.title, hasTranscript: transcripts.some(t => t.session_id === s.id) }))
  .sort((a, b) => a.date.localeCompare(b.date));
const order = (id) => sessions.findIndex(s => s.id === id);
transcripts.sort((a, b) => order(a.session_id) - order(b.session_id) || a.session_id.localeCompare(b.session_id));

const findings = await sql(`
  SELECT f.*, coalesce((SELECT json_agg(json_build_object('session_id', e.session_id, 'speaker', e.speaker, 'quote', e.quote, 'class', e.class, 'is_counter', e.is_counter, 'episode', e.episode))
                         FROM public.pm_evidence e WHERE e.finding_id = f.id), '[]') AS evidence
  FROM public.pm_findings f WHERE f.coachee_id = ${lit(row.id)} ORDER BY f.code`);

mkdirSync(join(out, 'transcripts'), { recursive: true });
transcripts.forEach((t, i) => writeFileSync(join(out, 'transcripts', `${String(i + 1).padStart(2, '0')}_${t.session_id}.md`), t.transcript_md));
writeFileSync(join(out, 'sessions.json'), JSON.stringify(sessions, null, 2));
writeFileSync(join(out, 'findings.json'), JSON.stringify(findings, null, 2));

console.log(JSON.stringify({
  transcripts: transcripts.map(t => `${t.session_id} (${t.source}, ${t.word_count} words)`),
  sessionsWithoutTranscript: sessions.filter(s => !s.hasTranscript).map(s => `${s.date} ${s.title}`),
  existingFindings: findings.reduce((m, f) => ({ ...m, [f.status]: (m[f.status] || 0) + 1 }), {}),
  out,
}, null, 2));
