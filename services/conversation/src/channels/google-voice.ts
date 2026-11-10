/**
 * Google Voice as the SMS channel, through Gmail. Google Voice emails each incoming text to the
 * account's Gmail, and replying to that email sends a text back. So inbound texts are read over
 * IMAP and replies go out over SMTP, with no carrier registration.
 *
 * Scope is enforced here, not by Google (an app password can reach the whole mailbox):
 *  - only mail from txt.voice.google.com, received after the bridge started, is ever fetched;
 *  - the mailbox is opened read-only, so nothing is marked read, moved or deleted;
 *  - replies go only to txt.voice.google.com addresses, and only to numbers that texted first.
 */
import { ImapFlow, type MessageStructureObject } from "imapflow";
import nodemailer, { type Transporter } from "nodemailer";
import { normalizePhone } from "../enrollment.ts";
import type { Logger } from "../logger.ts";
import type { SmsSender } from "./outbound.ts";

export const GV_DOMAIN = "txt.voice.google.com";

const last4 = (phone: string) => `…${phone.slice(-4)}`;

/** Pulls the sender's number and the message text out of a Google Voice notification email. */
export function parseGvEmail(subject: string, body: string): { phone: string; text: string } | undefined {
  const from = subject.match(/new text messages? from (.+)$/i)?.[1];
  if (!from) return undefined;
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => l.includes("voice.google.com>"));
  // The message ends at Google's reply hint or, when that line is missing, at the footer.
  const end = lines.findIndex((l) => /^(To respond to this text message|YOUR ACCOUNT\b)/i.test(l.trim()));
  const text = lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join("\n")
    .trim();
  return text ? { phone: normalizePhone(from), text } : undefined;
}

function textPart(node: MessageStructureObject | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "text/plain") return node.part ?? "1";
  for (const child of node.childNodes ?? []) {
    const found = textPart(child);
    if (found) return found;
  }
  return undefined;
}

export interface GoogleVoiceOptions {
  address: string;
  appPassword: string;
  log: Logger;
  /** Called once per incoming text, with the sender's normalized number. */
  onText: (phone: string, text: string) => Promise<void>;
  pollMs?: number;
}

export class GoogleVoiceSms implements SmsSender {
  private readonly smtp: Transporter;
  private readonly replyTo = new Map<string, { address: string; messageId?: string }>();
  private readonly seen = new Set<number>();
  private startedAt = 0;
  private timer?: NodeJS.Timeout;
  private stopped = true;

  constructor(private readonly opts: GoogleVoiceOptions) {
    this.smtp = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: opts.address, pass: opts.appPassword.replace(/\s/g, "") },
    });
  }

  start(): void {
    this.stopped = false;
    this.startedAt = Date.now();
    void this.poll();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.smtp.close();
  }

  /** Replies to the agent's latest text, which Google Voice delivers as an SMS. */
  async send(to: string, body: string): Promise<{ id?: string }> {
    const target = this.replyTo.get(normalizePhone(to));
    if (!target) throw new Error(`No Google Voice thread for ${last4(to)} yet; texts can only answer a number that texted first`);
    if (!target.address.toLowerCase().endsWith(`@${GV_DOMAIN}`)) throw new Error("Refusing to send outside Google Voice");
    const info = await this.smtp.sendMail({
      from: this.opts.address,
      to: target.address,
      subject: "Re: text message",
      text: body,
      ...(target.messageId ? { inReplyTo: target.messageId, references: target.messageId } : {}),
    });
    return { id: info.messageId };
  }

  /** A fresh connection per check: a long-lived Gmail session doesn't reliably see new mail. */
  private async connect(): Promise<ImapFlow> {
    const imap = new ImapFlow({
      host: "imap.gmail.com",
      port: 993,
      secure: true,
      auth: { user: this.opts.address, pass: this.opts.appPassword.replace(/\s/g, "") },
      logger: false,
    });
    imap.on("error", (err: Error) => this.opts.log.warn("google voice: connection error", { error: err.message }));
    await imap.connect();
    return imap;
  }

  private watching = false;

  private async poll(): Promise<void> {
    let imap: ImapFlow | undefined;
    try {
      imap = await this.connect();
      if (!this.watching) {
        this.watching = true;
        this.opts.log.info("google voice: watching for texts", { every_ms: this.opts.pollMs ?? 4000 });
      }
      const lock = await imap.getMailboxLock("INBOX", { readOnly: true });
      try {
        const since = new Date(this.startedAt - 24 * 60 * 60 * 1000);
        const uids = (await imap.search({ from: GV_DOMAIN, since }, { uid: true })) || [];
        for (const uid of uids) {
          if (this.seen.has(uid)) continue;
          this.seen.add(uid);
          const msg = await imap.fetchOne(String(uid), { uid: true, envelope: true, internalDate: true, bodyStructure: true }, { uid: true });
          if (!msg || !msg.internalDate || new Date(msg.internalDate).getTime() < this.startedAt) continue;
          const from = msg.envelope?.from?.[0]?.address ?? "";
          if (!from.toLowerCase().endsWith(`@${GV_DOMAIN}`)) continue;
          const part = textPart(msg.bodyStructure);
          if (!part) continue;
          const { content } = await imap.download(String(uid), part, { uid: true });
          if (!content) continue;
          const chunks: Buffer[] = [];
          for await (const chunk of content) chunks.push(chunk as Buffer);
          const parsed = parseGvEmail(msg.envelope?.subject ?? "", Buffer.concat(chunks).toString("utf8"));
          if (!parsed) continue;
          this.replyTo.set(parsed.phone, { address: from, messageId: msg.envelope?.messageId });
          this.opts.log.info("google voice: text received", { from: last4(parsed.phone), chars: parsed.text.length });
          await this.opts.onText(parsed.phone, parsed.text).catch((err: Error) => this.opts.log.error("google voice: handling failed", { error: err.message }));
        }
      } finally {
        lock.release();
      }
    } catch (err) {
      this.opts.log.warn("google voice: poll failed, retrying", { error: (err as Error).message });
    } finally {
      await imap?.logout().catch(() => undefined);
    }
    if (!this.stopped) this.timer = setTimeout(() => void this.poll(), this.opts.pollMs ?? 4000);
  }
}
