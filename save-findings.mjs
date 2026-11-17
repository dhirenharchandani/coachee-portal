// Save person-model candidates (and a run record) for one coachee.
// Applies the run card's rejection gate, checks every quote against the stored
// transcript, works out who said it, and writes candidates. Never confirms anything.
//
// Usage:
//   SUPABASE_ACCESS_TOKEN=<pat> node save-findings.mjs <payload.json> [--dry]
//
// Payload:
// {
//   "coachee": "olivia-lab",            // coachees.folder the findings belong to
//   "sourceFolder": "olivia",           // session_transcripts.folder the quotes come from
//   "clientNames": ["Olivia", "Olivia Manner"],
//   "run": { "kind": "first_pass", "sessions_read": [...], "coverage_note": "...", "blind_notes": [...], "summary": "..." },
//   "findings": [ {
//       "statement", "client_headline", "client_question"?, "lens", "domains": [...], "type",
//       "pattern_sequence"?: [{ "step": "trigger|interpretation|response|feedback|consequence", "text", "basis": "observed|inferred|unknown" }],
//       "mechanism", "episodes", "counter_evidence", "alternative", "scope", "exceptions",
//       "confidence", "importance", "coach_framed", "client_undervalues", "works_against_aims",
//       "evidence": [ { "session_id", "quote", "class": "direct|self_report|inference", "is_counter"?, "episode"?, "note"? } ]
//   } ],
//   "updates": [ {                        // run card: new sessions update existing findings before creating new ones
//       "code": "F-007",                  // existing finding; 'candidate' ones are changed; confirmed / disputed ones only with --coach-approved
//       "reason": "...",                  // required; logged against every changed field in pm_finding_history
//       "set": { "episodes"?, "confidence"?, "counter_evidence"?, "scope"?, "exceptions"?, "statement"?, "mechanism"?,
//                "alternative"?, "client_headline"?, "client_question"?, "importance"?, "pattern_sequence"?, "domains"?,
//                "type"?, "lens"?,          // a finding set to type 'loop' needs a full five-step pattern_sequence
//                "client_undervalues"?, "coach_framed"?, "works_against_aims"? },   // booleans
//       "merge_into"?: "F-003",           // mark this finding merged into another (coach-approved only). Its evidence
//                                         // is NOT moved: add what the survivor needs to the survivor's own update
//       "evidence": [ same shape as above ],  // added to the finding; each quote checked word for word
//       "remove_evidence": [ { "session_id", "quote" } ]  // quotes taken off this finding (exact stored text); the
//                                         // removed quotes are named in the logged reason
//   } ]
// }

import { readFileSync } from 'node:fs';

const PROJECT_REF = 'diiazuiyxxcecjnjmirt';
const PAT = process.env.SUPABASE_ACCESS_TOKEN;
const COACH_NAMES = ['dhiren', 'dhiren p. harchandani', 'dhiren harchandani'];
const LOOP_STEPS = ['trigger', 'interpretation', 'response', 'feedback', 'consequence'];

const [file, ...flags] = process.argv.slice(2);
const DRY = flags.includes('--dry');
// Confirmed findings belong to the coach. They can only be updated when the coach approved the change in
// advance (they saw the proposal), signalled by this flag; the reason is logged as approved by the coach.
const COACH_APPROVED = flags.includes('--coach-approved');
if (!PAT) { console.error('SUPABASE_ACCESS_TOKEN env var is required.'); process.exit(1); }
if (!file) { console.error('Usage: node save-findings.mjs <payload.json> [--dry]'); process.exit(1); }

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
// Pass any JS value into SQL as a jsonb literal (only ' needs escaping in a standard string).
const J = (v) => `'${JSON.stringify(v ?? null).replace(/'/g, "''")}'::jsonb`;

const norm = (s) => String(s || '').replace(/\*/g, '').replace(/\s+/g, ' ').trim();
const lc = (s) => norm(s).toLowerCase();

