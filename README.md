# Žatecká Internet Check

Dashboard monitoring internet stability at the PFC office on Žatecká street, Prague.
Tracks two SD-WAN links reported by the FortiGate FGT-40 router via email.

**Live dashboard:** https://reports.itrinity.com/internal/zatecka-internet-check/ (Google sign-in; migrated 2026-07-13, the old `itrinity.pages.dev/zatecka-internet-check/` 302-redirects there)
**GitHub repo:** https://github.com/aftanasmichal/zatecka-internet-check

---

## Connections monitored

| Interface | Provider | Speed | Type | Cost | Role |
|-----------|----------|-------|------|------|------|
| `wan` | Internet Praha Josefov | 250/250 Mbps | Optical | 4 928 CZK/mo | Primary |
| `a` | O2 5G | 100/20 Mbps | 5G | 599 CZK/mo | Backup |

---

## How it works

```
FortiGate router (FGT-40)
  → sends email to fgt@palefire.com on every link up/down event
  → received at michal@palefire.com

Cloudflare Worker cron (every 6 h)
  → worker/index.js polls Gmail API for new FortiGate emails
  → uses KV-stored lastPollEpoch (epoch seconds) to narrow Gmail query (after:<epoch>)
  → fetches at most FETCH_CAP (30) message bodies per run, oldest first, to stay
    under Cloudflare's 50-subrequest/invocation free-plan limit; any backlog drains
    across successive polls (up to 30 events per 6 h run)
  → new events appended to data/events-001.json (deduplicated by eventtime)
  → if new data: committed to GitHub via Contents API
  → records lastPolledAt + advances lastPollEpoch in Cloudflare KV after success

Dashboard (https://reports.itrinity.com/internal/zatecka-internet-check/)
  → static HTML/JS served from the reports portal (Worker + private R2, Google sign-in)
  → fetches data/*.json directly from GitHub raw URLs (always current)
  → shows current status, uptime %, 7-day hourly timeline, 365-day daily timeline, incidents
  → timelines color each hour/day bucket by total downtime (0 s green, 1-30 s orange, 31 s+ red)
  → incidents: paginated (20/page), filterable by interface (All/WAN/5G)
  → "Check Now" button triggers immediate poll via same Worker (POST /)
  → "Last checked" timestamp pulled from Worker KV (GET /)

Monthly git history squash (.github/workflows/squash-history.yml)
  → runs 1st of each month, replaces all git history with single commit
  → prevents .git directory bloat from frequent data commits
```

---

## File structure

```
.github/workflows/poll.yml            GitHub Actions — workflow_dispatch only (emergency manual recovery)
.github/workflows/squash-history.yml  Monthly git history squash (1st of month, also manual trigger)
data/index.json              Lists all data files
data/events-001.json         Event log (rotates at 10 MB → events-002.json, etc.)
index.html                   Dashboard (single static file)
scripts/poll.py              Legacy: polls Gmail API, ingests new events (kept for emergency use)
scripts/ingest.py            Core parser: FortiGate HTML email → event dict
worker/index.js              Cloudflare Worker: cron poller + "Check Now" handler + KV status
worker/wrangler.toml         Worker deployment config (includes cron trigger + KV binding)
```

---

## Secrets & credentials

| Secret | Stored in | Used by |
|--------|-----------|---------|
| `GMAIL_CLIENT_ID` | Cloudflare Worker Secret | Worker — Gmail API auth |
| `GMAIL_CLIENT_SECRET` | Cloudflare Worker Secret | Worker — Gmail API auth |
| `GMAIL_REFRESH_TOKEN` | Cloudflare Worker Secret | Worker — Gmail API auth |
| `GITHUB_TOKEN` | Cloudflare Worker Secret | Worker — GitHub Contents API (read/write data files) |

GitHub Actions secrets (`GMAIL_*`, `CLOUDFLARE_API_TOKEN`) are no longer used by the cron but kept for emergency manual workflow_dispatch runs.

Local credential files (bootstrap only):
- `C:\Users\afink\.gmail-mcp\palefire\gcp-oauth.keys.json` — client_id + client_secret
- `C:\Users\afink\.gmail-mcp\palefire\credentials.json` — refresh_token

Gmail OAuth app: Google Cloud project `claude-gmail-490805`

GitHub token: fine-grained PAT `zatecka-internet-check`, no expiration, permission: Contents read+write.

---

## Data format

Each event in `data/events-*.json`:
```json
{
  "ts":    "2026-03-23T04:47:38+01:00",
  "iface": "a",
  "from":  "dead",
  "to":    "alive",
  "eid":   "1774237658842957320"
}
```

- `eid` = FortiGate `eventtime` nanosecond timestamp — used for deduplication
- `iface`: `wan` (main optical) or `a` (O2 5G backup)
- `from`/`to`: `alive` or `dead`

