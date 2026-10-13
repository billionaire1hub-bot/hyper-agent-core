/** Domain model shared across storage, A2A protocol, workers and the API server. */

export type AgentStatus = "online" | "offline" | "unknown";

/** A peer discovered on the A2A network. */
export interface PeerAgent {
  id: string;
  name?: string;
  url: string;
  description?: string;
  skills?: string[];
  status: AgentStatus;
  /** Last successful handshake / heartbeat. */
  lastSeen: string;
  /** Negotiation completeness 0..1 learned from prior tasks. */
  reputation?: number;
  source: "registry" | "seed" | "inbound";
}

export type TaskStatus =
  | "discovered"
  | "negotiating"
  | "accepted"
  | "in_progress"
  | "completed"
  | "settled"
  | "rejected"
  | "failed";

export type PricingDecision = "accept" | "bargain" | "reject";

export interface TaskQuote {
  quoteId: string;
  taskId: string;
  peerId: string;
  peerUrl: string;
  title: string;
  description: string;
  /** What the requesting agent offers to pay, in USD. */
  offeredPayout: number;
  /** HyperAgent's own estimate of fair market value, in USD. */
  estimatedValue: number;
  /** HyperAgent's counter-offer / asking price in USD. */
  askingPrice: number;
  currency: string;
  round: number;
  decision: PricingDecision;
  rationale?: string;
  createdAt: string;
}

export interface Negotiation {
  id: string;
  taskId: string;
  peerId: string;
  peerUrl: string;
  title: string;
  description: string;
  status: "open" | "accepted" | "rejected" | "expired";
  round: number;
  offeredPayout: number;
  askingPrice: number;
  estimatedValue: number;
  history: Array<{
    round: number;
    actor: "peer" | "self";
    amount: number;
    note?: string;
    at: string;
  }>;
  createdAt: string;
  updatedAt: string;
}

export interface A2ATask {
  id: string;
  title: string;
  description: string;
  peerId: string;
  peerUrl: string;
  payout: number;
  currency: string;
  status: TaskStatus;
  negotiationId?: string;
  acceptedAt?: string;
  completedAt?: string;
  settledAt?: string;
  /** Whop identifier of the credit/payment once settled. */
  whopPaymentId?: string;
  result?: string;
  createdAt: string;
  updatedAt: string;
}

export type LedgerEntryType =
  | "credit"
  | "debit"
  | "payout"
  | "webhook_credit"
  | "webhook_debit"
  | "adjustment";

export interface LedgerEntry {
  id: string;
  agentId: string;
  type: LedgerEntryType;
  amount: number;
  currency: string;
  taskId?: string;
  whopPaymentId?: string;
  memo?: string;
  at: string;
}

export interface WalletBalance {
  /** Equal to agentId; present so it fits the generic collection key. */
  id: string;
  agentId: string;
  available: number;
  currency: string;
  updatedAt: string;
}

/** Whop webhook payload, normalized across event types. */
export interface WhopWebhookEvent {
  id?: string;
  type: string;
  createdAt?: string;
  data: Record<string, unknown>;
}
