/**
 * Subscribes to the Ramp side's event stream (GET /v1/events, Server-Sent Events) and republishes
 * every event on the local bus in one normalized shape.
 *
 * The spec names the events but not their envelope, so normalization accepts the common
 * variants: the type can come from the SSE "event:" field or a "type"/"event" property; the
 * request id can be top-level or nested under "data"; the payload can be under "data", "payload",
 * or be the object itself. Reconnects use exponential backoff and replay the full history (deduped by event_id).
 */
import { createHash } from "node:crypto";
import { createParser, type EventSourceMessage } from "eventsource-parser";
import type { GatewayEvent } from "../contract/schemas.ts";
import { GATEWAY_EVENT_TYPES } from "../contract/schemas.ts";
import type { EventBus } from "../bus.ts";
import type { Logger } from "../logger.ts";
import { silentLogger } from "../logger.ts";

const KNOWN = new Set<string>(GATEWAY_EVENT_TYPES);
let fallbackCounter = 0;

export function normalizeRampEvent(msg: { event?: string; id?: string; data: string }): GatewayEvent | undefined {
  let body: unknown;
  try {
    body = JSON.parse(msg.data);
  } catch {
    body = { message: msg.data };
  }
  const obj = (body && typeof body === "object" && !Array.isArray(body) ? body : { value: body }) as Record<string, unknown>;
  const sseType = msg.event && msg.event !== "message" ? msg.event : undefined;
  const type = sseType ?? str(obj.type) ?? str(obj.event) ?? str(obj.name);
  if (!type) return undefined;
  if (type === "ping" || type === "heartbeat" || type === "keepalive") return undefined;

  const inner = (isRecord(obj.data) ? obj.data : isRecord(obj.payload) ? obj.payload : undefined) as Record<string, unknown> | undefined;
  const data: Record<string, unknown> = inner ?? stripEnvelope(obj);
  const requestId =
    str(obj.request_id) ??
    str(data.request_id) ??
    (isRecord(data.request) ? str(data.request.request_id) : undefined) ??
    (isRecord(data.decision) ? str(data.decision.request_id) : undefined);
  const ts = str(obj.ts) ?? str(obj.timestamp) ?? str(obj.created_at) ?? str(obj.time) ?? new Date().toISOString();
  const id = msg.id ?? str(obj.id) ?? str(obj.event_id) ?? `ramp_${Date.now()}_${++fallbackCounter}`;

  return {
    id: `ramp:${id}`,
    type,
    ts,
    source: "ramp",
    ...(requestId ? { request_id: requestId } : {}),
    data,
  };
}

