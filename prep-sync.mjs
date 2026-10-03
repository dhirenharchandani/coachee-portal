// Pre-session prep sync — run daily by the `coachee-session-prep` scheduled task.
//
//   node prep-sync.mjs sync <events.json>   match calendar events to coachees, upsert
//                                           session_preps rows, print reminders due (JSON)
//   node prep-sync.mjs mark-sent <id> ...   record that reminders went out
//
// <events.json> is the Google Calendar list_events result ({ events: [...] }) covering
// at least the next 48 hours. A session = a non-cancelled, timed event with a coachee's
// email (primary or alias) among its non-declined attendees.
// Requires SUPABASE_ACCESS_TOKEN (read from .env next to this file if not set).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_REF = 'diiazuiyxxcecjnjmirt';
const COACH_EMAILS = ['dhirenharchandani@gmail.com', 'dhiren@myinnergame.com'];
const EXCLUDE_FOLDERS = []; // coachees who should never get prep reminders
const SYNC_WINDOW_H = 48;   // sessions this far ahead get a prep row
const REMIND_MIN_H = 2;     // remind for sessions starting between 2h ...
const REMIND_MAX_H = 36;    // ... and 36h from now (daily run = "the day before")

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

async function sync(eventsPath) {
  const raw = JSON.parse(readFileSync(eventsPath, 'utf8'));
  const events = Array.isArray(raw) ? raw : raw.events || [];
  const now = Date.now();
  const horizon = now + SYNC_WINDOW_H * 3600e3;

  const coachees = await sql(`SELECT id, folder, data->'profile'->>'preferredName' AS preferred,
    array[email] || coalesce(email_aliases, '{}') AS emails FROM public.coachees`);
  const byEmail = new Map();
  for (const c of coachees) {
    if (EXCLUDE_FOLDERS.includes(c.folder)) continue;
    for (const e of c.emails || []) {
      const k = (e || '').toLowerCase().trim();
      if (k && !COACH_EMAILS.includes(k)) byEmail.set(k, c);
    }
  }

  const sessions = [];
  const unmatched = [];
  for (const ev of events) {
    const start = ev.start?.dateTime;
    if (!start || ev.status === 'cancelled') continue;
    const t = new Date(start).getTime();
    if (t < now || t > horizon) continue;
    const attendees = (ev.attendees || []).filter(a => a.responseStatus !== 'declined');
    const hits = attendees.map(a => ({ a, c: byEmail.get((a.email || '').toLowerCase()) })).filter(h => h.c);
    if (!hits.length) {
      const external = attendees.filter(a => !a.self && !COACH_EMAILS.includes((a.email || '').toLowerCase()));
      if (external.length) unmatched.push({ title: ev.summary || '', starts_at: start, guests: external.length });
      continue;
    }
    // One prep row per event; if two coachee rows are on one invite, the first match owns it.
    const owner = hits[0].c;
    sessions.push({
      event_id: ev.id, coachee_id: owner.id, folder: owner.folder, starts_at: start, title: ev.summary || '',
      time_zone: ev.start?.timeZone || raw.timeZone || 'UTC',
      recipients: hits.filter(h => h.c.id === owner.id).map(h => ({
        email: h.a.email,
        firstName: (h.a.displayName || '').split(' ')[0] || owner.preferred || '',
      })),
    });
  }

  if (sessions.length) {
    const rows = JSON.stringify(sessions.map(s => ({ event_id: s.event_id, coachee_id: s.coachee_id, starts_at: s.starts_at, title: s.title })));
    await sql(`
      INSERT INTO public.session_preps (event_id, coachee_id, starts_at, title)
      SELECT event_id, coachee_id, starts_at, title
      FROM jsonb_to_recordset(${lit(rows)}::jsonb) AS x(event_id text, coachee_id uuid, starts_at timestamptz, title text)
      ON CONFLICT (event_id) DO UPDATE SET starts_at = EXCLUDED.starts_at, title = EXCLUDED.title, coachee_id = EXCLUDED.coachee_id;
    `);
  }

  // Sessions that vanished from the calendar (cancelled / moved out of the window) and were never prepped.
  const keep = sessions.length ? sessions.map(s => lit(s.event_id)).join(', ') : `''`;
  const removed = await sql(`
    DELETE FROM public.session_preps
    WHERE submitted_at IS NULL AND starts_at > now() AND starts_at <= now() + interval '${SYNC_WINDOW_H} hours'
      AND event_id NOT IN (${keep})
    RETURNING event_id;
  `);

  const ids = sessions.map(s => lit(s.event_id)).join(', ') || `''`;
  const due = await sql(`
    SELECT id, event_id FROM public.session_preps
    WHERE event_id IN (${ids}) AND reminded_at IS NULL AND submitted_at IS NULL
      AND starts_at BETWEEN now() + interval '${REMIND_MIN_H} hours' AND now() + interval '${REMIND_MAX_H} hours';
  `);
  const reminders = due.map(d => {
    const s = sessions.find(x => x.event_id === d.event_id);
    const day = new Date(s.starts_at).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: s.time_zone });
    return { id: d.id, folder: s.folder, title: s.title, starts_at: s.starts_at, day_label: day, recipients: s.recipients };
  });

  console.log(JSON.stringify({
    synced: sessions.map(s => ({ folder: s.folder, title: s.title, starts_at: s.starts_at })),
    removed: removed.length,
    unmatched_external_events: unmatched,
    reminders,
    prep_link: 'https://dashboard.myinnergame.com/#/prep',
  }, null, 2));
}

async function markSent(ids) {
  const clean = ids.filter(i => /^[0-9a-f-]{36}$/i.test(i));
  if (!clean.length) { console.error('No valid ids.'); process.exit(1); }
  const r = await sql(`UPDATE public.session_preps SET reminded_at = now() WHERE id IN (${clean.map(lit).join(', ')}) RETURNING id;`);
  console.log(`marked ${r.length} reminder(s) sent`);
}

const [cmd, ...args] = process.argv.slice(2);
(cmd === 'sync' && args[0] ? sync(args[0]) : cmd === 'mark-sent' ? markSent(args) : Promise.reject(new Error('usage: sync <events.json> | mark-sent <id>...')))
  .catch(e => { console.error(e.message); process.exit(1); });
