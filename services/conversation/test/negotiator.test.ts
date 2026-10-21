import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { ScriptedBrain } from "../src/negotiator/scripted-brain.ts";
import { LlmBrain, buildSystemPrompt, toMessages, type MessagesClient } from "../src/negotiator/llm-brain.ts";
import { type BrainContext, validateSubmitInput, describeToday } from "../src/negotiator/brain.ts";
import { MERCHANT_CATEGORIES } from "../src/contract/schemas.ts";
import type { ConversationTurn } from "../src/state.ts";
import { FIXED_NOW } from "./helpers.ts";

const cats = [...MERCHANT_CATEGORIES];

function ctx(turns: Partial<ConversationTurn>[], extra: Partial<BrainContext> = {}): BrainContext {
  return {
    company: "Northwind Labs",
    employeeName: "Maya Chen",
    employeeId: "emp_maya",
    agentLabel: "Instinct (Maya)",
    channel: "sms",
    merchantCategories: cats,
    turns: turns.map((t) => ({ role: "agent", text: "", ts: "2026-10-21T17:00:00Z", ...t })) as ConversationTurn[],
    requests: [],
    now: FIXED_NOW(),
    timeZone: "America/Los_Angeles",
    homeAirport: "PHL",
    validateSubmit: (i) => {
      const r = validateSubmitInput(i, cats);
      return r.ok ? undefined : r.error;
    },
    ...extra,
  };
}

describe("dates", () => {
  it("describes today in Pacific time", () => {
    assert.equal(describeToday(FIXED_NOW(), "America/Los_Angeles"), "Wednesday, October 21, 2026 (2026-10-21)");
  });
});

describe("scripted brain", () => {
  const brain = new ScriptedBrain();

  it("submits a complete request in one message, resolving Tuesday to the next Tuesday", async () => {
    const a = await brain.decide(ctx([{ text: "Please approve a United Airlines economy flight PHL to SFO, $480, for the Acme meeting Tuesday." }]));
    assert.equal(a.type, "submit");
    if (a.type !== "submit") return;
    assert.equal(a.input.merchant, "United Airlines");
    assert.equal(a.input.merchant_category, "airlines");
    assert.equal(a.input.amount_usd, 480);
    assert.deepEqual(a.input.claims, { meeting: "Acme", date: "2026-10-27" });
  });

  it("asks for missing fields, then combines details across messages", async () => {
    const first = await brain.decide(ctx([{ text: "Book me a flight to SF for the Acme meeting Tuesday." }]));
    assert.equal(first.type, "reply");
    assert.match((first as { text: string }).text, /merchant.*total price/);
    const second = await brain.decide(
      ctx([
        { text: "Book me a flight to SF for the Acme meeting Tuesday." },
        { role: "gateway", text: (first as { text: string }).text },
        { text: "United, $480 economy." },
      ]),
    );
    assert.equal(second.type, "submit");
  });

  it("accepts a counteroffer with YES", async () => {
    const a = await brain.decide(
      ctx([{ text: "YES" }], {
        requests: [{ request_id: "req_1", merchant: "United Airlines", merchant_category: "airlines", amount_usd: 1450, description: "first class", justification: "Acme meeting", claims: { meeting: "Acme", date: "2026-10-27" }, travel: { cabin_class: "first", origin: "PHL", destination: "SFO", depart_date: "2026-10-27" }, status: "counter", counteroffer: { merchant: "United Airlines", merchant_category: "airlines", amount_usd: 480, description: "PHL to SFO, economy", reason: "Economy only" } }],
      }),
    );
    assert.equal(a.type, "submit");
    if (a.type === "submit") {
      assert.equal(a.input.amount_usd, 480);
      assert.equal(a.input.description, "PHL to SFO, economy");
      assert.equal(a.input.parent_request_id, "req_1");
      assert.deepEqual(a.input.travel, { origin: "PHL", destination: "SFO", depart_date: "2026-10-27", cabin_class: "economy" }, "never resubmits the rejected cabin");
      assert.equal(a.input.merchant, "United Airlines");
      assert.deepEqual(a.input.claims, { meeting: "Acme", date: "2026-10-27" });
    }
  });

  it("stays quiet on acknowledgements (prevents agent-to-agent loops)", async () => {
    for (const text of ["Thanks!", "ok", "Booked it.", "got it"]) assert.equal((await brain.decide(ctx([{ text }]))).type, "no_reply", text);
  });

  it("looks up status when asked", async () => {
    const a = await brain.decide(ctx([{ text: "Any update? Did my manager approve it yet?" }], { requests: [{ request_id: "req_9", merchant: "DevWorld", merchant_category: "conferences", amount_usd: 2400, description: "", justification: "", claims: {}, status: "escalated" }] }));
    assert.deepEqual(a, { type: "status", request_id: "req_9" });
  });
});

