import type { AddressInfo } from "node:net";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.ts";
import { Enrollment } from "../src/enrollment.ts";
import { createConversationService, type ConversationServiceOverrides } from "../src/index.ts";
import type { SmsSender } from "../src/channels/outbound.ts";
import type { SlackChat } from "../src/slack/bot.ts";
import type { CardDetails } from "../src/contract/schemas.ts";

export const TOKENS = {
  claudeNoah: "tok_claude_noah_0123456789abcdef0123",
  chatgptMaya: "tok_chatgpt_maya_0123456789abcdef012",
  claudeMaya: "tok_claude_maya_0123456789abcdef012",
};
export const PHONES = { museMaya: "+15550000001", instinctNoah: "+15550000002", stranger: "+15559999999" };
export const SLACK = { priya: "UPRIYA0001", jordan: "UJORDAN001" };

export const ENROLLMENT_ENV = {
  MUSE_NUMBER_MAYA: PHONES.museMaya,
  INSTINCT_NUMBER_NOAH: PHONES.instinctNoah,
  MUSE_EMAIL_MAYA: "muse-maya@example.com",
  MCP_TOKEN_CLAUDE_NOAH: TOKENS.claudeNoah,
  MCP_TOKEN_CHATGPT_MAYA: TOKENS.chatgptMaya,
  MCP_TOKEN_CLAUDE_MAYA: TOKENS.claudeMaya,
  SLACK_ID_PRIYA: SLACK.priya,
};

export function testEnrollment(env: Record<string, string> = ENROLLMENT_ENV): Enrollment {
  return Enrollment.fromFile(new URL("../data/enrollment.json", import.meta.url).pathname, env);
}

// ---------------------------------------------------------------------------------------------
// The real gateway (services/gateway), started with uv for end-to-end tests.

const GATEWAY_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../gateway");
export const GATEWAY_TOKEN = "test-gateway-token";

/** True when uv is installed, so the real gateway can run. End-to-end suites skip otherwise. */
export const HAVE_UV = spawnSync("uv", ["--version"], { stdio: "ignore" }).status === 0;

export interface RealGateway {
  url: string;
  token: string;
  stop(): Promise<void>;
  /** Charges a card at the gateway's demo merchant, the way a personal agent would at checkout. */
  charge(cardId: string, amount: number, merchant?: string): Promise<{ status: string; decline_reason?: string }>;
  card(cardId: string): Promise<CardDetails>;
}

export async function startRealGateway(): Promise<RealGateway> {
  const dir = mkdtempSync(join(tmpdir(), "ps-gw-"));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child: ChildProcess = spawn("uv", ["run", "--quiet", "uvicorn", "--factory", "gateway.app:create_app", "--host", "127.0.0.1", "--port", String(port), "--log-level", "warning"], {
    cwd: GATEWAY_DIR,
    env: { ...process.env, GATEWAY_API_TOKEN: GATEWAY_TOKEN, GATEWAY_DB_PATH: join(dir, "gateway.db") },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (d) => (stderr += String(d)));
  const url = `http://127.0.0.1:${port}`;
  const started = Date.now();
  for (;;) {
    try {
      if ((await fetch(`${url}/healthz`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (child.exitCode !== null || Date.now() - started > 60_000) throw new Error(`gateway didn't start: ${stderr.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  const auth = { Authorization: `Bearer ${GATEWAY_TOKEN}` };
  const card = async (cardId: string) => (await (await fetch(`${url}/v1/cards/${cardId}`, { headers: auth })).json()) as CardDetails;
  return {
    url,
    token: GATEWAY_TOKEN,
    card,
    async charge(cardId, amount, merchant = "Demo Air (test merchant)") {
      const c = await card(cardId);
      const res = await fetch(`${url}/merchant/charge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pan: c.pan, cvc: c.cvc, exp_month: c.exp_month, exp_year: c.exp_year, merchant, merchant_category: c.merchant_lock, amount_usd: amount }),
      });
      return (await res.json()) as { status: string; decline_reason?: string };
    },
    async stop() {
      child.kill("SIGTERM");
      await new Promise((r) => (child.exitCode !== null ? r(null) : child.once("exit", r)));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// This service (conversation), with fake SMS and Slack.

export class FakeSms implements SmsSender {
  sent: { to: string; body: string }[] = [];
  async send(to: string, body: string) {
    this.sent.push({ to, body });
    return { id: `SM${this.sent.length}` };
  }
  to(number: string) {
    return this.sent.filter((s) => s.to === number).map((s) => s.body);
  }
}

export class FakeSlack implements SlackChat {
  posts: { channel: string; text: string; blocks?: unknown[]; ts: string }[] = [];
  updates: { channel: string; ts: string; text: string; blocks?: unknown[] }[] = [];
  ephemerals: { channel: string; user: string; text: string }[] = [];
  chat = {
    postMessage: async (args: { channel: string; text: string; blocks?: unknown[] }) => {
      const ts = `${1700000000 + this.posts.length}.000100`;
      this.posts.push({ ...args, ts });
      return { ok: true, ts, channel: args.channel };
    },
    update: async (args: { channel: string; ts: string; text: string; blocks?: unknown[] }) => {
      this.updates.push(args);
      return { ok: true };
    },
    postEphemeral: async (args: { channel: string; user: string; text: string }) => {
      this.ephemerals.push(args);
      return { ok: true };
    },
  };
}

export function testConfig(env: Record<string, string> = {}) {
  return loadConfig({
    GATEWAY_URL: "http://127.0.0.1:1",
    NEGOTIATOR_MODE: "scripted",
    TWILIO_VALIDATE_SIGNATURE: "false",
    LOG_FILE: "/dev/null",
    LOG_LEVEL: "error",
    SLACK_MANAGER_CHANNEL: "C_MANAGERS",
    SLACK_FINANCE_CHANNEL: "C_FINANCE",
    EMAIL_WEBHOOK_TOKEN: "email-hook-secret",
    ESCALATION_POLL_INTERVAL_MS: "500",
    STATE_FILE: "",
    ...env,
  });
}

/** A fixed "now": Wednesday Oct 21, 2026 10:00 PT, so "Tuesday" resolves to 2026-10-27 (the seed calendar's Acme meeting). */
export const FIXED_NOW = () => new Date("2026-10-21T17:00:00Z");

export async function startConversation(gatewayUrl: string, overrides: ConversationServiceOverrides = {}, env: Record<string, string> = {}) {
  const config = testConfig({ GATEWAY_URL: gatewayUrl, GATEWAY_API_TOKEN: GATEWAY_TOKEN, ...env });
  const sms = new FakeSms();
  const slack = new FakeSlack();
  const { silentLogger } = await import("../src/logger.ts");
  const service = createConversationService(config, { log: silentLogger, enrollment: testEnrollment(), sms, slackClient: slack, now: FIXED_NOW, ...overrides });
  const server = await service.start(0, "127.0.0.1");
  const { port } = server.address() as AddressInfo;
  return { service, sms, slack, url: `http://127.0.0.1:${port}`, config, stop: () => service.stop() };
}

export async function until<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 6000, label = "condition"): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export async function sendSms(url: string, from: string, body: string, sid = `SM${Math.random().toString(16).slice(2)}`) {
  return fetch(`${url}/sms/inbound`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ From: from, To: "+15558675309", Body: body, MessageSid: sid }).toString(),
  });
}
