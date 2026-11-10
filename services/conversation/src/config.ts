/**
 * All configuration comes from environment variables (optionally a local .env file).
 * Every integration is optional: if its credentials are missing it is disabled with a clear log
 * line, so the service always boots and the dashboard always works.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { MERCHANT_CATEGORIES } from "./contract/schemas.ts";

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? fallback : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  HOST: z.string().default("0.0.0.0"),
  /** Public HTTPS base URL of this service (tunnel URL). Needed for Twilio signature checks. */
  PUBLIC_BASE_URL: optionalString,
  COMPANY_NAME: z.string().default("Lumen Labs"),

  // Gateway (services/gateway).
  GATEWAY_URL: z.string().url().default("http://localhost:8000"),
  GATEWAY_API_TOKEN: optionalString,
  GATEWAY_TIMEOUT_MS: z.coerce.number().int().min(1000).default(20000),
  GATEWAY_EVENTS_ENABLED: bool(true),

  // Negotiator
  ANTHROPIC_API_KEY: optionalString,
  NEGOTIATOR_MODEL: z.string().default("claude-sonnet-5-5"),
  /** "llm" uses Claude; "scripted" uses a deterministic parser (tests and emergency fallback). */
  NEGOTIATOR_MODE: z.enum(["llm", "scripted", "auto"]).default("auto"),
  MERCHANT_CATEGORIES: optionalString,
  ESCALATION_POLL_INTERVAL_MS: z.coerce.number().int().min(500).default(5000),
  ESCALATION_POLL_TIMEOUT_MS: z.coerce.number().int().min(10_000).default(30 * 60 * 1000),
  NOTIFY_AGENT_ON_SUSPEND: bool(true),
  NOTIFY_AGENT_ON_RECONCILE: bool(true),
  /**
   * Pin "today" (YYYY-MM-DD, Pacific time) so relative dates like "Tuesday" resolve to the seed
   * calendar's dates on every take, whatever day you record.
   */
  DEMO_TODAY: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "DEMO_TODAY must be YYYY-MM-DD")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  DEMO_MERCHANT_URL: optionalString,
  /** Let the signed-in dashboard step through the demo script (N key). Creates real gateway requests. */
  DEMO_PRESENTER: bool(false),
  /** Whose agent the presenter speaks as. */
  DEMO_PRESENTER_EMPLOYEE: z.string().default("emp_maya"),

  // SMS (Twilio)
  TWILIO_ACCOUNT_SID: optionalString,
  TWILIO_AUTH_TOKEN: optionalString,
  TWILIO_FROM_NUMBER: optionalString,
  TWILIO_VALIDATE_SIGNATURE: bool(true),

  // SMS through Google Voice, by way of Gmail (used instead of Twilio when set)
  GV_GMAIL_ADDRESS: optionalString,
  GV_GMAIL_APP_PASSWORD: optionalString,
  /** The Google Voice number agents text; shown in the startup log only. */
  GV_NUMBER: optionalString,

  // Email (Postmark), only needed if Muse can't text
  POSTMARK_SERVER_TOKEN: optionalString,
  EMAIL_FROM_ADDRESS: optionalString,
  EMAIL_WEBHOOK_TOKEN: optionalString,
  /** Require SPF or DKIM to pass on inbound email, so nobody can spoof Muse's address. */
  EMAIL_REQUIRE_AUTH: bool(true),

  // MCP
  MCP_ENABLED: bool(true),

  // Slack
  SLACK_BOT_TOKEN: optionalString,
  SLACK_APP_TOKEN: optionalString,
  SLACK_MANAGER_CHANNEL: optionalString,
  SLACK_FINANCE_CHANNEL: optionalString,
  SLACK_OPEN_APPROVALS: z
    .string()
    .optional()
    .transform((v) => v === "true"),

  // Dashboard
  /** If set, the dashboard asks for this token once per browser (session cookie); scripts send X-Dashboard-Token. Required on a public URL. */
  DASHBOARD_TOKEN: optionalString,

  // Files
  ENROLLMENT_FILE: z.string().default("data/enrollment.json"),
  // Conversations, requests and what Slack already posted survive restarts. Set empty to disable.
  STATE_FILE: z
    .string()
    .default("data/state.json")
    .transform((v) => v.trim() || undefined),
  LOG_FILE: z.string().default("logs/conversation.log"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof EnvSchema>;

export interface Config extends Env {
  merchantCategories: string[];
  negotiatorMode: "llm" | "scripted";
  twilioEnabled: boolean;
  googleVoiceEnabled: boolean;
  emailEnabled: boolean;
  slackEnabled: boolean;
}

let loadedEnvFile = false;

export function loadDotEnv(path = ".env"): void {
  if (loadedEnvFile) return;
  loadedEnvFile = true;
  const full = resolve(path);
  if (existsSync(full)) process.loadEnvFile(full);
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const env = parsed.data;
  const merchantCategories = env.MERCHANT_CATEGORIES
    ? env.MERCHANT_CATEGORIES.split(",").map((s) => s.trim()).filter(Boolean)
    : [...MERCHANT_CATEGORIES];
  const unknown = merchantCategories.filter((c) => !(MERCHANT_CATEGORIES as readonly string[]).includes(c));
  if (unknown.length) throw new Error(`MERCHANT_CATEGORIES has categories the contract doesn't allow: ${unknown.join(", ")}`);
  const negotiatorMode =
    env.NEGOTIATOR_MODE === "auto" ? (env.ANTHROPIC_API_KEY ? "llm" : "scripted") : env.NEGOTIATOR_MODE;
  if (negotiatorMode === "llm" && !env.ANTHROPIC_API_KEY) {
    throw new Error("NEGOTIATOR_MODE=llm needs ANTHROPIC_API_KEY.");
  }
  if (env.PUBLIC_BASE_URL && !env.DASHBOARD_TOKEN) {
    throw new Error(
      "PUBLIC_BASE_URL is set but DASHBOARD_TOKEN is empty. On a public URL the dashboard shows card ids and conversations, so it needs a token. Set DASHBOARD_TOKEN (e.g. openssl rand -hex 16).",
    );
  }
  return {
    ...env,
    // The gateway serves the demo merchant; agents check out there unless told otherwise.
    // Unset: the gateway's demo merchant. "off": no checkout link (e.g. when agents can't reach a local gateway).
    DEMO_MERCHANT_URL: env.DEMO_MERCHANT_URL === "off" ? undefined : (env.DEMO_MERCHANT_URL ?? `${env.GATEWAY_URL.replace(/\/+$/, "")}/merchant`),
    merchantCategories,
    negotiatorMode,
    twilioEnabled: Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER),
    googleVoiceEnabled: Boolean(env.GV_GMAIL_ADDRESS && env.GV_GMAIL_APP_PASSWORD),
    emailEnabled: Boolean(env.POSTMARK_SERVER_TOKEN && env.EMAIL_FROM_ADDRESS),
    slackEnabled: Boolean(env.SLACK_BOT_TOKEN && env.SLACK_APP_TOKEN),
  };
}
