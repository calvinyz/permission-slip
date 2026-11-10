/**
 * Contract smoke test against a running gateway (services/gateway, local or remote). It checks every call this service makes, and every event it reads, against
 * api/openapi.yaml, and prints exactly where they disagree.
 *
 *   GATEWAY_URL=https://<gateway-host> GATEWAY_API_TOKEN=... npm run smoke
 *   npm run smoke -- --escalate     # also files the $2,400 conference and resolves it as Priya
 *   npm run smoke -- --charge       # also checks out at the demo merchant with the issued card
 *
 * It creates real (sandbox) requests in the gateway's database, which then show in the issuer
 * console. Nothing here moves real money.
 */
import { parseArgs } from "node:util";
import { createParser, type EventSourceMessage } from "eventsource-parser";
import { loadDotEnv } from "../src/config.ts";
import { contract, GATEWAY_EVENT_TYPES, type PurchaseRequest } from "../src/contract/schemas.ts";
import { normalizeGatewayEvent } from "../src/gateway/events.ts";
import { GatewayApiError, GatewayClient } from "../src/gateway/client.ts";
import { newRequestId } from "../src/requests.ts";

loadDotEnv();
const { values } = parseArgs({
  options: {
    escalate: { type: "boolean", default: false },
    charge: { type: "boolean", default: false },
    wait: { type: "string", default: "4" },
  },
});
const url = (process.env.GATEWAY_URL || "http://localhost:8000").replace(/\/+$/, "");
// "dev-token" is the gateway's own default when GATEWAY_API_TOKEN is unset (local runs only).
const token = process.env.GATEWAY_API_TOKEN || "dev-token";
const client = new GatewayClient({ baseUrl: url, token, retries: 0 });
const c = contract();
const problems: string[] = [];
const ok = (m: string) => console.log(`  ✓ ${m}`);
const bad = (m: string) => {
  problems.push(m);
  console.log(`  ✗ ${m}`);
};

console.log(`Gateway: ${url}\nToken: ${process.env.GATEWAY_API_TOKEN ? "from .env" : "dev-token (the gateway's local default)"}\nContract: api/openapi.yaml v${c.version}\n`);

