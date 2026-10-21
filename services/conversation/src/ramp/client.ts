/**
 * HTTP client for the gateway (services/gateway). The only way this service affects spend is
 * through these calls, and none of them can approve anything: approval comes back from the
 * gateway's policy engine, or from a manager via resolveEscalation.
 */
import { type CardDetails, type Contract, contract as sharedContract, type Decision, type EscalationResolution, type PurchaseRequest } from "../contract/schemas.ts";
import type { Logger } from "../logger.ts";
import { silentLogger } from "../logger.ts";

export class RampApiError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly body: unknown,
    readonly code?: string,
  ) {
    super(message);
    this.name = "RampApiError";
  }
}

export interface RampClientOptions {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
  retries?: number;
  log?: Logger;
  fetchImpl?: typeof fetch;
  contract?: Contract;
}

export interface RampApi {
  readonly baseUrl: string;
  submitRequest(request: PurchaseRequest): Promise<Decision>;
  getRequest(requestId: string): Promise<Decision>;
  resolveEscalation(escalationId: string, resolution: EscalationResolution): Promise<Decision>;
  /** Full card details (PAN, CVC, expiry) for checkout. Sandbox only. */
  getCard(cardId: string): Promise<CardDetails>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function errorInfo(body: unknown): { code?: string; message?: string } {
  const e = (body as { error?: { code?: string; message?: string } } | undefined)?.error;
  return { code: e?.code, message: e?.message };
}

export class RampClient implements RampApi {
  readonly baseUrl: string;
  private readonly token?: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly log: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly contract: Contract;

  constructor(opts: RampClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.retries = opts.retries ?? 2;
    this.log = opts.log ?? silentLogger;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.contract = opts.contract ?? sharedContract();
  }

  authHeaders(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  /** Lenient check on what the gateway returns: log drift, keep going. */
  private check<T>(schema: "Decision" | "CardDetails", value: unknown, context: string): T {
    const problems = this.contract.errors(schema, value);
    if (problems.length) this.log.warn(`gateway: ${schema} from ${context} doesn't match the contract`, { problems: problems.slice(0, 5) });
    return value as T;
  }

  async submitRequest(request: PurchaseRequest): Promise<Decision> {
    // Strict: a body the contract doesn't allow never leaves this service.
    this.contract.assert("PurchaseRequest", request);
    const started = Date.now();
    try {
      // request_id is the idempotency key, so retrying the same body is safe.
      const raw = await this.call("POST", "/v1/requests", request, { idempotent: true });
      const decision = this.check<Decision>("Decision", raw, "POST /v1/requests");
      this.log.info("ramp: decision", { request_id: request.request_id, status: decision.status, ms: Date.now() - started });
      return decision;
    } catch (err) {
      if (err instanceof RampApiError && err.status === 409) {
        this.log.warn("ramp: request_id conflict, fetching its decision", { request_id: request.request_id });
        return this.getRequest(request.request_id);
      }
      throw err;
    }
  }

  async getRequest(requestId: string): Promise<Decision> {
    const raw = await this.call("GET", `/v1/requests/${encodeURIComponent(requestId)}`, undefined, { idempotent: true });
    return this.check<Decision>("Decision", raw, "GET /v1/requests/{id}");
  }

  async resolveEscalation(escalationId: string, resolution: EscalationResolution): Promise<Decision> {
    this.contract.assert("EscalationResolution", resolution);
    // Not retried: a manager's click must not be applied twice.
    const raw = await this.call("POST", `/v1/escalations/${encodeURIComponent(escalationId)}/resolve`, resolution, { idempotent: false });
    return this.check<Decision>("Decision", raw, "POST /v1/escalations/{id}/resolve");
  }

  async getCard(cardId: string): Promise<CardDetails> {
    const raw = await this.call("GET", `/v1/cards/${encodeURIComponent(cardId)}`, undefined, { idempotent: true });
    return this.check<CardDetails>("CardDetails", raw, "GET /v1/cards/{id}");
  }

  private async call(method: "GET" | "POST", path: string, body: unknown, opts: { idempotent: boolean }): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const attempts = opts.idempotent ? this.retries + 1 : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await this.fetchImpl(url, {
          method,
          headers: { Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...this.authHeaders() },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const text = await res.text();
        let parsed: unknown = text;
        try {
          parsed = text ? JSON.parse(text) : undefined;
        } catch {
          /* keep text */
        }
        if (res.ok) return parsed;
        const info = errorInfo(parsed);
        const err = new RampApiError(`${method} ${path} failed with HTTP ${res.status}${info.message ? `: ${info.message}` : ""}`, res.status, parsed, info.code);
        if (res.status >= 500 || res.status === 429) lastError = err;
        else throw err;
      } catch (err) {
        if (err instanceof RampApiError && err.status !== undefined && err.status < 500 && err.status !== 429) throw err;
        lastError = err instanceof RampApiError ? err : new RampApiError(`${method} ${path} failed: ${(err as Error).message}`, undefined, undefined);
      }
      if (attempt < attempts) {
        const delay = 300 * 2 ** (attempt - 1);
        this.log.warn("ramp: retrying", { method, path, attempt, delay_ms: delay, error: (lastError as Error).message });
        await sleep(delay);
      }
    }
    throw lastError;
  }
}
