/**
 * Conversation service of Permission Slip: channels, negotiator, Slack approvals and the live dashboard.
 *
 *   POST /sms/inbound          Twilio webhook (Instinct, Muse over SMS)
 *   POST /email/inbound        Postmark webhook (Muse over email, if needed)
 *   POST /mcp, /mcp/t/:token   MCP server (Claude, ChatGPT)
 *   GET  /dashboard            live dashboard (four panels)
 *   GET  /healthz              what's configured and connected
 *   POST /admin/reset          clear conversations between demo takes
 *
 * Slack runs over Socket Mode (no route). Everything that decides or moves money lives on the
 * gateway; this service only talks.
 */
import express, { type Request, type Response } from "express";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { EventBus } from "./bus.ts";
import { type Config, loadConfig, loadDotEnv } from "./config.ts";
import { Enrollment } from "./enrollment.ts";
import { createLogger, type Logger } from "./logger.ts";
import { OutboundRouter, PostmarkEmailSender, type EmailSender, type SmsSender, TwilioSmsSender } from "./channels/outbound.ts";
import { smsRouter } from "./channels/sms.ts";
import { emailRouter } from "./channels/email.ts";
import { dashboardRouter, tokenMatches } from "./dashboard/routes.ts";
import { Followups } from "./followups.ts";
import { mcpRouter } from "./mcp/server.ts";
import type { Brain } from "./negotiator/brain.ts";
import { LlmBrain } from "./negotiator/llm-brain.ts";
import { Negotiator } from "./negotiator/negotiator.ts";
import { ScriptedBrain } from "./negotiator/scripted-brain.ts";
import { FallbackBrain } from "./negotiator/fallback-brain.ts";
import { type GatewayApi, GatewayClient } from "./gateway/client.ts";
import { GatewayEventStream } from "./gateway/events.ts";
import { RequestService } from "./requests.ts";
import { type SlackChat, SlackBot } from "./slack/bot.ts";
import { StateStore } from "./state.ts";
import { contract } from "./contract/schemas.ts";

const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

export interface ConversationServiceOverrides {
  log?: Logger;
  brain?: Brain;
  gateway?: GatewayApi;
  sms?: SmsSender;
  email?: EmailSender;
  slackClient?: SlackChat;
  enrollment?: Enrollment;
  now?: () => Date;
  /** Disable the gateway event stream subscription (tests drive the bus directly). */
  noEventStream?: boolean;
}

