# Cowork Prompt Extension — Sync Session to Coachee Portal

Append this section to your existing Fathom → Trello Cowork prompt. It runs **after** the Trello write step.

---

## After writing to Trello, also sync to the Coachee Portal dashboard

The Coachee Portal is a per-client dashboard at `dashboard.myinnergame.com` that mirrors Trello content. After you've added the session summary to Trello, also add it to the coachee's row in Supabase so it appears on their dashboard.

### Step 1 — Extract structured data from the session summary

Build a JSON object with these fields:

```json
{
  "folder": "rayhan",
  "date": "2026-05-06",
  "summaryMd": "<the full markdown body you wrote to Trello>",
  "title": "<short evocative session title — usually the central theme phrase>",
  "theme": "<one-to-three-word coaching theme>",
  "keyTakeaway": "<one-line essence — usually the strongest Core Breakthrough or quoted insight>",
  "actionItems": [
    { "text": "<the commitment, written as a directive>", "category": "leadership", "status": "pending" }
  ],
  "patterns": [
    { "label": "<pattern name in coach voice>", "color": "#a78bfa" }
  ],
  "quotes": [
    { "text": "<verbatim line from the coachee or coach>", "attribution": "Rayhan · May 2026" }
  ]
}
```

**Folder mapping** (use lowercase first name):

| Coachee | folder |
|---|---|
| Anshuman Marodia | `anshuman` |
| Philip Mark George Smith | `philip` |
| Rayhan Aleem | `rayhan` |
| Lucky Gangwal (personal) | `lucky` |
| Vardhman Global team | `vardhman` |
| James Mistry | `james` |
| Ahmed Al-Akber | `ahmed` |

**Action item categories:** `leadership`, `personal`, `cashflow`, `strategy`, `systems`, `hiring`, `marketing`, `general`

**Pattern colors** (rotate for visual variety): `#a78bfa` violet · `#fbbf24` amber · `#f87171` rose · `#60a5fa` blue · `#34d399` emerald

### Step 2 — Call the sync script

The script lives in the coachee-portal repo. It handles ID assignment, deduplication, sessionId linking, and stats recomputation.

```sh
echo '<the JSON from Step 1>' | SUPABASE_ACCESS_TOKEN=$SUPABASE_ACCESS_TOKEN node coachees/sync-session.mjs
```

The Supabase access token must be set as a Cowork environment secret. Get one at https://supabase.com/dashboard/account/tokens (account-level, scoped to all projects this user owns). Store as `SUPABASE_ACCESS_TOKEN`.

### Step 3 — Confirm in your output

The script prints a JSON summary like:

```json
{
  "folder": "rayhan",
  "added": {
    "session": "2026-05-06 — Fine for now: the decision underneath",
    "actionItems": 2,
    "patterns": 3,
    "quotes": 1
  },
  "totals": { "sessions": 6, "actionItems": 23, "patterns": 10, "quotes": 7 }
}
```

Confirm to the user with: *"Synced to dashboard.myinnergame.com — N sessions, X new action items, Y patterns, Z quotes."*

### Voice rules for extraction

When extracting action items, patterns, and quotes from the session summary, follow Dhiren's coaching voice:

- **No exclamation marks**
- **Hold the frame** — don't soften with hedges like "could you" or "maybe try"
- **Direct, second-person** for action items: *"Reframe the next Harris conversation around identity, not KPIs"* (not *"You should consider reframing..."*)
- **Pattern labels in coach voice** — name the loop, not the symptom: *"Fine for now loop"* not *"He says fine for now"*
- **Quotes verbatim** — don't paraphrase. If it's not a direct quote, don't add it.

### Idempotency

The script uses the date as the session ID. If you re-run with the same `folder` + `date`, it replaces the prior session entry but appends new action items / patterns / quotes. To avoid duplicate action items on re-runs, either don't include them on re-runs, or include the same items (de-dupe by `text` doesn't happen automatically yet).

### Failure mode

If the script returns a non-zero exit code, capture stderr and pass back to the user. Common issues:
- `SUPABASE_ACCESS_TOKEN required` — env var not set
- `No coachee row for folder='X'` — typo in folder name
- `HTTP 4xx/5xx` — Supabase API error, check token validity at the dashboard

---

## Where this script lives

`https://github.com/dhirenharchandani/coachee-portal/blob/main/sync-session.mjs`

Pull it fresh each Cowork run, or vendor it into your Cowork environment.
