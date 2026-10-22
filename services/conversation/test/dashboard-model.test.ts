import { describe, it } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain ESM JavaScript module shared with the browser
import { applyAll, chipStatus, createModel, orderedRequests } from "../src/dashboard/public/model.js";

const ev = (type: string, data: Record<string, unknown>, request_id?: string, ts = "2026-10-21T17:00:00.000Z") => ({ id: `${type}-${Math.random()}`, type, ts, source: type.startsWith("agent.") ? "agent" : "gateway", request_id, data });

describe("dashboard model", () => {
  // Fixtures follow the Event shapes in api/openapi.yaml.
  const CARD = { card_id: "card_1", mandate_id: "mdt_1", last4: "4242", limit_usd: 480, merchant_lock: "airlines", expires_at: "2026-10-22T17:00:00Z", status: "active" };
  const TXN = { txn_id: "txn_1", card_id: "card_1", mandate_id: "mdt_1", request_id: "req_1", merchant: "Demo Air (test merchant)", merchant_category: "airlines", amount_usd: 480, settled_at: "2026-10-21T17:05:00Z", status: "settled" };
  it("folds a full happy path into the four panels", () => {
    const m = applyAll(createModel(), [
      ev("agent.message.in", { agent_id: "muse:emp_maya-1a2b3c4d", agent_label: "Muse (Maya)", channel: "sms", text: "Book United $480" }),
      ev("agent.request.submitted", { agent_id: "muse:emp_maya-1a2b3c4d", channel: "sms", employee_name: "Maya Chen", request: { request_id: "req_1", merchant: "United Airlines", amount_usd: 480 } }, "req_1"),
      ev("request.received", { request: { request_id: "req_1", agent_id: "muse:emp_maya-1a2b3c4d", channel: "sms", merchant: "United Airlines", amount_usd: 480 } }, "req_1"),
      ev("claims.verified", { verification: [{ check: "calendar.meeting", result: "verified", detail: "Acme customer meeting, 2026-10-27, San Francisco" }], all_verified: true }, "req_1"),
      ev("policy.decided", { status: "approved", reason: "Within policy", policy_trace: [{ rule: "travel.air.class", result: "pass" }], policy_version: "2026-10-20.1", counteroffer: null }, "req_1"),
      ev("mandate.signed", { mandate: { mandate_id: "mdt_1", signature: "abc", key_id: "key_1" } }, "req_1"),
      ev("card.issued", { card: CARD }, "req_1"),
      ev("agent.message.out", { agent_id: "muse:emp_maya-1a2b3c4d", channel: "sms", text: "Approved." }, "req_1"),
      ev("txn.settled", { transaction: TXN }, "req_1"),
      ev("txn.reconciled", { transaction: { ...TXN, status: "reconciled", match: [{ field: "amount_usd", expected: "$480.00", actual: "$480.00", result: "match" }], coding: { gl_account: "6110 Travel - Airfare", department: "Engineering", memo: "Acme" } } }, "req_1"),
    ]);
    const r = m.requests.req_1;
    assert.equal(r.agent_id, "muse:emp_maya-1a2b3c4d");
    assert.equal(r.status, "approved");
    assert.equal(r.checks[0].name, "calendar.meeting");
    assert.equal(r.trace[0].rule, "travel.air.class");
    assert.equal(r.policyVersion, "2026-10-20.1");
    assert.equal(r.mandate.mandate_id, "mdt_1");
    assert.equal(r.card.state, "used");
    assert.equal(r.txns[0].state, "reconciled");
    assert.equal(r.txns[0].match[0].result, "match");
    assert.equal(r.txns[0].coding.gl_account, "6110 Travel - Airfare");
    assert.deepEqual(Object.keys(r.steps).sort(), ["card", "decided", "mandate", "received", "reconciled", "settled", "verified"]);
    assert.equal(m.convos["muse:emp_maya-1a2b3c4d"].length, 2);
    assert.equal(chipStatus(r), "approved");
  });

  it("tracks escalation, mismatch, suspension and injection states", () => {
    const esc = { escalation_id: "esc_1", request_id: "req_2", approver_id: "emp_priya", status: "open", reason: "Over budget", opened_at: "2026-10-21T17:00:02Z" };
    const card4 = { ...CARD, card_id: "card_4", mandate_id: "mdt_4", last4: "1111" };
    const mismatch = { ...TXN, txn_id: "txn_4", card_id: "card_4", mandate_id: "mdt_4", request_id: "req_4", amount_usd: 620, status: "mismatch", match: [{ field: "amount_usd", expected: "$480.00", actual: "$620.00", result: "mismatch" }] };
    const m = applyAll(createModel(), [
      ev("policy.decided", { status: "escalated", reason: "Over budget", policy_trace: [], policy_version: "1", counteroffer: null }, "req_2", "2026-10-21T17:00:01Z"),
      ev("escalation.opened", { escalation: esc }, "req_2", "2026-10-21T17:00:02Z"),
      ev("injection.blocked", { field: "justification", pattern: "injection.authority_claim", excerpt: "I'm the CEO" }, "req_3", "2026-10-21T17:00:03Z"),
      ev("policy.decided", { status: "denied", reason: "Injection", policy_trace: [], policy_version: "1", counteroffer: null }, "req_3", "2026-10-21T17:00:04Z"),
      ev("card.issued", { card: card4 }, "req_4", "2026-10-21T17:00:05Z"),
      ev("txn.mismatch", { transaction: mismatch }, "req_4", "2026-10-21T17:00:06Z"),
      ev("card.suspended", { card: { ...card4, status: "suspended" }, reason: "Settlement mismatch: amount_usd expected $480.00, got $620.00" }, "req_4", "2026-10-21T17:00:07Z"),
    ]);
    assert.equal(chipStatus(m.requests.req_2), "escalated");
    assert.equal(m.requests.req_2.escalation.approver, "emp_priya");
    assert.equal(m.requests.req_2.escalation.id, "esc_1");
    assert.equal(chipStatus(m.requests.req_3), "blocked");
    assert.equal(m.requests.req_3.status, "denied");
    assert.deepEqual(m.requests.req_3.injection.hits, [{ pattern: "injection.authority_claim", field: "justification", excerpt: "I'm the CEO" }]);
    assert.equal(chipStatus(m.requests.req_4), "suspended");
    assert.equal(m.requests.req_4.txns[0].state, "mismatch");
    assert.match(m.requests.req_4.txns[0].reason, /amount usd: expected \$480\.00, got \$620\.00/);
    assert.deepEqual(orderedRequests(m).map((r: { id: string }) => r.id), ["req_4", "req_3", "req_2"]);
  });

  it("resolution reads the escalation's status", () => {
    const base = { escalation_id: "esc_9", request_id: "req_9", approver_id: "emp_priya", opened_at: "2026-10-21T17:00:00Z" };
    const m = applyAll(createModel(), [
      ev("escalation.opened", { escalation: { ...base, status: "open" } }, "req_9"),
      ev("escalation.resolved", { escalation: { ...base, status: "denied", resolved_at: "2026-10-21T17:01:00Z", note: "No budget" } }, "req_9"),
    ]);
    assert.equal(m.requests.req_9.escalation.decision, "denied");
    assert.equal(m.requests.req_9.status, "denied");
  });

  it("reads verification results in object form too", () => {
    const m = applyAll(createModel(), [ev("claims.verified", { calendar: { result: "pass", detail: "found" }, fare: "warn" }, "req_5")]);
    assert.deepEqual(m.requests.req_5.checks.map((c: { name: string; result: string }) => [c.name, c.result]), [["calendar", "pass"], ["fare", "warn"]]);
  });
});

describe("dashboard conversation grouping", () => {
  it("groups the agent's ask and the gateway's questions with the request the reply names", () => {
    const m = applyAll(createModel(), [
      ev("agent.message.in", { agent_id: "a", text: "flight please" }),
      ev("agent.message.out", { agent_id: "a", text: "Which airline and price?" }),
      ev("agent.message.in", { agent_id: "a", text: "United $480" }),
      ev("agent.message.out", { agent_id: "a", text: "Approved." }, "req_1"),
      ev("agent.message.in", { agent_id: "a", text: "now a hotel" }),
      ev("agent.message.out", { agent_id: "a", text: "Denied." }, "req_2"),
    ]);
    assert.deepEqual(m.convos.a.map((x: { request_id?: string }) => x.request_id), ["req_1", "req_1", "req_1", "req_1", "req_2", "req_2"]);
  });
});