export function createConversationService(config: Config, overrides: ConversationServiceOverrides = {}) {
  const log = overrides.log ?? createLogger({ level: config.LOG_LEVEL, file: config.LOG_FILE });
  const bus = new EventBus();
  const state = new StateStore(config.STATE_FILE);
  const enrollment = overrides.enrollment ?? Enrollment.fromFile(config.ENROLLMENT_FILE, process.env, log);
  const gatewayClient = new GatewayClient({ baseUrl: config.GATEWAY_URL, token: config.GATEWAY_API_TOKEN, timeoutMs: config.GATEWAY_TIMEOUT_MS, log });
  const gateway: GatewayApi = overrides.gateway ?? gatewayClient;
  const requests = new RequestService({ gateway, state, bus, log });
  const brain: Brain =
    overrides.brain ??
    (config.negotiatorMode === "llm"
      ? new FallbackBrain(new LlmBrain({ apiKey: config.ANTHROPIC_API_KEY, model: config.NEGOTIATOR_MODEL, log }), new ScriptedBrain(), log)
      : new ScriptedBrain());
  // DEMO_TODAY pins the date (keeping the current time of day) so "Tuesday" matches the seed calendar.
  const now =
    overrides.now ??
    (config.DEMO_TODAY
      ? () => {
          const real = new Date();
          const realDay = real.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
          return new Date(real.getTime() + (Date.parse(`${config.DEMO_TODAY}T12:00:00Z`) - Date.parse(`${realDay}T12:00:00Z`)));
        }
      : undefined);
  const render = { demoMerchantUrl: config.DEMO_MERCHANT_URL, timeZone: "America/Los_Angeles" };
  const negotiator = new Negotiator({
    brain,
    requests,
    state,
    bus,
    log,
    options: { company: config.COMPANY_NAME, merchantCategories: config.merchantCategories, demoMerchantUrl: config.DEMO_MERCHANT_URL, timeZone: render.timeZone, now },
  });
  const sms = overrides.sms ?? (config.twilioEnabled ? new TwilioSmsSender(config.TWILIO_ACCOUNT_SID!, config.TWILIO_AUTH_TOKEN!, config.TWILIO_FROM_NUMBER!) : undefined);
  const email = overrides.email ?? (config.emailEnabled ? new PostmarkEmailSender(config.POSTMARK_SERVER_TOKEN!, config.EMAIL_FROM_ADDRESS!) : undefined);
  const outbound = new OutboundRouter({ sms, email, state, bus, log });
  const followups = new Followups({
    bus,
    gateway,
    state,
    enrollment,
    outbound,
    log,
    render,
    pollIntervalMs: config.ESCALATION_POLL_INTERVAL_MS,
    pollTimeoutMs: config.ESCALATION_POLL_TIMEOUT_MS,
    notifyOnSuspend: config.NOTIFY_AGENT_ON_SUSPEND,
    notifyOnReconcile: config.NOTIFY_AGENT_ON_RECONCILE,
    allPending: () => state.allRequests(),
  });
  const events =
    config.GATEWAY_EVENTS_ENABLED && !overrides.noEventStream
      ? new GatewayEventStream({ url: `${gatewayClient.baseUrl}/v1/events`, headers: gatewayClient.authHeaders(), bus, log })
      : undefined;

  const slackChannel = config.SLACK_MANAGER_CHANNEL;
  let slackBot: SlackBot | undefined;
  if (overrides.slackClient && slackChannel) {
    slackBot = new SlackBot({ client: overrides.slackClient, gateway, state, enrollment, bus, log, managerChannel: slackChannel, financeChannel: config.SLACK_FINANCE_CHANNEL, restrictToManager: true, openApprovals: config.SLACK_OPEN_APPROVALS });
  }

  // Post escalations to Slack straight from the decision too, so scenario 3 works even if the
  // event stream is down or late. SlackBot de-duplicates against the escalation.opened event.
  requests.onDecision((request, decision) => {
    if (decision.status === "escalated" && slackBot) {
      slackBot.postEscalation(request.request_id, { reason: decision.reason }).catch((err: Error) => log.warn("slack: escalation post failed", { request_id: request.request_id, error: err.message }));
    }
  });

  const info = () => ({
    service: "conversation",
    version: VERSION,
    company: config.COMPANY_NAME,
    gateway_url: config.GATEWAY_URL,
    contract_version: contract().version,
    employees: Object.fromEntries([...enrollment.employees.values()].map((e) => [e.employee_id, e.name])),
    gateway_events_connected: events?.connected ?? false,
    negotiator: brain.name,
    channels: { sms: config.twilioEnabled ? "twilio" : "dry-run", email: config.emailEnabled ? "postmark" : "off", mcp: config.MCP_ENABLED, slack: Boolean(slackBot) },
    agents: enrollment.summary(),
  });

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.get("/", (_req, res) => res.redirect("/dashboard/"));
  app.get("/healthz", (_req, res) => res.json({ ok: true, version: VERSION, gateway_events_connected: events?.connected ?? false }));
  app.use("/sms", smsRouter({ enrollment, negotiator, outbound, log, company: config.COMPANY_NAME, authToken: config.TWILIO_AUTH_TOKEN, validateSignature: config.TWILIO_VALIDATE_SIGNATURE, publicBaseUrl: config.PUBLIC_BASE_URL }));
  if (config.EMAIL_WEBHOOK_TOKEN) app.use("/email", emailRouter({ enrollment, negotiator, outbound, state, log, webhookToken: config.EMAIL_WEBHOOK_TOKEN, requireAuth: config.EMAIL_REQUIRE_AUTH }));
  if (config.MCP_ENABLED) app.use("/mcp", mcpRouter({ enrollment, requests, state, bus, log, merchantCategories: config.merchantCategories, render, serverVersion: VERSION }));
  app.use("/dashboard", dashboardRouter({ bus, token: config.DASHBOARD_TOKEN, info }));
  // Admin endpoints for scripts and between demo takes: localhost only, or the X-Dashboard-Token header.
  const adminOnly = (req: Request, res: Response): boolean => {
    // A tunnel (Tailscale Funnel, ngrok) connects from localhost, so a forwarded request is never "local".
    const forwarded = ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded", "tailscale-user-login"].some((h) => req.headers[h] !== undefined);
    const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "") && !forwarded;
    if (local || tokenMatches(req.header("x-dashboard-token"), config.DASHBOARD_TOKEN)) return true;
    res.status(403).json({ error: "forbidden" });
    return false;
  };
  app.post("/admin/reset", (req: Request, res: Response) => {
    if (!adminOnly(req, res)) return;
    state.resetAll();
    bus.clear();
    log.info("admin: state reset");
    res.json({ ok: true });
  });
  app.get("/admin/info", (req: Request, res: Response) => {
    if (!adminOnly(req, res)) return;
    res.json({ ...info(), agent_ids: enrollment.agents.map((a) => ({ agent_id: a.agent_id, channel: a.channel, employee_id: a.employee.employee_id })) });
  });
  app.get("/admin/requests", (req: Request, res: Response) => {
    if (!adminOnly(req, res)) return;
    const agent = typeof req.query.agent_id === "string" ? req.query.agent_id : undefined;
    const list = (agent ? state.requestsFor(agent) : state.allRequests()).map((r) => ({ request: { ...r.request, transcript: undefined }, decision: r.decision, agent_id: r.agent_id, channel: r.channel, created_at: r.created_at }));
    res.json(list);
  });
  app.use((_req, res) => res.status(404).json({ error: "not_found" }));

  let server: Server | undefined;
  return {
    app,
    bus,
    state,
    enrollment,
    negotiator,
    requests,
    outbound,
    followups,
    get slackBot() {
      return slackBot;
    },
    set slackBot(b: SlackBot | undefined) {
      slackBot = b;
    },
    gateway,
    log,
    info,
    async start(port = config.PORT, host = config.HOST): Promise<Server> {
      followups.start();
      events?.start();
      slackBot?.start();
      server = await new Promise<Server>((resolve) => {
        const s = app.listen(port, host, () => resolve(s));
      });
      return server;
    },
    async stop(): Promise<void> {
      followups.stop();
      events?.stop();
      slackBot?.stop();
      state.saveNow();
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    },
  };
}

