/**
 * Slack bot: manager escalations (Approve/Deny) and finance alerts.
 *
 * - escalation.opened  -> post to SLACK_MANAGER_CHANNEL with Approve/Deny buttons
 * - button click       -> POST /v1/escalations/{escalation_id}/resolve on the gateway, with the
 *                         gateway-assigned approver as resolver_id, then update the post
 * - escalation.resolved from elsewhere (e.g. a curl during testing) -> update the post too
 * - card.suspended     -> alert in SLACK_FINANCE_CHANNEL, enriched with txn.mismatch details
 *
 * The bot never approves anything itself: the button only forwards the manager's decision.
 * Runs in Socket Mode, so it needs no public URL.
 */
import type { EventBus } from "../bus.ts";
import type { Card, Escalation, GatewayEvent, PurchaseRequest, Transaction } from "../contract/schemas.ts";
import type { Enrollment } from "../enrollment.ts";
import type { Logger } from "../logger.ts";
import { GatewayApiError, type GatewayApi } from "../gateway/client.ts";
import type { StateStore } from "../state.ts";
import {
  type EscalationDetails,
  escalationBlocks,
  escalationText,
  resolvedBlocks,
  type SuspensionAlert,
  suspensionBlocks,
  suspensionText,
} from "./blocks.ts";

/** The subset of Slack's WebClient the bot uses (tests pass a fake). */
export interface SlackChat {
  chat: {
    postMessage(args: { channel: string; text: string; blocks?: unknown[]; unfurl_links?: boolean }): Promise<{ ok?: boolean; ts?: string; channel?: string }>;
    update(args: { channel: string; ts: string; text: string; blocks?: unknown[] }): Promise<unknown>;
    postEphemeral(args: { channel: string; user: string; text: string }): Promise<unknown>;
  };
}

interface PostedEscalation {
  channel: string;
  ts: string;
  details: EscalationDetails;
  resolved?: boolean;
}

export interface SlackBotOptions {
  client: SlackChat;
  gateway: GatewayApi;
  state: StateStore;
  enrollment: Enrollment;
  bus: EventBus;
  log: Logger;
  managerChannel: string;
  financeChannel?: string;
  /** If true and the approver has a slack_user_id, only that Slack user may approve or deny. */
  restrictToManager: boolean;
  /**
   * Lets anyone in the channel resolve escalations for an approver with no Slack id (sent to the
   * gateway as that approver). Off by default: map approvers with SLACK_ID_* instead.
   */
  openApprovals?: boolean;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length ? v : undefined;
}

export class SlackBot {
  // Posted escalations and sent alerts live in the StateStore, so a restart doesn't post them again.
  private readonly posted = {
    get: (id: string) => this.o.state.getSlackPost(id) as PostedEscalation | undefined,
    set: (id: string, p: PostedEscalation) => this.o.state.setSlackPost(id, p),
  };
  private readonly posting = new Map<string, Promise<PostedEscalation | undefined>>();
  private readonly mismatches = new Map<string, Partial<Transaction>>();
  private readonly deciding = new Set<string>();
  private unsubscribe?: () => void;

  constructor(private readonly o: SlackBotOptions) {}

  start(): void {
    this.unsubscribe = this.o.bus.subscribe((e) => void this.onEvent(e));
  }

  stop(): void {
    this.unsubscribe?.();
  }

  private async onEvent(e: GatewayEvent): Promise<void> {
    // History replayed after a restart is shown on the dashboard but never re-posted to Slack.
    if (e.source !== "gateway" || e.replayed) return;
    try {
      if (e.type === "escalation.opened" && e.request_id) await this.postEscalation(e.request_id, e.data);
      else if (e.type === "escalation.resolved" && e.request_id) await this.markResolvedFromEvent(e.request_id, e.data);
      else if (e.type === "txn.mismatch") {
        const txn = (e.data.transaction ?? {}) as Partial<Transaction>;
        this.mismatches.set(e.request_id ?? txn.card_id ?? "?", txn);
      }
      else if (e.type === "card.suspended") await this.postSuspension(e);
    } catch (err) {
      this.o.log.error("slack: event handling failed", { type: e.type, error: (err as Error).message });
    }
  }

