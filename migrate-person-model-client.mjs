// Person model, client access (phase 1): a per-client switch and one client-safe read function.
//
//   pm_client_settings   one row per coachee: is the read switched on for them, and (phase 2) consent and
//                        delete requests. Coach-only table; the client never reads it directly.
//   pm_client_read()     what a signed-in client may see of their own model, as one JSON object.
//
// The person model tables stay coach-only. A client gets nothing from them directly; they call
// pm_client_read(), which (as the database owner) returns only:
//   - their own coachee row's model (matched on email or alias, like coachees_read_own),
//   - only when the coach has switched it on AND the client has agreed to it,
//   - confirmed / disputed findings, with client fields only (no codes, episode labels, notes, change reasons,
//     who made a change, step bases, transcripts),
//   - quotes in the client's own words only, with the session and the kind of evidence,
//   - history: when it was first noted, and changes after it was confirmed (no wording, no reasons),
//   - predictions the coach has shared, and interventions that are active or done.
// Idempotent — safe to re-run.  Run: SUPABASE_ACCESS_TOKEN=<pat> node migrate-person-model-client.mjs

const PROJECT_REF = 'diiazuiyxxcecjnjmirt';
const PAT = process.env.SUPABASE_ACCESS_TOKEN;
const IS_COACH = `lower(auth.email()) = ANY (ARRAY['dhirenharchandani@gmail.com', 'dhiren@myinnergame.com'])`;
if (!PAT) { console.error('SUPABASE_ACCESS_TOKEN env var is required.'); process.exit(1); }

async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}
const step = (t) => console.log(`\n--- ${t} ---`);