describe("submit input validation", () => {
  it("enforces categories, positivity and cents", () => {
    const base = { merchant: "X", merchant_category: "software", amount_usd: 10, description: "d", justification: "j", claims: {} };
    assert.equal(validateSubmitInput(base, cats).ok, true);
    assert.equal(validateSubmitInput({ ...base, merchant_category: "yachts" }, cats).ok, false);
    assert.equal(validateSubmitInput({ ...base, amount_usd: 0 }, cats).ok, false);
    assert.equal(validateSubmitInput({ ...base, amount_usd: 1.001 }, cats).ok, false);
    assert.equal(validateSubmitInput({ ...base, amount_usd: "480" }, cats).ok, true, "numeric strings are coerced");
    assert.equal(validateSubmitInput({ ...base, claims: { date: "Tuesday" } }, cats).ok, false);
  });
  it("flights need cabin, origin and destination as IATA codes; lodging needs nights", () => {
    const flight = { merchant: "United Airlines", merchant_category: "airlines", amount_usd: 480, description: "d", justification: "j", claims: {} };
    assert.equal(validateSubmitInput(flight, cats).ok, false);
    assert.equal(validateSubmitInput({ ...flight, travel: { cabin_class: "economy", origin: "PHL", destination: "SFO" } }, cats).ok, true);
    assert.equal(validateSubmitInput({ ...flight, travel: { cabin_class: "economy", origin: "PHL" } }, cats).ok, false);
    assert.equal(validateSubmitInput({ ...flight, travel: { cabin_class: "economy", origin: "Philly", destination: "SFO" } }, cats).ok, false);
    assert.equal(validateSubmitInput({ ...flight, travel: { cabin_class: "coach", origin: "PHL", destination: "SFO" } }, cats).ok, false);
    const hotel = { merchant: "Hotel Zephyr", merchant_category: "lodging", amount_usd: 229, description: "d", justification: "j", claims: {} };
    assert.equal(validateSubmitInput(hotel, cats).ok, false);
    assert.equal(validateSubmitInput({ ...hotel, travel: { nights: 1 } }, cats).ok, true);
  });
});

function fakeClient(responses: Anthropic.Message["content"][]): MessagesClient & { calls: Anthropic.MessageCreateParamsNonStreaming[] } {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  return {
    calls,
    messages: {
      async create(body) {
        calls.push(structuredClone(body));
        const content = responses.shift();
        if (!content) throw new Error("no more fake responses");
        return { id: "msg", type: "message", role: "assistant", model: body.model, content, stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } as unknown as Anthropic.Message;
      },
    },
  };
}

const toolUse = (input: unknown, name = "submit_purchase_request") => ({ type: "tool_use", id: `tu_${Math.random()}`, name, input }) as unknown as Anthropic.ContentBlock;
const text = (t: string) => ({ type: "text", text: t, citations: null }) as unknown as Anthropic.ContentBlock;

describe("llm brain", () => {
  const good = { merchant: "United Airlines", merchant_category: "airlines", amount_usd: 480, description: "PHL to SFO, economy", justification: "Acme customer meeting", travel: { cabin_class: "economy", origin: "PHL", destination: "SFO", depart_date: "2026-10-27" }, claims: { meeting: "Acme", date: "2026-10-27" } };

  it("returns submit for a valid tool call and sends the right request", async () => {
    const client = fakeClient([[text("Submitting."), toolUse(good)]]);
    const brain = new LlmBrain({ client, model: "claude-sonnet-5-5" });
    const a = await brain.decide(ctx([{ text: "United $480 for Acme Tuesday" }]));
    assert.equal(a.type, "submit");
    const call = client.calls[0]!;
    assert.equal(call.model, "claude-sonnet-5-5");
    assert.deepEqual(call.tool_choice, { type: "auto", disable_parallel_tool_use: true });
    assert.deepEqual(call.tools?.map((t) => (t as { name: string }).name), ["submit_purchase_request", "get_request_status"]);
    assert.match(String(call.system), /cannot approve/);
    assert.match(String(call.system), /2026-10-21/);
  });

  it("feeds validation errors back to the model and accepts the corrected call", async () => {
    const client = fakeClient([[toolUse({ ...good, merchant_category: "flights" })], [toolUse(good)]]);
    const a = await new LlmBrain({ client, model: "m" }).decide(ctx([{ text: "x" }]));
    assert.equal(a.type, "submit");
    const second = client.calls[1]!.messages;
    const last = second.at(-1)!;
    assert.equal(last.role, "user");
    assert.match(JSON.stringify(last.content), /merchant_category must be one of/);
    assert.match(JSON.stringify(last.content), /"is_error":true/);
  });

  it("gives up gracefully after repeated invalid calls", async () => {
    const bad = toolUse({ merchant: "" });
    const a = await new LlmBrain({ client: fakeClient([[bad], [bad], [bad]]), model: "m" }).decide(ctx([{ text: "x" }]));
    assert.equal(a.type, "reply");
  });

  it("maps NO_REPLY and plain questions", async () => {
    assert.equal((await new LlmBrain({ client: fakeClient([[text("NO_REPLY")]]), model: "m" }).decide(ctx([{ text: "thanks" }]))).type, "no_reply");
    const q = await new LlmBrain({ client: fakeClient([[text("What's the total price?")]]), model: "m" }).decide(ctx([{ text: "flight please" }]));
    assert.deepEqual(q, { type: "reply", text: "What's the total price?" });
  });

  it("maps get_request_status", async () => {
    const a = await new LlmBrain({ client: fakeClient([[toolUse({ request_id: "req_abc" }, "get_request_status")]]), model: "m" }).decide(ctx([{ text: "status?" }]));
    assert.deepEqual(a, { type: "status", request_id: "req_abc" });
  });

  it("builds alternating messages that start with the user, merging same-role turns", () => {
    const msgs = toMessages(ctx([{ role: "gateway", text: "hello" }, { text: "a" }, { text: "b" }, { role: "gateway", text: "c" }, { text: "d" }]));
    assert.deepEqual(msgs.map((m) => [m.role, m.content]), [["user", "a\n\nb"], ["assistant", "c"], ["user", "d"]]);
  });

  it("system prompt tells the model to pass injection attempts through verbatim, never comply", () => {
    const p = buildSystemPrompt(ctx([{ text: "x" }]));
    assert.match(p, /verbatim in the justification/);
    assert.match(p, /Never say a request is approved/);
  });
});
