// Add Rayhan's May 6 2026 session to his coachees row.
// Read-first: prints current state + proposed diff. Pass --commit to write.
//
// Run inspect:  SUPABASE_ACCESS_TOKEN=<pat> node coachees/add-rayhan-may6-session.mjs
// Run commit:   SUPABASE_ACCESS_TOKEN=<pat> node coachees/add-rayhan-may6-session.mjs --commit

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PROJECT_REF = 'diiazuiyxxcecjnjmirt';
const PAT = process.env.SUPABASE_ACCESS_TOKEN;
const COMMIT = process.argv.includes('--commit');

if (!PAT) {
  console.error('SUPABASE_ACCESS_TOKEN env var is required.');
  console.error('Get one at https://supabase.com/dashboard/account/tokens — revoke after running.');
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

// Read the markdown summary from outputs/
const __dirname = dirname(fileURLToPath(import.meta.url));
const SUMMARY_MD_PATH = join(__dirname, '..', '..', 'Documents', 'Claude', 'CLAUDE-WORK', 'ABOUT ME', 'outputs', 'Rayhan_Session_Summary_May6_2026.md');
const summaryMd = readFileSync(SUMMARY_MD_PATH, 'utf8');

// New session payload — matches schema used by SessionDetailView
const newSession = {
  id: 'rayhan-2026-05-06',
  theme: 'The framework is the avoidance',
  title: 'SLIB is the KPI list with new clothes',
  displayDate: 'May 6, 2026',
  durationMin: 114,
  keyTakeaway: 'The diagnostic is the avoidance. The relationship redesigns itself once the operating model is clean.',
  recordingUrl: 'https://fathom.video/share/Sq3knAS5XzSo7FaspskyWXdpGcYGF62t',
  summaryMd,
};

// New action items — derived from the session's key direction
const newActionItems = [
  {
    id: 'rayhan-2026-05-06-a1',
    sessionId: 'rayhan-2026-05-06',
    text: 'Schedule two operating-model sessions with Harris this month — decision rights, the one mountain for the quarter, cadence, conflict protocol.',
    status: 'pending',
    category: 'partnership',
    notes: 'Structure first, measurement second. Do the KPI cut last, not first.',
  },
  {
    id: 'rayhan-2026-05-06-a2',
    sessionId: 'rayhan-2026-05-06',
    text: 'Sit with the Halima reflection this week — where does Halima live in you?',
    status: 'pending',
    category: 'inner-game',
    notes: 'Not a leadership lesson about her — a question about you. Walk with it; no answer required on a page.',
  },
  {
    id: 'rayhan-2026-05-06-a3',
    sessionId: 'rayhan-2026-05-06',
    text: 'Notice the framework reflex earlier next time — when uncertain, the hand reaches for a diagnostic.',
    status: 'pending',
    category: 'inner-game',
    notes: 'The watch story, the SLIB framework, the KPI list — same reflex. Knowing the reflex is the practice.',
  },
];

// New patterns surfaced this session — for the Patterns rail
const newPatterns = [
  { label: 'Reaches for a fresh framework when the work is to redesign the relationship.' },
];

// Verbatim quotes worth keeping on the Quotes rail
const newQuotes = [
  { text: 'Laziness is an identity. You’ve got to shift the identity.', attribution: 'Dhiren — May 6, 2026' },
  { text: 'The conversation is not about output, it’s about what’s really going on internally to get that shift.', attribution: 'Rayhan — May 6, 2026' },
];

// New growth edge — the operating-model gap
const newGrowthEdge = {
  title: 'No operating model with Harris yet',
  body: 'Harris is five months in as co-founder, not employee. There is no weekly cadence, no single quarter priority, no decision-rights map, no conflict protocol. KPIs and a SLIB diagnostic are not an operating model — they are substitutes.',
};

(async () => {
  console.log('--- 1. Locate Rayhan\'s row ---');
  const rows = await sql(`
    SELECT email, folder, data->'profile'->>'name' AS name
    FROM public.coachees
    WHERE LOWER(data->'profile'->>'name') LIKE 'rayhan%'
       OR LOWER(folder) = 'rayhan'
       OR LOWER(email) LIKE 'rayhan%';
  `);
  if (!Array.isArray(rows) || rows.length === 0) {
    console.error('No Rayhan row found. Available coachees:');
    console.table(await sql(`SELECT email, folder, data->'profile'->>'name' AS name FROM public.coachees ORDER BY folder;`));
    process.exit(1);
  }
  if (rows.length > 1) {
    console.error('Multiple matches — disambiguate before continuing:');
    console.table(rows);
    process.exit(1);
  }
  const { email, folder, name } = rows[0];
  console.log(`Found: ${name} (${email}, folder: ${folder})`);

  console.log('\n--- 2. Read current data ---');
  const [{ data }] = await sql(`SELECT data FROM public.coachees WHERE email = '${email.replace(/'/g, "''")}';`);

  const currentSessionCount = (data.sessions || []).length;
  const currentActionCount = (data.actionItems || []).length;
  const currentPatternCount = (data.patterns || []).length;
  const currentQuoteCount = (data.quotes || []).length;
  const currentGrowthEdgeCount = (data.growthEdges || []).length;

  console.log(`sessions: ${currentSessionCount} → ${currentSessionCount + 1}`);
  console.log(`actionItems: ${currentActionCount} → ${currentActionCount + newActionItems.length}`);
  console.log(`patterns: ${currentPatternCount} → ${currentPatternCount + newPatterns.length}`);
  console.log(`quotes: ${currentQuoteCount} → ${currentQuoteCount + newQuotes.length}`);
  console.log(`growthEdges: ${currentGrowthEdgeCount} → ${currentGrowthEdgeCount + 1}`);

  // Idempotency check
  const dupSession = (data.sessions || []).find(s => s.id === newSession.id);
  if (dupSession) {
    console.error(`\nSession id ${newSession.id} already exists. Aborting to avoid duplicate.`);
    console.error('If you want to replace, delete the existing row from data.sessions first.');
    process.exit(1);
  }

  // Build the new data
  const updated = {
    ...data,
    sessions: [...(data.sessions || []), newSession],
    actionItems: [...(data.actionItems || []), ...newActionItems],
    patterns: [...(data.patterns || []), ...newPatterns],
    quotes: [...(data.quotes || []), ...newQuotes],
    growthEdges: [...(data.growthEdges || []), newGrowthEdge],
    stats: {
      ...(data.stats || {}),
      sessions: ((data.stats?.sessions) || currentSessionCount) + 1,
      recapped: ((data.stats?.recapped) || 0) + 1,
    },
  };

  // If engagement.completed is tracked, increment it
  if (data.engagement && typeof data.engagement.completed === 'number') {
    updated.engagement = {
      ...data.engagement,
      completed: data.engagement.completed + 1,
      remaining: typeof data.engagement.remaining === 'number'
        ? Math.max(0, data.engagement.remaining - 1)
        : data.engagement.remaining,
    };
    console.log(`engagement.completed: ${data.engagement.completed} → ${updated.engagement.completed}`);
    if (typeof data.engagement.remaining === 'number') {
      console.log(`engagement.remaining: ${data.engagement.remaining} → ${updated.engagement.remaining}`);
    }
  }

  console.log('\n--- 3. New session preview ---');
  console.log(`id:           ${newSession.id}`);
  console.log(`theme:        ${newSession.theme}`);
  console.log(`title:        ${newSession.title}`);
  console.log(`displayDate:  ${newSession.displayDate}`);
  console.log(`durationMin:  ${newSession.durationMin}`);
  console.log(`keyTakeaway:  ${newSession.keyTakeaway}`);
  console.log(`summaryMd:    ${summaryMd.length} chars`);

  console.log('\n--- 4. New action items ---');
  newActionItems.forEach((a, i) => console.log(`${i + 1}. [${a.category}] ${a.text}`));

  if (!COMMIT) {
    console.log('\nDry run complete. Pass --commit to write.');
    return;
  }

  console.log('\n--- 5. Writing to Supabase ---');
  const jsonLiteral = JSON.stringify(updated).replace(/'/g, "''");
  await sql(`
    UPDATE public.coachees
    SET data = '${jsonLiteral}'::jsonb
    WHERE email = '${email.replace(/'/g, "''")}';
  `);
  console.log('Done.');

  console.log('\n--- 6. Verify ---');
  const [{ data: after }] = await sql(`SELECT data FROM public.coachees WHERE email = '${email.replace(/'/g, "''")}';`);
  console.log(`sessions count after: ${(after.sessions || []).length}`);
  console.log(`latest session id: ${(after.sessions || []).slice(-1)[0]?.id}`);
})().catch(err => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