  /** Collects the details for an escalation from the event, our own record, and the gateway. */
  async escalationDetails(requestId: string, data: Record<string, unknown>): Promise<EscalationDetails> {
    const rec = this.o.state.getRequest(requestId);
    const fromEvent = (typeof data.request === "object" && data.request ? data.request : {}) as Partial<PurchaseRequest>;
    const req: Partial<PurchaseRequest> = { ...fromEvent, ...(rec?.request ?? {}) };
    const employeeId = req.employee_id ?? "unknown";
    const employee = this.o.enrollment.employees.get(employeeId);
    const agent = req.agent_id ? this.o.enrollment.findAgent(req.agent_id) : undefined;
    // The escalation (who must approve, and its id for resolving) comes from the gateway.
    let escalation = (data.escalation as Escalation | undefined) ?? rec?.decision?.escalation ?? undefined;
    let reason = escalation?.reason ?? rec?.decision?.reason;
    if (!escalation) {
      try {
        const d = await this.o.gateway.getRequest(requestId);
        escalation = d.escalation ?? undefined;
        reason ??= escalation?.reason ?? d.reason;
      } catch {
        /* details are best-effort */
      }
    }
    const approver = escalation ? this.o.enrollment.employees.get(escalation.approver_id) : undefined;
    return {
      request_id: requestId,
      escalation_id: escalation?.escalation_id,
      approver_id: escalation?.approver_id,
      approver_name: approver?.name ?? escalation?.approver_id,
      employee_id: employeeId,
      employee_name: employee?.name ?? employeeId,
      approver_slack_id: approver?.slack_user_id,
      agent_label: agent?.label ?? req.agent_id,
      channel: req.channel,
      merchant: req.merchant,
      merchant_category: req.merchant_category,
      amount_usd: req.amount_usd,
      description: req.description,
      justification: req.justification,
      claims: req.claims as Record<string, unknown> | undefined,
      reason,
    };
  }

  postEscalation(requestId: string, data: Record<string, unknown> = {}): Promise<PostedEscalation | undefined> {
    const existing = this.posted.get(requestId);
    if (existing) return Promise.resolve(existing);
    const inProgress = this.posting.get(requestId);
    if (inProgress) return inProgress;
    const p = (async () => {
      // Don't post an escalation that's already been resolved (e.g. history replayed right after a restart).
      try {
        const current = await this.o.gateway.getRequest(requestId);
        if (current.escalation && current.escalation.status !== "open") {
          this.o.log.info("slack: escalation already resolved, not posting", { request_id: requestId, status: current.escalation.status });
          return undefined;
        }
      } catch {
        /* best effort: post anyway */
      }
      const details = await this.escalationDetails(requestId, data);
      const res = await this.o.client.chat.postMessage({ channel: this.o.managerChannel, text: escalationText(details), blocks: escalationBlocks(details), unfurl_links: false });
      if (!res.ts) throw new Error("Slack postMessage returned no ts");
      const posted = { channel: res.channel ?? this.o.managerChannel, ts: res.ts, details };
      this.posted.set(requestId, posted);
      this.o.log.info("slack: escalation posted", { request_id: requestId, channel: posted.channel });
      return posted;
    })().finally(() => this.posting.delete(requestId));
    this.posting.set(requestId, p);
    return p;
  }

  /**
   * Handles an Approve/Deny click. Returns the ephemeral error text if the click was refused, so
   * the Bolt handler (or a test) can show it.
   */
  async handleDecision(args: { requestId: string; decision: "approve" | "deny"; userId: string; userName?: string; channel?: string; messageTs?: string }): Promise<string | undefined> {
    // A double click must not resolve twice, whatever the gateway does with repeats.
    if (this.deciding.has(args.requestId)) return "Already working on that one.";
    if (this.posted.get(args.requestId)?.resolved) return "This request was already resolved.";
    this.deciding.add(args.requestId);
    try {
      return await this.decideNow(args);
    } finally {
      this.deciding.delete(args.requestId);
    }
  }

