// Extends prep reminders for Bloom teams and calendar events without guest emails.
//   coachee_whatsapp: + channel ('direct' = 1:1 number, 'group' = team WhatsApp group),
//                     + weekly_day (0=Sun..6=Sat; fallback when the week's meeting isn't on
//                       the calendar), + title_match (match events by title when the invite
//                       carries no client email). phone becomes optional for group teams.
//   session_preps:    + kind ('individual' | 'team'), + time_known (false for schedule fallbacks).
// Seeds the settings Dhiren gave on 2026-10-03. Idempotent — safe to re-run.
// Run: SUPABASE_ACCESS_TOKEN=<pat> node migrate-reminder-settings.mjs

const PROJECT_REF = 'diiazuiyxxcecjnjmirt';
const PAT = process.env.SUPABASE_ACCESS_TOKEN;

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
  step('1. coachee_whatsapp: channel, weekly_day, title_match');
  await sql(`ALTER TABLE public.coachee_whatsapp ALTER COLUMN phone DROP NOT NULL;`);
  await sql(`ALTER TABLE public.coachee_whatsapp ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'direct';`);
  await sql(`ALTER TABLE public.coachee_whatsapp ADD COLUMN IF NOT EXISTS weekly_day SMALLINT;`);
  await sql(`ALTER TABLE public.coachee_whatsapp ADD COLUMN IF NOT EXISTS title_match TEXT;`);
  await sql(`ALTER TABLE public.coachee_whatsapp DROP CONSTRAINT IF EXISTS coachee_whatsapp_channel_check;`);
  await sql(`ALTER TABLE public.coachee_whatsapp ADD CONSTRAINT coachee_whatsapp_channel_check CHECK (channel IN ('direct', 'group'));`);
  await sql(`ALTER TABLE public.coachee_whatsapp DROP CONSTRAINT IF EXISTS coachee_whatsapp_weekly_day_check;`);
  await sql(`ALTER TABLE public.coachee_whatsapp ADD CONSTRAINT coachee_whatsapp_weekly_day_check CHECK (weekly_day BETWEEN 0 AND 6);`);
  await sql(`ALTER TABLE public.coachee_whatsapp DROP CONSTRAINT IF EXISTS coachee_whatsapp_title_match_check;`);
  await sql(`ALTER TABLE public.coachee_whatsapp ADD CONSTRAINT coachee_whatsapp_title_match_check CHECK (char_length(title_match) BETWEEN 3 AND 80);`);
  console.log('done');

  step('2. session_preps: kind, time_known');
  await sql(`ALTER TABLE public.session_preps ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'individual';`);
  await sql(`ALTER TABLE public.session_preps ADD COLUMN IF NOT EXISTS time_known BOOLEAN NOT NULL DEFAULT true;`);
  await sql(`ALTER TABLE public.session_preps DROP CONSTRAINT IF EXISTS session_preps_kind_check;`);
  await sql(`ALTER TABLE public.session_preps ADD CONSTRAINT session_preps_kind_check CHECK (kind IN ('individual', 'team'));`);
  console.log('done');

  step('3. Seed settings (2026-10-03)');
  // Bloom teams with a WhatsApp group: weekly meeting weekday (0=Sun).
  // Caspaiou's weekly invite has no guests, so it is matched by title.
  // Fatma's invites carry no client email, so she is matched by name.
  await sql(`
    INSERT INTO public.coachee_whatsapp (coachee_id, channel, weekly_day, title_match)
    SELECT c.id, s.channel, s.weekly_day, s.title_match
    FROM (VALUES
      ('has',      'group',  1::smallint, NULL),
      ('caspaiou', 'group',  2::smallint, 'Caspaiou Bloom Weekly'),
      ('styletex', 'group',  3::smallint, NULL),
      ('tmb',      'group',  5::smallint, NULL),
      ('fatma',    'direct', NULL::smallint, 'Fatma')
    ) AS s(folder, channel, weekly_day, title_match)
    JOIN public.coachees c ON c.folder = s.folder
    ON CONFLICT (coachee_id) DO UPDATE
      SET channel = EXCLUDED.channel, weekly_day = EXCLUDED.weekly_day,
          title_match = EXCLUDED.title_match, updated_at = now();
  `);
  // A direct row may exist without a phone, to carry title_match (e.g. Fatma before her number is added).
  console.log('done');

  step('4. Nicki: add invite email nicky@daylightbureau.com as an alias');
  await sql(`
    UPDATE public.coachees
    SET email_aliases = array_append(coalesce(email_aliases, '{}'), 'nicky@daylightbureau.com')
    WHERE folder = 'nicky' AND NOT ('nicky@daylightbureau.com' = ANY(coalesce(email_aliases, '{}')));
  `);
  console.log('done');

  step('5. coach_engagement() + reminder channel');
  await sql(`DROP FUNCTION IF EXISTS public.coach_engagement();`);
  await sql(`
    CREATE FUNCTION public.coach_engagement()
    RETURNS TABLE (
      coachee_id UUID, folder TEXT, name TEXT, preferred_name TEXT, whatsapp TEXT, channel TEXT,
      last_sign_in TIMESTAMPTZ, last_session TIMESTAMPTZ, last_active TIMESTAMPTZ,
      opens_7d INT, opens_30d INT, actions_30d INT, top_section TEXT,
      next_session_at TIMESTAMPTZ, next_prep_done BOOLEAN, preps_done_90d INT, preps_total_90d INT
    )
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = public, auth
    AS $fn$
      SELECT
        c.id, c.folder, c.data->'profile'->>'name', c.data->'profile'->>'preferredName', w.phone, coalesce(w.channel, 'direct'),
        (SELECT max(u.last_sign_in_at) FROM auth.users u
          WHERE lower(u.email) IN (SELECT lower(e) FROM unnest(array[c.email] || coalesce(c.email_aliases, '{}')) e)
            AND lower(u.email) NOT IN ('dhirenharchandani@gmail.com', 'dhiren@myinnergame.com')),
        -- Session token refreshes happen while the app is open, so they catch
        -- visits by clients who stay signed in (and predate activity_events).
        (SELECT max(coalesce(s.refreshed_at::timestamptz, s.updated_at)) FROM auth.sessions s JOIN auth.users u ON u.id = s.user_id
          WHERE lower(u.email) IN (SELECT lower(e) FROM unnest(array[c.email] || coalesce(c.email_aliases, '{}')) e)
            AND lower(u.email) NOT IN ('dhirenharchandani@gmail.com', 'dhiren@myinnergame.com')),
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
          WHERE p.coachee_id = c.id AND p.kind = 'individual' AND p.submitted_at IS NOT NULL AND p.starts_at > now() - interval '90 days')::int,
        (SELECT count(*) FROM public.session_preps p
          WHERE p.coachee_id = c.id AND p.kind = 'individual' AND p.starts_at > now() - interval '90 days' AND p.starts_at < now())::int
      FROM public.coachees c
      LEFT JOIN public.coachee_whatsapp w ON w.coachee_id = c.id
      LEFT JOIN LATERAL (
        SELECT p.starts_at, p.submitted_at FROM public.session_preps p
        WHERE p.coachee_id = c.id AND p.starts_at > now() - interval '2 hours'
        ORDER BY p.starts_at LIMIT 1
      ) nx ON true
      WHERE lower(auth.email()) IN ('dhirenharchandani@gmail.com', 'dhiren@myinnergame.com')
      ORDER BY c.folder;
    $fn$;
  `);
  await sql(`REVOKE ALL ON FUNCTION public.coach_engagement() FROM PUBLIC, anon;`);
  await sql(`GRANT EXECUTE ON FUNCTION public.coach_engagement() TO authenticated;`);
  console.log('done');

  step('6. Verify');
  console.table(await sql(`SELECT c.folder, w.channel, w.weekly_day, w.title_match, w.phone IS NOT NULL AS has_phone
    FROM public.coachee_whatsapp w JOIN public.coachees c ON c.id = w.coachee_id ORDER BY 1;`));
  console.table(await sql(`SELECT folder, 'nicky@daylightbureau.com' = ANY(email_aliases) AS nicky_alias FROM public.coachees WHERE folder = 'nicky';`));
})().catch(e => { console.error(e.message); process.exit(1); });
