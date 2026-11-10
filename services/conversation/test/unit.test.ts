import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GoogleVoiceSms, parseGvEmail, parseGvSender } from "../src/channels/google-voice.ts";
import { silentLogger } from "../src/logger.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ContractError, contract, type Decision } from "../src/contract/schemas.ts";
import { Enrollment, normalizeEmail, normalizePhone } from "../src/enrollment.ts";
import { describeCounteroffer, maskCardNumbers, renderDecision, renderEscalationOutcome, renderReconciled, renderSuspension } from "../src/negotiator/render.ts";
import { splitForSms } from "../src/channels/outbound.ts";
import { stripQuotedReply } from "../src/channels/email.ts";
import { normalizeGatewayEvent } from "../src/gateway/events.ts";
import { EventBus } from "../src/bus.ts";
import { ENROLLMENT_ENV, SLACK, TOKENS, testEnrollment } from "./helpers.ts";
import { loadConfig } from "../src/config.ts";
import { redact } from "../src/logger.ts";

const EXAMPLES = resolve(import.meta.dirname, "../../../api/examples");
const example = (name: string) => JSON.parse(readFileSync(resolve(EXAMPLES, name), "utf8"));

const CARD = { card_id: "card_example", mandate_id: "mdt_example", last4: "4242", limit_usd: 480, merchant_lock: "airlines", expires_at: "2026-10-22T15:00:00Z", status: "active" } as const;
const APPROVED: Decision = {
  request_id: "req_s1_flight_sfo",
  status: "approved",
  reason: "Economy fare within the $600 flight cap; Acme meeting verified on calendar.",
  policy_trace: [{ rule: "travel.air.class", result: "pass", detail: "economy" }],
  verification: [{ check: "calendar.meeting", result: "verified", detail: "Acme customer meeting, 2026-11-17, San Francisco" }],
  policy_version: "2026-10-20.1",
  decided_at: "2026-11-11T15:00:00Z",
  counteroffer: null,
  escalation: null,
  mandate_id: "mdt_example",
  card: { ...CARD },
} as Decision;
const DETAILS = { ...CARD, pan: "4242424242421234", cvc: "123", exp_month: 10, exp_year: 2027 };

describe("contract (api/openapi.yaml)", () => {
  it("loads the contract and accepts every request example in api/examples", () => {
    assert.match(contract().version, /^\d+\.\d+\.\d+$/);
    for (const f of ["01-happy-path.request.json", "02-pushback.request.json", "02-pushback-accept.request.json", "03-escalation.request.json", "04-mismatch.request.json"]) {
      assert.deepEqual(contract().errors("PurchaseRequest", example(f)), [], f);
    }
    for (const r of example("05-red-team.requests.json") as unknown[]) assert.deepEqual(contract().errors("PurchaseRequest", r), []);
    assert.deepEqual(contract().errors("EscalationResolution", example("03-escalation.resolution.json")), []);
  });
  it("rejects what the gateway would reject", () => {
    const ok = example("01-happy-path.request.json");
    assert.ok(contract().errors("PurchaseRequest", { ...ok, amount_usd: -1 }).length);
    assert.ok(contract().errors("PurchaseRequest", { ...ok, channel: "fax" }).length);
    assert.ok(contract().errors("PurchaseRequest", { ...ok, agent_id: "not an agent id" }).length);
    assert.ok(contract().errors("PurchaseRequest", { ...ok, transcript: ["plain strings are not allowed"] }).length);
    assert.ok(contract().errors("PurchaseRequest", { ...ok, surprise: 1 }).length, "no extra fields");
    assert.throws(() => contract().assert("PurchaseRequest", { ...ok, merchant_category: "casino" }), ContractError);
  });
  it("accepts the contract's decision and card shapes", () => {
    assert.deepEqual(contract().errors("Decision", APPROVED), []);
    assert.deepEqual(contract().errors("CardDetails", DETAILS), []);
  });
});

