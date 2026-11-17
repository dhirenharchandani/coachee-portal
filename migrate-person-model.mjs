// Person model (Slice 1): findings, their evidence, their history, and runs.
// See person-model-framework.md. Claude writes candidates; only the coach confirms.
//
//   pm_runs             one row per first pass / session pass / checkpoint (checkpoint dates)
//   pm_findings         one row per finding (the 16-field record + extras)
//   pm_evidence         cited passages; each quote is verified against session_transcripts on save
//   pm_finding_history  dated log of every change to a finding (written by trigger)
//
// Access: coach emails only, for every table. Clients cannot read any of it.
// Existing tables are not changed. Idempotent — safe to re-run.
// Run: SUPABASE_ACCESS_TOKEN=<pat> node migrate-person-model.mjs

const PROJECT_REF = 'diiazuiyxxcecjnjmirt';
const PAT = process.env.SUPABASE_ACCESS_TOKEN;
const IS_COACH = `lower(auth.email()) = ANY (ARRAY['dhirenharchandani@gmail.com', 'dhiren@myinnergame.com'])`;

if (!PAT) {
  console.error('SUPABASE_ACCESS_TOKEN env var is required.');
  process.exit(1);
}

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

function step(title) { console.log(`\n--- ${title} ---`); }

const DOMAINS = `ARRAY['drives','values','beliefs','identity','cognition','emotion','relationships','agency']`;

