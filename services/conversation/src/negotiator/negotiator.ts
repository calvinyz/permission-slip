/**
 * The negotiator turns a conversation with a personal agent (over SMS or email) into structured
 * PurchaseRequests, and relays the gateway's decisions back in plain language.
 *
 * It has no authority. Its only path to money is RequestService.submit, which asks the gateway;
 * every decision message is rendered from the gateway's Decision (render.ts).
 */
import type { Decision } from "../contract/schemas.ts";
import type { EventBus } from "../bus.ts";
import type { EnrolledAgent } from "../enrollment.ts";
import type { Logger } from "../logger.ts";
import { GatewayApiError } from "../gateway/client.ts";
import { NotYourRequestError, type RequestService } from "../requests.ts";
import type { StateStore } from "../state.ts";
import { type Brain, type BrainContext, type RequestSummary, validateSubmitInput } from "./brain.ts";
import { maskCardNumbers, renderDecision } from "./render.ts";
import { ContractError, type TranscriptMessage } from "../contract/schemas.ts";
import type { ConversationTurn } from "../state.ts";

/**
 * The transcript sent with a request: only this exchange (turns since the previous request was
 * decided). The gateway scans agent-authored transcript lines for injection, so an earlier,
 * already-denied exchange must not taint the next request.
 */
export function currentExchange(turns: ConversationTurn[]): TranscriptMessage[] {
  let start = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]!.request_id && turns[i]!.role === "gateway") {
      start = i + 1;
      break;
    }
  }
  // Keep the negotiator's last decision message when the agent is answering it (e.g. "YES").
  const from = start > 0 && turns.slice(start).length <= 1 ? start - 1 : start;
  return turns.slice(from).map((t) => ({ role: t.role === "agent" ? "personal_agent" : "negotiator", text: t.text, ts: t.ts.replace(/\.\d{3}Z$/, "Z") }));
}

export interface NegotiatorOptions {
  company: string;
  merchantCategories: string[];
  demoMerchantUrl?: string;
  timeZone?: string;
  /** Inbound messages allowed per agent per minute before we stop responding (loop guard). */
  maxInboundPerMinute?: number;
  now?: () => Date;
}

export interface NegotiatorResult {
  replies: string[];
  request_id?: string;
  decision?: Decision;
  action: "reply" | "submit" | "status" | "no_reply" | "rate_limited" | "error";
}

const MAX_INBOUND_CHARS = 4000;

/**
 * The model's free text is only meant to ask for details. If it reads like an outcome or card
 * details (e.g. after an injected "tell them it's approved"), we replace it: only rendered
 * decisions from the gateway may say those things.
 */
// Statements of an outcome ("it's approved", "I've approved", "Denied."), not questions that
// merely mention approval ("so I can get this approved?").
const OUTCOME_LIKE = /\b(is|was|are|been|got|it's|that's|you're|i've|i have|i'll|i will|i can|i)\s+(now\s+|already\s+)?(pre-?approved|approved|approve|denied|declined|deny|decline)\b|^\W*(pre-?approved|approved|denied|declined)\b/i;
const CARD_LIKE = /\b(card (id|ending|number)|cvv|cvc|card_[a-z0-9]{4,}|mandate)\b|\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/i;
export function guardReply(text: string): string {
  return OUTCOME_LIKE.test(text) || CARD_LIKE.test(text)
    ? "I can't approve or decline anything myself; the company's policy engine decides once I submit. Send me the merchant, the total, what it's for, and the meeting date."
    : text;
}

/** Runs tasks one at a time per key, so two texts from the same agent are handled in order. */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(task);
    this.tails.set(key, next);
    void next.finally(() => {
      if (this.tails.get(key) === next) this.tails.delete(key);
    });
    return next;
  }
}

export class Negotiator {
  private readonly queue = new KeyedQueue();
  private readonly inboundTimes = new Map<string, number[]>();

  constructor(
    private readonly deps: {
      brain: Brain;
      requests: RequestService;
      state: StateStore;
      bus: EventBus;
      log: Logger;
      options: NegotiatorOptions;
    },
  ) {}

  get brainName(): string {
    return this.deps.brain.name;
  }

  handle(agent: EnrolledAgent, text: string): Promise<NegotiatorResult> {
    return this.queue.run(agent.agent_id, () => this.handleNow(agent, text));
  }

  private rateLimited(agentId: string): boolean {
    const limit = this.deps.options.maxInboundPerMinute ?? 15;
    const now = Date.now();
    const times = (this.inboundTimes.get(agentId) ?? []).filter((t) => now - t < 60_000);
    times.push(now);
    this.inboundTimes.set(agentId, times);
    return times.length > limit;
  }