async function main() {
  loadDotEnv();
  const config = loadConfig();
  const log = createLogger({ level: config.LOG_LEVEL, file: config.LOG_FILE });
  const service = createConversationService(config, { log });
  let stopSlack: (() => Promise<unknown>) | undefined;

  if (config.slackEnabled) {
    if (!config.SLACK_MANAGER_CHANNEL) {
      log.warn("slack: SLACK_MANAGER_CHANNEL is not set; Slack disabled");
    } else {
      const { createSlackApp, registerSlackHandlers } = await import("./slack/app.ts");
      const slackApp = createSlackApp({ botToken: config.SLACK_BOT_TOKEN!, appToken: config.SLACK_APP_TOKEN!, log });
      const bot = new SlackBot({ client: slackApp.client as unknown as SlackChat, gateway: service.gateway, state: service.state, enrollment: service.enrollment, bus: service.bus, log, managerChannel: config.SLACK_MANAGER_CHANNEL, financeChannel: config.SLACK_FINANCE_CHANNEL, restrictToManager: true, openApprovals: config.SLACK_OPEN_APPROVALS });
      registerSlackHandlers(slackApp, bot, log);
      const noSlack = ["emp_priya", "emp_jordan"].filter((id) => !service.enrollment.employees.get(id)?.slack_user_id);
      if (noSlack.length) log.warn(config.SLACK_OPEN_APPROVALS ? "slack: these approvers have no Slack id; with SLACK_OPEN_APPROVALS=true anyone in the channel can resolve for them" : "slack: these approvers have no Slack id, so their escalations can't be resolved from Slack until you set SLACK_ID_*", { approvers: noSlack });
      try {
        await slackApp.start();
        service.slackBot = bot;
        stopSlack = () => slackApp.stop();
        log.info("slack: connected (Socket Mode)");
      } catch (err) {
        // Slack is optional: a bad or revoked token must not take SMS, MCP or the dashboard down.
        log.error("slack: failed to connect; continuing without Slack", { error: (err as Error).message });
      }
    }
  } else {
    log.info("slack: disabled (set SLACK_BOT_TOKEN, SLACK_APP_TOKEN and SLACK_MANAGER_CHANNEL)");
  }

  await service.start();
  const base = config.PUBLIC_BASE_URL ?? `http://localhost:${config.PORT}`;
  log.info("conversation service listening", {
    port: config.PORT,
    dashboard: `${base}/dashboard/`,
    sms_webhook: `${base}/sms/inbound`,
    mcp: `${base}/mcp`,
    gateway: config.GATEWAY_URL,
    negotiator: service.negotiator.brainName,
    sms: config.twilioEnabled ? "twilio" : "dry-run (no TWILIO_* set)",
  });
  if (!config.GATEWAY_API_TOKEN) log.warn("GATEWAY_API_TOKEN is empty; the gateway will reject every request (locally its default is dev-token)");
  if (!config.TWILIO_VALIDATE_SIGNATURE) log.warn("TWILIO_VALIDATE_SIGNATURE is off: anyone who knows the URL can impersonate an enrolled agent over SMS. Only use this locally.");

  const shutdown = async (signal: string) => {
    log.info("shutting down", { signal });
    await stopSlack?.().catch(() => undefined);
    await service.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
