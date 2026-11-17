// Copy a person model from one coachee row to another, e.g. from the lab copy to the client's real row.
// Copies runs, findings, evidence, finding history, predictions, interventions and growth history, with new ids
// and every reference remapped. History keeps its original dates, actors and reasons (the copy's own
// "created" entries are replaced by the originals). Every quote is re-verified by the evidence trigger.
// The client switch (pm_client_settings) is NOT copied: the target stays off until the coach turns it on.
//
// One transaction: all or nothing. Refuses if the target already has any person model data.
//
// Usage: SUPABASE_ACCESS_TOKEN=<pat> node pm-promote.mjs <from-folder> <to-folder> [--dry]

const PAT = process.env.SUPABASE_ACCESS_TOKEN;
const [from, to, flag] = process.argv.slice(2);
const DRY = flag === '--dry';
if (!PAT || !from || !to) { console.error('Usage: SUPABASE_ACCESS_TOKEN=<pat> node pm-promote.mjs <from-folder> <to-folder> [--dry]'); process.exit(1); }

async function sql(query) {
  const r = await fetch('https://api.supabase.com/v1/projects/diiazuiyxxcecjnjmirt/database/query', {
    method: 'POST', headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${text}`);
  return JSON.parse(text);
}
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const cols = async (t) => (await sql(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='${t}' ORDER BY ordinal_position`)).map(r => r.column_name);

(async () => {
  const rows = await sql(`SELECT id, folder FROM public.coachees WHERE folder IN (${lit(from)}, ${lit(to)})`);
  const F = rows.find(r => r.folder === from)?.id, T = rows.find(r => r.folder === to)?.id;
  if (!F || !T) throw new Error(`Need both coachee rows: ${from} ${F ? 'found' : 'missing'}, ${to} ${T ? 'found' : 'missing'}`);

  // Columns copied as they are; ids and references are handled explicitly below.
  const copy = async (t, skip) => (await cols(t)).filter(c => !skip.includes(c));
  const runC = await copy('pm_runs', ['id', 'coachee_id']);
  const fC = await copy('pm_findings', ['id', 'coachee_id', 'run_id', 'merged_into', 'related', 'last_change_reason']);
  const eC = await copy('pm_evidence', ['id', 'finding_id', 'position', 'transcript_hash', 'verified_at']);
  const pC = await copy('pm_predictions', ['id', 'coachee_id', 'run_id', 'finding_ids', 'last_change_reason']);
  const iC = await copy('pm_interventions', ['id', 'coachee_id', 'run_id', 'finding_id', 'last_change_reason']);
  const list = (c, p) => c.map(x => `${p}${x}`).join(', ');
  const why = lit(`Copied from ${from}`);

  const counts = `SELECT
    (SELECT count(*) FROM public.pm_runs WHERE coachee_id='${T}') runs,
    (SELECT count(*) FROM public.pm_findings WHERE coachee_id='${T}') findings,
    (SELECT count(*) FROM public.pm_findings WHERE coachee_id='${T}' AND status='confirmed') confirmed,
    (SELECT count(*) FROM public.pm_evidence e JOIN public.pm_findings f ON f.id=e.finding_id WHERE f.coachee_id='${T}') evidence,
    (SELECT count(*) FROM public.pm_evidence e JOIN public.pm_findings f ON f.id=e.finding_id WHERE f.coachee_id='${T}' AND e.verified_at IS NOT NULL) verified,
    (SELECT count(*) FROM public.pm_finding_history h JOIN public.pm_findings f ON f.id=h.finding_id WHERE f.coachee_id='${T}') history,
    (SELECT count(*) FROM public.pm_predictions WHERE coachee_id='${T}') predictions,
    (SELECT count(*) FROM public.pm_interventions WHERE coachee_id='${T}') interventions,
    (SELECT count(*) FROM public.pm_growth_history WHERE coachee_id='${T}') growth_history,
    (SELECT coalesce(bool_or(visible), false) FROM public.pm_client_settings WHERE coachee_id='${T}') switch_on`;
  const source = counts.replaceAll(`'${T}'`, `'${F}'`);

  const body = `
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM public.pm_findings WHERE coachee_id='${T}') OR EXISTS (SELECT 1 FROM public.pm_runs WHERE coachee_id='${T}')
         OR EXISTS (SELECT 1 FROM public.pm_predictions WHERE coachee_id='${T}') OR EXISTS (SELECT 1 FROM public.pm_interventions WHERE coachee_id='${T}') THEN
        RAISE EXCEPTION 'The target row already has a person model. Nothing was copied.';
      END IF;
    END $$;

    CREATE TEMP TABLE m_run ON COMMIT DROP AS SELECT id AS old_id, gen_random_uuid() AS new_id FROM public.pm_runs WHERE coachee_id='${F}';
    CREATE TEMP TABLE m_f   ON COMMIT DROP AS SELECT id AS old_id, gen_random_uuid() AS new_id FROM public.pm_findings WHERE coachee_id='${F}';
    CREATE TEMP TABLE m_p   ON COMMIT DROP AS SELECT id AS old_id, gen_random_uuid() AS new_id FROM public.pm_predictions WHERE coachee_id='${F}';
    CREATE TEMP TABLE m_i   ON COMMIT DROP AS SELECT id AS old_id, gen_random_uuid() AS new_id FROM public.pm_interventions WHERE coachee_id='${F}';

    INSERT INTO public.pm_runs (id, coachee_id, ${list(runC, '')})
      SELECT m.new_id, '${T}', ${list(runC, 'r.')} FROM public.pm_runs r JOIN m_run m ON m.old_id = r.id;

    INSERT INTO public.pm_findings (id, coachee_id, run_id, merged_into, related, last_change_reason, ${list(fC, '')})
      SELECT m.new_id, '${T}', mr.new_id, mm.new_id,
             coalesce(ARRAY(SELECT x.new_id FROM unnest(f.related) u(id) JOIN m_f x ON x.old_id = u.id), '{}'), ${why}, ${list(fC, 'f.')}
      FROM public.pm_findings f JOIN m_f m ON m.old_id = f.id
      LEFT JOIN m_run mr ON mr.old_id = f.run_id LEFT JOIN m_f mm ON mm.old_id = f.merged_into;

    -- The insert trigger wrote a fresh "created" entry for each copy; keep the originals instead.
    DELETE FROM public.pm_finding_history WHERE finding_id IN (SELECT new_id FROM m_f);
    INSERT INTO public.pm_finding_history (finding_id, changed_at, actor, field, before, after, reason)
      SELECT m.new_id, h.changed_at, h.actor, h.field, h.before, h.after, h.reason
      FROM public.pm_finding_history h JOIN m_f m ON m.old_id = h.finding_id ORDER BY h.id;

    INSERT INTO public.pm_evidence (id, finding_id, ${list(eC, '')})
      SELECT gen_random_uuid(), m.new_id, ${list(eC, 'e.')} FROM public.pm_evidence e JOIN m_f m ON m.old_id = e.finding_id;

    INSERT INTO public.pm_predictions (id, coachee_id, run_id, finding_ids, last_change_reason, ${list(pC, '')})
      SELECT m.new_id, '${T}', mr.new_id,
             ARRAY(SELECT x.new_id FROM unnest(p.finding_ids) WITH ORDINALITY u(id, n) JOIN m_f x ON x.old_id = u.id ORDER BY u.n), ${why}, ${list(pC, 'p.')}
      FROM public.pm_predictions p JOIN m_p m ON m.old_id = p.id LEFT JOIN m_run mr ON mr.old_id = p.run_id;

    INSERT INTO public.pm_interventions (id, coachee_id, run_id, finding_id, last_change_reason, ${list(iC, '')})
      SELECT m.new_id, '${T}', mr.new_id, mf.new_id, ${why}, ${list(iC, 'i.')}
      FROM public.pm_interventions i JOIN m_i m ON m.old_id = i.id JOIN m_f mf ON mf.old_id = i.finding_id LEFT JOIN m_run mr ON mr.old_id = i.run_id;

    DELETE FROM public.pm_growth_history WHERE item_id IN (SELECT new_id FROM m_p UNION SELECT new_id FROM m_i);
    INSERT INTO public.pm_growth_history (item_type, item_id, coachee_id, changed_at, actor, field, before, after, reason)
      SELECT g.item_type, coalesce(mp.new_id, mi.new_id), '${T}', g.changed_at, g.actor, g.field, g.before, g.after, g.reason
      FROM public.pm_growth_history g LEFT JOIN m_p mp ON mp.old_id = g.item_id LEFT JOIN m_i mi ON mi.old_id = g.item_id
      WHERE g.coachee_id = '${F}' AND coalesce(mp.new_id, mi.new_id) IS NOT NULL ORDER BY g.id;
  `;

  const res = await sql(`BEGIN; ${body} ${counts}; ${DRY ? 'ROLLBACK' : 'COMMIT'};`);
  console.log(JSON.stringify({ from, to, dry: DRY, source: (await sql(source))[0], target: (Array.isArray(res) ? res : [res]).flat().pop() }, null, 2));
  if (!DRY) console.log('after:', (await sql(counts))[0]);
})().catch(e => { console.error(e.message); process.exit(1); });