  private async decideNow(args: { requestId: string; decision: "approve" | "deny"; userId: string; userName?: string; channel?: string; messageTs?: string }): Promise<string | undefined> {
    const posted = this.posted.get(args.requestId) ?? (args.channel && args.messageTs ? { channel: args.channel, ts: args.messageTs, details: await this.escalationDetails(args.requestId, {}) } : undefined);
    let details = posted?.details ?? (await this.escalationDetails(args.requestId, {}));
    if (!details.escalation_id || !details.approver_id) details = await this.escalationDetails(args.requestId, {});
    if (!details.escalation_id || !details.approver_id) return "Couldn't find this escalation on the gateway. Nothing changed.";
    if (this.o.restrictToManager && details.approver_slack_id && details.approver_slack_id !== args.userId) {
      return `Only <@${details.approver_slack_id}> (${details.approver_name}) can approve or deny this request.`;
    }
    // Resolve as whoever clicked, so the gateway's own approver check applies too. A click we can't
    // tie to an employee is only accepted when open approvals are switched on explicitly.
    const clicker = this.o.enrollment.findBySlackId(args.userId);
    if (!clicker && !this.o.openApprovals) {
      return `Your Slack account isn't linked to an employee, so this can't be resolved from here. Set SLACK_ID_${details.approver_id.replace(/^emp_/, "").toUpperCase()} to ${details.approver_name}'s Slack user id (or SLACK_OPEN_APPROVALS=true for a test workspace).`;
    }
    const resolverId = clicker?.employee_id ?? details.approver_id;
    const by = `<@${args.userId}>`;
    try {
      await this.o.gateway.resolveEscalation(details.escalation_id, {
        action: args.decision,
        resolver_id: resolverId,
        note: `Via Slack by ${args.userName ?? args.userId}`,
      });
    } catch (err) {
      if (err instanceof GatewayApiError && err.status === 403) {
        return `The gateway says ${clicker?.name ?? "you"} isn't the approver for this escalation (${details.approver_name} is). Nothing changed.`;
      }
      if (err instanceof GatewayApiError && err.status === 409) {
        // Already resolved (double click, or resolved elsewhere): show the current state.
        try {
          const d = await this.o.gateway.getRequest(args.requestId);
          if (posted) await this.updatePost(posted, d.status, "someone else");
        } catch {
          /* ignore */
        }
        return "This request was already resolved.";
      }
      this.o.log.error("slack: resolve failed", { request_id: args.requestId, error: (err as Error).message });
      return "Couldn't reach the approval system. Nothing changed; try again in a moment.";
    }
    if (posted) await this.updatePost(posted, args.decision === "approve" ? "approved" : "denied", by);
    this.o.log.info("slack: escalation resolved", { request_id: args.requestId, decision: args.decision, by: args.userId });
    return undefined;
  }

  private async updatePost(posted: PostedEscalation, outcome: string, by: string): Promise<void> {
    if (posted.resolved) return;
    posted.resolved = true;
    this.posted.set(posted.details.request_id, posted);
    await this.o.client.chat.update({ channel: posted.channel, ts: posted.ts, text: `${outcome === "approved" ? "Approved" : "Denied"}: ${escalationText(posted.details)}`, blocks: resolvedBlocks(posted.details, outcome, by) });
  }

  private async markResolvedFromEvent(requestId: string, data: Record<string, unknown>): Promise<void> {
    const posted = this.posted.get(requestId);
    if (!posted || posted.resolved) return;
    const esc = data.escalation as Escalation | undefined;
    const outcome = esc?.status === "approved" || esc?.status === "denied" ? esc.status : "resolved";
    const by = (esc?.approver_id && this.o.enrollment.employees.get(esc.approver_id)?.name) ?? esc?.approver_id ?? "a manager";
    await this.updatePost(posted, outcome, by);
  }

  private async postSuspension(e: GatewayEvent): Promise<void> {
    const card = (e.data.card ?? {}) as Partial<Card>;
    const key = e.request_id ?? card.card_id ?? e.id;
    if (!this.o.state.claimSlackAlert(`suspended:${key}`)) return;
    // Give a txn.mismatch that arrives just after the suspension a moment to land.
    if (!this.mismatches.has(key)) await new Promise((r) => setTimeout(r, 400));
    const mismatch = this.mismatches.get(key) ?? {};
    const rec = e.request_id ? this.o.state.getRequest(e.request_id) : undefined;
    const employee = rec ? this.o.enrollment.employees.get(rec.employee_id) : undefined;
    const alert: SuspensionAlert = {
      request_id: e.request_id,
      employee_name: employee?.name,
      card_last4: card.last4 ?? rec?.decision?.card?.last4,
      card_id: card.card_id ?? rec?.decision?.card?.card_id,
      merchant: mismatch.merchant ?? rec?.request.merchant,
      charged_usd: num(mismatch.amount_usd),
      approved_usd: num(card.limit_usd) ?? rec?.decision?.card?.limit_usd,
      reason: str(e.data.reason),
      mandate_id: mismatch.mandate_id ?? card.mandate_id ?? rec?.decision?.mandate_id ?? undefined,
    };
    await this.o.client.chat.postMessage({ channel: this.o.financeChannel ?? this.o.managerChannel, text: suspensionText(alert), blocks: suspensionBlocks(alert), unfurl_links: false });
    this.o.log.info("slack: suspension alert posted", { request_id: e.request_id });
  }
}
