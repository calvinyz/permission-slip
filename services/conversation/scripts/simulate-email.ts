/**
 * Sends a fake Postmark inbound webhook to this service (CONVERSATION_URL, default localhost:PORT).
 *   npm run sim:email -- --from muse-maya@example.com "Book Hotel Zephyr for $229 for the Acme meeting Tuesday"
 */
import { parseArgs } from "node:util";
import { loadDotEnv } from "../src/config.ts";

loadDotEnv();
const { values, positionals } = parseArgs({ allowPositionals: true, options: { from: { type: "string" }, subject: { type: "string" }, url: { type: "string" } } });
const text = positionals.join(" ").trim();
const token = process.env.EMAIL_WEBHOOK_TOKEN ?? "local-email-token";
if (!values.from || !text) {
  console.error('Usage: npm run sim:email -- --from muse-maya@example.com "message text"');
  process.exit(2);
}
const base = (values.url ?? process.env.CONVERSATION_URL ?? `http://localhost:${process.env.PORT ?? 8787}`).replace(/\/+$/, "");
const body = {
  From: values.from,
  FromFull: { Email: values.from },
  Subject: values.subject ?? "Purchase request",
  TextBody: text,
  MessageID: `sim-${Date.now()}`,
  Headers: [
    { Name: "Message-ID", Value: `<sim-${Date.now()}@example.com>` },
    // What Postmark adds for a sender whose SPF passes. Simulated, so only use this locally.
    { Name: "Received-SPF", Value: `Pass (simulated) identity=mailfrom; envelope-from="${values.from}"` },
  ],
};
const res = await fetch(`${base}/email/inbound?token=${encodeURIComponent(token)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
console.log(`HTTP ${res.status}: ${await res.text()}`);
