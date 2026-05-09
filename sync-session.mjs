// Append a coaching session (and optionally action items, patterns, quotes) to a coachee's Coachee Portal row.
// Designed to be called by Cowork after the Trello write step, with the session metadata + extracted body as JSON on stdin.
//
// Run:
//   echo '{"folder":"rayhan","date":"2026-05-06","summaryMd":"...","extract":true}' \
//     | SUPABASE_ACCESS_TOKEN=<pat> node coachees/sync-session.mjs
//
// Or via env:
//   SUPABASE_ACCESS_TOKEN=<pat> SESSION_JSON=$(cat session.json) node coachees/sync-session.mjs
//
// Get a PAT at https://supabase.com/dashboard/account/tokens — store as a secret in Cowork's env.

const PROJECT_REF = 'diiazuiyxxcecjnjmirt';
const PAT = process.env.SUPABASE_ACCESS_TOKEN;
if (!PAT) { console.error('SUPABASE_ACCESS_TOKEN required'); process.exit(1); }

// Read input — stdin or SESSION_JSON env var
let raw = process.env.SESSION_JSON;
if (!raw) {
  raw = await new Promise(resolve => {
    let s = ''; process.stdin.on('data', d => s += d); process.stdin.on('end', () => resolve(s));
  });
}
const input = JSON.parse(raw);

// Required: folder + summaryMd. Optional: date, title, theme, action items, patterns, quotes.
const {
  folder,                                         // 'rayhan' | 'ahmed' | etc.
  date = new Date().toISOString().slice(0, 10),   // YYYY-MM-DD, defaults to today UTC
  title,                                          // optional override; otherwise extracted
  theme,                                          // optional override
  durationMin = null,
  summaryMd,                                      // the markdown body — required
  keyTakeaway,                                    // optional override
  actionItems = [],                               // [{text, category, status}] — sessionId added automatically
  patterns = [],                                  // [{label, color}]
  quotes = [],                                    // [{text, attribution}] — sessionId added automatically
} = input;

if (!folder) { console.error('folder required'); process.exit(1); }
if (!summaryMd) { console.error('summaryMd required'); process.exit(1); }

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

