# Coachee Portal

Master Your Inner Game — coaching dashboard for clients.

Live at **https://dashboard.myinnergame.com**

## Stack

- Single-file React app (`index.html`) — Tailwind + Babel via CDN
- **Supabase** — auth, database (RLS), storage
- **Resend** — magic-link email delivery
- **GitHub Pages** — static hosting

## Local development

Serve the directory with any static server:

```bash
python3 -m http.server 4173
# open http://localhost:4173
```

## Adding a new coachee

1. Build their data JSON locally
2. Insert into Supabase `coachees` table (`email`, `data` JSONB)
3. Upload any PDFs to Supabase Storage `resources` bucket under `<slug>/`
4. Reference the storage paths in their JSON `resources[].items[].storagePath`

## Deploy

Push to `main` — GitHub Pages auto-deploys.

```bash
git add . && git commit -m "Update" && git push
```
