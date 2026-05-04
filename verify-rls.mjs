// Verifies the RESTRICTIVE folder-scope policy by simulating each coachee's auth context
// and confirming they can read their own folder but not anyone else's.
// Run: SUPABASE_ACCESS_TOKEN=<pat> node coachees/verify-rls.mjs

const PROJECT_REF = 'diiazuiyxxcecjnjmirt';
const PAT = process.env.SUPABASE_ACCESS_TOKEN;

if (!PAT) {
  console.error('SUPABASE_ACCESS_TOKEN env var is required.');
  console.error('Get one at https://supabase.com/dashboard/account/tokens');
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
  return JSON.parse(text);
}

async function readAs(email, folderProbe) {
  const claims = JSON.stringify({ email, role: 'authenticated' }).replace(/'/g, "''");
  const result = await sql(`
    BEGIN;
    SET LOCAL ROLE authenticated;
    SET LOCAL request.jwt.claims TO '${claims}';
    SELECT name FROM storage.objects
    WHERE bucket_id = 'resources' AND name LIKE '${folderProbe}/%'
    ORDER BY name;
    ROLLBACK;
  `);
  return Array.isArray(result) ? result.length : 0;
}

(async () => {
  const coachees = await sql(`SELECT email, folder FROM public.coachees ORDER BY folder, email;`);
  if (!Array.isArray(coachees) || coachees.length === 0) {
    console.error('No coachees found.');
    process.exit(1);
  }

  const folders = [...new Set(coachees.map(c => c.folder))];
  let pass = 0;
  let fail = 0;

  console.log(`Testing ${coachees.length} coachee(s) across ${folders.length} folder(s).\n`);

  for (const c of coachees) {
    for (const f of folders) {
      const count = await readAs(c.email, f);
      const isOwn = c.folder === f;
      const ok = isOwn ? count > 0 : count === 0;
      const tag = ok ? 'PASS' : 'FAIL';
      const expected = isOwn ? 'should see own files' : 'should see nothing';
      console.log(`[${tag}] ${c.email.padEnd(40)} -> ${f.padEnd(12)} (${count} rows, ${expected})`);
      ok ? pass++ : fail++;
    }
  }

  console.log(`\n${pass} pass, ${fail} fail`);
  if (fail > 0) {
    console.error('Cross-coachee isolation is not working. Review the storage policy.');
    process.exit(1);
  }
})().catch(err => { console.error('\nFAILED:', err.message); process.exit(1); });
