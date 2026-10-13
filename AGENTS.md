# AGENTS.md — HyperAgent

Persistent repository memory. Read this before working in this repo.

## What this is
HyperAgent is an autonomous Agent-to-Agent (A2A) network node. It discovers peers
globally, negotiates task pricing with an LLM, accepts work when terms are met,
executes it, and settles earnings through Whop — all continuously and without a
manual trigger.

## Layout
```
package.json            npm workspaces root; scripts: build, typecheck, start, test, dev
tsconfig.base.json      shared strict TS config
start.sh                24/7 boot script (installs, builds, supervises, runs)
Dockerfile / .dockerignore   container build (multi-stage, prod-only runtime)
railway.json / nixpacks.toml / render.yaml / Procfile / vercel.json  host configs
.env.example            every environment variable, documented
lib/                    shared domain library (hyperagent-lib)
  src/config.ts         env-driven configuration (single source of truth)
  src/logger.ts         JSON structured logger (never throws)
  src/retry.ts          sleep / backoff / withRetry / fetchWithTimeout
  src/types.ts          domain model (PeerAgent, A2ATask, Negotiation, ...)
  src/storage/          JSON-file collections + wallet/ledger service
  src/agent/gemini.ts   Gemini REST client with model fallback chain
  src/agent/pricing*.ts valuation: Gemini first, deterministic heuristic fallback
  src/agent/bargaining.ts negotiation subroutine (LLM + convergence guardrails)
  src/agent/whop.ts     Whop API v1 client (account balance, transfers, payments)
  src/agent/whopWebhook.ts  Standard Webhooks HMAC verification (base64, v1)
  src/agent/whopEvents.ts   idempotent webhook -> wallet processing
  src/a2a/protocol.ts   Agent Card, JSON-RPC, handshake, SendMessage/message-send
  src/a2a/discovery.ts  registry polling + seed peers + peer task polling
  src/workers/          ResilientLoop, task pipeline, WorkerManager
artifacts/api-server/   HTTP surface (hyperagent-api-server)
  src/app.ts            express app; raw body for webhook, JSON elsewhere
  src/routes/a2a.ts     agent-card (+ legacy) + GET /a2a/tasks board + POST /a2a JSON-RPC
  src/routes/whop.ts    POST /api/whop/webhook (Standard Webhooks verified)
  src/routes/admin.ts   /api/admin/{health,ready,status,peers,tasks,wallet}
  src/index.ts          entrypoint: listen + auto-start workers + crash guards
ecosystem.config.js     PM2 process definition (autorestart, backoff)
tests/core.test.js      deterministic unit tests
tests/integration.test.js  real HTTP server + two-node federation tests
```

## Commands
- `npm install` — install workspace deps
- `npm run build` — compile lib then api-server (tsc, strict)
- `npm test` — build + run the unit and integration suites
- `npm start` — run the built server (workers start automatically)
- `bash start.sh` — full 24/7 boot path (install + build + PM2/supervisor)

## Architecture invariants (do not break these)
- **A2A is always on.** `config.a2a.enabled` and `config.workers.startOnBoot` are
  `true` constants, not env toggles. There is no flag that can disable discovery
  or the workers. `A2A_SEED_PEERS` defaults to localhost peers so discovery is
  never inert, and the Agent Card also lists known peers so a node self-registers
  to re-hydrate after a restart.
- **Zero manual trigger.** Workers start inside `index.ts` on `listen()`. Do not
  add an HTTP endpoint that must be called to start the loops.
- **Never crash.** `ResilientLoop` catches every iteration error and retries with
  capped exponential backoff. `index.ts` installs `uncaughtException` /
  `unhandledRejection` guards that log instead of exiting. `start.sh` adds a
  process manager (PM2 when available, else a supervised restart loop).
- **No fabricated counterparties.** Negotiation only accepts a price a real peer
  replied with. `PeerReply` has an explicit `unreachable` kind; the pipeline
  never invents a counter-offer or midpoint. Settlement only credits after the
  task is actually completed.
- **Real signatures.** The Whop webhook verifies the Standard Webhooks scheme:
  base64 HMAC-SHA256 over `{webhook-id}.{webhook-timestamp}.{raw body}`, key =
  base64-decoded secret after stripping the `ws_`/`whsec_` prefix, constant-time
  compare, `v1,` version tag, space-delimited rotation list, and a 5-minute
  timestamp tolerance. The raw bytes are captured before JSON parsing.
- **Graceful degradation.** Gemini and Whop are optional. Missing `GEMINI_API_KEY`
  falls back to the deterministic pricing heuristic; missing `WHOP_API_KEY` runs
  ledger-only. The autonomous loop must run with neither configured.
- **Storage is a shared singleton.** API server and workers use the same `store`,
  so writes are visible immediately. Files are written atomically (tmp + rename).

## Verified external API facts (from the live OpenAPI + docs)
- Whop REST base URL is `https://api.whop.com/api/v1` (NOT `/api/v5` — that path
  404s silently, which is how a deployment ends up with a permanently zero
  balance). Override via `WHOP_BASE_URL`.
- Verified Whop endpoints: `GET /accounts/{biz_id}` (balance in the `total_usd`
  string field, else sum `balances[].breakdown.available`), `POST /transfers`
  (`type:"balance"`, `origin_id`, `destination_id`, `amount`, `currency`,
  optional `idempotence_key`), `POST /payments` (`account_id` required).
- Whop webhooks use the Standard Webhooks scheme with a `ws_` secret: base64
  HMAC-SHA256 over `{webhook-id}.{webhook-timestamp}.{raw body}`, header value
  `v1,<base64>`, 5-minute replay tolerance. Cross-checked byte-for-byte against
  the reference implementation.
- A2A v1 method is `SendMessage`; card at `/.well-known/agent-card.json` (legacy
  `message/send` and `/.well-known/agent.json` still served for compatibility).

## Task lifecycle
`discovered -> negotiating -> accepted -> in_progress -> completed -> settled`
(`rejected` / `failed` are terminal). `acquireTask` does discovery→negotiation→
accept; `executeAndSettle` does execution→Whop payment→ledger credit.

## Known placeholder (not real yet)
`performTask()` in `lib/src/workers/pipeline.ts` returns a descriptive string
instead of doing real work. Replace it (or add a handler registry) before the
node is expected to earn for delivered real-world results. Everything else in the
pipeline is real network I/O; this is the only non-real step.

## Conventions
- Strict TypeScript, no `any` (use `unknown` + narrow).
- Comments explain *why*, not *what*. No change-history narration.
- Env vars are read only in `lib/src/config.ts`.
- Keep the deterministic fallback path working — tests exercise it.

## Gotchas
- npm workspace is addressed by path (`--workspace=artifacts/api-server`), not by
  package name, in the root build script.
- `WalletBalance` carries an `id` equal to `agentId` to satisfy the generic
  collection key constraint.