(async () => {
  step('1. pm_client_settings');
  await sql(`
    CREATE TABLE IF NOT EXISTS public.pm_client_settings (
      coachee_id UUID PRIMARY KEY REFERENCES public.coachees(id) ON DELETE CASCADE,
      visible BOOLEAN NOT NULL DEFAULT false,
      visible_changed_at TIMESTAMPTZ,
      consent_at TIMESTAMPTZ,
      consent_version TEXT,
      delete_requested_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await sql(`ALTER TABLE public.pm_client_settings ENABLE ROW LEVEL SECURITY;`);
  await sql(`REVOKE ALL ON public.pm_client_settings FROM anon, authenticated;`);
  await sql(`GRANT SELECT, INSERT, UPDATE ON public.pm_client_settings TO authenticated;`);
  await sql(`DROP POLICY IF EXISTS pm_client_settings_coach_all ON public.pm_client_settings;`);
  await sql(`CREATE POLICY pm_client_settings_coach_all ON public.pm_client_settings FOR ALL TO authenticated USING (${IS_COACH}) WITH CHECK (${IS_COACH});`);
  await sql(`
    CREATE OR REPLACE FUNCTION public.pm_client_settings_touch() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      NEW.updated_at := now();
      IF TG_OP = 'INSERT' OR NEW.visible IS DISTINCT FROM OLD.visible THEN NEW.visible_changed_at := now(); END IF;
      RETURN NEW;
    END $$;
  `);
  await sql(`DROP TRIGGER IF EXISTS pm_client_settings_touch ON public.pm_client_settings;`);
  await sql(`CREATE TRIGGER pm_client_settings_touch BEFORE INSERT OR UPDATE ON public.pm_client_settings FOR EACH ROW EXECUTE FUNCTION public.pm_client_settings_touch();`);

  step('2. pm_client_read()');
  await sql(`
    CREATE OR REPLACE FUNCTION public.pm_client_read() RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
    DECLARE cid UUID; s public.pm_client_settings; em TEXT := lower(coalesce(auth.email(), ''));
    BEGIN
      IF em = '' THEN RETURN jsonb_build_object('available', false); END IF;
      SELECT c.id INTO cid FROM public.coachees c
        WHERE lower(c.email) = em OR em IN (SELECT lower(unnest(c.email_aliases))) LIMIT 1;
      IF cid IS NULL THEN RETURN jsonb_build_object('available', false); END IF;
      SELECT * INTO s FROM public.pm_client_settings WHERE coachee_id = cid;
      IF s IS NULL OR NOT s.visible THEN RETURN jsonb_build_object('available', false); END IF;
      IF s.consent_at IS NULL THEN RETURN jsonb_build_object('available', true, 'consented', false); END IF;

      RETURN jsonb_build_object(
        'available', true, 'consented', true, 'consent_at', s.consent_at,
        'findings', coalesce((SELECT jsonb_agg(jsonb_build_object(
            'id', f.id, 'statement', f.statement, 'client_headline', f.client_headline, 'client_question', f.client_question,
            'lens', f.lens, 'domains', to_jsonb(f.domains), 'type', f.type,
            'pattern_sequence', (SELECT jsonb_agg(jsonb_build_object('step', x->>'step', 'text', x->>'text'))
                                 FROM jsonb_array_elements(coalesce(f.pattern_sequence, '[]'::jsonb)) x),
            'mechanism', f.mechanism, 'alternative', f.alternative, 'counter_evidence', f.counter_evidence,
            'scope', f.scope, 'exceptions', f.exceptions, 'confidence', f.confidence, 'importance', f.importance,
            'episodes', f.episodes, 'status', f.status,
            'works_against_aims', f.works_against_aims, 'client_undervalues', f.client_undervalues))
          FROM public.pm_findings f WHERE f.coachee_id = cid AND f.status IN ('confirmed','disputed')), '[]'::jsonb),
        'evidence', coalesce((SELECT jsonb_agg(jsonb_build_object(
            'id', e.id, 'finding_id', e.finding_id, 'session_id', e.session_id, 'quote', e.quote,
            'class', e.class, 'is_counter', e.is_counter, 'speaker', 'client'))
          FROM public.pm_evidence e JOIN public.pm_findings f ON f.id = e.finding_id
          WHERE f.coachee_id = cid AND f.status IN ('confirmed','disputed') AND e.speaker = 'client'), '[]'::jsonb),
        'history', coalesce((SELECT jsonb_agg(jsonb_build_object(
            'id', h.id, 'finding_id', h.finding_id, 'changed_at', h.changed_at, 'field', h.field,
            'before', CASE WHEN h.field IN ('confidence','status') THEN h.before END,
            'after', CASE WHEN h.field IN ('confidence','status') THEN h.after END) ORDER BY h.changed_at)
          FROM public.pm_finding_history h JOIN public.pm_findings f ON f.id = h.finding_id
          WHERE f.coachee_id = cid AND f.status IN ('confirmed','disputed')
            AND (h.field = 'created'
              OR (h.field IN ('status','confidence','scope','exceptions','statement','client_headline')
                  AND h.changed_at >= (SELECT min(h2.changed_at) FROM public.pm_finding_history h2
                                        WHERE h2.finding_id = h.finding_id AND h2.field = 'status' AND h2.after = '"confirmed"'::jsonb)))), '[]'::jsonb),
        'predictions', coalesce((SELECT jsonb_agg(jsonb_build_object(
            'id', p.id, 'finding_ids', to_jsonb(p.finding_ids), 'situation', p.situation, 'situation_date', p.situation_date,
            'expected', p.expected, 'conditions', p.conditions, 'wrong_if', p.wrong_if, 'involves_others', p.involves_others,
            'status', p.status, 'outcome', p.outcome, 'outcome_note', p.outcome_note, 'shared_with_client', true,
            'created_at', p.created_at))
          FROM public.pm_predictions p WHERE p.coachee_id = cid AND p.shared_with_client AND p.status IN ('open','scored')
            AND NOT EXISTS (SELECT 1 FROM public.pm_findings f WHERE f.id = ANY (p.finding_ids) AND f.status NOT IN ('confirmed','disputed'))), '[]'::jsonb),
        'interventions', coalesce((SELECT jsonb_agg(jsonb_build_object(
            'id', i.id, 'finding_id', i.finding_id, 'kind', i.kind, 'opportunity', i.opportunity,
            'point_of_change', i.point_of_change, 'action', i.action, 'intended_benefit', i.intended_benefit,
            'how_we_know', i.how_we_know, 'result', i.result, 'status', i.status))
          FROM public.pm_interventions i JOIN public.pm_findings f ON f.id = i.finding_id
          WHERE i.coachee_id = cid AND i.status IN ('active','done') AND f.status IN ('confirmed','disputed')), '[]'::jsonb),
        'sessions_read', coalesce((SELECT jsonb_agg(DISTINCT x) FROM public.pm_runs r, unnest(r.sessions_read) x WHERE r.coachee_id = cid), '[]'::jsonb)
      );
    END $$;
  `);
  await sql(`REVOKE ALL ON FUNCTION public.pm_client_read() FROM public, anon;`);
  await sql(`GRANT EXECUTE ON FUNCTION public.pm_client_read() TO authenticated;`);

  step('3. Check');
  console.log(JSON.stringify(await sql(`SELECT proname, prosecdef FROM pg_proc WHERE proname = 'pm_client_read';`)));
})().catch(e => { console.error(e.message); process.exit(1); });
