/**
 * In-process event bus. Gateway events (from GET /v1/events) and conversation events (messages in
 * and out) both land here. The dashboard, the Slack bot and the escalation follow-up all subscribe.
 * A ring buffer lets a dashboard that opens mid-demo replay recent history.
 */
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { AgentEventType, GatewayEvent } from "./contract/schemas.ts";

export type Listener = (event: GatewayEvent) => void;

export class EventBus {
  private readonly emitter = new EventEmitter();
  private readonly buffer: GatewayEvent[] = [];
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];

  constructor(private readonly capacity = 1000) {
    this.emitter.setMaxListeners(100);
  }

  /** Publish an event. Duplicate ids (e.g. after an SSE reconnect replay) are dropped. */
  publish(event: GatewayEvent): boolean {
    if (this.seen.has(event.id)) return false;
    this.seen.add(event.id);
    this.seenOrder.push(event.id);
    if (this.seenOrder.length > this.capacity * 50) {
      const old = this.seenOrder.splice(0, this.capacity * 10);
      for (const id of old) this.seen.delete(id);
    }
    this.buffer.push(event);
    if (this.buffer.length > this.capacity) this.buffer.splice(0, this.buffer.length - this.capacity);
    for (const listener of this.emitter.listeners("event") as Listener[]) {
      try {
        listener(event);
      } catch {
        // A failing subscriber must never break the others or the publisher.
      }
    }
    return true;
  }

  /** Convenience for conversation events. */
  emitAgent(type: AgentEventType, data: Record<string, unknown>, requestId?: string): GatewayEvent {
    const event: GatewayEvent = {
      id: `agt_${randomUUID()}`,
      type,
      ts: new Date().toISOString(),
      source: "agent",
      ...(requestId ? { request_id: requestId } : {}),
      data,
    };
    this.publish(event);
    return event;
  }

  /** Clears history (between demo takes) and tells live dashboards to clear too. */
  clear(): void {
    this.buffer.length = 0;
    for (const listener of this.emitter.listeners("reset") as (() => void)[]) {
      try {
        listener();
      } catch {
        /* ignore */
      }
    }
  }

  onReset(listener: () => void): () => void {
    this.emitter.on("reset", listener);
    return () => this.emitter.off("reset", listener);
  }

  subscribe(listener: Listener): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  recent(limit = this.capacity): GatewayEvent[] {
    return this.buffer.slice(-limit);
  }

  /** Resolves with the first future event matching the predicate, or rejects on timeout. */
  waitFor(predicate: (e: GatewayEvent) => boolean, timeoutMs: number): Promise<GatewayEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`Timed out after ${timeoutMs} ms waiting for event`));
      }, timeoutMs);
      const off = this.subscribe((e) => {
        if (predicate(e)) {
          clearTimeout(timer);
          off();
          resolve(e);
        }
      });
    });
  }
}