// Derive title/theme/keyTakeaway from summary if not supplied
function inferTitle(md) {
  const m = md.match(/^#+\s+(.+)$/m); if (m) return m[1].trim();
  const first = md.split('\n').find(l => l.trim().length > 10);
  return first ? first.trim().slice(0, 80) : 'Coaching session';
}
function inferKeyTakeaway(md) {
  // First explicit Core Breakthrough or first quoted line under 200 chars
  const breakthrough = md.match(/(?:Core Breakthroughs?|Big Insights?)[\s\S]*?(?:^|\n)\s*(?:1\.|🔹|✳️)\s*(.+?)(?:\n|$)/);
  if (breakthrough) return breakthrough[1].trim().slice(0, 220);
  const quoted = md.match(/"([^"]{30,200})"/);
  if (quoted) return quoted[1];
  return '';
}
function inferQuarter(date) {
  const d = new Date(date + 'T00:00:00Z');
  return `q${Math.floor(d.getUTCMonth() / 3) + 1}-${String(d.getUTCFullYear()).slice(2)}`;
}
function displayDate(date) {
  const d = new Date(date + 'T00:00:00Z');
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

const finalTitle = title || inferTitle(summaryMd);
const finalTheme = theme || 'Coaching';
const finalKeyTakeaway = keyTakeaway || inferKeyTakeaway(summaryMd);

const session = {
  id: date,
  date,
  displayDate: displayDate(date),
  title: finalTitle,
  shortTitle: finalTitle.length > 50 ? finalTitle.slice(0, 47) + '…' : finalTitle,
  theme: finalTheme,
  quarter: inferQuarter(date),
  durationMin,
  summaryMd,
  keyTakeaway: finalKeyTakeaway,
  recordingUrl: null,
};

// Fetch the row, mutate, write back
const cur = await sql(`SELECT data FROM public.coachees WHERE folder='${folder}';`);
if (!cur.length) { console.error(`No coachee row for folder='${folder}'`); process.exit(1); }
const data = cur[0].data;

// 1. Sessions — replace any prior with same id, then sort
const sessions = (data.sessions || []).filter(s => s.id !== session.id).concat([session])
  .sort((a, b) => a.date.localeCompare(b.date));

// 2. Action items — assign IDs + sessionId, append
const existingActions = data.actionItems || [];
const startN = Math.max(0, ...existingActions.map(a => parseInt((a.id || '').replace(/[^0-9]/g, '')) || 0)) + 1;
const newActions = actionItems.map((a, i) => ({
  id: `ai-${String(startN + i).padStart(3, '0')}`,
  sessionId: session.id,
  category: a.category || 'general',
  status: a.status || 'pending',
  text: a.text,
}));

// 3. Patterns — append, dedupe by label
const existingPatterns = data.patterns || [];
const existingLabels = new Set(existingPatterns.map(p => p.label));
const newPatterns = patterns.filter(p => !existingLabels.has(p.label)).map(p => ({
  label: p.label,
  color: p.color || '#a78bfa',
}));

// 4. Quotes — append with sessionId
const existingQuotes = data.quotes || [];
const newQuotes = quotes.map(q => ({
  text: q.text,
  sessionId: session.id,
  attribution: q.attribution || `${data.profile?.preferredName || 'Coachee'} · ${displayDate(date)}`,
}));

// 5. Recompute stats
const recapped = sessions.filter(s => s.summaryMd && s.summaryMd.length > 200).length;
const dates = sessions.map(s => new Date(s.date + 'T00:00:00Z')).filter(d => !isNaN(d));
const minD = new Date(Math.min(...dates.map(d => d.getTime())));
const maxD = new Date(Math.max(...dates.map(d => d.getTime())));
const months = (maxD.getUTCFullYear() - minD.getUTCFullYear()) * 12 + (maxD.getUTCMonth() - minD.getUTCMonth()) + 1;
const quarterSet = new Set(sessions.map(s => s.quarter));
const stats = { ...(data.stats || {}), sessions: sessions.length, recapped: `${recapped}/${sessions.length}`, months, quarters: quarterSet.size };

// 6. Update engagement counters — subtract 1 from remaining, add 1 to completed
const engagement = data.engagement ? { ...data.engagement } : null;
if (engagement && typeof engagement.remaining === 'number' && engagement.remaining > 0) {
  engagement.remaining -= 1;
  engagement.completed = (engagement.completed || 0) + 1;
}

// 7. Update monthChart
const monthChart = (data.monthChart || []).slice();
const newMonthLabel = displayDate(date).match(/^(\w+)/)[1] + " '" + date.slice(2, 4);
const monthIdx = monthChart.findIndex(m => m.label === newMonthLabel || m.label === newMonthLabel.split(' ')[0]);
if (monthIdx >= 0) monthChart[monthIdx] = { ...monthChart[monthIdx], count: (monthChart[monthIdx].count || 0) + 1 };
else monthChart.push({ label: newMonthLabel, count: 1, color: '#34d399' });

const newData = {
  ...data,
  sessions,
  actionItems: [...existingActions, ...newActions],
  patterns: [...existingPatterns, ...newPatterns],
  quotes: [...existingQuotes, ...newQuotes],
  stats,
  monthChart,
  ...(engagement ? { engagement } : {}),
};

const lit = JSON.stringify(newData).replace(/'/g, "''");
await sql(`UPDATE public.coachees SET data='${lit}'::jsonb WHERE folder='${folder}';`);

console.log(JSON.stringify({
  folder,
  added: {
    session: session.id + ' — ' + session.title,
    actionItems: newActions.length,
    patterns: newPatterns.length,
    quotes: newQuotes.length,
  },
  totals: {
    sessions: sessions.length,
    actionItems: existingActions.length + newActions.length,
    patterns: existingPatterns.length + newPatterns.length,
    quotes: existingQuotes.length + newQuotes.length,
  },
}, null, 2));
