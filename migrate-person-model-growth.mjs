// Person model, Growth pillar: predictions and interventions (nudges, practices, experiments).
// See person-model-framework.md ("Predictions and interventions"). Claude proposes; only the coach accepts.
//
//   pm_predictions       written before the event, scored after it; wording locked once accepted
//   pm_interventions     nudge / practice / experiment, each tied to one finding and a point of change
//   pm_growth_history    dated log of every change to either (written by trigger)
//
// Rules the database enforces, so no screen or script can get round them:
//   - A prediction can only be accepted (status open) if every finding it rests on is confirmed and Live or Solid.
//   - Once accepted, what a prediction expected (situation, date, expected, conditions, would-count-as-wrong,
//     findings) can no longer change. Scoring it needs an outcome.
//   - An intervention can only go active if its finding is confirmed.
//
// Access: coach emails only, like the rest of the person model. Existing tables are not changed.
// Idempotent — safe to re-run.  Run: SUPABASE_ACCESS_TOKEN=<pat> node migrate-person-model-growth.mjs

const PROJECT_REF = 'diiazuiyxxcecjnjmirt';
const PAT = process.env.SUPABASE_ACCESS_TOKEN;
const IS_COACH = `lower(auth.email()) = ANY (ARRAY['dhirenharchandani@gmail.com', 'dhiren@myinnergame.com'])`;
if (!PAT) { console.error('SUPABASE_ACCESS_TOKEN env var is required.'); process.exit(1); }

async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}
const step = (t) => console.log(`\n--- ${t} ---`);

