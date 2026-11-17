// Save proposed predictions and interventions (Growth pillar) for one coachee.
// Everything is saved as 'proposed'. The coach accepts in the dashboard, and the database only allows that
// once the findings involved are confirmed (see migrate-person-model-growth.mjs).
//
// Usage:
//   SUPABASE_ACCESS_TOKEN=<pat> node save-growth.mjs <payload.json> [--dry]
//
// Payload:
// {
//   "coachee": "olivia-lab",
//   "run": { "kind": "session_pass", "sessions_read": [...], "coverage_note": "...", "summary": "..." }?,
//   "predictions": [ {                       // at most two per run (run card, Mode 2 step 7)
//       "findings": ["F-001", "F-007"],      // Live or Solid; not rejected, merged, retired or closed
//       "situation", "situation_date": "YYYY-MM-DD" (today or later: written before the event),
//       "expected", "conditions", "wrong_if", "involves_others"?: true when it depends on another person's response
//   } ],
//   "interventions": [ {
//       "finding": "F-001", "kind": "nudge|practice|experiment",
//       "opportunity", "point_of_change", "action", "intended_benefit", "how_we_know"
//   } ]
// }
// Every text field is read by the client once accepted and shared: write it to them, as "you".

import { readFileSync } from 'node:fs';

const PAT = process.env.SUPABASE_ACCESS_TOKEN;
const [file, ...flags] = process.argv.slice(2);
const DRY = flags.includes('--dry');
if (!PAT) { console.error('SUPABASE_ACCESS_TOKEN env var is required.'); process.exit(1); }
if (!file) { console.error('Usage: node save-growth.mjs <payload.json> [--dry]'); process.exit(1); }

