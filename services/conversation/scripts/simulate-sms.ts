/**
 * Sends a fake inbound SMS to the agent side, exactly as Twilio would (form-encoded webhook).
 * Signs it with X-Twilio-Signature when TWILIO_AUTH_TOKEN is set, so it also works against a
 * gateway with signature checks on.
 *
 *   npm run sim:sms -- --from +15550000001 "Book United economy $480 for the Acme meeting Tuesday"
 *   npm run sim:sms -- --url https://your-tunnel.example --from +1... "text"
 *
 * Replies go out through Twilio (or show as dry-run on the dashboard), not to this terminal.
 */
import { parseArgs } from "node:util";
import twilio from "twilio";
import { loadDotEnv } from "../src/config.ts";

loadDotEnv();
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { from: { type: "string" }, url: { type: "string" }, to: { type: "string" } },
});
const text = positionals.join(" ").trim();
if (!values.from || !text) {
  console.error('Usage: npm run sim:sms -- --from +15550000001 "message text"');
  process.exit(2);
}
const base = (values.url ?? process.env.CONVERSATION_URL ?? `http://localhost:${process.env.PORT ?? 8787}`).replace(/\/+$/, "");
const url = `${base}/sms/inbound`;
const params = { From: values.from, To: values.to ?? process.env.TWILIO_FROM_NUMBER ?? "+15558675309", Body: text, MessageSid: `SMsim${Date.now()}`, NumMedia: "0" };
const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
const token = process.env.TWILIO_AUTH_TOKEN;
if (token) {
  // Twilio signs the public URL it called; use PUBLIC_BASE_URL when simulating against a tunnel.
  const signedUrl = values.url ? url : `${(process.env.PUBLIC_BASE_URL ?? base).replace(/\/+$/, "")}/sms/inbound`;
  headers["X-Twilio-Signature"] = twilio.getExpectedTwilioSignature(token, signedUrl, params);
}
const res = await fetch(url, { method: "POST", headers, body: new URLSearchParams(params).toString() });
console.log(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
console.log("Watch the reply on the dashboard (or on the phone, if Twilio is configured).");
