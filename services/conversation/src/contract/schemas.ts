/**
 * The contract with the gateway: types plus validators built from api/openapi.yaml, the single
 * source of truth (see api/README.md). Nothing here re-declares a schema: every outgoing request
 * is validated against the gateway's own JSON Schemas before it is sent, and every response and
 * event is checked on the way in.
 *
 * Outgoing payloads are validated strictly (a bad body never leaves this service). Incoming
 * payloads are validated leniently: drift is logged, and the service keeps going, because a
 * live demo shouldn't stop on a cosmetic contract difference.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse } from "yaml";

export const MERCHANT_CATEGORIES = ["airlines", "lodging", "ground_transport", "conferences", "meals", "software", "office_supplies", "other"] as const;
export type MerchantCategory = (typeof MERCHANT_CATEGORIES)[number];
export const CABIN_CLASSES = ["economy", "premium_economy", "business", "first"] as const;
export type CabinClass = (typeof CABIN_CLASSES)[number];
export const AGENT_KINDS = ["instinct", "muse", "claude", "chatgpt", "redteam"] as const;

export type Channel = "sms" | "email" | "mcp";

export interface Travel {
  cabin_class?: CabinClass;
  origin?: string;
  destination?: string;
  depart_date?: string;
  return_date?: string;
  nights?: number;
}

export interface TranscriptMessage {
  role: "employee" | "personal_agent" | "negotiator";
  text: string;
  ts?: string;
}

export interface Claims {
  meeting?: string;
  event?: string;
  date?: string;
  [key: string]: string | undefined;
}

export interface PurchaseRequest {
  request_id: string;
  parent_request_id?: string;
  agent_id: string;
  channel: Channel;
  employee_id: string;
  merchant: string;
  merchant_category: MerchantCategory;
  amount_usd: number;
  description: string;
  justification: string;
  travel?: Travel;
  claims?: Claims;
  transcript?: TranscriptMessage[];
}

export type DecisionStatus = "approved" | "counter" | "escalated" | "denied";

export interface PolicyTraceItem {
  rule: string;
  result: "pass" | "fail" | "skip";
  detail?: string;
}

export interface VerificationItem {
  check: string;
  result: "verified" | "unverified" | "failed";
  detail?: string;
}

export interface Counteroffer {
  merchant: string;
  merchant_category: MerchantCategory;
  amount_usd: number;
  description: string;
  travel?: Travel;
  reason: string;
}

export interface Escalation {
  escalation_id: string;
  request_id: string;
  approver_id: string;
  status: "open" | "approved" | "denied";
  reason?: string;
  opened_at: string;
  resolved_at?: string;
  note?: string;
}

export interface Card {
  card_id: string;
  mandate_id: string;
  last4: string;
  limit_usd: number;
  merchant_lock: MerchantCategory;
  expires_at: string;
  status: "active" | "suspended" | "closed";
}

export interface CardDetails extends Card {
  pan: string;
  cvc: string;
  exp_month: number;
  exp_year: number;
}

export interface Decision {
  request_id: string;
  status: DecisionStatus;
  reason: string;
  policy_trace: PolicyTraceItem[];
  verification: VerificationItem[];
  policy_version: string;
  decided_at: string;
  counteroffer: Counteroffer | null;
  escalation: Escalation | null;
  mandate_id: string | null;
  card: Card | null;
}

export interface EscalationResolution {
  action: "approve" | "deny";
  resolver_id: string;
  note?: string;
}

export interface Transaction {
  txn_id: string;
  card_id: string;
  mandate_id: string;
  request_id: string;
  merchant: string;
  merchant_category: MerchantCategory;
  amount_usd: number;
  settled_at: string;
  status: "settled" | "reconciled" | "mismatch";
  match?: { field: string; expected: string; actual: string; result: "match" | "mismatch" }[];
  coding?: { gl_account: string; department: string; memo: string };
}

/** Event names on GET /v1/events. */
export const GATEWAY_EVENT_TYPES = [
  "request.received",
  "claims.verified",
  "policy.decided",
  "escalation.opened",
  "escalation.resolved",
  "mandate.signed",
  "card.issued",
  "txn.settled",
  "txn.reconciled",
  "txn.mismatch",
  "card.suspended",
  "injection.blocked",
] as const;
export type GatewayEventType = (typeof GATEWAY_EVENT_TYPES)[number];

/** Events this service adds to the dashboard stream (never sent to the gateway). */
export const AGENT_EVENT_TYPES = ["agent.message.in", "agent.message.out", "agent.request.submitted", "agent.error"] as const;
export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

/** Normalized event used inside this service and on the dashboard stream. */
export interface GatewayEvent {
  id: string;
  type: GatewayEventType | AgentEventType | (string & {});
  ts: string;
  source: "gateway" | "agent";
  request_id?: string;
  data: Record<string, unknown>;
  /** True for gateway events from before this process started (history replayed on connect). */
  replayed?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Validators built from api/openapi.yaml

const here = dirname(fileURLToPath(import.meta.url));
/** services/conversation/src/contract -> repo root /api/openapi.yaml */
export const DEFAULT_CONTRACT_PATH = resolve(here, "../../../../api/openapi.yaml");

export type SchemaName =
  | "PurchaseRequest"
  | "Decision"
  | "EscalationResolution"
  | "CardDetails"
  | "Card"
  | "Event"
  | "Mandate"
  | "Error"
  | "AgentId"
  | "EmployeeId"
  | "Travel";

export class ContractError extends Error {
  constructor(
    readonly schema: SchemaName,
    readonly problems: string[],
  ) {
    super(`Payload doesn't match ${schema}: ${problems.join("; ")}`);
    this.name = "ContractError";
  }
}

export class Contract {
  readonly version: string;
  private readonly ajv: Ajv2020;
  private readonly cache = new Map<SchemaName, ValidateFunction>();

  constructor(readonly path: string = process.env.CONTRACT_PATH || DEFAULT_CONTRACT_PATH) {
    if (!existsSync(path)) throw new Error(`Contract not found at ${path}. Set CONTRACT_PATH to the repo's api/openapi.yaml.`);
    const doc = parse(readFileSync(path, "utf8")) as { info?: { version?: string } };
    this.version = doc.info?.version ?? "unknown";
    this.ajv = new Ajv2020({ strict: false, allErrors: true });
    (addFormats as unknown as (a: Ajv2020) => void)(this.ajv);
    this.ajv.addSchema(doc as object, "contract");
  }

  private validator(name: SchemaName): ValidateFunction {
    let v = this.cache.get(name);
    if (!v) {
      v = this.ajv.getSchema(`contract#/components/schemas/${name}`);
      if (!v) throw new Error(`Schema ${name} isn't in the contract`);
      this.cache.set(name, v);
    }
    return v;
  }

  /** Problems as readable strings; empty when valid. */
  errors(name: SchemaName, value: unknown): string[] {
    const v = this.validator(name);
    if (v(value)) return [];
    return (v.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}${e.params && "additionalProperty" in e.params ? ` (${String(e.params.additionalProperty)})` : ""}`);
  }

  assert<T>(name: SchemaName, value: T): T {
    const problems = this.errors(name, value);
    if (problems.length) throw new ContractError(name, problems);
    return value;
  }
}

let shared: Contract | undefined;
/** The contract loaded once per process. */
export function contract(): Contract {
  shared ??= new Contract();
  return shared;
}
