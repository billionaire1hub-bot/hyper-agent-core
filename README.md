# HyperAgent

An autonomous **Agent-to-Agent (A2A) network node**. HyperAgent discovers peers
globally, negotiates task pricing with an LLM, accepts work when the terms are
right, executes it, and settles earnings through Whop — continuously, with no
manual trigger.

## What it does

1. **Autonomous discovery & task acquisition** — a background loop polls A2A
   registries and seed peers 24/7, handshakes with every active agent, and polls
   them for open tasks.
2. **Dynamic pricing & bargaining** — every task is valued (Gemini, with a
   deterministic heuristic fallback). If the peer's offer is below threshold, an
   LLM bargaining subroutine negotiates a fair price before acceptance. Accepted
   tasks are executed and earnings are credited to the Whop balance.
3. **Whop integration** — signature-verified, idempotent webhook endpoint updates
   wallets in real time; the agent charges/pays out via the Whop API per task.
4. **24/7 readiness** — all workers start automatically on server boot. Nothing
   must be called to kick them off. Errors are retried with backoff and the
   process never exits on an unhandled error.

## Quick start

```bash
cp .env.example .env      # fill in GEMINI_API_KEY / WHOP_API_KEY as available
npm install
npm run build
npm start                 # workers start automatically
```

Or use the supervised 24/7 boot script (installs, builds, restarts on crash):

```bash
bash start.sh
```

Both Gemini and Whop are optional: without keys the node still runs, pricing
falls back to the deterministic heuristic, and settlement is recorded in the
internal ledger.

## Configuration

All settings are environment variables — see `.env.example` for the full list
with descriptions. The most important ones:

| Variable | Purpose |
|---|---|
| `AGENT_ID`, `AGENT_PUBLIC_URL` | Node identity and public URL for the Agent Card |
| `PORT`, `HOST` | HTTP bind address |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | LLM valuation + bargaining |
| `WHOP_API_KEY`, `WHOP_COMPANY_ID` | Whop balance/payment/payout API |
| `WHOP_WEBHOOK_SECRET` | HMAC secret for inbound webhook verification |
| `A2A_REGISTRY_URLS`, `A2A_SEED_PEERS` | Where to discover peers |
| `A2A_DISCOVERY_INTERVAL_MS` | Discovery/poll cadence |
| `MIN_TASK_PAYOUT`, `TASK_UNIT_RATE`, `TARGET_MARGIN_PCT` | Pricing thresholds |

## HTTP surface

| Method | Path | Description |
|---|---|---|
| GET | `/.well-known/agent-card.json` | A2A Agent Card (current well-known URI; also lists known peers) |
| GET | `/.well-known/agent.json` | A2A Agent Card (legacy URI, still served) |
| GET | `/a2a/tasks` | REST task board other agents poll for open work |
| POST | `/a2a` | A2A JSON-RPC: `SendMessage`/`message/send`, `GetTask`/`tasks/get`, `ListTasks`, `CancelTask`, `price.quote` |
| POST | `/api/whop/webhook` | Standard-Webhooks-verified Whop webhook |
| GET | `/api/admin/health` | Liveness |
| GET | `/api/admin/ready` | Readiness (503 until workers run) |
| GET | `/api/admin/status` | Workers, integrations, counters, balances |
| GET | `/api/admin/{peers,tasks,negotiations,wallet}` | Inspection |
| POST | `/api/admin/tasks` | Publish a task to this node's board (`{title, payout, description?}`) |

There is intentionally **no** endpoint that starts the workers — they start on boot.

## How the autonomous loop works

```
WorkerManager.start()  (called from index.ts on listen)
  ├─ discovery   -> pollRegistries + probeSeedPeers + handshake   (60s)
  ├─ acquisition -> pollPeerTasks -> acquireTask(price -> bargain -> accept)
  ├─ settlement  -> executeAndSettle(execute -> Whop transfer -> ledger credit)
  └─ heartbeat   -> mark stale peers offline
```

Mapped to the end-to-end acquisition pipeline, always on:

| Phase | What happens | Where |
|---|---|---|
| 1 Discovery | Poll registries + seed peers, probe Agent Cards | `discovery` loop |
| 2 Outreach & handshake | Real `SendMessage` handshake; poll `/a2a/tasks` | `discovery` + `acquisition` loops |
| 3 Evaluation & pricing | Gemini valuation (heuristic fallback) + balance check | `acquireTask` -> `evaluateOffer` |
| 4 Bargaining & settlement | LLM counter-offers over A2A, accept, execute, Whop settle | `acquireTask` -> `runBargain`, `settlement` loop |

Each loop is a `ResilientLoop`: errors are caught, logged and retried with capped
exponential backoff; the loop never stops. The process also survives
`uncaughtException` and `unhandledRejection` without exiting, and `start.sh` runs
it under PM2 (or a supervised restart loop) so a hard crash is recovered.

## Deploy to a free-tier host

The repo ships configs for the common platforms. All of them build both
workspaces with dev dependencies (TypeScript) present, then start the server —
which brings the autonomous workers up on boot. No env vars are required to
boot; every integration has a defensive default.

| Platform | File | Notes |
|---|---|---|
| Docker (any) | `Dockerfile` | Multi-stage; runtime image is production-only |
| Railway | `railway.json`, `nixpacks.toml` | Build + start + healthcheck |
| Render | `render.yaml` | Free web service with sane defaults |
| Vercel / others | `vercel.json` | Build command + dev-dep install |
| Heroku-style | `Procfile` | `web: node ...` |

Set `AGENT_PUBLIC_URL` (or let the platform's `RENDER_EXTERNAL_URL` /
`RAILWAY_PUBLIC_DOMAIN` / `FLY_APP_NAME` be detected) so peers can reach you, and
add real peers to `A2A_SEED_PEERS`/`A2A_REGISTRY_URLS`.

### What is real, and what needs your keys

- **Whop webhooks** are verified with the exact Standard Webhooks scheme Whop
  documents (`ws_` secret, base64 HMAC-SHA256 over `id.timestamp.body`, `v1,`
  signature, 5-minute tolerance) and are idempotent by event id. This works with
  no keys configured.
- **A2A handshake, discovery and task polling** are real HTTP + JSON-RPC calls
  against peers you list in `A2A_SEED_PEERS`/`A2A_REGISTRY_URLS`. Two nodes will
  discover and handshake each other with no configuration beyond the seed list.
- **Gemini** pricing and bargaining make real REST calls when `GEMINI_API_KEY` is
  set; without it the deterministic heuristic keeps the loop running.
- **Whop balance/transfer/payment** calls hit `https://api.whop.com/api/v1` when
  `WHOP_API_KEY` is set. Without it, settlement is recorded in the internal
  ledger only (clearly marked), so nothing pretends money moved when it did not.

### The task executor is a placeholder — wire in a real handler before earning

Everything in the acquire → price → bargain → accept path is real network I/O.
The one component that does **not** yet do real-world work is the executor:
`performTask()` in `lib/src/workers/pipeline.ts` returns a descriptive string
rather than performing the task. The node will still negotiate and settle, but
you must replace `performTask()` (or register real per-skill handlers) so a
`settled` task corresponds to work actually done. Until then, treat a
`settled` task as a completed *protocol* exchange, not a delivered real-world
result. This is the only simulated step in the pipeline and it is intentionally
isolated to one function.

## Tests

```bash
npm test          # builds, then runs both suites
```

- `tests/core.test.js` — signature verification (accept/reject/tamper/stale/
  rotation), pricing, offer evaluation, bargaining (including the unreachable
  peer aborting without a fabricated price), loop resilience, webhook idempotency.
- `tests/integration.test.js` — boots the real built server and drives it over
  HTTP: Agent Card on both paths, v1 + legacy JSON-RPC, `price.quote`, signed
  webhook credit + redelivery suppression, readiness, a **live two-node A2A
  federation** where one node discovers and handshakes the other, and a **full
  phases 1-4 pipeline** where a second node autonomously discovers a posted task,
  negotiates the price up, accepts, executes, credits its wallet and reports
  completion back to the poster.

## Security notes

- The Whop webhook verifies an HMAC-SHA256 signature over the **raw** request
  bytes using a constant-time comparison, rejects stale timestamps, and is
  idempotent by event id, so redeliveries cannot double-credit.
- Set `WHOP_WEBHOOK_REQUIRE_SIGNATURE=false` only for local development.
- Keep `.env` out of version control (already in `.gitignore`).
