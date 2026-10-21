/**
 * Sends messages back to personal agents on whichever channel they used. When a channel's
 * credentials are missing it runs in dry-run mode: the message is logged and still appears on the
 * dashboard, so local development and rehearsals work without Twilio or Postmark.
 */
import twilio from "twilio";
import type { EventBus } from "../bus.ts";
import type { EnrolledAgent } from "../enrollment.ts";
import type { Logger } from "../logger.ts";
import type { StateStore } from "../state.ts";
import { maskCardNumbers } from "../negotiator/render.ts";

export interface SmsSender {
  send(to: string, body: string): Promise<{ id?: string }>;
}

export interface EmailSender {
  send(msg: { to: string; subject: string; text: string; inReplyTo?: string }): Promise<{ id?: string }>;
}

/** Splits long text at sentence or word boundaries. Twilio accepts up to 1600 characters per message. */
export function splitForSms(text: string, max = 1500): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("\n"));
    const at = cut > max * 0.5 ? cut + 1 : window.lastIndexOf(" ") > 0 ? window.lastIndexOf(" ") : max;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

export class TwilioSmsSender implements SmsSender {
  private readonly client: ReturnType<typeof twilio>;
  constructor(accountSid: string, authToken: string, private readonly from: string) {
    this.client = twilio(accountSid, authToken);
  }
  async send(to: string, body: string) {
    const msg = await this.client.messages.create({ from: this.from, to, body });
    return { id: msg.sid };
  }
}

export class PostmarkEmailSender implements EmailSender {
  constructor(
    private readonly serverToken: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async send(msg: { to: string; subject: string; text: string; inReplyTo?: string }) {
    const res = await this.fetchImpl("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-Postmark-Server-Token": this.serverToken },
      body: JSON.stringify({
        From: this.from,
        To: msg.to,
        Subject: msg.subject,
        TextBody: msg.text,
        MessageStream: "outbound",
        Headers: msg.inReplyTo
          ? [
              { Name: "In-Reply-To", Value: msg.inReplyTo },
              { Name: "References", Value: msg.inReplyTo },
            ]
          : [],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { MessageID?: string; Message?: string };
    if (!res.ok) throw new Error(`Postmark send failed: HTTP ${res.status} ${body.Message ?? ""}`);
    return { id: body.MessageID };
  }
}

export class OutboundRouter {
  constructor(
    private readonly deps: {
      sms?: SmsSender;
      email?: EmailSender;
      state: StateStore;
      bus: EventBus;
      log: Logger;
    },
  ) {}

  /** Delivers text to the agent. Returns false if delivery failed (already logged and shown on the dashboard). */
  async send(agent: EnrolledAgent, text: string, meta: { requestId?: string; kind?: "reply" | "followup" } = {}): Promise<boolean> {
    if (agent.channel === "mcp") return true; // MCP clients pull results through tools.
    const { bus, log } = this.deps;
    let dryRun = false;
    let ok = true;
    let error: string | undefined;
    try {
      if (agent.channel === "sms") {
        if (!this.deps.sms) dryRun = true;
        else for (const part of splitForSms(text)) await this.deps.sms.send(agent.credential, part);
      } else if (agent.channel === "email") {
        if (!this.deps.email) dryRun = true;
        else {
          const thread = this.deps.state.getSession(agent.agent_id)?.email_thread;
          const subject = thread?.subject ? (/^re:/i.test(thread.subject) ? thread.subject : `Re: ${thread.subject}`) : "Your purchase request";
          await this.deps.email.send({ to: agent.credential, subject, text, inReplyTo: thread?.message_id });
        }
      }
    } catch (err) {
      ok = false;
      error = (err as Error).message;
      log.error("outbound: delivery failed", { agent_id: agent.agent_id, channel: agent.channel, error });
    }
    // The agent received the full card number; logs and the dashboard only ever see it masked.
    const shown = maskCardNumbers(text);
    if (dryRun) log.info("outbound: dry run (channel not configured)", { agent_id: agent.agent_id, channel: agent.channel, text: shown });
    bus.emitAgent(
      "agent.message.out",
      { agent_id: agent.agent_id, agent_kind: agent.kind, agent_label: agent.label, channel: agent.channel, employee_id: agent.employee.employee_id, text: shown, kind: meta.kind ?? "reply", dry_run: dryRun, delivered: ok, ...(error ? { error } : {}) },
      meta.requestId,
    );
    return ok;
  }
}
