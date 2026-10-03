// Adds pre-session prep: public.session_preps, one row per upcoming calendar session.
// Rows are created by prep-sync.mjs (service access); clients can only read their own
// rows and fill in the three answer columns. The coach can read every row.
// Also extends coach_engagement() with next-session prep status.
// Idempotent — safe to re-run.
// Run: SUPABASE_ACCESS_TOKEN=<pat> node migrate-session-prep.mjs

const PROJECT_REF = 'diiazuiyxxcecjnjmirt';
const PAT = process.env.SUPABASE_ACCESS_TOKEN;
const COACH_EMAILS = `('dhirenharchandani@gmail.com', 'dhiren@myinnergame.com')`;
const OWNS_ROW = `EXISTS (
  SELECT 1 FROM public.coachees c
  WHERE c.id = session_preps.coachee_id
    AND (lower(c.email) = lower(auth.email())
         OR lower(auth.email()) IN (SELECT lower(unnest(c.email_aliases))))
)`;

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
  step('1. session_preps table');
  await sql(`
    CREATE TABLE IF NOT EXISTS public.session_preps (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      coachee_id UUID NOT NULL REFERENCES public.coachees(id) ON DELETE CASCADE,
      event_id TEXT NOT NULL UNIQUE,
      starts_at TIMESTAMPTZ NOT NULL,
      title TEXT,
      moved TEXT CHECK (char_length(moved) <= 4000),
      stuck TEXT CHECK (char_length(stuck) <= 4000),
      want TEXT CHECK (char_length(want) <= 4000),
      submitted_at TIMESTAMPTZ,
      reminded_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await sql(`CREATE INDEX IF NOT EXISTS session_preps_coachee_time ON public.session_preps (coachee_id, starts_at DESC);`);
  await sql(`ALTER TABLE public.session_preps ENABLE ROW LEVEL SECURITY;`);
  console.log('done');

  step('2. Grants: clients may only touch the answer columns');
  await sql(`REVOKE ALL ON public.session_preps FROM anon, authenticated;`);
  await sql(`GRANT SELECT ON public.session_preps TO authenticated;`);
  await sql(`GRANT UPDATE (moved, stuck, want, submitted_at) ON public.session_preps TO authenticated;`);
  console.log('done');

  step('3. Policies: read own (coach reads all via aliases), clients update own');
  await sql(`DROP POLICY IF EXISTS "prep_select_own" ON public.session_preps;`);
  await sql(`
    CREATE POLICY "prep_select_own" ON public.session_preps
    FOR SELECT TO authenticated
    USING (${OWNS_ROW} OR lower(auth.email()) IN ${COACH_EMAILS});
  `);
  await sql(`DROP POLICY IF EXISTS "prep_update_own" ON public.session_preps;`);
  await sql(`
    CREATE POLICY "prep_update_own" ON public.session_preps
    FOR UPDATE TO authenticated
    USING (${OWNS_ROW} AND lower(auth.email()) NOT IN ${COACH_EMAILS})
    WITH CHECK (${OWNS_ROW} AND lower(auth.email()) NOT IN ${COACH_EMAILS});
  `);
  console.log('done');

  step('4. coach_engagement() + next session prep status');
  await sql(`DROP FUNCTION IF EXISTS public.coach_engagement();`);
  await sql(`
    CREATE FUNCTION public.coach_engagement()
    RETURNS TABLE (
      coachee_id UUID, folder TEXT, name TEXT,
      last_sign_in TIMESTAMPTZ, last_session TIMESTAMPTZ, last_active TIMESTAMPTZ,
      opens_7d INT, opens_30d INT, actions_30d INT, top_section TEXT,
      next_session_at TIMESTAMPTZ, next_prep_done BOOLEAN, preps_done_90d INT, preps_total_90d INT
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
          GROUP BY 1 ORDER BY count(*) DESC LIMIT 1),
        nx.starts_at, nx.submitted_at IS NOT NULL,
        (SELECT count(*) FROM public.session_preps p
          WHERE p.coachee_id = c.id AND p.submitted_at IS NOT NULL AND p.starts_at > now() - interval '90 days')::int,
        (SELECT count(*) FROM public.session_preps p
          WHERE p.coachee_id = c.id AND p.starts_at > now() - interval '90 days' AND p.starts_at < now())::int
      FROM public.coachees c
      LEFT JOIN LATERAL (
        SELECT p.starts_at, p.submitted_at FROM public.session_preps p
        WHERE p.coachee_id = c.id AND p.starts_at > now() - interval '2 hours'
        ORDER BY p.starts_at LIMIT 1
      ) nx ON true
      WHERE lower(auth.email()) IN ${COACH_EMAILS}
      ORDER BY c.folder;
    $fn$;
  `);
  await sql(`REVOKE ALL ON FUNCTION public.coach_engagement() FROM PUBLIC, anon;`);
  await sql(`GRANT EXECUTE ON FUNCTION public.coach_engagement() TO authenticated;`);
  console.log('done');

  step('5. Verify');
  console.table(await sql(`SELECT policyname, cmd FROM pg_policies WHERE tablename = 'session_preps';`));
  console.table(await sql(`SELECT grantee, privilege_type, column_name FROM information_schema.column_privileges
    WHERE table_name = 'session_preps' AND grantee IN ('anon', 'authenticated') AND privilege_type = 'UPDATE' ORDER BY 1, 3;`));
})().catch(e => { console.error(e.message); process.exit(1); });
