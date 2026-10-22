/**
 * Uses the primary brain (Claude) and falls back to the deterministic parser if it errors or times
 * out, so an API outage or a wrong NEGOTIATOR_MODEL degrades the demo instead of breaking it.
 */
import type { Logger } from "../logger.ts";
import type { Brain, BrainAction, BrainContext } from "./brain.ts";

export class FallbackBrain implements Brain {
  readonly name: string;
  constructor(
    private readonly primary: Brain,
    private readonly fallback: Brain,
    private readonly log: Logger,
    private readonly timeoutMs = 25_000,
  ) {
    this.name = `${primary.name} (fallback: ${fallback.name})`;
  }

  async decide(ctx: BrainContext): Promise<BrainAction> {
    const abort = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.primary.decide({ ...ctx, signal: abort.signal }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            abort.abort();
            reject(new Error(`no answer within ${this.timeoutMs} ms`));
          }, this.timeoutMs);
        }),
      ]);
    } catch (err) {
      this.log.error("negotiator: primary brain failed, using fallback", { error: (err as Error).message });
      return this.fallback.decide(ctx);
    } finally {
      clearTimeout(timer);
    }
  }
}
