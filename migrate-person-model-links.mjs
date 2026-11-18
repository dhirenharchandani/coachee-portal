// Person model: directed links between findings (what may drive what).
// See person-model-framework.md, "Links between findings".
//
//   pm_links   one row per link between two findings of the same coachee:
//              feeds          from may feed to (a working explanation, not a proven cause)
//              draws_on       from is a strength that may help with to
//              goes_with      the two tend to show up together (stored once; direction means nothing)
//              pulls_against  the two pull in opposite directions (stored once)
//              Each carries a one-line reason, written to the client as "you".
//
// Every insert, change or removal is logged on BOTH findings in pm_finding_history (field 'link').
// Access: coach only. Clients see links through pm_client_read(), and only between findings they can see.
// pm_findings.related (the older, undirected list) is no longer read by the dashboard.
// Idempotent — safe to re-run.
// Run before migrate-person-model-client.mjs, whose pm_client_read() returns the links.
// Run: SUPABASE_ACCESS_TOKEN=<pat> node migrate-person-model-links.mjs

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
const step = (s) => console.log(`\n--- ${s} ---`);

step('1. pm_links');
await sql(`
  CREATE TABLE IF NOT EXISTS public.pm_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    coachee_id UUID NOT NULL REFERENCES public.coachees(id) ON DELETE CASCADE,
    from_id UUID NOT NULL REFERENCES public.pm_findings(id) ON DELETE CASCADE,
    to_id UUID NOT NULL REFERENCES public.pm_findings(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('feeds', 'draws_on', 'goes_with', 'pulls_against')),
    why TEXT NOT NULL CHECK (char_length(trim(why)) > 0),
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (from_id <> to_id)
  );
`);
// One link per pair, whichever way round it was written.
await sql(`CREATE UNIQUE INDEX IF NOT EXISTS pm_links_pair ON public.pm_links (LEAST(from_id, to_id), GREATEST(from_id, to_id));`);
await sql(`CREATE INDEX IF NOT EXISTS pm_links_coachee ON public.pm_links (coachee_id);`);

step('2. Both ends belong to the same coachee');
await sql(`
  CREATE OR REPLACE FUNCTION public.pm_links_check() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public AS $$
  BEGIN
    IF (SELECT count(*) FROM public.pm_findings WHERE id IN (NEW.from_id, NEW.to_id) AND coachee_id = NEW.coachee_id) <> 2 THEN
      RAISE EXCEPTION 'Both findings must belong to this coachee';
    END IF;
    RETURN NEW;
  END $$;
`);
await sql(`DROP TRIGGER IF EXISTS pm_links_check ON public.pm_links;`);
await sql(`CREATE TRIGGER pm_links_check BEFORE INSERT OR UPDATE ON public.pm_links FOR EACH ROW EXECUTE FUNCTION public.pm_links_check();`);

step('3. Log every link change on both findings');
await sql(`
  CREATE OR REPLACE FUNCTION public.pm_links_log() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
  DECLARE who TEXT := coalesce(auth.email(), 'claude'); r RECORD; o RECORD; fid UUID; other UUID; side TEXT;
  BEGIN
    r := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    FOREACH fid IN ARRAY ARRAY[r.from_id, r.to_id] LOOP
      other := CASE WHEN fid = r.from_id THEN r.to_id ELSE r.from_id END;
      side := CASE WHEN fid = r.from_id THEN 'from' ELSE 'to' END;
      -- A finding being deleted takes its history with it, so there is nothing to log on it.
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM public.pm_findings WHERE id = fid);
      INSERT INTO public.pm_finding_history (finding_id, actor, field, before, after, reason)
      VALUES (fid, who, 'link',
        CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE jsonb_build_object('kind', OLD.kind, 'side', side,
          'other', (SELECT code FROM public.pm_findings WHERE id = other), 'why', OLD.why) END,
        CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE jsonb_build_object('kind', NEW.kind, 'side', side,
          'other', (SELECT code FROM public.pm_findings WHERE id = other), 'why', NEW.why) END,
        r.reason);
    END LOOP;
    RETURN r;
  END $$;
`);
await sql(`DROP TRIGGER IF EXISTS pm_links_log ON public.pm_links;`);
await sql(`CREATE TRIGGER pm_links_log AFTER INSERT OR UPDATE OR DELETE ON public.pm_links FOR EACH ROW EXECUTE FUNCTION public.pm_links_log();`);

step('4. RLS: coach only');
await sql(`ALTER TABLE public.pm_links ENABLE ROW LEVEL SECURITY;`);
await sql(`REVOKE ALL ON public.pm_links FROM anon, authenticated;`);
await sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.pm_links TO authenticated;`);
await sql(`DROP POLICY IF EXISTS pm_links_coach_all ON public.pm_links;`);
await sql(`CREATE POLICY pm_links_coach_all ON public.pm_links FOR ALL TO authenticated USING (${IS_COACH}) WITH CHECK (${IS_COACH});`);

step('5. Check');
console.log(JSON.stringify(await sql(`SELECT count(*) AS links FROM public.pm_links;`)));
