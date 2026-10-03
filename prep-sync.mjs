// Pre-session prep sync — run every Sunday morning by the `coachee-session-prep` scheduled task.
// Reminders go out from Dhiren's own WhatsApp: each reminder carries a wa.me link
// with the message prefilled, which he taps and sends.
//
//   node prep-sync.mjs sync <events.json> [--dry-run]
//                                           match calendar events to coachees, upsert
//                                           session_preps rows, print reminders due (JSON);
//                                           --dry-run previews without writing anything
//   node prep-sync.mjs mark-sent <id> ...   record that reminders went out
//
// <events.json> is the Google Calendar list_events result ({ events: [...] }) covering
// at least the next 7 days. A session = a non-cancelled, timed event that either has a
// coachee's email (primary or alias) among its non-declined guests, or — when no guest
// matches — whose title contains that coachee's `title_match` (coachee_whatsapp).
// Bloom teams (channel 'group') get a team message for their WhatsApp group, and a
// fallback reminder on their `weekly_day` if no meeting of theirs is on the calendar.
// Requires SUPABASE_ACCESS_TOKEN (read from .env next to this file if not set).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_REF = 'diiazuiyxxcecjnjmirt';
const COACH_EMAILS = ['dhirenharchandani@gmail.com', 'dhiren@myinnergame.com'];
const COACH_DOMAINS = ['dhirenharchandani.com', 'bloomgrowthcoach.com', 'myinnergame.com'];
const COACH_TZ = 'Asia/Dubai';  // times in reminders, and schedule-based reminder dates
const EXCLUDE_FOLDERS = [];     // coachees who should never get prep reminders
const EXCLUDE_TITLE = /^\s*(prep|prepare|retainer)\b/i; // Dhiren's own prep/admin blocks
const NOT_CLIENTS = [/\bliya\b/i, /\bray x dhiren\b/i]; // look like sessions, aren't clients (per Dhiren)
const SYNC_WINDOW_H = 7 * 24;   // sessions this far ahead get a prep row
const REMIND_MIN_H = 2;         // remind for sessions starting between 2h ...
const REMIND_MAX_H = 7 * 24;    // ... and 7 days from now (weekly run = one list for the week)

const here = dirname(fileURLToPath(import.meta.url));
let PAT = process.env.SUPABASE_ACCESS_TOKEN;
if (!PAT) {
  try { PAT = readFileSync(join(here, '.env'), 'utf8').match(/^SUPABASE_ACCESS_TOKEN=(.+)$/m)?.[1]?.trim(); } catch {}
}
if (!PAT) { console.error('SUPABASE_ACCESS_TOKEN is required (env or .env).'); process.exit(1); }

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
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
const isCoachAddress = (e) => {
  const k = (e || '').toLowerCase();
  return COACH_EMAILS.includes(k) || COACH_DOMAINS.some(d => k.endsWith('@' + d));
};

// Keep this wording in sync with prepMessage() / teamPrepMessage() in index.html.
const PREP_LINK = 'https://dashboard.myinnergame.com/#/prep';
function prepMessage(firstName, when) {
  return `Hi ${firstName || 'there'}, looking forward to our session ${when}. ` +
    "Before we meet, take two minutes with three questions: what's moved, what's stuck, and what you most want from our time.\n\n" + PREP_LINK;
}
function bloomMeetingLabel(title) {
  if (/quarterly/i.test(title || '')) return 'Bloom quarterly session';
  if (/bloom day/i.test(title || '')) return 'Bloom Day';
  return 'Bloom weekly meeting';
}
function teamPrepMessage(title, when) {
  return `Team, our ${bloomMeetingLabel(title)} is ${when}. ` +
    'Before we meet, log in to your Bloom dashboard and update your scorecard, rocks, to-dos and issues, so we can spend our time on what matters.';
}

// "today" / "tomorrow" / "on Monday 5 October", judged in the event's time zone.
function whenPhrase(startsAt, timeZone) {
  const day = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone });
  const now = Date.now();
  if (day(startsAt) === day(now)) return 'today';
  if (day(startsAt) === day(now + 24 * 3600e3)) return 'tomorrow';
  return 'on ' + new Date(startsAt).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone });
}

// Next date (YYYY-MM-DD in COACH_TZ) falling on `weekday` (0=Sun), from tomorrow up to 7 days out.
function nextWeekday(weekday) {
  for (let i = 1; i <= 7; i++) {
    const d = new Date(Date.now() + i * 24 * 3600e3);
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: COACH_TZ, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(d);
    const get = (t) => parts.find(p => p.type === t).value;
    if (['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')) === weekday) return `${get('year')}-${get('month')}-${get('day')}`;
  }
  return null;
}