describe("enrollment", () => {
  it("normalizes phones and emails", () => {
    assert.equal(normalizePhone("(555) 000-0001"), "+15550000001");
    assert.equal(normalizePhone("+1 555 000 0001"), "+15550000001");
    assert.equal(normalizePhone("15550000001"), "+15550000001");
    assert.equal(normalizeEmail("Muse <Muse-Maya@Example.com>"), "muse-maya@example.com");
  });
  it("resolves ${ENV} placeholders and finds agents by channel", () => {
    const e = testEnrollment();
    assert.match(e.findSmsSender("555-000-0001")?.agent_id ?? "", /^muse:emp_maya-[0-9a-f]{8}$/, "no phone number in agent_id");
    assert.equal(e.findSmsSender("+15550000002")?.employee.employee_id, "emp_noah");
    assert.equal(e.findEmailSender("MUSE-MAYA@example.com")?.kind, "muse");
    assert.equal(e.findMcpToken(TOKENS.claudeNoah)?.agent_id, "claude:emp_noah");
    assert.equal(e.findMcpToken(TOKENS.chatgptMaya)?.agent_id, "chatgpt:emp_maya");
    assert.equal(e.findMcpToken("wrong"), undefined);
    assert.equal(e.findMcpToken(undefined), undefined);
    assert.equal(e.employees.get("emp_priya")?.slack_user_id, SLACK.priya);
    assert.equal(e.findBySlackId(SLACK.priya)?.employee_id, "emp_priya");
    assert.equal(e.employees.get("emp_jordan")?.slack_user_id, undefined, "unset optional placeholder becomes undefined");
    assert.equal(e.employees.get("emp_maya")?.home_airport, "PHL");
  });
  it("employee ids and agent ids match the gateway's patterns", () => {
    for (const a of testEnrollment().agents) assert.match(a.agent_id, /^(instinct|muse|claude|chatgpt|redteam):[A-Za-z0-9_.+@-]+$/);
  });
  it("skips agents whose credential env var is unset", () => {
    const e = testEnrollment({ MUSE_NUMBER_MAYA: "+15550000001" });
    assert.equal(e.agents.length, 1);
    assert.equal(e.findMcpToken(TOKENS.claudeNoah), undefined);
  });
  it("rejects short MCP tokens and duplicate senders", () => {
    assert.throws(() => testEnrollment({ ...ENROLLMENT_ENV, MCP_TOKEN_CLAUDE_NOAH: "short" }), /too short/);
    assert.throws(() => testEnrollment({ ...ENROLLMENT_ENV, INSTINCT_NUMBER_NOAH: "+15550000001" }), /enrolled twice/);
  });
  it("summary never exposes credentials", () => {
    const s = JSON.stringify(testEnrollment().summary());
    assert.ok(!s.includes(TOKENS.claudeNoah));
    assert.ok(!s.includes("+15550000001"));
  });
  it("rejects agents that reference unknown employees", () => {
    assert.throws(
      () => new Enrollment({ employees: [{ employee_id: "emp_a", name: "A" }], agents: [{ kind: "instinct", channel: "sms", employee_id: "emp_b", credential: "+15550000009" }] }),
      /unknown employee/,
    );
  });
});

