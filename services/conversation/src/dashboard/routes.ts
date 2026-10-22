/**
 * Live dashboard: GET /dashboard (page), GET /dashboard/stream (SSE), GET /dashboard/config,
 * POST /dashboard/session (sign in).
 *
 * With DASHBOARD_TOKEN set, the page asks for the token once and exchanges it for an HttpOnly
 * session cookie, which EventSource sends automatically. The token never appears in a URL, so it
 * stays out of browser history, access logs and screen recordings. Scripts send it as the
 * X-Dashboard-Token header instead.
 *
 * The browser only talks to this service, never to the gateway, so the gateway API token stays on
 * the server and there are no CORS issues. The stream replays recent history on connect, then
 * forwards every bus event (gateway events plus agent conversation events) live.
 */
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { EventBus } from "../bus.ts";
import type { GatewayEvent } from "../contract/schemas.ts";
import { maskCardNumbers } from "../negotiator/render.ts";
import type { Presenter } from "../presenter.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(here, "public");
const TYPES: Record<string, string> = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8" };

export interface DashboardOptions {
  bus: EventBus;
  token?: string;
  info: () => Record<string, unknown>;
  /** Presenter mode (DEMO_PRESENTER=true): step through the demo script from the dashboard. */
  presenter?: Presenter;
  /** Clears conversations and the live view, for a fresh take. */
  reset?: () => void;
}

const SESSION_COOKIE = "ps_dashboard";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** Constant-time comparison of a supplied token against DASHBOARD_TOKEN. */
export function tokenMatches(given: string | undefined, expected: string | undefined): boolean {
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookie(req: Request, name: string): string | undefined {
  for (const part of (req.header("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

const CARD_SECRET = /^(number|pan|card_number|full_number|cvc|cvv|cvv2|security_code|exp_month|exp_year|expiration|track\d?)$/i;

/** Removes card secrets anywhere in an event payload, so a raw-log flash on video can't show them. */
export function stripSecrets(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => stripSecrets(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (CARD_SECRET.test(k)) out[k] = "[hidden]";
    else if (typeof v === "string") out[k] = maskCardNumbers(v);
    else if (k === "transcript") continue;
    else out[k] = stripSecrets(v, depth + 1);
  }
  return out;
}

/** Drops what the dashboard never needs (transcripts) and hides card secrets. */
export function forDashboard(e: GatewayEvent): GatewayEvent {
  return { ...e, data: stripSecrets(e.data) as Record<string, unknown> };
}

export function dashboardRouter(opts: DashboardOptions): Router {
  const router = express.Router();
  const sessions = new Map<string, number>();
  const authorized = (req: Request): boolean => {
    if (!opts.token) return true;
    if (tokenMatches(req.header("x-dashboard-token"), opts.token)) return true;
    const sid = cookie(req, SESSION_COOKIE);
    const expires = sid ? sessions.get(sid) : undefined;
    return expires !== undefined && expires > Date.now();
  };
  const guard = (req: Request, res: Response, next: NextFunction) => {
    if (authorized(req)) return next();
    res.status(401).json({ error: "unauthorized" });
  };

  router.post("/session", express.json({ limit: "4kb" }), (req, res) => {
    if (!opts.token) {
      res.status(204).end();
      return;
    }
    if (!tokenMatches((req.body as { token?: unknown })?.token as string | undefined, opts.token)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const now = Date.now();
    for (const [sid, expires] of sessions) if (expires <= now) sessions.delete(sid);
    const sid = randomBytes(24).toString("base64url");
    sessions.set(sid, now + SESSION_TTL_MS);
    const secure = req.secure || req.header("x-forwarded-proto") === "https" ? "; Secure" : "";
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/dashboard; Max-Age=${SESSION_TTL_MS / 1000}${secure}`);
    res.status(204).end();
  });

  // The page holds no data; it signs in, then loads everything through the guarded routes.
  router.get("/", (req, res) => {
    if (!req.originalUrl.split("?")[0]!.endsWith("/")) {
      res.redirect(301, `${req.baseUrl}/${req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : ""}`);
      return;
    }
    res.type("html").set("Cache-Control", "no-store").send(readFileSync(join(PUBLIC_DIR, "index.html"), "utf8"));
  });

  router.get(["/app.js", "/model.js", "/styles.css"], (req, res) => {
    const name = req.path.slice(1);
    const ext = name.slice(name.lastIndexOf("."));
    res.type(TYPES[ext] ?? "text/plain").set("Cache-Control", "no-store").send(readFileSync(join(PUBLIC_DIR, name), "utf8"));
  });

  router.get("/config", guard, (_req, res) => res.json({ ...opts.info(), presenter: opts.presenter?.status() ?? null }));

  if (opts.presenter) {
    const presenter = opts.presenter;
    router.post("/presenter/next", guard, async (_req, res) => {
      try {
        const status = await presenter.next();
        res.status(status ? 200 : 409).json(status ?? presenter.status());
      } catch (err) {
        res.status(502).json({ error: (err as Error).message, ...presenter.status() });
      }
    });
    router.post("/presenter/reset", guard, (_req, res) => {
      presenter.reset();
      opts.reset?.();
      res.json(presenter.status());
    });
  }

  router.get("/stream", guard, (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(`retry: 2000\n\n`);
    res.write(`event: snapshot\ndata: ${JSON.stringify(opts.bus.recent(500).map(forDashboard))}\n\n`);
    const off = opts.bus.subscribe((e) => res.write(`event: bus\nid: ${e.id}\ndata: ${JSON.stringify(forDashboard(e))}\n\n`));
    const offReset = opts.bus.onReset(() => res.write(`event: reset\ndata: {}\n\n`));
    const ping = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 15_000);
    req.on("close", () => {
      clearInterval(ping);
      off();
      offReset();
    });
  });

  return router;
}