async function sync(eventsPath, dryRun) {
  const raw = JSON.parse(readFileSync(eventsPath, 'utf8'));
  const events = Array.isArray(raw) ? raw : raw.events || [];
  const now = Date.now();
  const horizon = now + SYNC_WINDOW_H * 3600e3;

  const coachees = (await sql(`SELECT c.id, c.folder, c.data->'profile'->>'name' AS name,
    c.data->'profile'->>'preferredName' AS preferred, c.data->'profile'->>'engagementMode' AS mode,
    w.phone, coalesce(w.channel, 'direct') AS channel, w.weekly_day, w.title_match,
    array[c.email] || coalesce(c.email_aliases, '{}') AS emails
    FROM public.coachees c LEFT JOIN public.coachee_whatsapp w ON w.coachee_id = c.id`))
    .filter(c => !EXCLUDE_FOLDERS.includes(c.folder));
  const byEmail = new Map(); // one email can belong to several dashboards (e.g. a person + their company)
  for (const c of coachees) {
    for (const e of c.emails || []) {
      const k = (e || '').toLowerCase().trim();
      if (!k || isCoachAddress(k)) continue;
      if (!byEmail.has(k)) byEmail.set(k, []);
      byEmail.get(k).push(c);
    }
  }
  const titleMatchers = coachees.filter(c => c.title_match)
    .sort((a, b) => b.title_match.length - a.title_match.length);

  const sessions = [];
  const unmatched = [];
  for (const ev of events) {
    const start = ev.start?.dateTime;
    const title = ev.summary || '';
    if (!start || ev.status === 'cancelled' || EXCLUDE_TITLE.test(title)) continue;
    const t = new Date(start).getTime();
    if (t < now || t > horizon) continue;
    const attendees = (ev.attendees || []).filter(a => a.responseStatus !== 'declined');
    const external = attendees.filter(a => !a.self && !isCoachAddress(a.email));

    // Score every dashboard with a guest on the invite. Most matching guests wins; ties go
    // to the team dashboard for group meetings and the personal one for 1:1s.
    const scores = new Map();
    for (const a of external) {
      for (const c of byEmail.get((a.email || '').toLowerCase()) || []) {
        scores.set(c.id, { c, n: (scores.get(c.id)?.n || 0) + 1 });
      }
    }
    const rank = ({ c, n }) => n * 10
      + (c.channel === 'group' && external.length >= 2 ? 5 : 0)
      + (c.mode === 'individual' && external.length <= 1 ? 5 : 0);
    let owner = [...scores.values()].sort((x, y) => rank(y) - rank(x))[0]?.c;
    if (!owner) owner = titleMatchers.find(c => title.toLowerCase().includes(c.title_match.toLowerCase()));
    if (!owner) {
      if (external.length && !NOT_CLIENTS.some(re => re.test(title))) unmatched.push({ title, starts_at: start, guests: external.length });
      continue;
    }
    sessions.push({
      event_id: ev.id, coachee: owner, starts_at: start, title, time_known: true,
      time_zone: COACH_TZ, // label every session in Dubai time, whatever zone it was created in
    });
  }

  // Bloom teams whose weekly meeting isn't on the calendar this week: remind from their schedule.
  for (const c of coachees.filter(c => c.channel === 'group' && c.weekly_day !== null)) {
    if (sessions.some(s => s.coachee.id === c.id)) continue;
    const date = nextWeekday(c.weekly_day);
    if (!date) continue;
    sessions.push({
      event_id: `weekly:${c.folder}:${date}`, coachee: c, starts_at: `${date}T09:00:00+04:00`,
      title: 'Bloom weekly meeting (from schedule)', time_known: false, time_zone: COACH_TZ,
    });
  }

  if (sessions.length && !dryRun) {
    const rows = JSON.stringify(sessions.map(s => ({
      event_id: s.event_id, coachee_id: s.coachee.id, starts_at: s.starts_at, title: s.title,
      kind: s.coachee.channel === 'group' ? 'team' : 'individual', time_known: s.time_known,
    })));
    await sql(`
      INSERT INTO public.session_preps (event_id, coachee_id, starts_at, title, kind, time_known)
      SELECT event_id, coachee_id, starts_at, title, kind, time_known
      FROM jsonb_to_recordset(${lit(rows)}::jsonb)
        AS x(event_id text, coachee_id uuid, starts_at timestamptz, title text, kind text, time_known boolean)
      ON CONFLICT (event_id) DO UPDATE SET starts_at = EXCLUDED.starts_at, title = EXCLUDED.title,
        coachee_id = EXCLUDED.coachee_id, kind = EXCLUDED.kind, time_known = EXCLUDED.time_known;
    `);
  }

  // Sessions that vanished from the calendar (cancelled / moved out of the window) and were never prepped.
  const keep = sessions.length ? sessions.map(s => lit(s.event_id)).join(', ') : `''`;
  const removed = dryRun ? [] : await sql(`
    DELETE FROM public.session_preps
    WHERE submitted_at IS NULL AND starts_at > now() AND starts_at <= now() + interval '${SYNC_WINDOW_H} hours'
      AND event_id NOT IN (${keep})
    RETURNING event_id;
  `);

  const ids = sessions.map(s => lit(s.event_id)).join(', ') || `''`;
  const due = dryRun ? await previewDue(sessions, ids) : await sql(`
    SELECT id, event_id FROM public.session_preps
    WHERE event_id IN (${ids}) AND reminded_at IS NULL AND submitted_at IS NULL
      AND starts_at BETWEEN now() + interval '${REMIND_MIN_H} hours' AND now() + interval '${REMIND_MAX_H} hours'
    ORDER BY starts_at;
  `);
  const reminders = due.map(d => {
    const s = sessions.find(x => x.event_id === d.event_id);
    const c = s.coachee;
    const team = c.channel === 'group';
    const fmt = (opts) => new Date(s.starts_at).toLocaleString('en-GB', { ...opts, timeZone: s.time_zone });
    const when = whenPhrase(s.starts_at, s.time_zone);
    const message = team ? teamPrepMessage(s.title, when) : prepMessage(c.preferred, when);
    const day = fmt({ weekday: 'short', day: 'numeric', month: 'short' });
    return {
      id: d.id, folder: c.folder, name: c.name || c.folder, title: s.title, starts_at: s.starts_at,
      kind: team ? 'team' : 'individual',
      when_label: s.time_known ? `${day}, ${fmt({ hour: '2-digit', minute: '2-digit' })}` : `${day} (from weekly schedule)`,
      whatsapp: team ? 'group' : c.phone || null, message,
      // A link without a number opens WhatsApp's chat picker, so Dhiren picks the team group.
      wa_link: team ? `https://wa.me/?text=${encodeURIComponent(message)}`
        : c.phone ? `https://wa.me/${c.phone.replace(/\D/g, '')}?text=${encodeURIComponent(message)}` : null,
    };
  });

  console.log(JSON.stringify({
    synced: sessions.map(s => ({ folder: s.coachee.folder, title: s.title, starts_at: s.starts_at })),
    removed: removed.length,
    unmatched_external_events: unmatched,
    reminders,
    engagement_page: 'https://dashboard.myinnergame.com/#/engagement',
  }, null, 2));
}