// Split a transcript into utterances: { speaker, text }. Handles the three stored formats:
//   Fathom      "0:20 - Name (email)"  then indented lines
//   Paste       "- Name (6/29/26 5:29 PM): text"
//   Edited      "**Name:** text", "0:05 — Name: text", "**@0:00 · Name:** text", "**0:11 - Name:** text"
// Lines starting with ">" are editor / handling notes and are never quotable.
function utterances(md, clientNames) {
  const out = [];
  let cur = { speaker: 'unknown', text: '' };
  const push = () => { if (cur.text.trim()) out.push(cur); };
  const who = (name) => {
    const n = lc(name);
    if (COACH_NAMES.some(c => n === c || n.startsWith(c + ' '))) return 'coach';
    if (clientNames.some(c => n === lc(c))) return 'client';
    return 'unknown';
  };
  for (const line of md.split('\n')) {
    let m;
    if (/^\s*>/.test(line)) { if (cur.speaker !== 'note') { push(); cur = { speaker: 'note', text: '' }; } cur.text += '\n' + line.replace(/^\s*>\s?/, ''); continue; }
    if (/^#/.test(line)) { push(); cur = { speaker: 'unknown', text: '' }; continue; }
    if ((m = line.match(/^\d{1,2}:\d{2}(?::\d{2})? - (.+?)(?: \([^)]*\))?\s*$/))) { push(); cur = { speaker: who(m[1]), text: '' }; continue; }
    if ((m = line.match(/^- ([^():]{1,40}) \(\d{1,2}\/\d{1,2}\/\d{2,4}[^)]*\):\s?(.*)$/))) { push(); cur = { speaker: who(m[1]), text: m[2] }; continue; }
    // Inline turns: "**Name:** text", "0:05 — Name: text", "**@0:00 · Name:** text", "**0:11 - Name:** text"
    if ((m = line.match(/^\*{0,2}@?(?:\d{1,2}:\d{2}(?::\d{2})?\s*[—–·-]\s*)?([A-Z][A-Za-z .'-]{1,40}?):\*{0,2}\s?(.*)$/)) && who(m[1]) !== 'unknown') { push(); cur = { speaker: who(m[1]), text: m[2] }; continue; }
    if (cur.speaker === 'note' && line.trim() === '') { push(); cur = { speaker: 'unknown', text: '' }; continue; }
    cur.text += '\n' + line;
  }
  push();
  return out.map(u => ({ speaker: u.speaker, text: norm(u.text) }));
}

function locate(quote, utts) {
  const q = norm(quote);
  const hits = utts.filter(u => u.text.includes(q));
  if (hits.length === 0) return { error: 'not found inside a single utterance (quotes must not span speakers or include notes)' };
  const speakers = [...new Set(hits.map(h => h.speaker))];
  if (speakers.includes('note')) return { error: 'quote is from an editor / handling note, not the conversation' };
  return { speaker: speakers.length === 1 ? speakers[0] : 'unknown' };
}

function gate(f, transcripts, clientNames) {
  const reasons = [];
  const need = ['statement', 'client_headline', 'lens', 'type', 'confidence', 'importance'];
  for (const k of need) if (!f[k] || !String(f[k]).trim()) reasons.push(`missing ${k}`);
  if (!Array.isArray(f.domains) || f.domains.length === 0) reasons.push('missing domains');
  if (!f.alternative || !f.alternative.trim()) reasons.push('no alternative explanation');
  if (!f.counter_evidence || !f.counter_evidence.trim()) reasons.push('counter-evidence blank (use "None found after search")');
  if (f.type === 'loop') {
    const seq = f.pattern_sequence || [];
    const steps = seq.map(s => s.step);
    if (LOOP_STEPS.some(s => !steps.includes(s))) reasons.push('loop without all five steps');
    if (seq.some(s => !['observed', 'inferred', 'unknown'].includes(s.basis))) reasons.push('loop step not marked observed / inferred / unknown');
  }
  if (f.type === 'self_perception_gap' && !(f.evidence || []).some(e => e.class === 'self_report' || e.class === 'direct')) {
    reasons.push("blind spot without the client's own stated view on record");
  }
  const ev = [];
  for (const e of f.evidence || []) {
    const t = transcripts.get(e.session_id);
    if (!t) { reasons.push(`no stored transcript for session ${e.session_id}`); continue; }
    if (norm(e.quote).split(' ').length > 40) { reasons.push(`quote over 40 words in ${e.session_id}`); continue; }
    const loc = locate(e.quote, t.utts);
    if (loc.error) { reasons.push(`${e.session_id}: ${loc.error}: "${norm(e.quote).slice(0, 70)}"`); continue; }
    ev.push({ ...e, transcript_id: t.id, speaker: loc.speaker });
  }
  const support = ev.filter(e => !e.is_counter && e.speaker === 'client');
  if (support.length === 0) reasons.push("no supporting quote in the client's own words");
  return { reasons, evidence: ev };
}

(async () => {
  const p = JSON.parse(readFileSync(file, 'utf8'));
  const clientNames = p.clientNames || [];
  const [coachee] = await sql(`SELECT id FROM public.coachees WHERE folder = (${J([p.coachee])}->>0)`);
  if (!coachee) throw new Error(`No coachee row for folder='${p.coachee}'`);

  const rows = await sql(`SELECT id, session_id, transcript_md FROM public.session_transcripts WHERE folder = (${J([p.sourceFolder])}->>0)`);
  const transcripts = new Map(rows.map(r => [r.session_id, { id: r.id, utts: utterances(r.transcript_md, clientNames) }]));

  const results = { accepted: [], rejected: [] };
  const toSave = [];
  for (const f of p.findings || []) {
    const { reasons, evidence } = gate(f, transcripts, clientNames);
    if (reasons.length) results.rejected.push({ headline: f.client_headline, reasons });
    else toSave.push({ f, evidence });
  }

  // Updates to existing findings: same quote checks, but a finding the coach has already acted on is never touched.
  const UPDATABLE = ['episodes', 'confidence', 'counter_evidence', 'scope', 'exceptions', 'statement', 'mechanism', 'alternative',
    'client_headline', 'client_question', 'importance', 'pattern_sequence', 'domains', 'type', 'lens', 'client_undervalues', 'coach_framed', 'works_against_aims'];
  const BOOLS = ['client_undervalues', 'coach_framed', 'works_against_aims'];
  const TYPES = ['characteristic', 'strength', 'vulnerability', 'self_perception_gap', 'loop', 'connection', 'conflict', 'impact_on_others'];
  const existing = new Map((await sql(`SELECT id, code, status, type, pattern_sequence FROM public.pm_findings WHERE coachee_id = '${coachee.id}'`)).map(r => [r.code, r]));
  const allEvidence = await sql(`SELECT e.id, e.finding_id, e.session_id, e.quote FROM public.pm_evidence e JOIN public.pm_findings f ON f.id = e.finding_id WHERE f.coachee_id = '${coachee.id}'`);
  results.updated = []; results.update_rejected = [];
  const toUpdate = [];
  for (const u of p.updates || []) {
    const reasons = [];
    const row = existing.get(u.code);
    if (!row) reasons.push(`no finding ${u.code}`);
    else if (row.status !== 'candidate' && !(COACH_APPROVED && ['confirmed', 'disputed'].includes(row.status))) reasons.push(`${u.code} is ${row.status}; the coach owns it now (needs --coach-approved)`);
    if (!u.reason || !u.reason.trim()) reasons.push('missing reason');
    const bad = Object.keys(u.set || {}).filter(k => !UPDATABLE.includes(k));
    if (bad.length) reasons.push(`fields not updatable here: ${bad.join(', ')}`);
    if (u.set?.counter_evidence !== undefined && !String(u.set.counter_evidence).trim()) reasons.push('counter-evidence blank');
    if (u.set?.alternative !== undefined && !String(u.set.alternative).trim()) reasons.push('alternative blank');
    if (u.set?.type !== undefined && !TYPES.includes(u.set.type)) reasons.push(`unknown type ${u.set.type}`);
    if (u.set?.lens !== undefined && !['my_os', 'my_insights'].includes(u.set.lens)) reasons.push(`unknown lens ${u.set.lens}`);
    if (row && (u.set?.type ?? row.type) === 'loop') {
      const seq = u.set?.pattern_sequence ?? row.pattern_sequence ?? [];
      if (LOOP_STEPS.some(st => !seq.map(x => x.step).includes(st))) reasons.push('loop without all five steps');
    }
    for (const k of BOOLS) if (u.set?.[k] !== undefined && typeof u.set[k] !== 'boolean') reasons.push(`${k} must be true or false`);
    if (u.merge_into) {
      if (!COACH_APPROVED) reasons.push('merge_into needs --coach-approved');
      else if (!existing.get(u.merge_into) || u.merge_into === u.code) reasons.push(`merge_into: no other finding ${u.merge_into}`);
    }
    const removeIds = [];
    for (const r of u.remove_evidence || []) {
      const hit = row && allEvidence.find(e => e.finding_id === row.id && e.session_id === r.session_id && norm(e.quote) === norm(r.quote));
      if (!hit) reasons.push(`remove: no such quote on ${u.code} in ${r.session_id}: "${norm(r.quote).slice(0, 60)}"`);
      else removeIds.push(hit.id);
    }
    const ev = [];
    for (const e of u.evidence || []) {
      const t = transcripts.get(e.session_id);
      if (!t) { reasons.push(`no stored transcript for session ${e.session_id}`); continue; }
      if (norm(e.quote).split(' ').length > 40) { reasons.push(`quote over 40 words in ${e.session_id}`); continue; }
      const loc = locate(e.quote, t.utts);
      if (loc.error) { reasons.push(`${e.session_id}: ${loc.error}: "${norm(e.quote).slice(0, 70)}"`); continue; }
      if (!e.is_counter && loc.speaker !== 'client') { reasons.push(`${e.session_id}: supporting quote is not in the client's words (${loc.speaker}): "${norm(e.quote).slice(0, 50)}"`); continue; }
      ev.push({ ...e, transcript_id: t.id, speaker: loc.speaker });
    }
    if (reasons.length) results.update_rejected.push({ code: u.code, reasons });
    else toUpdate.push({ u, row, evidence: ev, removeIds });
  }

  if (DRY) {
    results.accepted = toSave.map(x => ({ headline: x.f.client_headline, quotes: x.evidence.map(e => `${e.session_id} [${e.speaker}] ${norm(e.quote).slice(0, 50)}`) }));
    results.updated = toUpdate.map(x => ({ code: x.u.code, set: Object.keys(x.u.set || {}), merge_into: x.u.merge_into, removes: x.removeIds.length, quotes: x.evidence.map(e => `${e.session_id} [${e.speaker}${e.is_counter ? ', counter' : ''}] ${norm(e.quote).slice(0, 50)}`) }));
    console.log(JSON.stringify({ dry: true, ...results }, null, 2));
    return;
  }

  let runId = null;
  if (p.run) {
    const [r] = await sql(`
      INSERT INTO public.pm_runs (coachee_id, kind, sessions_read, coverage_note, blind_notes, summary)
      SELECT '${coachee.id}', x->>'kind', ARRAY(SELECT jsonb_array_elements_text(coalesce(x->'sessions_read','[]'))),
             x->>'coverage_note', coalesce(x->'blind_notes','[]'), x->>'summary'
      FROM (SELECT ${J(p.run)} AS x) s RETURNING id`);
    runId = r.id;
  }

  const [{ n }] = await sql(`SELECT coalesce(max(substring(code from 3)::int), 0) AS n FROM public.pm_findings WHERE coachee_id = '${coachee.id}'`);
  let next = n + 1;
  for (const { f, evidence } of toSave) {
    const code = `F-${String(next++).padStart(3, '0')}`;
    const rec = { ...f, code, run_id: runId, last_change_reason: `Proposed by Claude (${p.run?.kind || 'manual'})` };
    const [ins] = await sql(`
      INSERT INTO public.pm_findings (coachee_id, code, run_id, statement, client_headline, client_question, lens, domains, type,
        pattern_sequence, mechanism, episodes, counter_evidence, alternative, scope, exceptions, confidence, importance,
        coach_framed, client_undervalues, works_against_aims, last_change_reason)
      SELECT '${coachee.id}', x->>'code', nullif(x->>'run_id','')::uuid, x->>'statement', x->>'client_headline', x->>'client_question',
        x->>'lens', ARRAY(SELECT jsonb_array_elements_text(x->'domains')), x->>'type',
        x->'pattern_sequence', x->>'mechanism', coalesce((x->>'episodes')::int, 0), x->>'counter_evidence', x->>'alternative',
        x->>'scope', x->>'exceptions', x->>'confidence', x->>'importance',
        coalesce((x->>'coach_framed')::boolean, false), coalesce((x->>'client_undervalues')::boolean, false),
        coalesce((x->>'works_against_aims')::boolean, false), x->>'last_change_reason'
      FROM (SELECT ${J(rec)} AS x) s RETURNING id`);
    for (const e of evidence) {
      await sql(`
        INSERT INTO public.pm_evidence (finding_id, transcript_id, session_id, speaker, quote, class, is_counter, episode, note)
        SELECT '${ins.id}', (x->>'transcript_id')::bigint, x->>'session_id', x->>'speaker', x->>'quote', x->>'class',
               coalesce((x->>'is_counter')::boolean, false), x->>'episode', x->>'note'
        FROM (SELECT ${J(e)} AS x) s`);
    }
    results.accepted.push({ code, headline: f.client_headline, quotes: evidence.length });
  }

  const insertEvidence = (findingId, e) => sql(`
    INSERT INTO public.pm_evidence (finding_id, transcript_id, session_id, speaker, quote, class, is_counter, episode, note)
    SELECT '${findingId}', (x->>'transcript_id')::bigint, x->>'session_id', x->>'speaker', x->>'quote', x->>'class',
           coalesce((x->>'is_counter')::boolean, false), x->>'episode', x->>'note'
    FROM (SELECT ${J(e)} AS x) s`);
  for (const { u, row, evidence, removeIds } of toUpdate) {
    const set = u.set || {};
    const cols = Object.keys(set).map(k => {
      if (k === 'episodes') return `episodes = (x->'set'->>'episodes')::int`;
      if (k === 'pattern_sequence') return `pattern_sequence = x->'set'->'pattern_sequence'`;
      if (k === 'domains') return `domains = ARRAY(SELECT jsonb_array_elements_text(x->'set'->'domains'))`;
      if (BOOLS.includes(k)) return `${k} = (x->'set'->>'${k}')::boolean`;
      return `${k} = x->'set'->>'${k}'`;
    });
    const removed = (u.remove_evidence || []).map(r => `${r.session_id} "${norm(r.quote).slice(0, 60)}"`);
    const why = removed.length ? `${u.reason} Removed quote(s): ${removed.join('; ')}.` : u.reason;
    const reason = row.status === 'candidate' ? `${why} (Claude, ${p.run?.kind || 'manual'})` : `${why} (approved by the coach; Claude, ${p.run?.kind || 'manual'})`;
    if (u.merge_into) cols.push(`status = 'merged'`, `merged_into = '${existing.get(u.merge_into).id}'`);
    await sql(`UPDATE public.pm_findings f SET ${[...cols, `last_change_reason = x->>'reason'`].join(', ')}
      FROM (SELECT ${J({ set, reason })} AS x) s WHERE f.id = '${row.id}' AND (f.status = 'candidate' OR (${COACH_APPROVED} AND f.status IN ('confirmed','disputed')))`);
    if (removeIds.length) await sql(`DELETE FROM public.pm_evidence WHERE finding_id = '${row.id}' AND id IN (${removeIds.map(i => `'${i}'`).join(', ')})`);
    for (const e of evidence) await insertEvidence(row.id, e);
    results.updated.push({ code: u.code, fields: Object.keys(set), quotes_added: evidence.length, quotes_removed: removeIds.length });
  }
  console.log(JSON.stringify({ run: runId, ...results }, null, 2));
})().catch(e => { console.error(e.message); process.exit(1); });
