// Adds client activity tracking: public.activity_events + coach-only summary function.
// Clients can INSERT their own events (never read them); only coach emails can SELECT.
// Idempotent — safe to re-run.
// Run: SUPABASE_ACCESS_TOKEN=<pat> node migrate-activity.mjs

const PROJECT_REF = 'diiazuiyxxcecjnjmirt';
const PAT = process.env.SUPABASE_ACCESS_TOKEN;
const COACH_EMAILS = `('dhirenharchandani@gmail.com', 'dhiren@myinnergame.com')`;

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

(async () => {
  step('1. activity_events table');
  await sql(`
    CREATE TABLE IF NOT EXISTS public.activity_events (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      coachee_id UUID NOT NULL REFERENCES public.coachees(id) ON DELETE CASCADE,
      actor_email TEXT NOT NULL DEFAULT lower(auth.email()),
      event TEXT NOT NULL CHECK (char_length(event) BETWEEN 1 AND 40),
      detail JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(detail) < 2048),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await sql(`CREATE INDEX IF NOT EXISTS activity_events_coachee_time ON public.activity_events (coachee_id, created_at DESC);`);
  await sql(`ALTER TABLE public.activity_events ENABLE ROW LEVEL SECURITY;`);
  console.log('done');

  step('2. Policies: client inserts own (non-coach), coach reads all');
  await sql(`DROP POLICY IF EXISTS "activity_insert_own" ON public.activity_events;`);
  await sql(`
    CREATE POLICY "activity_insert_own" ON public.activity_events
    FOR INSERT TO authenticated
    WITH CHECK (
      actor_email = lower(auth.email())
      AND lower(auth.email()) NOT IN ${COACH_EMAILS}
      AND EXISTS (
        SELECT 1 FROM public.coachees c
        WHERE c.id = activity_events.coachee_id
          AND (lower(c.email) = lower(auth.email())
               OR lower(auth.email()) IN (SELECT lower(unnest(c.email_aliases))))
      )
    );
  `);
  await sql(`DROP POLICY IF EXISTS "activity_coach_select" ON public.activity_events;`);
  await sql(`
    CREATE POLICY "activity_coach_select" ON public.activity_events
    FOR SELECT TO authenticated
    USING (lower(auth.email()) IN ${COACH_EMAILS});
  `);
  console.log('done');

  step('3. coach_engagement() summary function');
  await sql(`DROP FUNCTION IF EXISTS public.coach_engagement();`);
  await sql(`
    CREATE OR REPLACE FUNCTION public.coach_engagement()
    RETURNS TABLE (
      coachee_id UUID, folder TEXT, name TEXT,
      last_sign_in TIMESTAMPTZ, last_session TIMESTAMPTZ, last_active TIMESTAMPTZ,
      opens_7d INT, opens_30d INT, actions_30d INT, top_section TEXT
    )
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = public, auth
    AS $fn$
      SELECT
        c.id, c.folder, c.data->'profile'->>'name',
        (SELECT max(u.last_sign_in_at) FROM auth.users u
          WHERE lower(u.email) IN (SELECT lower(e) FROM unnest(array[c.email] || coalesce(c.email_aliases, '{}')) e)
            AND lower(u.email) NOT IN ${COACH_EMAILS}),
        -- Session token refreshes happen while the app is open, so they catch
        -- visits by clients who stay signed in (and predate activity_events).
        (SELECT max(coalesce(s.refreshed_at::timestamptz, s.updated_at)) FROM auth.sessions s JOIN auth.users u ON u.id = s.user_id
          WHERE lower(u.email) IN (SELECT lower(e) FROM unnest(array[c.email] || coalesce(c.email_aliases, '{}')) e)
            AND lower(u.email) NOT IN ${COACH_EMAILS}),
        (SELECT max(a.created_at) FROM public.activity_events a WHERE a.coachee_id = c.id),
        (SELECT count(*) FROM public.activity_events a
          WHERE a.coachee_id = c.id AND a.event = 'open' AND a.created_at > now() - interval '7 days')::int,
        (SELECT count(*) FROM public.activity_events a
          WHERE a.coachee_id = c.id AND a.event = 'open' AND a.created_at > now() - interval '30 days')::int,
        (SELECT count(*) FROM public.activity_events a
          WHERE a.coachee_id = c.id AND a.event NOT IN ('open', 'view') AND a.created_at > now() - interval '30 days')::int,
        (SELECT a.detail->>'section' FROM public.activity_events a
          WHERE a.coachee_id = c.id AND a.event = 'view' AND a.created_at > now() - interval '30 days'
          GROUP BY 1 ORDER BY count(*) DESC LIMIT 1)
      FROM public.coachees c
      WHERE lower(auth.email()) IN ${COACH_EMAILS}
      ORDER BY c.folder;
    $fn$;
  `);
  await sql(`REVOKE ALL ON FUNCTION public.coach_engagement() FROM PUBLIC, anon;`);
  await sql(`GRANT EXECUTE ON FUNCTION public.coach_engagement() TO authenticated;`);
  console.log('done');

  step('4. Verify');
  console.table(await sql(`SELECT policyname, cmd FROM pg_policies WHERE tablename = 'activity_events';`));
  console.table(await sql(`SELECT relrowsecurity FROM pg_class WHERE relname = 'activity_events' AND relnamespace = 'public'::regnamespace;`));
})().catch(e => { console.error(e.message); process.exit(1); });