function stripEnvelope(obj: Record<string, unknown>): Record<string, unknown> {
  const { type: _t, event: _e, id: _i, ts: _ts, timestamp: _tm, ...rest } = obj;
  return rest;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export interface RampEventStreamOptions {
  url: string;
  headers: Record<string, string>;
  bus: EventBus;
  log?: Logger;
  fetchImpl?: typeof fetch;
  maxBackoffMs?: number;
  /** Abort and reconnect if nothing (not even a keep-alive comment) arrives for this long. */
  idleTimeoutMs?: number;
  /**
   * Events whose own timestamp is older than (process start - this margin) are history: shown on
   * the dashboard but marked `replayed`, so Slack and follow-ups don't act on them twice after a
   * restart. The margin absorbs clock skew between the two laptops.
   */
  historyMarginMs?: number;
  now?: () => number;
}

/**
 * Stable identity for an event across reconnects and server restarts. With a Ramp-side timestamp
 * we hash the content, so a replay of the same event dedupes and a restarted server's reused SSE
 * ids don't collide. Without one we fall back to the SSE id scoped to this connection.
 */
export function eventKey(e: GatewayEvent, rawTs: boolean, connection: number): string {
  if (rawTs) return `ramp:${createHash("sha1").update(`${e.type}|${e.request_id ?? ""}|${e.ts}|${JSON.stringify(e.data)}`).digest("hex").slice(0, 20)}`;
  return `ramp:c${connection}:${e.id.replace(/^ramp:/, "")}`;
}

export class RampEventStream {
  private abort?: AbortController;
  private stopped = false;
  private backoff = 500;
  private connection = 0;
  private readonly startedAt: number;
  connected = false;
  private readonly log: Logger;
  private readonly warnedTypes = new Set<string>();
  private warnedSkew = false;

  constructor(private readonly opts: RampEventStreamOptions) {
    this.log = opts.log ?? silentLogger;
    this.startedAt = (opts.now ?? Date.now)();
  }

  start(): void {
    this.stopped = false;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.abort?.abort();
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.connectOnce();
      } catch (err) {
        if (this.stopped) break;
        this.log.warn("ramp events: stream error", { error: (err as Error).message, retry_ms: this.backoff });
      }
      this.connected = false;
      if (this.stopped) break;
      await new Promise((r) => setTimeout(r, this.backoff));
      this.backoff = Math.min(this.backoff * 2, this.opts.maxBackoffMs ?? 15_000);
    }
  }

  private handle(msg: EventSourceMessage): void {
    const event = normalizeRampEvent(msg);
    if (!event) return;
    let rawTs = false;
    let eventId: string | undefined;
    try {
      const body = JSON.parse(msg.data) as Record<string, unknown>;
      rawTs = ["ts", "timestamp", "created_at", "time"].some((k) => typeof body[k] === "string");
      // The gateway's event_id (evt_…) is globally unique and stable across replays: the best key.
      if (typeof body.event_id === "string" && body.event_id) eventId = body.event_id;
    } catch {
      /* not JSON */
    }
    event.id = eventId ? `ramp:${eventId}` : eventKey(event, rawTs, this.connection);
    const now = (this.opts.now ?? Date.now)();
    const evTs = Date.parse(event.ts);
    if (rawTs && Number.isFinite(evTs)) {
      if (evTs < this.startedAt - (this.opts.historyMarginMs ?? 120_000)) event.replayed = true;
      else if (!this.warnedSkew && Math.abs(now - evTs) > 60_000 && evTs > this.startedAt) {
        this.warnedSkew = true;
        this.log.warn("ramp events: event timestamps differ from this machine's clock by over a minute; sync both clocks", { skew_ms: now - evTs });
      }
    }
    if (!KNOWN.has(event.type) && !this.warnedTypes.has(event.type)) {
      this.warnedTypes.add(event.type);
      this.log.warn("ramp events: unknown event type (passing through)", { type: event.type });
    }
    this.opts.bus.publish(event);
  }

  private async connectOnce(): Promise<void> {
    const abort = new AbortController();
    this.abort = abort;
    this.connection++;
    const idleMs = this.opts.idleTimeoutMs ?? 60_000;
    let idle: NodeJS.Timeout | undefined;
    const kick = () => {
      clearTimeout(idle);
      idle = setTimeout(() => abort.abort(new Error(`no data for ${idleMs} ms`)), idleMs);
      idle.unref?.();
    };
    try {
      const res = await (this.opts.fetchImpl ?? fetch)(this.opts.url, {
        headers: {
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
          ...this.opts.headers,
        },
        signal: abort.signal,
      });
      // No Last-Event-ID on purpose: the gateway's seq restarts at 1 when its database is wiped,
      // so resuming by seq after a gateway reset would silently skip every new event. A full
      // replay is cheap at demo scale, and the bus drops duplicates by the global event_id.
      if (!res.ok || !res.body) throw new Error(`GET /v1/events returned HTTP ${res.status}`);
      this.connected = true;
      this.backoff = 500;
      this.log.info("ramp events: connected", { url: this.opts.url, connection: this.connection });
      kick();
      const parser = createParser({ onEvent: (msg: EventSourceMessage) => this.handle(msg) });
      const decoder = new TextDecoder();
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        kick();
        parser.feed(decoder.decode(chunk, { stream: true }));
      }
      throw new Error("stream ended");
    } finally {
      clearTimeout(idle);
    }
  }
}
