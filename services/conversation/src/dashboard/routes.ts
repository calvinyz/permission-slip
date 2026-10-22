/**
 * Live dashboard: GET /dashboard (page), GET /dashboard/stream (SSE), GET /dashboard/config.
 *
 * The browser only talks to this service, never to the gateway, so the gateway API token stays on
 * the server and there are no CORS issues. The stream replays recent history on connect, then
 * forwards every bus event (gateway events plus agent conversation events) live.
 */
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import type { EventBus } from "../bus.ts";
import type { GatewayEvent } from "../contract/schemas.ts";
import { maskCardNumbers } from "../negotiator/render.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(here, "public");
const TYPES: Record<string, string> = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8" };

export interface DashboardOptions {
  bus: EventBus;
  token?: string;
  info: () => Record<string, unknown>;
}

function tokenOk(req: Request, expected?: string): boolean {
  if (!expected) return true;
  const got = typeof req.query.token === "string" ? req.query.token : req.header("x-dashboard-token") ?? "";
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
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
  const guard = (req: Request, res: Response, next: NextFunction) => {
    if (tokenOk(req, opts.token)) return next();
    res.status(401).type("text/plain").send("Dashboard token required: add ?token=… to the URL.");
  };

  router.get("/", guard, (req, res) => {
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

  router.get("/config", guard, (_req, res) => res.json(opts.info()));

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
