// Adds coach-only WhatsApp numbers for prep reminders: public.coachee_whatsapp.
// Only the coach can read or write numbers (entered on the Engagement page);
// prep-sync.mjs reads them with service access. Extends coach_engagement()
// with preferred_name + whatsapp so the Engagement page can build wa.me links.
// Idempotent — safe to re-run.
// Run: SUPABASE_ACCESS_TOKEN=<pat> node migrate-whatsapp.mjs

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
  step('1. coachee_whatsapp table (coach-only)');
  await sql(`
    CREATE TABLE IF NOT EXISTS public.coachee_whatsapp (
      coachee_id UUID PRIMARY KEY REFERENCES public.coachees(id) ON DELETE CASCADE,
      phone TEXT NOT NULL CHECK (phone ~ '^\\+[1-9][0-9]{6,14}$'),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await sql(`ALTER TABLE public.coachee_whatsapp ENABLE ROW LEVEL SECURITY;`);
  await sql(`REVOKE ALL ON public.coachee_whatsapp FROM anon, authenticated;`);
  await sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.coachee_whatsapp TO authenticated;`);
  await sql(`DROP POLICY IF EXISTS "whatsapp_coach_all" ON public.coachee_whatsapp;`);
  await sql(`
    CREATE POLICY "whatsapp_coach_all" ON public.coachee_whatsapp
    FOR ALL TO authenticated
    USING (lower(auth.email()) IN ${COACH_EMAILS})
    WITH CHECK (lower(auth.email()) IN ${COACH_EMAILS});
  `);
  console.log('done');

  step('2. coach_engagement() + preferred_name, whatsapp');
  await sql(`DROP FUNCTION IF EXISTS public.coach_engagement();`);
  await sql(`
    CREATE FUNCTION public.coach_engagement()
    RETURNS TABLE (
      coachee_id UUID, folder TEXT, name TEXT, preferred_name TEXT, whatsapp TEXT,
      last_sign_in TIMESTAMPTZ, last_session TIMESTAMPTZ, last_active TIMESTAMPTZ,
      opens_7d INT, opens_30d INT, actions_30d INT, top_section TEXT,
      next_session_at TIMESTAMPTZ, next_prep_done BOOLEAN, preps_done_90d INT, preps_total_90d INT
    )
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = public, auth
    AS $fn$
      SELECT
        c.id, c.folder, c.data->'profile'->>'name', c.data->'profile'->>'preferredName', w.phone,
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
      LEFT JOIN public.coachee_whatsapp w ON w.coachee_id = c.id
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

  step('3. Verify');
  console.table(await sql(`SELECT policyname, cmd FROM pg_policies WHERE tablename = 'coachee_whatsapp';`));
})().catch(e => { console.error(e.message); process.exit(1); });