console.log("1. GET /healthz");
try {
  const res = await fetch(`${url}/healthz`);
  if (res.ok) ok(`HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
  else bad(`/healthz returned HTTP ${res.status}`);
} catch (err) {
  bad(`gateway unreachable: ${(err as Error).message}`);
  console.log("\nIs the gateway running, and is this machine on the same tailnet?");
  process.exit(1);
}

// 2. Event stream, recorded for the whole run.
const raw: EventSourceMessage[] = [];
const ctrl = new AbortController();
let streamStatus = "not connected";
void (async () => {
  try {
    const res = await fetch(`${url}/v1/events`, { headers: { Accept: "text/event-stream", ...client.authHeaders() }, signal: ctrl.signal });
    streamStatus = `HTTP ${res.status} ${res.headers.get("content-type") ?? ""}`;
    if (!res.ok || !res.body) return;
    const parser = createParser({ onEvent: (m) => raw.push(m) });
    const dec = new TextDecoder();
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) parser.feed(dec.decode(chunk, { stream: true }));
  } catch (err) {
    if (!ctrl.signal.aborted) streamStatus = `error: ${(err as Error).message}`;
  }
})();
await new Promise((r) => setTimeout(r, 1000));

const created = new Set<string>();
function request(over: Partial<PurchaseRequest>): PurchaseRequest {
  const request_id = newRequestId();
  created.add(request_id);
  return {
    request_id,
    agent_id: "claude:conversation-smoke",
    channel: "mcp",
    employee_id: "emp_maya",
    merchant: "United Airlines",
    merchant_category: "airlines",
    amount_usd: 480,
    description: "PHL to SFO, economy, Tue Nov 17 (smoke test)",
    justification: "Acme customer meeting",
    travel: { cabin_class: "economy", origin: "PHL", destination: "SFO", depart_date: "2026-11-17" },
    claims: { meeting: "Acme", date: "2026-11-17" },
    transcript: [{ role: "personal_agent", text: "Smoke test from the conversation service." }],
    ...over,
  };
}

async function rawCall(method: string, path: string, body?: unknown) {
  const res = await fetch(`${url}${path}`, { method, headers: { "Content-Type": "application/json", Accept: "application/json", ...client.authHeaders() }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, text };
}

function checkDecision(json: unknown, label: string) {
  const errs = c.errors("Decision", json);
  if (errs.length) bad(`${label}: Decision doesn't match the contract: ${errs.slice(0, 4).join("; ")}`);
  else ok(`${label}: Decision matches the contract`);
}

console.log("\n2. POST /v1/requests (scenario 1 happy path)");
let approved: { request_id: string; card?: { card_id: string } | null } | undefined;
{
  const req = request({});
  const errs = c.errors("PurchaseRequest", req);
  if (errs.length) bad(`our request doesn't match the contract: ${errs.join("; ")}`);
  const r = await rawCall("POST", "/v1/requests", req);
  console.log(`  HTTP ${r.status}: ${r.text.slice(0, 300)}`);
  if (r.status !== 200 && r.status !== 201) bad(`POST /v1/requests returned ${r.status}`);
  else {
    checkDecision(r.json, "POST /v1/requests");
    const d = r.json as { status: string; request_id: string; card?: { card_id: string } | null };
    if (d.status === "approved") {
      ok(`approved (${(r.json as { reason: string }).reason})`);
      approved = d;
    } else bad(`expected approved for the seed's Acme flight, got ${d.status}`);
  }
}

if (approved) {
  console.log("\n3. GET /v1/requests/{id} and GET /v1/cards/{id}");
  try {
    const d = await client.getRequest(approved.request_id);
    ok(`request readable (status=${d.status})`);
  } catch (err) {
    bad(`GET /v1/requests/{id}: ${(err as Error).message}`);
  }
  if (approved.card) {
    const r = await rawCall("GET", `/v1/cards/${approved.card.card_id}`);
    const errs = c.errors("CardDetails", r.json);
    if (r.status !== 200) bad(`GET /v1/cards returned ${r.status}`);
    else if (errs.length) bad(`CardDetails doesn't match: ${errs.join("; ")}`);
    else ok("CardDetails matches the contract (PAN not printed)");
    if (values.charge && r.status === 200) {
      const card = r.json as { pan: string; cvc: string; exp_month: number; exp_year: number };
      const ch = await fetch(`${url}/merchant/charge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pan: card.pan, cvc: card.cvc, exp_month: card.exp_month, exp_year: card.exp_year, merchant: "Demo Air (test merchant)", merchant_category: "airlines", amount_usd: 480 }),
      });
      const body = (await ch.json().catch(() => ({}))) as { status?: string };
      if (body.status === "authorized") ok("demo merchant charge authorized");
      else bad(`demo merchant charge: HTTP ${ch.status} ${JSON.stringify(body).slice(0, 200)}`);
    }
  } else bad("approved Decision has no card");
}

console.log("\n4. POST /v1/requests (scenario 2 first class, expect counter)");
{
  const r = await rawCall("POST", "/v1/requests", request({ employee_id: "emp_noah", agent_id: "muse:conversation-smoke", channel: "sms", amount_usd: 1850, description: "PHL to SFO, first class (smoke test)", travel: { cabin_class: "first", origin: "PHL", destination: "SFO", depart_date: "2026-11-17" } }));
  checkDecision(r.json, "counter");
  const d = r.json as { status?: string; counteroffer?: unknown };
  if (d.status === "counter" && d.counteroffer) ok(`counter with offer ${JSON.stringify(d.counteroffer).slice(0, 160)}`);
  else bad(`expected counter, got ${d.status}`);
}

if (values.escalate) {
  console.log("\n5. Escalation: $2,400 conference, then POST /v1/escalations/{id}/resolve as the approver");
  try {
    const d = await client.submitRequest(
      request({ merchant: "AI Engineer Summit", merchant_category: "conferences", amount_usd: 2400, description: "AI Engineer Summit full pass (smoke test)", justification: "AI Engineer Summit", travel: undefined, claims: { event: "AI Engineer Summit", date: "2026-11-24" } }),
    );
    if (d.status !== "escalated" || !d.escalation) bad(`expected escalated with an escalation, got ${d.status}`);
    else {
      ok(`escalated to ${d.escalation.approver_id} (${d.reason})`);
      const r = await client.resolveEscalation(d.escalation.escalation_id, { action: "approve", resolver_id: d.escalation.approver_id, note: "smoke test" });
      if (r.status === "approved" && r.card) ok("resolve approved it and issued a card");
      else bad(`resolve returned ${r.status} without a card`);
    }
  } catch (err) {
    bad(`escalation: ${(err as Error).message} ${JSON.stringify((err as GatewayApiError).body ?? "").slice(0, 300)}`);
  }
}

await new Promise((r) => setTimeout(r, Number(values.wait) * 1000));
ctrl.abort();
// The stream replays history first; only this run's requests are reported.
const mine = raw.filter((m) => {
  const id = normalizeGatewayEvent(m)?.request_id;
  return id !== undefined && created.has(id);
});
console.log(`\n6. Event stream (${streamStatus}): ${raw.length} events received, ${mine.length} for this run's requests`);
const known = new Set<string>(GATEWAY_EVENT_TYPES);
for (const m of mine) {
  const n = normalizeGatewayEvent(m);
  let body: unknown;
  try {
    body = JSON.parse(m.data);
  } catch {
    body = m.data;
  }
  const errs = c.errors("Event", body);
  console.log(`  ${m.id ?? "-"} ${m.event ?? "-"} request_id=${n?.request_id ?? "none"}${errs.length ? `  CONTRACT: ${errs.slice(0, 2).join("; ")}` : ""}`);
  if (errs.length) bad(`event ${m.event} doesn't match the Event schema`);
  if (n && !known.has(n.type)) bad(`unknown event type "${n.type}"`);
}
if (!mine.length) bad("no events received for this run (check GET /v1/events and its auth)");

if (process.env.ANTHROPIC_API_KEY) {
  console.log("\n7. Negotiator model check");
  try {
    const { LlmBrain } = await import("../src/negotiator/llm-brain.ts");
    const { validateSubmitInput } = await import("../src/negotiator/brain.ts");
    const { MERCHANT_CATEGORIES } = await import("../src/contract/schemas.ts");
    const cats = [...MERCHANT_CATEGORIES];
    const model = process.env.NEGOTIATOR_MODEL || "claude-sonnet-5-5";
    const brain = new LlmBrain({ apiKey: process.env.ANTHROPIC_API_KEY, model });
    const t0 = Date.now();
    const action = await brain.decide({
      company: "Lumen Labs", employeeName: "Maya Chen", employeeId: "emp_maya", agentLabel: "smoke", channel: "sms", merchantCategories: cats, homeAirport: "PHL",
      turns: [{ role: "agent", text: "Book a United Airlines economy flight to SFO for $480 for the Acme meeting on 2026-11-17.", ts: new Date().toISOString() }],
      requests: [], now: new Date(), timeZone: "America/Los_Angeles",
      validateSubmit: (i) => { const r = validateSubmitInput(i, cats); return r.ok ? undefined : r.error; },
    });
    if (action.type === "submit") ok(`${model} built a valid request in ${Date.now() - t0} ms: ${JSON.stringify(action.input.travel)}`);
    else bad(`model answered with ${action.type} instead of submitting a complete request`);
  } catch (err) {
    bad(`negotiator model call failed: ${(err as Error).message}`);
  }
}

console.log(problems.length ? `\n${problems.length} problem(s):\n- ${problems.join("\n- ")}` : "\nEverything matches the contract. Point GATEWAY_URL at this gateway and start the service.");
process.exit(problems.length ? 1 : 0);