(async () => {
  step('1. pm_predictions');
  await sql(`
    CREATE TABLE IF NOT EXISTS public.pm_predictions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      coachee_id UUID NOT NULL REFERENCES public.coachees(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      run_id UUID REFERENCES public.pm_runs(id) ON DELETE SET NULL,
      finding_ids UUID[] NOT NULL CHECK (cardinality(finding_ids) >= 1),
      situation TEXT NOT NULL CHECK (char_length(trim(situation)) > 0),
      situation_date DATE NOT NULL,
      expected TEXT NOT NULL CHECK (char_length(trim(expected)) > 0),
      conditions TEXT NOT NULL CHECK (char_length(trim(conditions)) > 0),
      wrong_if TEXT NOT NULL CHECK (char_length(trim(wrong_if)) > 0),
      involves_others BOOLEAN NOT NULL DEFAULT false,
      status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','open','scored','rejected')),
      outcome TEXT CHECK (outcome IN ('hit','miss','partial','not_testable')),
      outcome_note TEXT,
      outcome_session_id TEXT,
      scored_at TIMESTAMPTZ,
      shared_with_client BOOLEAN NOT NULL DEFAULT false,
      shared_at TIMESTAMPTZ,
      reject_reason TEXT,
      last_change_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (coachee_id, code),
      CHECK (status <> 'scored' OR outcome IS NOT NULL)
    );
  `);
  await sql(`CREATE INDEX IF NOT EXISTS pm_predictions_coachee ON public.pm_predictions (coachee_id, status);`);

  step('2. pm_interventions');
  await sql(`
    CREATE TABLE IF NOT EXISTS public.pm_interventions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      coachee_id UUID NOT NULL REFERENCES public.coachees(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      run_id UUID REFERENCES public.pm_runs(id) ON DELETE SET NULL,
      finding_id UUID NOT NULL REFERENCES public.pm_findings(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('nudge','practice','experiment')),
      opportunity TEXT NOT NULL CHECK (char_length(trim(opportunity)) > 0),
      point_of_change TEXT NOT NULL CHECK (char_length(trim(point_of_change)) > 0),
      action TEXT NOT NULL CHECK (char_length(trim(action)) > 0),
      intended_benefit TEXT NOT NULL CHECK (char_length(trim(intended_benefit)) > 0),
      how_we_know TEXT NOT NULL CHECK (char_length(trim(how_we_know)) > 0),
      result TEXT,
      status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','active','done','dropped','rejected')),
      reject_reason TEXT,
      last_change_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (coachee_id, code)
    );
  `);
  await sql(`CREATE INDEX IF NOT EXISTS pm_interventions_coachee ON public.pm_interventions (coachee_id, status);`);

  step('3. Guards: accept only on confirmed findings; a prediction is fixed once accepted');
  await sql(`
    CREATE OR REPLACE FUNCTION public.pm_prediction_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
    DECLARE bad TEXT;
    BEGIN
      IF TG_OP = 'UPDATE' AND OLD.status <> 'proposed' AND (
           NEW.situation IS DISTINCT FROM OLD.situation OR NEW.situation_date IS DISTINCT FROM OLD.situation_date
        OR NEW.expected IS DISTINCT FROM OLD.expected OR NEW.conditions IS DISTINCT FROM OLD.conditions
        OR NEW.wrong_if IS DISTINCT FROM OLD.wrong_if OR NEW.finding_ids IS DISTINCT FROM OLD.finding_ids) THEN
        RAISE EXCEPTION 'pm_predictions: % was logged before the event and cannot be reworded', OLD.code;
      END IF;
      IF NEW.status IN ('open','scored') AND (TG_OP = 'INSERT' OR OLD.status = 'proposed') THEN
        SELECT string_agg(f.code || ' (' || f.status || ', ' || f.confidence || ')', ', ') INTO bad
        FROM public.pm_findings f
        WHERE f.id = ANY (NEW.finding_ids) AND NOT (f.status = 'confirmed' AND f.confidence IN ('live','solid'));
        IF bad IS NOT NULL THEN
          RAISE EXCEPTION 'pm_predictions: predict only from confirmed Live or Solid findings; not yet: %', bad;
        END IF;
      END IF;
      IF NEW.status = 'scored' AND NEW.scored_at IS NULL THEN NEW.scored_at := now(); END IF;
      IF NEW.shared_with_client AND NEW.shared_at IS NULL THEN NEW.shared_at := now(); END IF;
      RETURN NEW;
    END $$;
  `);
  await sql(`DROP TRIGGER IF EXISTS pm_prediction_guard ON public.pm_predictions;`);
  await sql(`CREATE TRIGGER pm_prediction_guard BEFORE INSERT OR UPDATE ON public.pm_predictions FOR EACH ROW EXECUTE FUNCTION public.pm_prediction_guard();`);
  await sql(`
    CREATE OR REPLACE FUNCTION public.pm_intervention_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
    DECLARE s TEXT; c TEXT;
    BEGIN
      IF NEW.status IN ('active','done') AND (TG_OP = 'INSERT' OR OLD.status = 'proposed') THEN
        SELECT status, code INTO s, c FROM public.pm_findings WHERE id = NEW.finding_id;
        IF s IS DISTINCT FROM 'confirmed' THEN
          RAISE EXCEPTION 'pm_interventions: % rests on % (%); confirm the finding first', NEW.code, c, s;
        END IF;
      END IF;
      RETURN NEW;
    END $$;
  `);
  await sql(`DROP TRIGGER IF EXISTS pm_intervention_guard ON public.pm_interventions;`);
  await sql(`CREATE TRIGGER pm_intervention_guard BEFORE INSERT OR UPDATE ON public.pm_interventions FOR EACH ROW EXECUTE FUNCTION public.pm_intervention_guard();`);

  step('4. pm_growth_history + change-log trigger');
  await sql(`
    CREATE TABLE IF NOT EXISTS public.pm_growth_history (
      id BIGSERIAL PRIMARY KEY,
      item_type TEXT NOT NULL CHECK (item_type IN ('prediction','intervention')),
      item_id UUID NOT NULL,
      coachee_id UUID NOT NULL REFERENCES public.coachees(id) ON DELETE CASCADE,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      actor TEXT NOT NULL,
      field TEXT NOT NULL,
      before JSONB,
      after JSONB,
      reason TEXT
    );
  `);
  await sql(`CREATE INDEX IF NOT EXISTS pm_growth_history_item ON public.pm_growth_history (item_id, changed_at);`);
  await sql(`
    CREATE OR REPLACE FUNCTION public.pm_growth_log() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
    DECLARE k TEXT; o JSONB; n JSONB; who TEXT; kind TEXT;
    BEGIN
      who := coalesce(auth.email(), 'claude');
      kind := CASE TG_TABLE_NAME WHEN 'pm_predictions' THEN 'prediction' ELSE 'intervention' END;
      IF TG_OP = 'INSERT' THEN
        INSERT INTO public.pm_growth_history (item_type, item_id, coachee_id, actor, field, before, after, reason)
        VALUES (kind, NEW.id, NEW.coachee_id, who, 'created', NULL, to_jsonb(NEW.status), NEW.last_change_reason);
        RETURN NEW;
      END IF;
      NEW.updated_at := now();
      o := to_jsonb(OLD); n := to_jsonb(NEW);
      FOR k IN SELECT jsonb_object_keys(n) LOOP
        IF k NOT IN ('updated_at','last_change_reason','scored_at','shared_at') AND o->k IS DISTINCT FROM n->k THEN
          INSERT INTO public.pm_growth_history (item_type, item_id, coachee_id, actor, field, before, after, reason)
          VALUES (kind, NEW.id, NEW.coachee_id, who, k, o->k, n->k, NEW.last_change_reason);
        END IF;
      END LOOP;
      RETURN NEW;
    END $$;
  `);
  for (const t of ['pm_predictions', 'pm_interventions']) {
    await sql(`DROP TRIGGER IF EXISTS ${t}_log ON public.${t};`);
    await sql(`CREATE TRIGGER ${t}_log BEFORE UPDATE ON public.${t} FOR EACH ROW EXECUTE FUNCTION public.pm_growth_log();`);
    await sql(`DROP TRIGGER IF EXISTS ${t}_log_insert ON public.${t};`);
    await sql(`CREATE TRIGGER ${t}_log_insert AFTER INSERT ON public.${t} FOR EACH ROW EXECUTE FUNCTION public.pm_growth_log();`);
  }

  step('5. RLS: coach only');
  const T = ['pm_predictions', 'pm_interventions', 'pm_growth_history'];
  for (const t of T) {
    await sql(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`);
    await sql(`REVOKE ALL ON public.${t} FROM anon, authenticated;`);
    await sql(`DROP POLICY IF EXISTS ${t}_coach_all ON public.${t};`);
  }
  await sql(`GRANT SELECT, INSERT, UPDATE ON public.pm_predictions, public.pm_interventions TO authenticated;`);
  await sql(`GRANT SELECT ON public.pm_growth_history TO authenticated;`);
  for (const t of T) {
    await sql(`CREATE POLICY ${t}_coach_all ON public.${t} FOR ALL TO authenticated USING (${IS_COACH}) WITH CHECK (${IS_COACH});`);
  }

  step('6. Check');
  console.log(JSON.stringify(await sql(`
    SELECT tablename, policyname FROM pg_policies WHERE schemaname='public' AND tablename IN ('pm_predictions','pm_interventions','pm_growth_history') ORDER BY 1;
  `), null, 2));
})().catch(e => { console.error(e.message); process.exit(1); });
