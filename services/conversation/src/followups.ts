/**
 * Pushes news to SMS and email agents after the first reply:
 *  - when a manager resolves an escalation (Slack), the agent gets the outcome and the card;
 *  - when the purchase settles and is reconciled, the employee gets the confirmation, with no
 *    receipt upload and no expense report;
 *  - when a card is suspended after a settlement mismatch, the agent gets a heads-up.
 *
 * Driven by the event stream, with polling as a fallback for escalations in case the stream
 * drops. Each kind of news is delivered exactly once per request (RequestRecord.notified_*).
 * History replayed after a restart is ignored. MCP clients aren't pushed to; they call
 * get_request_status.
 */
import type { EventBus } from "./bus.ts";
import type { Card, GatewayEvent, Transaction } from "./contract/schemas.ts";
import type { Enrollment } from "./enrollment.ts";
import type { Logger } from "./logger.ts";
import type { OutboundRouter } from "./channels/outbound.ts";
import { maskCardNumbers, renderEscalationOutcome, renderReconciled, renderSuspension, type RenderOptions } from "./negotiator/render.ts";
import type { GatewayApi } from "./gateway/client.ts";
import type { RequestRecord, StateStore } from "./state.ts";

const RESOLUTION_EVENTS = new Set(["escalation.resolved", "card.issued", "mandate.signed", "policy.decided"]);

export class Followups {
  private readonly inFlight = new Set<string>();
  private readonly recheck = new Set<string>();
  /** Mismatch transactions by request, to explain a suspension that follows. */
  private readonly mismatches = new Map<string, Partial<Transaction>>();
  private timer?: NodeJS.Timeout;
  private unsubscribe?: () => void;

  constructor(
    private readonly deps: {
      bus: EventBus;
      gateway: GatewayApi;
      state: StateStore;
      enrollment: Enrollment;
      outbound: OutboundRouter;
      log: Logger;
      render: RenderOptions;
      pollIntervalMs: number;
      pollTimeoutMs: number;
      notifyOnSuspend: boolean;
      notifyOnReconcile?: boolean;
      /** All requests to scan when polling. */
      allPending: () => RequestRecord[];
    },
  ) {}

  start(): void {
    this.unsubscribe = this.deps.bus.subscribe((e) => this.onEvent(e));
    this.timer = setInterval(() => void this.poll().catch(() => undefined), this.deps.pollIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.unsubscribe?.();
    clearInterval(this.timer);
  }

  private onEvent(e: GatewayEvent): void {
    if (e.source !== "gateway" || e.replayed) return;
    const fail = (err: unknown) => this.deps.log.warn("followups: handler failed", { type: e.type, error: (err as Error).message });
    if (RESOLUTION_EVENTS.has(e.type) && e.request_id) void this.checkEscalation(e.request_id).catch(fail);
    if (e.type === "txn.mismatch" && e.request_id) this.mismatches.set(e.request_id, (e.data.transaction ?? {}) as Partial<Transaction>);
    if (e.type === "card.suspended") void this.onSuspended(e).catch(fail);
    if (e.type === "txn.reconciled") void this.onReconciled(e).catch(fail);
  }

  private async poll(): Promise<void> {
    const now = Date.now();
    for (const rec of this.deps.allPending()) {
      if (rec.notified_status !== "escalated") continue;
      if (now - Date.parse(rec.created_at) > this.deps.pollTimeoutMs) continue;
      await this.checkEscalation(rec.request.request_id);
    }
  }

  /** If an escalated request has been resolved, tell the agent once. */
  async checkEscalation(requestId: string): Promise<void> {
    const rec = this.deps.state.getRequest(requestId);
    if (!rec || rec.channel === "mcp" || rec.notified_status !== "escalated") return;
    if (this.inFlight.has(requestId)) {
      // An event arrived mid-check (e.g. card.issued right after escalation.resolved): look again after.
      this.recheck.add(requestId);
      return;
    }
    this.inFlight.add(requestId);
    try {
      const decision = await this.deps.gateway.getRequest(requestId);
      this.deps.state.updateDecision(requestId, decision);
      if (decision.status === "escalated") return;
      // Card issuance can trail the resolution event; wait for it before texting.
      if (decision.status === "approved" && !decision.card) return;
      const agent = this.deps.enrollment.findAgent(rec.agent_id);
      if (!agent) return;
      this.deps.state.markNotified(requestId, { notified_status: decision.status });
      let details;
      if (decision.status === "approved" && decision.card) {
        try {
          details = await this.deps.gateway.getCard(decision.card.card_id);
        } catch (err) {
          this.deps.log.warn("followups: couldn't fetch card details", { request_id: requestId, error: (err as Error).message });
        }
      }
      await this.send(rec, renderEscalationOutcome(decision, this.deps.render, details));
    } catch (err) {
      this.deps.log.warn("followups: status check failed", { request_id: requestId, error: (err as Error).message });
    } finally {
      this.inFlight.delete(requestId);
      if (this.recheck.delete(requestId)) await this.checkEscalation(requestId);
    }
  }

  private findRecord(e: GatewayEvent): RequestRecord | undefined {
    const card = e.data.card as Partial<Card> | undefined;
    const txn = e.data.transaction as Partial<Transaction> | undefined;
    const cardId = card?.card_id ?? txn?.card_id;
    return (e.request_id ? this.deps.state.getRequest(e.request_id) : undefined) ?? this.deps.allPending().find((r) => cardId && r.decision?.card?.card_id === cardId);
  }

  private async send(rec: RequestRecord, text: string): Promise<void> {
    const agent = this.deps.enrollment.findAgent(rec.agent_id);
    if (!agent) return;
    const session = this.deps.state.session({ agent_id: agent.agent_id, employee_id: agent.employee.employee_id, channel: agent.channel });
    this.deps.state.addTurn(session, { role: "gateway", text: maskCardNumbers(text), request_id: rec.request.request_id });
    await this.deps.outbound.send(agent, text, { requestId: rec.request.request_id, kind: "followup" });
  }

  private async onSuspended(e: GatewayEvent): Promise<void> {
    if (!this.deps.notifyOnSuspend) return;
    const rec = this.findRecord(e);
    if (!rec || rec.channel === "mcp" || rec.notified_suspended) return;
    this.deps.state.markNotified(rec.request.request_id, { notified_suspended: true });
    // The gateway publishes txn.mismatch just before card.suspended; give it a moment if it's late.
    if (!this.mismatches.has(rec.request.request_id)) await new Promise((r) => setTimeout(r, 300));
    const card = (e.data.card as Partial<Card> | undefined) ?? rec.decision?.card ?? undefined;
    const reason = typeof e.data.reason === "string" ? e.data.reason : undefined;
    const mismatch = this.mismatches.get(rec.request.request_id);
    this.mismatches.delete(rec.request.request_id);
    await this.send(rec, renderSuspension(card, reason, mismatch));
  }

  private async onReconciled(e: GatewayEvent): Promise<void> {
    if (this.deps.notifyOnReconcile === false) return;
    const rec = this.findRecord(e);
    if (!rec || rec.channel === "mcp" || rec.notified_reconciled) return;
    this.deps.state.markNotified(rec.request.request_id, { notified_reconciled: true });
    await this.send(rec, renderReconciled((e.data.transaction ?? {}) as Partial<Transaction>, rec.request.merchant));
  }
}
