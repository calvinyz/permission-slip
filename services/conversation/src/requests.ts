/**
 * Shared request service used by the negotiator (SMS and email) and the MCP server, so both
 * channels build, record and submit requests identically.
 */
import { maskCardNumbers } from "./negotiator/render.ts";
import { createHash, randomBytes } from "node:crypto";
import type { CardDetails, Decision, MerchantCategory, PurchaseRequest, TranscriptMessage } from "./contract/schemas.ts";
import type { EventBus } from "./bus.ts";
import type { EnrolledAgent } from "./enrollment.ts";
import type { Logger } from "./logger.ts";
import type { GatewayApi } from "./gateway/client.ts";
import type { StateStore } from "./state.ts";
import type { SubmitInput } from "./negotiator/brain.ts";

export class NotYourRequestError extends Error {
  constructor(requestId: string) {
    super(`Request ${requestId} doesn't belong to this agent.`);
    this.name = "NotYourRequestError";
  }
}

export function newRequestId(): string {
  return `req_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
}

type DecisionListener = (request: PurchaseRequest, decision: Decision) => void;

/**
 * MCP clients may retry a tool call; an identical request from the same MCP agent within this
 * window returns the first result instead of creating a second request and card. SMS and email
 * are excluded: Twilio retries are already deduplicated by MessageSid, and a person repeating a
 * request on purpose should get a new decision.
 */
const DUPLICATE_WINDOW_MS = 30_000;

export class RequestService {
  private readonly listeners: DecisionListener[] = [];
  private readonly recent = new Map<string, { at: number; result: Promise<{ request: PurchaseRequest; decision: Decision }> }>();

  constructor(
    private readonly deps: { gateway: GatewayApi; state: StateStore; bus: EventBus; log: Logger },
  ) {}

  /** Called after every decision from POST /v1/requests (e.g. to post escalations to Slack). */
  onDecision(listener: DecisionListener): void {
    this.listeners.push(listener);
  }

  /** Builds a contract-shaped PurchaseRequest. Optional fields are omitted when empty (schemas are closed). */
  build(agent: EnrolledAgent, input: SubmitInput, transcript: TranscriptMessage[]): PurchaseRequest {
    const claims = Object.fromEntries(Object.entries(input.claims ?? {}).filter(([, v]) => typeof v === "string" && v.trim() !== ""));
    const travel = input.travel ? Object.fromEntries(Object.entries(input.travel).filter(([, v]) => v !== undefined && v !== "")) : undefined;
    return {
      request_id: newRequestId(),
      ...(input.parent_request_id ? { parent_request_id: input.parent_request_id } : {}),
      agent_id: agent.agent_id,
      channel: agent.channel,
      employee_id: agent.employee.employee_id,
      merchant: input.merchant,
      merchant_category: input.merchant_category as MerchantCategory,
      amount_usd: Math.round(input.amount_usd * 100) / 100,
      description: input.description,
      justification: input.justification,
      ...(travel && Object.keys(travel).length ? { travel } : {}),
      ...(Object.keys(claims).length ? { claims } : {}),
      ...(transcript.length ? { transcript: transcript.slice(-30).map((t) => ({ ...t, text: maskCardNumbers(t.text.length > 4000 ? `${t.text.slice(0, 3990)}…` : t.text) })) } : {}),
    };
  }

  submit(agent: EnrolledAgent, input: SubmitInput, transcript: TranscriptMessage[]): Promise<{ request: PurchaseRequest; decision: Decision }> {
    if (agent.channel !== "mcp") return this.submitNow(agent, input, transcript);
    const key = createHash("sha1").update(`${agent.agent_id}|${JSON.stringify(input)}`).digest("hex");
    const now = Date.now();
    for (const [k, v] of this.recent) if (now - v.at > DUPLICATE_WINDOW_MS) this.recent.delete(k);
    const hit = this.recent.get(key);
    if (hit) {
      this.deps.log.info("requests: duplicate MCP submit within 30 s, returning the first result", { agent_id: agent.agent_id });
      return hit.result;
    }
    const result = this.submitNow(agent, input, transcript);
    this.recent.set(key, { at: now, result });
    result.catch(() => this.recent.delete(key));
    return result;
  }

  private async submitNow(agent: EnrolledAgent, input: SubmitInput, transcript: TranscriptMessage[]): Promise<{ request: PurchaseRequest; decision: Decision }> {
    const request = this.build(agent, input, transcript);
    this.deps.state.recordRequest(request, agent.channel);
    this.deps.bus.emitAgent(
      "agent.request.submitted",
      {
        agent_id: agent.agent_id,
        agent_kind: agent.kind,
        channel: agent.channel,
        employee_id: agent.employee.employee_id,
        employee_name: agent.employee.name,
        request: { ...request, transcript: undefined },
      },
      request.request_id,
    );
    let decision: Decision;
    try {
      decision = await this.deps.gateway.submitRequest(request);
    } catch (err) {
      // The gateway never accepted this request, so it must not linger as one the agent can ask about.
      this.deps.state.forgetRequest(request.request_id);
      throw err;
    }
    this.deps.state.updateDecision(request.request_id, decision);
    for (const l of this.listeners) {
      try {
        l(request, decision);
      } catch (err) {
        this.deps.log.warn("requests: decision listener failed", { error: (err as Error).message });
      }
    }
    return { request, decision };
  }

  /** Checkout details for an approved request this employee made, or undefined if there's no card yet. */
  async cardDetails(agent: EnrolledAgent, requestId: string, decision?: Decision): Promise<CardDetails | undefined> {
    const d = decision ?? (await this.status(agent, requestId));
    if (d.status !== "approved" || !d.card) return undefined;
    try {
      return await this.deps.gateway.getCard(d.card.card_id);
    } catch (err) {
      this.deps.log.warn("requests: couldn't fetch card details", { request_id: requestId, error: (err as Error).message });
      return undefined;
    }
  }

  /** Latest decision for a request this agent made. Refreshes from the gateway. */
  async status(agent: EnrolledAgent, requestId: string): Promise<Decision> {
    const rec = this.deps.state.getRequest(requestId);
    if (!rec || rec.agent_id !== agent.agent_id) {
      // Allow the same employee to look up a request made from another of their agents.
      if (!rec || rec.employee_id !== agent.employee.employee_id) throw new NotYourRequestError(requestId);
    }
    const decision = await this.deps.gateway.getRequest(requestId);
    this.deps.state.updateDecision(requestId, decision);
    return decision;
  }
}