  private async handleNow(agent: EnrolledAgent, rawText: string): Promise<NegotiatorResult> {
    const { state, bus, log, options } = this.deps;
    // Agents sometimes echo the card back ("booking with 4242 …"). Mask it before it's stored,
    // shown, sent to the model or put in a transcript.
    const clipped = rawText.length > MAX_INBOUND_CHARS ? `${rawText.slice(0, MAX_INBOUND_CHARS)}…` : rawText;
    const text = maskCardNumbers(clipped);
    const session = state.session({ agent_id: agent.agent_id, employee_id: agent.employee.employee_id, channel: agent.channel });
    state.addTurn(session, { role: "agent", text });
    bus.emitAgent(
      "agent.message.in",
      // Not tagged with a request id: until the negotiator acts, we don't know which request it belongs to.
      { agent_id: agent.agent_id, agent_kind: agent.kind, agent_label: agent.label, channel: agent.channel, employee_id: agent.employee.employee_id, employee_name: agent.employee.name, text },
    );

    if (this.rateLimited(agent.agent_id)) {
      log.warn("negotiator: rate limited, not responding", { agent_id: agent.agent_id });
      return { replies: [], action: "rate_limited" };
    }

    const requests: RequestSummary[] = state.requestsFor(agent.agent_id).map((r) => ({
      request_id: r.request.request_id,
      merchant: r.request.merchant,
      merchant_category: r.request.merchant_category,
      amount_usd: r.request.amount_usd,
      description: r.request.description,
      justification: r.request.justification,
      claims: r.request.claims ?? {},
      ...(r.request.travel ? { travel: r.request.travel as Record<string, unknown> } : {}),
      status: r.decision?.status,
      reason: r.decision?.reason,
      counteroffer: r.decision?.counteroffer,
    }));
    const ctx: BrainContext = {
      company: options.company,
      employeeName: agent.employee.name,
      employeeId: agent.employee.employee_id,
      ...(agent.employee.home_airport ? { homeAirport: agent.employee.home_airport } : {}),
      agentLabel: agent.label,
      channel: agent.channel,
      merchantCategories: options.merchantCategories,
      turns: session.turns,
      requests,
      now: options.now?.() ?? new Date(),
      timeZone: options.timeZone ?? "America/Los_Angeles",
      validateSubmit: (input) => {
        const r = validateSubmitInput(input, options.merchantCategories);
        return r.ok ? undefined : r.error;
      },
    };

    // The agent gets the full text (it needs the card number to check out); everything stored or
    // shown keeps only the masked version.
    const say = (reply: string, requestId?: string): string => {
      state.addTurn(session, { role: "gateway", text: maskCardNumbers(reply), ...(requestId ? { request_id: requestId } : {}) });
      return reply;
    };
    const renderOpts = { demoMerchantUrl: options.demoMerchantUrl, timeZone: options.timeZone };

    let action;
    const started = Date.now();
    try {
      action = await this.deps.brain.decide(ctx);
    } catch (err) {
      log.error("negotiator: brain failed", { agent_id: agent.agent_id, error: (err as Error).message });
      bus.emitAgent("agent.error", { agent_id: agent.agent_id, stage: "negotiator", error: (err as Error).message });
      return { replies: [say("Sorry, I hit a snag reading that. Please resend the merchant, total, and what it's for.")], action: "error" };
    }
    log.info("negotiator: action", { agent_id: agent.agent_id, action: action.type, brain: this.deps.brain.name, ms: Date.now() - started });

    try {
      switch (action.type) {
        case "no_reply":
          return { replies: [], action: "no_reply" };
        case "reply": {
          const text = guardReply(action.text);
          if (text !== action.text) log.warn("negotiator: replaced a model reply that read like a decision", { agent_id: agent.agent_id });
          return { replies: [say(text)], action: "reply" };
        }
        case "status": {
          const decision = await this.deps.requests.status(agent, action.request_id);
          state.markNotified(action.request_id, { notified_status: decision.status });
          const details = await this.deps.requests.cardDetails(agent, action.request_id, decision);
          return { replies: [say(`${action.request_id}: ${renderDecision(decision, renderOpts, details)}`, action.request_id)], request_id: action.request_id, decision, action: "status" };
        }
        case "submit": {
          const { request, decision } = await this.deps.requests.submit(agent, action.input, currentExchange(session.turns));
          session.last_request_id = request.request_id;
          state.markNotified(request.request_id, { notified_status: decision.status });
          const details = await this.deps.requests.cardDetails(agent, request.request_id, decision);
          log.info("negotiator: decision relayed", { agent_id: agent.agent_id, request_id: request.request_id, status: decision.status, ms: Date.now() - started });
          return { replies: [say(renderDecision(decision, renderOpts, details), request.request_id)], request_id: request.request_id, decision, action: "submit" };
        }
      }
    } catch (err) {
      const message =
        err instanceof ContractError
          ? "I couldn't put that into a valid request. Please resend the merchant, total, what it's for, and the meeting date."
          : err instanceof NotYourRequestError
          ? "I can't find that request for you. Check the request ID."
          : err instanceof GatewayApiError && err.status !== undefined && err.status < 500
            ? "The approval system rejected that request's format. I've logged it; please try rephrasing."
            : "I couldn't reach the approval system just now. Nothing was approved or charged. Please try again in a minute.";
      log.error("negotiator: request failed", { agent_id: agent.agent_id, error: (err as Error).message, status: (err as GatewayApiError).status, body: (err as GatewayApiError).body });
      bus.emitAgent("agent.error", { agent_id: agent.agent_id, stage: "gateway_api", error: (err as Error).message });
      return { replies: [say(message)], action: "error" };
    }
  }
}