File rotation: when `events-001.json` hits 10 MB, a new `events-002.json` is created automatically by the Worker. `data/index.json` always lists all files; dashboard loads all of them.

---

## Deployment

### Cloudflare Worker (poller + "Check Now")
```bash
cd projects/work/zatecka-internet-check/worker
wrangler deploy
```

### Publishing the dashboard
Only needed when `index.html` changes — data updates go straight to GitHub and are fetched
client-side, so they never touch the portal.

The dashboard lives in the reports-portal repo at
`projects/work/itrinity_Reports_Portal/content/internal/zatecka-internet-check/index.html`.
There is no `wrangler pages deploy` since the 2026-07-13 migration: **the git push is the deploy.**
```bash
cd projects/work/itrinity_Reports_Portal
git add content/internal/zatecka-internet-check/index.html
git commit -m "chore(zatecka): dashboard update"
git push origin main   # CI syncs content/ to R2 (~2 min)
```

### Worker secrets (if re-setting up from scratch)
```bash
cd projects/work/zatecka-internet-check/worker

# Gmail credentials (from C:\Users\afink\.gmail-mcp\palefire\)
echo <client_id>     | wrangler secret put GMAIL_CLIENT_ID
echo <client_secret> | wrangler secret put GMAIL_CLIENT_SECRET
echo <refresh_token> | wrangler secret put GMAIL_REFRESH_TOKEN

# GitHub fine-grained PAT (Contents: read+write on zatecka-internet-check repo)
echo <token> | wrangler secret put GITHUB_TOKEN
```

### KV namespace
The `POLLER_STATE` KV namespace (id: `620ec9cab32e4efd8391c6704cd673e0`) stores:
- `lastPolledAt` — ISO timestamp of last successful poll
- `lastPollEpoch` — epoch seconds of the newest email processed, used to narrow Gmail queries (`after:<epoch>`). Migrated from the old day-resolution `lastEventDate`, which could deadlock the poller when a single day's flapping produced more emails than the 50-subrequest limit allowed fetching.

If re-creating: `wrangler kv namespace create POLLER_STATE` → update id in `wrangler.toml`.

---

## Costs

Everything is free:
- **Cloudflare Worker** — 100 000 req/day free (4 cron runs/day + manual triggers)
- **Cloudflare KV** — 1 000 writes/day free (~4-8 used: 1-2 writes per run, 4 runs/day), 100 000 reads/day free
- **Reports portal** (Worker + R2) — hosts the dashboard; no extra cost, it already serves the board reports
- **GitHub** — public repo, Contents API unlimited for authenticated requests
- **Gmail API** — free well within quota

Poll cadence is every 6 h (`0 */6 * * *`), set 2026-07-07. It was `*/5` (every 5 min) until then, but 288 cron runs/day each wrote 1-2 KV keys (`lastPolledAt`, `lastPollEpoch`), so 288-576 writes/day crossed Cloudflare's free-tier "50% of 1 000 writes/day" alert. At 6 h it writes ~4-8 keys/day. Trade-offs: dashboard data can lag up to 6 h, and a heavy flapping backlog drains slower (max 30 events per run), use the dashboard "Check Now" button to force an immediate poll.

---

## Maintenance notes

- **Gmail refresh token expires?** Unlikely (Google only expires tokens after 6 months of inactivity or consent revocation). If it does: re-run `gmail-mcp` auth for palefire account, update `GMAIL_REFRESH_TOKEN` Worker secret.
- **GitHub token expires?** Never — created with no expiration. If revoked: create new fine-grained PAT (`zatecka-internet-check` repo, Contents: read+write), run `echo <token> | wrangler secret put GITHUB_TOKEN` from `worker/` directory.
- **Worker cron not firing?** Check Worker logs in Cloudflare dashboard → Workers & Pages → zatecka-check-now → Observability. Also verify via `GET https://zatecka-check-now.michal-aftanas.workers.dev` — if `lastPolledAt` is stale, something is wrong. If a manual POST fails after ~9 s (not ~1 s), the poll is running but throwing mid-work; the most likely cause is exceeding the 50-subrequest free-plan limit on a large email backlog (see `FETCH_CAP` in `worker/index.js`).
- **Adding a new interface?** Add it to the `IFACES` object in `index.html` and redeploy Pages. FortiGate emails will be picked up automatically as long as the interface name matches.
- **Data file rotation?** Handled automatically by the Worker. Old files stay in the repo forever; `data/index.json` lists all of them and the dashboard loads all.
- **Emergency manual poll?** GitHub Actions → poll.yml → Run workflow. Or: `curl -X POST https://zatecka-check-now.michal-aftanas.workers.dev`.
