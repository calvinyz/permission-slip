/**
 * One command to see everything working locally, with no Twilio, Slack or Anthropic accounts:
 *   npm run demo:local
 *
 * Uses the gateway at GATEWAY_URL if it answers. Otherwise, when GATEWAY_URL is local (the
 * default http://localhost:8000), it starts the gateway from ../gateway with uv. Then it
 * starts this service on PORT (default 8787) with demo enrollment values and prints the
 * dashboard URL and copy-paste commands for every scenario.
 * Uses Claude as the negotiator if ANTHROPIC_API_KEY is set, otherwise the scripted parser.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, loadDotEnv } from "../src/config.ts";
import { createLogger } from "../src/logger.ts";
import { createConversationService } from "../src/index.ts";
import { DEMO_ENROLLMENT } from "./demo-values.ts";

loadDotEnv();
const PORT = Number(process.env.PORT ?? 8787);
const GATEWAY_URL = (process.env.GATEWAY_URL || "http://localhost:8000").replace(/\/+$/, "");
const demoEnv: Record<string, string> = { ...DEMO_ENROLLMENT, GATEWAY_API_TOKEN: "dev-token" };
for (const [k, v] of Object.entries(demoEnv)) if (!process.env[k]) process.env[k] = v;

async function healthy(url: string): Promise<boolean> {
  try {
    return (await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

let child: ChildProcess | undefined;
if (!(await healthy(GATEWAY_URL))) {
  const local = new URL(GATEWAY_URL);
  if (!["localhost", "127.0.0.1"].includes(local.hostname)) {
    console.error(`The gateway at ${GATEWAY_URL} isn't answering. Start it, or unset GATEWAY_URL to run one locally.`);
    process.exit(1);
  }
  const dir = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../gateway");
  console.log(`Starting the gateway from ${dir} on port ${local.port || 8000} (uv)…`);
  child = spawn("uv", ["run", "--quiet", "uvicorn", "--factory", "gateway.app:create_app", "--host", "127.0.0.1", "--port", local.port || "8000", "--log-level", "warning"], {
    cwd: dir,
    env: { ...process.env, GATEWAY_API_TOKEN: process.env.GATEWAY_API_TOKEN },
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.on("error", (err) => {
    console.error(`Couldn't start the gateway (${err.message}). Install uv: https://docs.astral.sh/uv/`);
    process.exit(1);
  });
  const started = Date.now();
  while (!(await healthy(GATEWAY_URL))) {
    if (child.exitCode !== null || Date.now() - started > 60_000) {
      console.error("The gateway didn't start. Run `uv sync` in services/gateway and try again.");
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  const stop = () => child?.kill("SIGTERM");
  process.on("exit", stop);
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}

const config = loadConfig({
  ...process.env,
  PORT: String(PORT),
  GATEWAY_URL,
  TWILIO_VALIDATE_SIGNATURE: "false",
  EMAIL_WEBHOOK_TOKEN: process.env.EMAIL_WEBHOOK_TOKEN || "local-email-token",
  DASHBOARD_TOKEN: "",
  PUBLIC_BASE_URL: "",
  STATE_FILE: "",
});
const log = createLogger({ level: "warn", file: config.LOG_FILE });
const service = createConversationService(config, { log });
await service.start(PORT, "127.0.0.1");

const base = `http://localhost:${PORT}`;
console.log(`
  Permission Slip, conversation service: local demo
  Gateway       ${GATEWAY_URL}${child ? " (started by this script)" : ""}
  Negotiator    ${service.negotiator.brainName}${service.negotiator.brainName === "scripted" ? " (set ANTHROPIC_API_KEY for Claude)" : ""}

  Dashboard     ${base}/dashboard/
  Issuer        ${GATEWAY_URL}/issuer       Demo merchant  ${GATEWAY_URL}/merchant
  MCP (Claude)  ${base}/mcp        header  Authorization: Bearer ${process.env.MCP_TOKEN_CLAUDE_NOAH}
  MCP (ChatGPT) ${base}/mcp/t/${process.env.MCP_TOKEN_CHATGPT_MAYA}

  In another terminal:
    npm run scenarios                         # runs all five scenarios and prints pass/fail
    npm run sim:sms -- --from +15550000001 "Book a United Airlines economy flight PHL to SFO for \\$480 for the Acme meeting on Nov 17"
    npm run sim:sms -- --from +15550000002 "Book a United Airlines first class flight to SFO for \\$1,850 for the Acme meeting on Nov 17"
    npm run sim:sms -- --from +15550000002 "Yes"
    curl -X POST ${base}/admin/reset         # clear conversations between takes

  SMS replies show on the dashboard as dry runs (no Twilio). These MCP tokens are fixed local-demo values; the service only listens on 127.0.0.1.
  Ctrl+C to stop.
`);
