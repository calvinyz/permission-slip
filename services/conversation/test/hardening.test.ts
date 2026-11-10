/** Hardening: event stream resilience, negotiator safety, email and Slack edge cases, dashboard secrecy. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "../src/bus.ts";
import { GatewayEventStream, eventKey, normalizeGatewayEvent } from "../src/gateway/events.ts";
import { guardReply } from "../src/negotiator/negotiator.ts";
import { ScriptedBrain } from "../src/negotiator/scripted-brain.ts";
import { FallbackBrain } from "../src/negotiator/fallback-brain.ts";
import { validateSubmitInput, type BrainContext } from "../src/negotiator/brain.ts";
import { senderAuthenticated } from "../src/channels/email.ts";
import { dashboardRouter, stripSecrets } from "../src/dashboard/routes.ts";
import express from "express";
import supertest from "supertest";
import { clip } from "../src/slack/blocks.ts";
import { SlackBot } from "../src/slack/bot.ts";
import { StateStore } from "../src/state.ts";
import { loadConfig } from "../src/config.ts";
import { silentLogger } from "../src/logger.ts";
import { MERCHANT_CATEGORIES } from "../src/contract/schemas.ts";
import { FakeSlack, FIXED_NOW, SLACK, testEnrollment, until } from "./helpers.ts";
import { GatewayApiError, GatewayClient, type GatewayApi } from "../src/gateway/client.ts";

const cats = [...MERCHANT_CATEGORIES];
const ctx = (text: string): BrainContext => ({
  company: "N", employeeName: "M", employeeId: "emp_maya", agentLabel: "x", channel: "sms", merchantCategories: cats,
  turns: [{ role: "agent", text, ts: "" }], requests: [], now: FIXED_NOW(), timeZone: "America/Los_Angeles", homeAirport: "PHL",
  validateSubmit: (i) => { const r = validateSubmitInput(i, cats); return r.ok ? undefined : r.error; },
});

const escalated = (request_id = "req_x") => ({
  request_id, status: "escalated", reason: "Over budget", policy_trace: [], verification: [], policy_version: "1", decided_at: "2026-11-11T17:00:00Z",
  counteroffer: null, mandate_id: null, card: null,
  escalation: { escalation_id: "esc_1", request_id, approver_id: "emp_priya", status: "open", opened_at: "2026-11-11T17:00:00Z" },
});

function sseResponse(frames: string[], keepOpen = false): Response {
  const body = new ReadableStream({
    start(c) {
      for (const f of frames) c.enqueue(new TextEncoder().encode(f));
      if (!keepOpen) c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}
const frame = (id: number, type: string, ts: string, request_id = "req_1") => `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify({ type, request_id, ts, data: { n: id } })}\n\n`;

describe("event stream resilience", () => {
  it("a restarted gateway reusing SSE ids still gets its new events through", async () => {
    const bus = new EventBus();
    const now = Date.parse("2026-11-11T17:00:00Z");
    let call = 0;
    const fetchImpl = (async () => {
      call++;
      return call === 1
        ? sseResponse([frame(1, "request.received", "2026-11-11T17:00:01Z"), frame(2, "policy.decided", "2026-11-11T17:00:02Z")])
        : sseResponse([frame(1, "request.received", "2026-11-11T17:05:01Z", "req_2"), frame(2, "policy.decided", "2026-11-11T17:05:02Z", "req_2")], true);
    }) as unknown as typeof fetch;
    const s = new GatewayEventStream({ url: "http://x/v1/events", headers: {}, bus, fetchImpl, now: () => now, maxBackoffMs: 10 });
    s.start();
    await until(() => bus.recent().filter((e) => e.request_id === "req_2").length === 2, 3000, "events after restart");
    s.stop();
    assert.equal(bus.recent().length, 4);
  });

  it("a replay of the same events (same content) is de-duplicated", () => {
    const e = normalizeGatewayEvent({ id: "1", event: "card.issued", data: JSON.stringify({ request_id: "r", ts: "2026-11-11T00:00:00Z", data: { a: 1 } }) })!;
    assert.equal(eventKey(e, true, 1), eventKey({ ...e }, true, 2));
    assert.notEqual(eventKey(e, false, 1), eventKey(e, false, 2), "without timestamps, ids are scoped to the connection");
  });

  it("history from before startup is marked replayed; Slack ignores it", async () => {
    const bus = new EventBus();
    const now = Date.parse("2026-11-11T17:00:00Z");
    const fetchImpl = (async () => sseResponse([frame(7, "escalation.opened", "2026-11-11T15:00:00Z", "req_old"), frame(8, "escalation.opened", "2026-11-11T17:00:01Z", "req_new")], true)) as unknown as typeof fetch;
    const slack = new FakeSlack();
    const gateway = { getRequest: async (id: string) => escalated(id) } as unknown as GatewayApi;
    const bot = new SlackBot({ client: slack, gateway, state: new StateStore(), enrollment: testEnrollment(), bus, log: silentLogger, managerChannel: "C", restrictToManager: true });
    bot.start();
    const s = new GatewayEventStream({ url: "http://x", headers: {}, bus, fetchImpl, now: () => now });
    s.start();
    await until(() => slack.posts.length === 1, 3000, "one post");
    await new Promise((r) => setTimeout(r, 100));
    s.stop();
    assert.equal(slack.posts.length, 1);
    assert.match(JSON.stringify(slack.posts[0]!.blocks), /req_new/);
    assert.equal(bus.recent().find((e) => e.request_id === "req_old")?.replayed, true, "still on the dashboard, flagged");
  });

  it("after a gateway reset (seq restarts at 1) reconnects replay everything, deduped by event_id", async () => {
    const bus = new EventBus();
    const now = Date.parse("2026-11-11T17:00:00Z");
    const ev = (seq: number, event_id: string, request_id: string, ts: string) => `id: ${seq}\nevent: request.received\ndata: ${JSON.stringify({ event_id, seq, type: "request.received", ts, request_id, data: {} })}\n\n`;
    const sent: (string | null)[] = [];
    let call = 0;
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      call++;
      sent.push(new Headers(init.headers).get("Last-Event-ID"));
      if (call === 1) return sseResponse([ev(1, "evt_a", "req_a", "2026-11-11T17:00:01Z"), ev(2, "evt_b", "req_b", "2026-11-11T17:00:02Z")]);
      if (call === 2) return sseResponse([ev(1, "evt_a", "req_a", "2026-11-11T17:00:01Z"), ev(2, "evt_b", "req_b", "2026-11-11T17:00:02Z"), ev(3, "evt_c", "req_c", "2026-11-11T17:00:03Z")]);
      return sseResponse([ev(1, "evt_new", "req_new", "2026-11-11T17:09:00Z")], true);
    }) as unknown as typeof fetch;
    const s = new GatewayEventStream({ url: "http://x", headers: {}, bus, fetchImpl, now: () => now, maxBackoffMs: 10 });
    s.start();
    await until(() => bus.recent().some((e) => e.request_id === "req_new"), 3000, "event after reset");
    s.stop();
    assert.deepEqual(bus.recent().map((e) => e.request_id), ["req_a", "req_b", "req_c", "req_new"]);
    assert.ok(sent.every((h) => h === null), "never resumes by seq");
  });

  it("an idle stream is dropped and reconnected", async () => {
    const bus = new EventBus();
    let calls = 0;
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      calls++;
      const body = new ReadableStream({ start(c) { init.signal?.addEventListener("abort", () => c.error(new Error("aborted"))); } });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    const s = new GatewayEventStream({ url: "http://x", headers: {}, bus, fetchImpl, idleTimeoutMs: 50, maxBackoffMs: 10 });
    s.start();
    await until(() => calls >= 3, 3000, "reconnects");
    s.stop();
  });
});

describe("negotiator safety", () => {
  it("replaces model replies that read like decisions or card details", () => {
    for (const t of ["Approved! Card ending 4242.", "Your request is denied.", "Use card_abcd1234 to pay", "The mandate is signed"]) assert.notEqual(guardReply(t), t, t);
    for (const t of ["You're approved, go ahead.", "I've approved it.", "Pre-approved: book it", "Card number 4242 4242 4242 4242"]) assert.notEqual(guardReply(t), t, t);
    for (const t of ["What's the total price?", "Which meeting is this for?", "What date is the meeting so I can get this approved?", "Which airport are you flying from? Approval depends on the route."]) assert.equal(guardReply(t), t);
  });
  it("falls back to the scripted brain when the LLM throws or hangs", async () => {
    const boom = { name: "llm", decide: async () => { throw new Error("529 overloaded"); } };
    const hang = { name: "llm", decide: () => new Promise<never>(() => {}) };
    const msg = "Book a United Airlines economy flight to SFO for $480 for the Acme meeting Tuesday";
    assert.equal((await new FallbackBrain(boom, new ScriptedBrain(), silentLogger).decide(ctx(msg))).type, "submit");
    assert.equal((await new FallbackBrain(hang, new ScriptedBrain(), silentLogger, 50).decide(ctx(msg))).type, "submit");
  });
});

describe("scripted dates", () => {
  const brain = new ScriptedBrain();
  const date = async (t: string) => { const a = await brain.decide(ctx(t)); return a.type === "submit" ? a.input.claims.date : a.type; };
  it("doesn't read hotel names as months", async () => {
    assert.equal(await date("Book the Marriott 2 nights for $200 for the Acme meeting Tuesday"), "2026-11-17");
  });
  it("uses the meeting's weekday, not the first weekday mentioned", async () => {
    assert.equal(await date("Fly United Airlines to SFO Monday for $480 for the Acme meeting Tuesday"), "2026-11-17");
  });
  it("reads month names and ordinals", async () => {
    assert.equal(await date("United Airlines PHL to SFO $480 for the Acme meeting on November 17th"), "2026-11-17");
  });
  it("DEMO_TODAY validates and is optional", () => {
    assert.equal(loadConfig({ DEMO_TODAY: "2026-11-11" }).DEMO_TODAY, "2026-11-11");
    assert.equal(loadConfig({ DEMO_TODAY: "" }).DEMO_TODAY, undefined);
    assert.throws(() => loadConfig({ DEMO_TODAY: "Tuesday" }));
  });
});

describe("email, Slack and dashboard edge cases", () => {
  it("email sender must pass Postmark's SPF check", () => {
    const from = "muse-maya@example.com";
    assert.equal(senderAuthenticated([{ Name: "Received-SPF", Value: "Pass (sender SPF authorized) identity=mailfrom; client-ip=1.2.3.4; envelope-from=\"bounce@mail.example.com\"; receiver=x" }], from), true);
    assert.equal(senderAuthenticated([{ Name: "Received-SPF", Value: "SoftFail" }], from), false);
    assert.equal(senderAuthenticated(undefined, from), false);
  });
  it("authentication headers written by the sender are ignored", () => {
    const from = "muse-maya@example.com";
    // Only Postmark's own verdict (the topmost Received-SPF) counts; anything below it is sender-controlled.
    assert.equal(senderAuthenticated([{ Name: "Authentication-Results", Value: "mx; dkim=pass header.d=example.com; spf=pass smtp.mailfrom=muse-maya@example.com" }], from), false);
    assert.equal(
      senderAuthenticated([
        { Name: "Received-SPF", Value: "Fail (sender not authorized) envelope-from=\"muse-maya@example.com\"" },
        { Name: "Received-SPF", Value: "Pass (forged) envelope-from=\"muse-maya@example.com\"" },
      ], from),
      false,
    );
  });
  it("a pass for some other domain doesn't vouch for Muse's From address", () => {
    const from = "muse-maya@example.com";
    assert.equal(senderAuthenticated([{ Name: "Received-SPF", Value: "Pass (x) envelope-from=\"a@attacker.test\"" }], from), false);
    assert.equal(senderAuthenticated([{ Name: "Received-SPF", Value: "Pass (x)" }], from), false, "no envelope-from to check");
  });
  it("Slack field text is clipped under Slack's limit", () => {
    assert.equal(clip("x".repeat(5000), 1900).length, 1900);
  });
  it("Slack double click resolves once", async () => {
    let calls = 0;
    const gateway = {
      resolveEscalation: async () => { calls++; await new Promise((r) => setTimeout(r, 50)); return {}; },
      getRequest: async (id: string) => escalated(id),
    } as unknown as GatewayApi;
    const bot = new SlackBot({ client: new FakeSlack(), gateway, state: new StateStore(), enrollment: testEnrollment(), bus: new EventBus(), log: silentLogger, managerChannel: "C", restrictToManager: false });
    const [a, b] = await Promise.all([bot.handleDecision({ requestId: "req_x", decision: "approve", userId: SLACK.priya }), bot.handleDecision({ requestId: "req_x", decision: "approve", userId: SLACK.priya })]);
    assert.equal(calls, 1);
    assert.ok([a, b].some((x) => x && /Already working/.test(x)));
  });
  it("card secrets never reach the dashboard stream", () => {
    const out = JSON.stringify(stripSecrets({ card: { card_id: "c", last4: "4242", pan: "4242424242424242", number: "4242424242424242", cvc: "123" }, request: { transcript: [{ role: "employee", text: "x" }], merchant: "m" } }));
    assert.ok(!out.includes("4242424242424242") && !out.includes('"123"') && !out.includes("transcript"));
    assert.match(out, /"last4":"4242"/);
  });
  it("a public URL requires a dashboard token", () => {
    assert.throws(() => loadConfig({ PUBLIC_BASE_URL: "https://x.ts.net" }), /DASHBOARD_TOKEN/);
    assert.doesNotThrow(() => loadConfig({ PUBLIC_BASE_URL: "https://x.ts.net", DASHBOARD_TOKEN: "t" }));
  });
});

describe("Slack approvals, restarts and masking", () => {
  const escalatedTo = (approver: string, request_id = "req_j") => ({
    request_id, status: "escalated", reason: "Over budget", policy_trace: [], verification: [], policy_version: "1", decided_at: "2026-11-11T17:00:00Z",
    counteroffer: null, mandate_id: null, card: null,
    escalation: { escalation_id: "esc_j", request_id, approver_id: approver, status: "open", opened_at: "2026-11-11T17:00:00Z" },
  });

  it("Slack: a click that can't be tied to an employee is refused unless open approvals are on", async () => {
    const resolved: unknown[] = [];
    const gateway = { getRequest: async (id: string) => escalatedTo("emp_jordan", id), resolveEscalation: async (_id: string, body: unknown) => { resolved.push(body); return {}; } } as unknown as GatewayApi;
    const mk = (openApprovals: boolean) => new SlackBot({ client: new FakeSlack(), gateway, state: new StateStore(), enrollment: testEnrollment(), bus: new EventBus(), log: silentLogger, managerChannel: "C", restrictToManager: true, openApprovals });
    assert.match((await mk(false).handleDecision({ requestId: "req_j", decision: "approve", userId: "UNOBODY" })) ?? "", /isn't linked to an employee.*SLACK_ID_JORDAN/);
    assert.equal(resolved.length, 0);
    assert.equal(await mk(true).handleDecision({ requestId: "req_j", decision: "approve", userId: "UNOBODY" }), undefined);
    assert.deepEqual((resolved[0] as { resolver_id: string }).resolver_id, "emp_jordan");
  });

  it("Slack: a mapped clicker resolves as themselves, so the gateway can refuse the wrong approver", async () => {
    const resolved: { resolver_id: string }[] = [];
    const gateway = { getRequest: async (id: string) => escalatedTo("emp_jordan", id), resolveEscalation: async (_id: string, body: { resolver_id: string }) => { resolved.push(body); return {}; } } as unknown as GatewayApi;
    const bot = new SlackBot({ client: new FakeSlack(), gateway, state: new StateStore(), enrollment: testEnrollment(), bus: new EventBus(), log: silentLogger, managerChannel: "C", restrictToManager: true });
    await bot.handleDecision({ requestId: "req_j", decision: "approve", userId: SLACK.priya });
    assert.equal(resolved[0]!.resolver_id, "emp_priya");
  });

  it("Slack: posts and alerts survive a restart (no duplicates), and a resolved escalation isn't posted", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "ps-state-"));
    try {
      const file = join(dir, "state.json");
      const gateway = { getRequest: async (id: string) => escalated(id) } as unknown as GatewayApi;
      const slack1 = new FakeSlack();
      const state1 = new StateStore(file);
      const bot1 = new SlackBot({ client: slack1, gateway, state: state1, enrollment: testEnrollment(), bus: new EventBus(), log: silentLogger, managerChannel: "C", restrictToManager: true });
      await bot1.postEscalation("req_r");
      assert.equal(state1.claimSlackAlert("suspended:req_r"), true);
      state1.saveNow();
      const slack2 = new FakeSlack();
      const state2 = new StateStore(file);
      const bot2 = new SlackBot({ client: slack2, gateway, state: state2, enrollment: testEnrollment(), bus: new EventBus(), log: silentLogger, managerChannel: "C", restrictToManager: true });
      await bot2.postEscalation("req_r");
      assert.equal(slack2.posts.length, 0, "not re-posted after restart");
      assert.equal(state2.claimSlackAlert("suspended:req_r"), false, "alert not re-sent after restart");
      const resolvedGateway = { getRequest: async (id: string) => ({ ...escalated(id), status: "approved", escalation: { ...escalated(id).escalation, status: "approved" } }) } as unknown as GatewayApi;
      const slack3 = new FakeSlack();
      const bot3 = new SlackBot({ client: slack3, gateway: resolvedGateway, state: new StateStore(), enrollment: testEnrollment(), bus: new EventBus(), log: silentLogger, managerChannel: "C", restrictToManager: true });
      await bot3.postEscalation("req_done");
      assert.equal(slack3.posts.length, 0, "already-resolved escalation isn't posted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scripted brain: clean description; 'not business' and 'no upgrade' don't change the cabin", async () => {
    const brain = new ScriptedBrain();
    const submit = async (t: string) => { const a = await brain.decide(ctx(t)); assert.equal(a.type, "submit", t); return (a as { input: { description: string; travel?: { cabin_class?: string } } }).input; };
    const a = await submit("Book a United Airlines economy flight PHL to SFO for $480 for the Acme meeting Tuesday, no upgrade needed.");
    assert.equal(a.description, "PHL to SFO, economy, 2026-11-17");
    assert.equal((await submit("United Airlines PHL to SFO, economy, not business class, $480 for the Acme meeting Tuesday")).travel?.cabin_class, "economy");
    assert.equal((await submit("United Airlines PHL to SFO, economy rather than first class, $480 for the Acme meeting Tuesday")).travel?.cabin_class, "economy");
    assert.equal((await submit("United Airlines first class PHL to SFO $1,850 for the Acme meeting Tuesday")).travel?.cabin_class, "first");
  });

  it("rejects dates that don't exist, so the model can correct them", () => {
    const base = { merchant: "X", merchant_category: "software", amount_usd: 10, description: "d", justification: "j" };
    assert.equal(validateSubmitInput({ ...base, claims: { date: "2026-02-30" } }, cats).ok, false);
    assert.equal(validateSubmitInput({ ...base, claims: { date: "2026-02-28" } }, cats).ok, true);
  });

  it("dashboard stream masks card numbers inside any text field", () => {
    const out = JSON.stringify(stripSecrets({ text: "Paying with 4242 4242 4242 1234, CVC 123", nested: { note: "4242424242421234" } }));
    assert.ok(!out.includes("4242 4242 4242 1234") && !out.includes("4242424242421234") && !out.includes("CVC 123"), out);
  });
});

describe("dashboard sign-in", () => {
  const app = express().use("/dashboard", dashboardRouter({ bus: new EventBus(), token: "s3cret-dashboard-token", info: () => ({ ok: true }) }));
  const agent = () => supertest(app);

  it("serves the page but guards data, and never accepts the token in the URL", async () => {
    assert.equal((await agent().get("/dashboard/")).status, 200);
    assert.equal((await agent().get("/dashboard/config")).status, 401);
    assert.equal((await agent().get("/dashboard/config?token=s3cret-dashboard-token")).status, 401);
    assert.equal((await agent().get("/dashboard/config").set("X-Dashboard-Token", "s3cret-dashboard-token")).status, 200);
  });

  it("exchanges the token for an HttpOnly session cookie", async () => {
    assert.equal((await agent().post("/dashboard/session").send({ token: "wrong" })).status, 401);
    const res = await agent().post("/dashboard/session").send({ token: "s3cret-dashboard-token" });
    assert.equal(res.status, 204);
    const cookie = String(res.headers["set-cookie"]);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.ok(!cookie.includes("s3cret-dashboard-token"), "the cookie is a session id, not the token");
    assert.equal((await agent().get("/dashboard/config").set("Cookie", cookie.split(";")[0]!)).status, 200);
  });
});

describe("gateway client", () => {
  it("never adopts another request's decision on a request_id conflict", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push(`${init.method} ${new URL(url).pathname}`);
      return new Response(JSON.stringify({ error: { code: "conflict", message: "different body" } }), { status: 409 });
    }) as typeof fetch;
    const client = new GatewayClient({ baseUrl: "http://gateway.test", token: "t", fetchImpl });
    const request = { request_id: "req_x", agent_id: "claude:emp_noah", channel: "mcp", employee_id: "emp_noah", merchant: "United Airlines", merchant_category: "airlines", amount_usd: 480, description: "PHL to SFO, economy", justification: "Acme customer meeting", travel: { cabin_class: "economy", origin: "PHL", destination: "SFO" } } as const;
    await assert.rejects(client.submitRequest(request), (err: unknown) => err instanceof GatewayApiError && err.status === 409);
    assert.deepEqual(calls, ["POST /v1/requests"], "no follow-up GET of the other request's decision");
  });
});