async function sql(query) {
  const r = await fetch('https://api.supabase.com/v1/projects/diiazuiyxxcecjnjmirt/database/query', {
    method: 'POST', headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${text}`);
  return JSON.parse(text);
}
const J = (v) => `'${JSON.stringify(v ?? null).replace(/'/g, "''")}'::jsonb`;
const blank = (s) => !s || !String(s).trim();
const DEAD = ['rejected', 'merged', 'retired', 'closed'];
const today = new Date().toISOString().slice(0, 10);

(async () => {
  const p = JSON.parse(readFileSync(file, 'utf8'));
  const [coachee] = await sql(`SELECT id FROM public.coachees WHERE folder = (${J([p.coachee])}->>0)`);
  if (!coachee) throw new Error(`No coachee row for folder='${p.coachee}'`);
  const findings = new Map((await sql(`SELECT id, code, status, confidence, type, pattern_sequence FROM public.pm_findings WHERE coachee_id = '${coachee.id}'`)).map(f => [f.code, f]));
  const out = { predictions: [], interventions: [], rejected: [] };

  const preds = [];
  if ((p.predictions || []).length > 2) out.rejected.push({ item: 'predictions', reasons: ['at most two predictions per run'] });
  else for (const x of p.predictions || []) {
    const r = [];
    for (const k of ['situation', 'situation_date', 'expected', 'conditions', 'wrong_if']) if (blank(x[k])) r.push(`missing ${k}`);
    if (x.situation_date && !/^\d{4}-\d{2}-\d{2}$/.test(x.situation_date)) r.push('situation_date must be YYYY-MM-DD');
    else if (x.situation_date && x.situation_date < today) r.push('the situation has already happened; predictions are written before the event');
    if (!Array.isArray(x.findings) || !x.findings.length) r.push('no findings it rests on');
    const ids = [];
    for (const code of x.findings || []) {
      const f = findings.get(code);
      if (!f) { r.push(`no finding ${code}`); continue; }
      if (DEAD.includes(f.status)) r.push(`${code} is ${f.status}`);
      if (!['live', 'solid'].includes(f.confidence)) r.push(`${code} is ${f.confidence}; predict only from Live or Solid findings`);
      ids.push(f.id);
    }
    if (r.length) out.rejected.push({ item: x.situation, reasons: r });
    else preds.push({ ...x, finding_ids: ids, unconfirmed: (x.findings || []).filter(c => findings.get(c).status !== 'confirmed') });
  }

  const ints = [];
  for (const x of p.interventions || []) {
    const r = [];
    for (const k of ['finding', 'kind', 'opportunity', 'point_of_change', 'action', 'intended_benefit', 'how_we_know']) if (blank(x[k])) r.push(`missing ${k}`);
    if (x.kind && !['nudge', 'practice', 'experiment'].includes(x.kind)) r.push(`kind must be nudge, practice or experiment`);
    const f = findings.get(x.finding);
    if (x.finding && !f) r.push(`no finding ${x.finding}`);
    if (f && DEAD.includes(f.status)) r.push(`${x.finding} is ${f.status}`);
    if (r.length) out.rejected.push({ item: x.action || x.opportunity, reasons: r });
    else ints.push({ ...x, finding_id: f.id, unconfirmed: f.status !== 'confirmed' });
  }

  if (DRY) {
    out.predictions = preds.map(x => ({ situation: x.situation, on: x.situation_date, findings: x.findings, waits_for: x.unconfirmed }));
    out.interventions = ints.map(x => ({ kind: x.kind, finding: x.finding, action: x.action.slice(0, 70), waits_for: x.unconfirmed ? [x.finding] : [] }));
    console.log(JSON.stringify({ dry: true, ...out }, null, 2));
    return;
  }

  let runId = null;
  if (p.run && (preds.length || ints.length)) {
    const [r] = await sql(`
      INSERT INTO public.pm_runs (coachee_id, kind, sessions_read, coverage_note, blind_notes, summary)
      SELECT '${coachee.id}', x->>'kind', ARRAY(SELECT jsonb_array_elements_text(coalesce(x->'sessions_read','[]'))),
             x->>'coverage_note', coalesce(x->'blind_notes','[]'), x->>'summary'
      FROM (SELECT ${J(p.run)} AS x) s RETURNING id`);
    runId = r.id;
  }
  const nextCode = async (table, prefix) => {
    const [{ n }] = await sql(`SELECT coalesce(max(substring(code from 3)::int), 0) AS n FROM public.${table} WHERE coachee_id = '${coachee.id}'`);
    return `${prefix}-${String(n + 1).padStart(3, '0')}`;
  };
  const reason = `Proposed by Claude (${p.run?.kind || 'manual'})`;
  for (const x of preds) {
    const code = await nextCode('pm_predictions', 'P');
    await sql(`
      INSERT INTO public.pm_predictions (coachee_id, code, run_id, finding_ids, situation, situation_date, expected, conditions, wrong_if, involves_others, last_change_reason)
      SELECT '${coachee.id}', '${code}', ${runId ? `'${runId}'` : 'NULL'}, ARRAY(SELECT jsonb_array_elements_text(x->'finding_ids'))::uuid[],
        x->>'situation', (x->>'situation_date')::date, x->>'expected', x->>'conditions', x->>'wrong_if',
        coalesce((x->>'involves_others')::boolean, false), (${J([reason])}->>0)
      FROM (SELECT ${J(x)} AS x) s`);
    out.predictions.push({ code, situation: x.situation, waits_for: x.unconfirmed });
  }
  for (const x of ints) {
    const code = await nextCode('pm_interventions', 'I');
    await sql(`
      INSERT INTO public.pm_interventions (coachee_id, code, run_id, finding_id, kind, opportunity, point_of_change, action, intended_benefit, how_we_know, last_change_reason)
      SELECT '${coachee.id}', '${code}', ${runId ? `'${runId}'` : 'NULL'}, (x->>'finding_id')::uuid, x->>'kind', x->>'opportunity',
        x->>'point_of_change', x->>'action', x->>'intended_benefit', x->>'how_we_know', (${J([reason])}->>0)
      FROM (SELECT ${J(x)} AS x) s`);
    out.interventions.push({ code, kind: x.kind, finding: x.finding, waits_for: x.unconfirmed ? [x.finding] : [] });
  }
  console.log(JSON.stringify({ run: runId, ...out }, null, 2));
})().catch(e => { console.error(e.message); process.exit(1); });