(async () => {
  step('1. pm_runs');
  await sql(`
    CREATE TABLE IF NOT EXISTS public.pm_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      coachee_id UUID NOT NULL REFERENCES public.coachees(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('first_pass','session_pass','checkpoint')),
      sessions_read TEXT[] NOT NULL DEFAULT '{}',
      coverage_note TEXT,
      blind_notes JSONB NOT NULL DEFAULT '[]',
      summary TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      signed_off_at TIMESTAMPTZ
    );
  `);

  step('2. pm_findings');
  await sql(`
    CREATE TABLE IF NOT EXISTS public.pm_findings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      coachee_id UUID NOT NULL REFERENCES public.coachees(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      run_id UUID REFERENCES public.pm_runs(id) ON DELETE SET NULL,
      statement TEXT NOT NULL CHECK (char_length(statement) BETWEEN 10 AND 1200),
      client_headline TEXT NOT NULL CHECK (char_length(client_headline) BETWEEN 3 AND 200),
      client_question TEXT,
      lens TEXT NOT NULL CHECK (lens IN ('my_os','my_insights','my_growth')),
      domains TEXT[] NOT NULL CHECK (cardinality(domains) >= 1 AND domains <@ ${DOMAINS}),
      type TEXT NOT NULL CHECK (type IN ('characteristic','strength','vulnerability','self_perception_gap','loop','connection','conflict','impact_on_others')),
      pattern_sequence JSONB,
      mechanism TEXT,
      episodes INTEGER NOT NULL DEFAULT 0 CHECK (episodes >= 0),
      counter_evidence TEXT NOT NULL CHECK (char_length(trim(counter_evidence)) > 0),
      alternative TEXT NOT NULL CHECK (char_length(trim(alternative)) > 0),
      scope TEXT,
      exceptions TEXT,
      confidence TEXT NOT NULL CHECK (confidence IN ('thin','live','solid')),
      importance TEXT NOT NULL CHECK (importance IN ('high','medium','low')),
      status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','confirmed','disputed','retired','closed','rejected','merged')),
      client_responses JSONB NOT NULL DEFAULT '[]',
      related UUID[] NOT NULL DEFAULT '{}',
      coach_framed BOOLEAN NOT NULL DEFAULT false,
      client_undervalues BOOLEAN NOT NULL DEFAULT false,
      works_against_aims BOOLEAN NOT NULL DEFAULT false,
      reject_reason TEXT,
      merged_into UUID REFERENCES public.pm_findings(id) ON DELETE SET NULL,
      last_change_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (coachee_id, code)
    );
  `);
  await sql(`CREATE INDEX IF NOT EXISTS pm_findings_coachee_status ON public.pm_findings (coachee_id, status);`);

  step('3. pm_evidence');
  await sql(`
    CREATE TABLE IF NOT EXISTS public.pm_evidence (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      finding_id UUID NOT NULL REFERENCES public.pm_findings(id) ON DELETE CASCADE,
      transcript_id BIGINT NOT NULL REFERENCES public.session_transcripts(id) ON DELETE RESTRICT,
      session_id TEXT NOT NULL,
      speaker TEXT NOT NULL CHECK (speaker IN ('client','coach','unknown')),
      quote TEXT NOT NULL,
      class TEXT NOT NULL CHECK (class IN ('direct','self_report','inference')),
      is_counter BOOLEAN NOT NULL DEFAULT false,
      episode TEXT,
      note TEXT,
      position INTEGER,
      transcript_hash TEXT,
      verified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await sql(`CREATE INDEX IF NOT EXISTS pm_evidence_finding ON public.pm_evidence (finding_id);`);

  step('4. Quote verification trigger (exact words; whitespace and ** ignored; <= 40 words)');
  await sql(`
    CREATE OR REPLACE FUNCTION public.pm_verify_quote() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
    DECLARE t TEXT; norm TEXT; q TEXT; pos INTEGER;
    BEGIN
      SELECT transcript_md INTO t FROM public.session_transcripts WHERE id = NEW.transcript_id;
      IF t IS NULL THEN RAISE EXCEPTION 'pm_evidence: transcript % not found', NEW.transcript_id; END IF;
      -- Markdown emphasis (**bold**) added when a transcript was edited is not part of the words.
      norm := regexp_replace(replace(t, '*', ''), '\\s+', ' ', 'g');
      q := trim(regexp_replace(replace(NEW.quote, '*', ''), '\\s+', ' ', 'g'));
      IF cardinality(regexp_split_to_array(q, ' ')) > 40 THEN
        RAISE EXCEPTION 'pm_evidence: quote is over 40 words';
      END IF;
      pos := strpos(norm, q);
      IF pos = 0 THEN
        RAISE EXCEPTION 'pm_evidence: quote not found word for word in transcript % (%): "%"', NEW.transcript_id, NEW.session_id, left(q, 80);
      END IF;
      NEW.quote := q;
      NEW.position := pos;
      NEW.transcript_hash := md5(t);
      NEW.verified_at := now();
      RETURN NEW;
    END $$;
  `);
  await sql(`DROP TRIGGER IF EXISTS pm_evidence_verify ON public.pm_evidence;`);
  await sql(`CREATE TRIGGER pm_evidence_verify BEFORE INSERT OR UPDATE OF quote, transcript_id ON public.pm_evidence FOR EACH ROW EXECUTE FUNCTION public.pm_verify_quote();`);

  step('5. pm_finding_history + change-log trigger');
  await sql(`
    CREATE TABLE IF NOT EXISTS public.pm_finding_history (
      id BIGSERIAL PRIMARY KEY,
      finding_id UUID NOT NULL REFERENCES public.pm_findings(id) ON DELETE CASCADE,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      actor TEXT NOT NULL,
      field TEXT NOT NULL,
      before JSONB,
      after JSONB,
      reason TEXT
    );
  `);
  await sql(`CREATE INDEX IF NOT EXISTS pm_history_finding ON public.pm_finding_history (finding_id, changed_at);`);
  await sql(`
    CREATE OR REPLACE FUNCTION public.pm_log_change() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
    DECLARE f TEXT; o JSONB; n JSONB; who TEXT;
    BEGIN
      who := coalesce(auth.email(), 'claude');
      IF TG_OP = 'INSERT' THEN
        INSERT INTO public.pm_finding_history (finding_id, actor, field, before, after, reason)
        VALUES (NEW.id, who, 'created', NULL, to_jsonb(NEW.status), NEW.last_change_reason);
        RETURN NEW;
      END IF;
      NEW.updated_at := now();
      o := to_jsonb(OLD); n := to_jsonb(NEW);
      FOREACH f IN ARRAY ARRAY['status','confidence','importance','scope','exceptions','statement','client_headline','client_question','mechanism','alternative','counter_evidence','episodes','domains','lens','type','pattern_sequence','merged_into','reject_reason','client_undervalues','works_against_aims','coach_framed']
      LOOP
        IF o->f IS DISTINCT FROM n->f THEN
          INSERT INTO public.pm_finding_history (finding_id, actor, field, before, after, reason)
          VALUES (NEW.id, who, f, o->f, n->f, NEW.last_change_reason);
        END IF;
      END LOOP;
      IF o->'client_responses' IS DISTINCT FROM n->'client_responses' THEN
        INSERT INTO public.pm_finding_history (finding_id, actor, field, before, after, reason)
        VALUES (NEW.id, who, 'client_response', NULL, n->'client_responses'->-1, NEW.last_change_reason);
      END IF;
      RETURN NEW;
    END $$;
  `);
  await sql(`DROP TRIGGER IF EXISTS pm_findings_log ON public.pm_findings;`);
  await sql(`CREATE TRIGGER pm_findings_log BEFORE UPDATE ON public.pm_findings FOR EACH ROW EXECUTE FUNCTION public.pm_log_change();`);
  await sql(`DROP TRIGGER IF EXISTS pm_findings_log_insert ON public.pm_findings;`);
  await sql(`CREATE TRIGGER pm_findings_log_insert AFTER INSERT ON public.pm_findings FOR EACH ROW EXECUTE FUNCTION public.pm_log_change();`);

  step('6. RLS: coach only, every table');
  for (const t of ['pm_runs', 'pm_findings', 'pm_evidence', 'pm_finding_history']) {
    await sql(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`);
    await sql(`REVOKE ALL ON public.${t} FROM anon, authenticated;`);
    await sql(`DROP POLICY IF EXISTS ${t}_coach_all ON public.${t};`);
  }
  await sql(`GRANT SELECT, INSERT, UPDATE ON public.pm_runs, public.pm_findings, public.pm_evidence TO authenticated;`);
  await sql(`GRANT SELECT ON public.pm_finding_history TO authenticated;`);
  for (const t of ['pm_runs', 'pm_findings', 'pm_evidence', 'pm_finding_history']) {
    await sql(`CREATE POLICY ${t}_coach_all ON public.${t} FOR ALL TO authenticated USING (${IS_COACH}) WITH CHECK (${IS_COACH});`);
  }
  // History is written only by the trigger (SECURITY DEFINER); nobody edits it from the app.
  console.log('done');

  step('7. Check');
  console.log(JSON.stringify(await sql(`
    SELECT tablename, policyname, cmd FROM pg_policies WHERE schemaname='public' AND tablename LIKE 'pm_%' ORDER BY 1;
  `), null, 2));
})().catch(e => { console.error(e.message); process.exit(1); });
