/**
 * Twilio inbound SMS webhook: POST /sms/inbound
 *
 * - Verifies X-Twilio-Signature against the public URL Twilio called (PUBLIC_BASE_URL).
 * - Unknown senders get one polite refusal (at most every 10 minutes per number) and nothing else:
 *   no model call, no request, no data.
 * - Known senders: Twilio gets an immediate empty 200 so it never times out (15 s limit) while the
 *   negotiator thinks; replies go out through the REST API.
 * - Twilio retries are de-duplicated by MessageSid.
 */
import express, { type Request, type Response, type Router } from "express";
import twilio from "twilio";
import type { Enrollment } from "../enrollment.ts";
import type { Logger } from "../logger.ts";
import type { Negotiator } from "../negotiator/negotiator.ts";
import type { OutboundRouter } from "./outbound.ts";

export interface SmsRouteOptions {
  enrollment: Enrollment;
  negotiator: Negotiator;
  outbound: OutboundRouter;
  log: Logger;
  company: string;
  authToken?: string;
  validateSignature: boolean;
  publicBaseUrl?: string;
}

export class RecentSet {
  private readonly items = new Map<string, number>();
  constructor(private readonly ttlMs: number) {}
  has(key: string): boolean {
    const t = this.items.get(key);
    if (t === undefined) return false;
    if (Date.now() - t > this.ttlMs) {
      this.items.delete(key);
      return false;
    }
    return true;
  }
  add(key: string): void {
    this.items.set(key, Date.now());
    if (this.items.size > 5000) {
      const cutoff = Date.now() - this.ttlMs;
      for (const [k, v] of this.items) if (v < cutoff) this.items.delete(k);
    }
  }
}

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
}

export function publicUrlFor(req: Request, base?: string): string {
  if (base) return `${base.replace(/\/+$/, "")}${req.originalUrl}`;
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ?? req.protocol;
  const host = (req.headers["x-forwarded-host"] as string | undefined) ?? req.headers.host;
  return `${proto}://${host}${req.originalUrl}`;
}

export function smsRouter(opts: SmsRouteOptions): Router {
  const router = express.Router();
  const seenSids = new RecentSet(60 * 60 * 1000);
  const refused = new RecentSet(10 * 60 * 1000);
  const { log } = opts;

  if (opts.validateSignature && !opts.authToken) {
    log.warn("sms: TWILIO_VALIDATE_SIGNATURE is on but TWILIO_AUTH_TOKEN is missing; inbound SMS will be rejected");
  }
  if (opts.validateSignature && !opts.publicBaseUrl) {
    log.warn("sms: PUBLIC_BASE_URL not set; reconstructing the URL from forwarded headers for signature checks");
  }

  router.post("/inbound", express.urlencoded({ extended: false, limit: "64kb" }), (req: Request, res: Response) => {
    const params = (req.body ?? {}) as Record<string, string>;
    if (opts.validateSignature) {
      const signature = req.header("x-twilio-signature") ?? "";
      const url = publicUrlFor(req, opts.publicBaseUrl);
      const valid = Boolean(opts.authToken) && twilio.validateRequest(opts.authToken!, signature, url, params);
      if (!valid) {
        log.warn("sms: rejected request with invalid Twilio signature", { url });
        res.status(403).type("text/plain").send("invalid signature");
        return;
      }
    }

    const from = params.From ?? "";
    const body = (params.Body ?? "").trim();
    const sid = params.MessageSid ?? params.SmsSid;
    res.type("text/xml");

    if (sid && seenSids.has(sid)) {
      res.send(EMPTY_TWIML);
      return;
    }
    if (sid) seenSids.add(sid);

    const agent = opts.enrollment.findSmsSender(from);
    if (!agent) {
      log.info("sms: message from unenrolled number", { from_last4: from.slice(-4) });
      if (refused.has(from)) {
        res.send(EMPTY_TWIML);
        return;
      }
      refused.add(from);
      res.send(
        `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(
          `This number only works for AI agents enrolled with ${opts.company}. Ask your finance team to enroll you.`,
        )}</Message></Response>`,
      );
      return;
    }

    res.send(EMPTY_TWIML);
    if (!body) {
      if (Number(params.NumMedia ?? 0) > 0) void opts.outbound.send(agent, "I can only read text messages. Please send the details as text.");
      return;
    }
    void (async () => {
      const result = await opts.negotiator.handle(agent, body);
      for (const reply of result.replies) await opts.outbound.send(agent, reply, { requestId: result.request_id });
    })().catch((err) => log.error("sms: handling failed", { error: (err as Error).message }));
  });

  return router;
}