describe("render", () => {
  it("approved, with and without card details", () => {
    const withDetails = renderDecision(APPROVED, { demoMerchantUrl: "https://gw.example/merchant", timeZone: "UTC" }, DETAILS);
    assert.equal(
      withDetails,
      "Approved. Economy fare within the $600 flight cap; Acme meeting verified on calendar. Card ending 4242, limit $480, locked to airlines, valid until Oct 22, 3:00 PM UTC. Card number 4242 4242 4242 1234, exp 10/27, CVC 123. Check out at https://gw.example/merchant",
    );
    assert.match(renderDecision(APPROVED), /Card ID: card_example\./);
  });
  it("counter, escalated, denied", () => {
    const counter = renderDecision({ ...APPROVED, status: "counter", reason: "Policy allows economy only", card: null, mandate_id: null, counteroffer: { merchant: "United Airlines", merchant_category: "airlines", amount_usd: 480, description: "PHL to SFO, economy, 2026-11-17", reason: "Same route in economy" } });
    assert.equal(counter, "Not approved as requested. Policy allows economy only. Within-policy alternative: PHL to SFO, economy, 2026-11-17 at United Airlines for $480. Reply YES to request that instead.");
    assert.match(renderDecision({ ...APPROVED, status: "escalated", reason: "Over budget", card: null }), /^Sent to your manager/);
    assert.equal(renderDecision({ ...APPROVED, status: "denied", reason: "Blocked merchant", card: null }), "Denied. Blocked merchant.");
    assert.equal(describeCounteroffer(null), undefined);
  });
  it("escalation outcome, reconciliation and suspension wording", () => {
    assert.match(renderEscalationOutcome(APPROVED, {}, DETAILS), /^Your manager approved it\. .*Card number 4242 4242 4242 1234/);
    assert.equal(renderEscalationOutcome({ ...APPROVED, status: "denied", reason: "No budget", card: null }), "Your manager declined it. No budget.");
    const trip = { description: "United UA 1234 PHL to SFO Nov 17 7:05 AM, return UA 567 Nov 19 6:10 PM" };
    assert.match(renderDecision(APPROVED, {}, undefined, trip), /^Approved\. United UA 1234 PHL to SFO Nov 17 7:05 AM, return UA 567 Nov 19 6:10 PM\. /);
    assert.equal(
      renderReconciled({ amount_usd: 612, merchant: "United Airlines", coding: { gl_account: "6110 Travel - Airfare" } } as never, undefined, trip.description),
      "Booked and paid: United UA 1234 PHL to SFO Nov 17 7:05 AM, return UA 567 Nov 19 6:10 PM. $612 at United Airlines settled and matched to its approval, coded to 6110 Travel - Airfare. No receipt or expense report needed.",
    );
    assert.equal(renderReconciled({ amount_usd: 480, merchant: "Demo Air", coding: { gl_account: "6110 Travel - Airfare" } } as never), "Done: $480 at Demo Air settled and matched to its approval, coded to 6110 Travel - Airfare. No receipt or expense report needed.");
    assert.equal(renderSuspension({ last4: "4242", limit_usd: 480 }, "Settlement mismatch: amount_usd expected $480.00, got $620.00", { amount_usd: 620 }), "Heads up: the card ending 4242 was suspended. The merchant charged $620 against an approved $480. Finance has been alerted.");
    assert.equal(renderSuspension({ last4: "4242" }, "Settlement mismatch: amount_usd expected $480.00, got $620.00"), "Heads up: the card ending 4242 was suspended (Settlement mismatch: amount expected $480.00, got $620.00). Finance has been alerted.");
  });
  it("masks card numbers and CVCs in stored and displayed text", () => {
    assert.equal(maskCardNumbers("Card number 4242 4242 4242 1234, exp 10/27, CVC 123."), "Card number •••• •••• •••• 1234, exp 10/27, CVC •••.");
    assert.equal(maskCardNumbers("pan 4242424242421234"), "pan •••• •••• •••• 1234");
    assert.equal(maskCardNumbers("$480 on 2026-11-17"), "$480 on 2026-11-17", "dates and amounts are untouched");
  });
});

describe("helpers", () => {
  it("splits long SMS on sentence boundaries", () => {
    const parts = splitForSms("A".repeat(1000) + ". " + "B".repeat(1000), 1500);
    assert.equal(parts.length, 2);
    assert.ok(parts.every((p) => p.length <= 1500));
  });
  it("strips quoted email history", () => {
    assert.equal(stripQuotedReply("Yes, economy works.\n\nOn Tue, Oct 20, 2026 Permission Slip wrote:\n> old"), "Yes, economy works.");
  });
  it("redacts secrets in logs", () => {
    assert.deepEqual(redact({ api_key: "x", nested: { token: "y", ok: 1 } }), { api_key: "[redacted]", nested: { token: "[redacted]", ok: 1 } });
  });
  it("config: auto mode picks scripted without a key and llm with one", () => {
    assert.equal(loadConfig({}).negotiatorMode, "scripted");
    assert.equal(loadConfig({ ANTHROPIC_API_KEY: "k" }).negotiatorMode, "llm");
    assert.throws(() => loadConfig({ NEGOTIATOR_MODE: "llm" }), /ANTHROPIC_API_KEY/);
    assert.deepEqual(loadConfig({ MERCHANT_CATEGORIES: "airlines, lodging" }).merchantCategories, ["airlines", "lodging"]);
  });
});

