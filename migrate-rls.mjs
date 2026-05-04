// Adds a RESTRICTIVE folder-scoped read policy to the resources bucket so coachees can't see each others' files.
// Run: SUPABASE_ACCESS_TOKEN=<pat> node coachees/migrate-rls.mjs
// Get a PAT at https://supabase.com/dashboard/account/tokens — revoke after running if not re-using soon.

const PROJECT_REF = 'diiazuiyxxcecjnjmirt';
const PAT = process.env.SUPABASE_ACCESS_TOKEN;

if (!PAT) {
  console.error('SUPABASE_ACCESS_TOKEN env var is required.');
  console.error('Get one at https://supabase.com/dashboard/account/tokens');
  console.error('Then: SUPABASE_ACCESS_TOKEN=<token> node coachees/migrate-rls.mjs');
  process.exit(1);
}

if (typeof fetch !== 'function') {
  console.error('Node 18+ required (uses built-in fetch). Your version:', process.version);
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
function show(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return console.log('(no rows)');
  console.table(rows);
}

(async () => {
  step('1. RLS enabled on coachees table?');
  show(await sql(`SELECT relname, relrowsecurity FROM pg_class WHERE relname = 'coachees' AND relnamespace = 'public'::regnamespace;`));

  step('2. Existing policies on coachees');
  show(await sql(`SELECT policyname, cmd, permissive, qual::text AS using_clause FROM pg_policies WHERE tablename = 'coachees' AND schemaname = 'public';`));

  step('3. Existing storage.objects policies');
  show(await sql(`SELECT policyname, cmd, permissive, roles, qual::text AS using_clause FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects';`));

  step('4. Coachees in the table');
  show(await sql(`SELECT email, (data->'profile'->>'name') AS name FROM public.coachees ORDER BY email;`));

  step('5. Adding folder column (idempotent)');
  await sql(`ALTER TABLE public.coachees ADD COLUMN IF NOT EXISTS folder TEXT;`);
  console.log('done');

  step('6. Backfilling folder where NULL (derived from profile.name)');
  await sql(`
    UPDATE public.coachees
    SET folder = LOWER(SPLIT_PART(data->'profile'->>'name', ' ', 1))
    WHERE folder IS NULL;
  `);
  show(await sql(`SELECT email, folder FROM public.coachees ORDER BY email;`));

  const nulls = await sql(`SELECT email FROM public.coachees WHERE folder IS NULL;`);
  if (Array.isArray(nulls) && nulls.length > 0) {
    console.error(`\nStopping: ${nulls.length} coachee(s) have no folder mapping.`);
    console.error('Update the CASE in step 6 to cover them, then re-run.');
    process.exit(1);
  }

  step('7. Locking folder NOT NULL');
  await sql(`ALTER TABLE public.coachees ALTER COLUMN folder SET NOT NULL;`);
  console.log('done');

  step('8. Installing RESTRICTIVE folder-scope policy on storage.objects');
  await sql(`DROP POLICY IF EXISTS "coachee_folder_restriction" ON storage.objects;`);
  await sql(`
    CREATE POLICY "coachee_folder_restriction"
    ON storage.objects
    AS RESTRICTIVE
    FOR SELECT
    TO authenticated
    USING (
      bucket_id <> 'resources'
      OR EXISTS (
        SELECT 1 FROM public.coachees c
        WHERE lower(c.email) = lower(auth.email())
          AND (storage.foldername(name))[1] = c.folder
      )
    );
  `);
  console.log('done');

  step('9. Final storage.objects policies');
  show(await sql(`SELECT policyname, cmd, permissive, qual::text AS using_clause FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' ORDER BY policyname;`));

  console.log('\nMigration complete.');
  console.log('\nManual verification — sign in as one coachee and try to read another\'s file:');
  console.log('  1. Open https://dashboard.myinnergame.com, sign in as Anshuman.');
  console.log('  2. DevTools console:');
  console.log(`     const r = await sb.storage.from('resources').createSignedUrl('philip/anything.pdf', 60); console.log(r);`);
  console.log('  3. Expect: { data: null, error: ... }   NOT a working signedUrl.');
})().catch(err => {
  console.error('\nMigration failed:', err.message);
  process.exit(1);
});
