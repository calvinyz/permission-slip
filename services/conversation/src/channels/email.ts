/**
 * Postmark inbound email webhook: POST /email/inbound?token=<EMAIL_WEBHOOK_TOKEN>
 *
 * For personal agents that reach us by email rather than SMS. Feeds the same negotiator as SMS;
 * replies thread onto the original message.
 */
import express, { type Request, type Response, type Router } from "express";
import { timingSafeEqual } from "node:crypto";
import { normalizeEmail, type Enrollment } from "../enrollment.ts";
import type { Logger } from "../logger.ts";
import type { Negotiator } from "../negotiator/negotiator.ts";
import type { StateStore } from "../state.ts";
import type { OutboundRouter } from "./outbound.ts";
import { RecentSet } from "./sms.ts";

interface PostmarkInbound {
  From?: string;
  FromFull?: { Email?: string };
  Subject?: string;
  TextBody?: string;
  StrippedTextReply?: string;
  MessageID?: string;
  Headers?: { Name: string; Value: string }[];
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Removes quoted history ("On … wrote:", "> …") when Postmark didn't strip it. */
export function stripQuotedReply(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (/^On .+wrote:\s*$/.test(line) || /^-{2,}\s*Original Message/i.test(line) || /^From: /.test(line)) break;
    if (line.startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}

/**
 * True if Postmark's SPF verdict passed for the sender's domain. Without this, anyone could email
 * the inbound address with an enrolled agent's From header and act for that employee.
 *
 * Only the topmost Received-SPF header counts: Postmark prepends its own above the message's
 * headers, while anything further down (including Authentication-Results) may have been written
 * by the sender.
 */
export function senderAuthenticated(headers: { Name: string; Value: string }[] | undefined, fromEmail: string | undefined): boolean {
  const fromDomain = domainOf(fromEmail);
  if (!fromDomain) return false;
  const verdict = (headers ?? []).find((h) => h.Name.toLowerCase() === "received-spf");
  if (!verdict || !/^\s*pass\b/i.test(verdict.Value)) return false;
  // The pass must vouch for the From domain itself (DMARC-style relaxed alignment); otherwise
  // anyone with their own SPF-clean domain could forge the From header.
  const envelope = domainOf(verdict.Value.match(/envelope-from=["<]?([^"\s;>]+)/i)?.[1]);
  return Boolean(envelope) && (envelope === fromDomain || envelope!.endsWith(`.${fromDomain}`) || fromDomain.endsWith(`.${envelope}`));
}

function domainOf(address: string | undefined): string | undefined {
  const at = address?.lastIndexOf("@") ?? -1;
  const d = at >= 0 ? address!.slice(at + 1) : address;
  return d ? d.trim().replace(/[>"]+$/, "").toLowerCase() || undefined : undefined;
}

export function emailRouter(opts: {
  enrollment: Enrollment;
  negotiator: Negotiator;
  outbound: OutboundRouter;
  state: StateStore;
  log: Logger;
  webhookToken?: string;
  requireAuth?: boolean;
}): Router {
  const router = express.Router();
  const seen = new RecentSet(60 * 60 * 1000);

  router.post("/inbound", express.json({ limit: "2mb" }), (req: Request, res: Response) => {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    if (!opts.webhookToken || !safeEqual(token, opts.webhookToken)) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const msg = (req.body ?? {}) as PostmarkInbound;
    const from = msg.FromFull?.Email ?? msg.From ?? "";
    const messageId = msg.Headers?.find((h) => h.Name.toLowerCase() === "message-id")?.Value ?? msg.MessageID;
    res.status(200).json({ ok: true });

    if (messageId && seen.has(messageId)) return;
    if (messageId) seen.add(messageId);

    const agent = opts.enrollment.findEmailSender(from);
    if (!agent) {
      opts.log.info("email: message from unenrolled sender (ignored)");
      return;
    }
    if (opts.requireAuth !== false && !senderAuthenticated(msg.Headers, normalizeEmail(from))) {
      opts.log.warn("email: rejected message that failed SPF/DKIM (possible spoof)", { agent_id: agent.agent_id });
      return;
    }
    const text = (msg.StrippedTextReply?.trim() || stripQuotedReply(msg.TextBody ?? "")).slice(0, 4000);
    const session = opts.state.session({ agent_id: agent.agent_id, employee_id: agent.employee.employee_id, channel: "email" });
    session.email_thread = { message_id: messageId, subject: msg.Subject ?? session.email_thread?.subject };
    if (!text) return;

    void (async () => {
      const result = await opts.negotiator.handle(agent, text);
      for (const reply of result.replies) await opts.outbound.send(agent, reply, { requestId: result.request_id });
    })().catch((err) => opts.log.error("email: handling failed", { error: (err as Error).message }));
  });

  return router;
}
