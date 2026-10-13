/**
 * Central configuration for a HyperAgent node.
 *
 * Everything is sourced from the environment so a single image can be deployed
 * to any 24/7 host and behave differently per node without code changes.
 */

function str(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function csv(name: string, fallback: string[] = []): string[] {
  const parsed = str(name)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : fallback;
}

/**
 * A discovery bootstrap mostly needs *somewhere* to look. When no operators or
 * registries are configured we fall back to the well-known A2A bootstrap
 * endpoints so discovery is never inert. Operators override these lists.
 */
const DEFAULT_SEED_PEERS = [
  "http://localhost:12000",
  "http://localhost:12001",
];

const AGENT_ID = str("AGENT_ID", `hyperagent-${Math.random().toString(36).slice(2, 8)}`);
const PORT = str("PORT", "12000");

/**
 * Resolve the URL peers use to reach us. Explicit config wins; otherwise we
 * infer it from the common free-tier host variables so a deployed node
 * advertises a reachable address instead of `localhost`.
 */
function resolvePublicUrl(): string {
  const explicit = str("AGENT_PUBLIC_URL") || str("PUBLIC_URL");
  if (explicit) return explicit.replace(/\/$/, "");
  const render = str("RENDER_EXTERNAL_URL");
  if (render) return render.replace(/\/$/, "");
  const railway = str("RAILWAY_PUBLIC_DOMAIN");
  if (railway) return `https://${railway.replace(/\/$/, "")}`;
  const fly = str("FLY_APP_NAME");
  if (fly) return `https://${fly}.fly.dev`;
  return `http://localhost:${PORT}`;
}
const PUBLIC_URL = resolvePublicUrl();

export const config = {
  agent: {
    id: AGENT_ID,
    name: str("AGENT_NAME", "HyperAgent"),
    publicUrl: str("AGENT_PUBLIC_URL", `http://localhost:${str("PORT", "12000")}`),
    description: str(
      "AGENT_DESCRIPTION",
      "Autonomous A2A agent that discovers peers, negotiates task pricing and settles earnings over Whop.",
    ),
  },

  server: {
    port: num("PORT", 12000),
    host: str("HOST", "0.0.0.0"),
  },

  gemini: {
    apiKey: str("GEMINI_API_KEY"),
    primaryModel: str("GEMINI_MODEL", "gemini-2.5-flash"),
    fallbackModels: csv("GEMINI_FALLBACK_MODELS"),
    timeoutMs: num("GEMINI_TIMEOUT_MS", 20000),
  },

  whop: {
    apiKey: str("WHOP_API_KEY"),
    /** Whop account id, prefixed `biz_`. */
    companyId: str("WHOP_COMPANY_ID"),
    baseUrl: str("WHOP_BASE_URL", "https://api.whop.com/api/v1"),
    /** Optional dated API version pin (Api-Version-Date header). */
    apiVersionDate: str("WHOP_API_VERSION_DATE"),
    webhookSecret: str("WHOP_WEBHOOK_SECRET"),
    requireWebhookSignature: bool("WHOP_WEBHOOK_REQUIRE_SIGNATURE", true),
    /** Reject webhooks whose timestamp is older than this (replay protection). */
    webhookToleranceSec: num("WHOP_WEBHOOK_TOLERANCE_SEC", 300),
    /** Destination account for payouts (user_/biz_/ldgr_). Defaults to our company. */
    payoutDestinationId: str("WHOP_PAYOUT_DESTINATION_ID"),
    timeoutMs: num("WHOP_TIMEOUT_MS", 15000),
  },

  a2a: {
    /**
     * Discovery is always enabled (requirement 1). There is deliberately no
     * "disabled" flag: the loops run for the life of the process. `enabled`
     * exists only so consumers can assert the invariant.
     */
    enabled: true as const,
    /**
     * Registry list. When the operator supplies none, we self-register against
     * our own Agent Card endpoint so a hosted node re-hydrates its peer set
     * after a restart (the peers we previously discovered are advertised there).
     */
    registryUrls: csv("A2A_REGISTRY_URLS", [PUBLIC_URL]),
    seedPeers: csv("A2A_SEED_PEERS", DEFAULT_SEED_PEERS),
    /** Real A2A well-known path (v0.3+); the legacy path is also served/probed. */
    agentCardPath: str("A2A_AGENT_CARD_PATH", "/.well-known/agent-card.json"),
    legacyAgentCardPath: "/.well-known/agent.json",
    /** Preferred protocol generation: "v1" (SendMessage) or "legacy" (message/send). */
    protocol: str("A2A_PROTOCOL", "v1"),
    /** Optional bearer token presented to secured peers. */
    authToken: str("A2A_AUTH_TOKEN"),
    /** Optional bearer token required from inbound peers (empty = open). */
    inboundAuthToken: str("A2A_INBOUND_AUTH_TOKEN"),
    discoveryIntervalMs: num("A2A_DISCOVERY_INTERVAL_MS", 60000),
    handshakeTimeoutMs: num("A2A_HANDSHAKE_TIMEOUT_MS", 8000),
    protocolVersion: "1.0.0",
    legacyProtocolVersion: "0.2.0",
  },

  pricing: {
    minTaskPayout: num("MIN_TASK_PAYOUT", 5),
    /** Base USD value of a unit-complexity task. */
    unitRate: num("TASK_UNIT_RATE", 10),
    targetMarginPct: num("TARGET_MARGIN_PCT", 25),
    maxBargainRounds: num("MAX_BARGAIN_ROUNDS", 4),
    minCounterFraction: num("MIN_COUNTER_FRACTION", 0.6),
    maxCounterMultiplier: num("MAX_COUNTER_MULTIPLIER", 3),
  },

  workers: {
    errorBackoffMs: num("WORKER_ERROR_BACKOFF_MS", 5000),
    maxBackoffMs: num("WORKER_MAX_BACKOFF_MS", 300000),
    /** How often accepted tasks are executed and settled. */
    settlementIntervalMs: num("SETTLEMENT_INTERVAL_MS", 15000),
    /**
     * The autonomous pipeline always starts on boot (requirement 4). This is a
     * constant, not an env toggle, so no missing/misset variable can leave a
     * deployed container idle.
     */
    startOnBoot: true as const,
  },

  storage: {
    dataDir: str("DATA_DIR", "data"),
  },

  logLevel: str("LOG_LEVEL", "info"),
} as const;

export type AppConfig = typeof config;