describe("gateway event normalization", () => {
  it("reads the gateway's SSE envelope (id: seq, event: type, data: Event JSON)", () => {
    const body = { event_id: "evt_abc123", seq: 7, type: "card.issued", ts: "2026-11-11T15:00:00Z", request_id: "req_1", data: { card: { card_id: "card_1" } } };
    const e = normalizeGatewayEvent({ event: "card.issued", id: "7", data: JSON.stringify(body) });
    assert.equal(e?.type, "card.issued");
    assert.equal(e?.request_id, "req_1");
    assert.equal(e?.ts, "2026-11-11T15:00:00Z");
    assert.deepEqual(e?.data, { card: { card_id: "card_1" } });
  });
  it("finds request_id nested in a request object, ignores pings", () => {
    assert.equal(normalizeGatewayEvent({ event: "request.received", data: JSON.stringify({ request_id: null, data: { request: { request_id: "req_3" } } }) })?.request_id, "req_3");
    assert.equal(normalizeGatewayEvent({ event: "ping", data: "{}" }), undefined);
    assert.equal(normalizeGatewayEvent({ data: "{}" }), undefined);
  });
});

describe("event bus", () => {
  it("dedupes by id and replays recent events", async () => {
    const bus = new EventBus(10);
    const seen: string[] = [];
    bus.subscribe((e) => seen.push(e.id));
    const e = { id: "x", type: "t", ts: "", source: "gateway" as const, data: {} };
    assert.equal(bus.publish(e), true);
    assert.equal(bus.publish(e), false);
    assert.deepEqual(seen, ["x"]);
    for (let i = 0; i < 15; i++) bus.publish({ ...e, id: `y${i}` });
    assert.equal(bus.recent().length, 10);
    const waiting = bus.waitFor((ev) => ev.type === "z", 1000);
    bus.publish({ ...e, id: "z1", type: "z" });
    assert.equal((await waiting).id, "z1");
  });
  it("a throwing subscriber doesn't break others", () => {
    const bus = new EventBus();
    let got = 0;
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe(() => got++);
    bus.publish({ id: "a", type: "t", ts: "", source: "agent", data: {} });
    assert.equal(got, 1);
  });
});

describe("google voice", () => {
  const body = [
    "<https://voice.google.com>",
    "Please book a United Airlines economy flight PHL to SFO for $480",
    "for the Acme meeting on Nov 17.",
    "To respond to this text message, reply to this email or visit Google Voice.",
    "YOUR ACCOUNT <https://voice.google.com> HELP CENTER",
  ].join("\r\n");

  it("reads the sender and the text out of a notification email", () => {
    const parsed = parseGvEmail("New text message from (555) 010-0001", body);
    assert.deepEqual(parsed, {
      phone: "+15550100001",
      text: "Please book a United Airlines economy flight PHL to SFO for $480\nfor the Acme meeting on Nov 17.",
    });
  });

  it("stops at the footer when the reply hint is missing", () => {
    const footerOnly = ["<https://voice.google.com>", "Book economy for $480.", "YOUR ACCOUNT <https://voice.google.com> HELP CENTER", "Google LLC"].join("\n");
    assert.equal(parseGvEmail("New text message from (555) 010-0001", footerOnly)?.text, "Book economy for $480.");
  });

  it("reads the sender from the subject alone", () => {
    assert.equal(parseGvSender("New text message from (555) 010-0001"), "+15550100001");
    assert.equal(parseGvSender("Your Google Voice voicemail"), undefined);
  });

  it("ignores mail that isn't a text notification", () => {
    assert.equal(parseGvEmail("Your Google Voice voicemail", body), undefined);
    assert.equal(parseGvEmail("New text message from (555) 010-0001", "<https://voice.google.com>\nTo respond to this text message, reply"), undefined);
  });

  it("only replies to numbers that texted first", async () => {
    const gv = new GoogleVoiceSms({ address: "someone@example.com", appPassword: "x", log: silentLogger, onText: async () => undefined });
    await assert.rejects(gv.send("+15550100001", "hi"), /texted first/);
  });
});

describe("checkout link", () => {
  it("defaults to the gateway's demo merchant and can be switched off", () => {
    assert.equal(loadConfig({ GATEWAY_URL: "http://localhost:8000" }).DEMO_MERCHANT_URL, "http://localhost:8000/merchant");
    assert.equal(loadConfig({ GATEWAY_URL: "http://localhost:8000", DEMO_MERCHANT_URL: "off" }).DEMO_MERCHANT_URL, undefined);
  });
});