// Dry run: the reminders a real run would produce, without creating or deleting rows.
async function previewDue(sessions, ids) {
  const existing = await sql(`SELECT id, event_id, reminded_at, submitted_at FROM public.session_preps WHERE event_id IN (${ids});`);
  const lo = Date.now() + REMIND_MIN_H * 3600e3, hi = Date.now() + REMIND_MAX_H * 3600e3;
  return sessions
    .filter(s => { const t = new Date(s.starts_at).getTime(); return t >= lo && t <= hi; })
    .map(s => ({ s, row: existing.find(r => r.event_id === s.event_id) }))
    .filter(({ row }) => !row || (!row.reminded_at && !row.submitted_at))
    .sort((a, b) => new Date(a.s.starts_at) - new Date(b.s.starts_at))
    .map(({ s, row }) => ({ id: row?.id || '(dry-run)', event_id: s.event_id }));
}

async function markSent(ids) {
  const clean = ids.filter(i => /^[0-9a-f-]{36}$/i.test(i));
  if (!clean.length) { console.error('No valid ids.'); process.exit(1); }
  const r = await sql(`UPDATE public.session_preps SET reminded_at = now() WHERE id IN (${clean.map(lit).join(', ')}) RETURNING id;`);
  console.log(`marked ${r.length} reminder(s) sent`);
}

const [cmd, ...args] = process.argv.slice(2);
(cmd === 'sync' && args[0] ? sync(args[0], args.includes('--dry-run')) : cmd === 'mark-sent' ? markSent(args) : Promise.reject(new Error('usage: sync <events.json> | mark-sent <id>...')))
  .catch(e => { console.error(e.message); process.exit(1); });
