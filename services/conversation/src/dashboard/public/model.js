// Dashboard state model: folds the event stream into per-request state.
// Pure functions, no DOM, so test/dashboard-model.test.ts can run them in Node.
// Ramp-side payload shapes are read defensively: the spec names the events but not every field.

export const STEPS = [
  { key: "received", label: "Received", types: ["agent.request.submitted", "request.received"] },
  { key: "verified", label: "Verified", types: ["claims.verified"] },
  { key: "decided", label: "Decided", types: ["policy.decided"] },
  { key: "manager", label: "Manager", types: ["escalation.opened", "escalation.resolved"], optional: true },
  { key: "mandate", label: "Mandate", types: ["mandate.signed"] },
  { key: "card", label: "Card", types: ["card.issued"] },
  { key: "settled", label: "Settled", types: ["txn.settled"] },
  { key: "reconciled", label: "Reconciled", types: ["txn.reconciled", "txn.mismatch"] },
];

export function createModel() {
  return { requests: {}, order: [], convos: {}, agents: {}, cardToRequest: {}, log: [], errors: [] };
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" && v.length ? v : undefined);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);

function ensure(m, id, ts) {
  if (!m.requests[id]) {
    m.requests[id] = { id, firstTs: ts, lastTs: ts, steps: {}, txns: [], checks: [], trace: [], errors: [] };
    m.order.push(id);
  }
  return m.requests[id];
}

export function requestIdFor(m, e) {
  const d = e.data || {};
  return (
    str(e.request_id) ||
    str(d.request_id) ||
    (isObj(d.request) && str(d.request.request_id)) ||
    m.cardToRequest[str(d.card_id) || ""] ||
    (isObj(d.card) && m.cardToRequest[str(d.card.card_id) || ""]) ||
    (isObj(d.transaction) && (str(d.transaction.request_id) || m.cardToRequest[str(d.transaction.card_id) || ""])) ||
    (isObj(d.escalation) && str(d.escalation.request_id)) ||
    undefined
  );
}

function normalizeChecks(d) {
  const raw = Array.isArray(d.verification) ? d.verification : Array.isArray(d.checks) ? d.checks : Array.isArray(d.results) ? d.results : null;
  if (raw) {
    return raw.map((c) => ({
      name: str(c.check) || str(c.name) || str(c.type) || "check",
      result: str(c.result) || str(c.status) || (c.ok === true || c.passed === true ? "pass" : c.ok === false || c.passed === false ? "fail" : "info"),
      detail: str(c.detail) || str(c.details) || str(c.message) || "",
    }));
  }
  // Object form: { calendar: {...}, fare: {...} } or { calendar: "pass" }
  return Object.entries(d)
    .filter(([k]) => !["request_id", "request", "ts"].includes(k))
    .map(([k, v]) => ({
      name: k,
      result: isObj(v) ? str(v.result) || str(v.status) || (v.ok ? "pass" : "info") : typeof v === "boolean" ? (v ? "pass" : "fail") : String(v),
      detail: isObj(v) ? str(v.detail) || str(v.message) || "" : "",
    }));
}

function txn(r, d) {
  const id = str(d.txn_id) || str(d.transaction_id) || str(d.id) || `t${r.txns.length}`;
  let t = r.txns.find((x) => x.id === id);
  if (!t) {
    t = { id, state: "settled" };
    r.txns.push(t);
  }
  return t;
}

export function apply(m, e) {
  m.log.push(e);
  if (m.log.length > 400) m.log.splice(0, m.log.length - 400);
  const d = e.data || {};

  if (e.type === "agent.message.in" || e.type === "agent.message.out") {
    const agentId = str(d.agent_id) || "unknown";
    m.agents[agentId] = { label: str(d.agent_label) || agentId, kind: str(d.agent_kind), channel: str(d.channel), employee: str(d.employee_name) || m.agents[agentId]?.employee };
    const convo = (m.convos[agentId] ||= []);
    const rid0 = str(e.request_id);
    // A reply tied to a request claims the untagged messages just before it (the agent's ask and
    // any follow-up questions), so the whole exchange is grouped with that request.
    if (rid0 && e.type === "agent.message.out") {
      for (let i = convo.length - 1; i >= 0 && !convo[i].request_id; i--) convo[i].request_id = rid0;
    }
    convo.push({ dir: e.type.endsWith(".in") ? "in" : "out", text: String(d.text ?? ""), ts: e.ts, channel: str(d.channel), kind: str(d.kind), dry_run: d.dry_run === true, delivered: d.delivered !== false, request_id: rid0 });
    if (convo.length > 200) convo.shift();
    const rid = str(e.request_id);
    if (rid && m.requests[rid]) m.requests[rid].lastTs = e.ts;
    return m;
  }
  if (e.type === "agent.error") {
    m.errors.push({ ts: e.ts, ...d });
    if (m.errors.length > 50) m.errors.shift();
    return m;
  }

  const id = requestIdFor(m, e);
  if (!id) return m;
  const r = ensure(m, id, e.ts);
  r.lastTs = e.ts;
  for (const s of STEPS) if (s.types.includes(e.type)) r.steps[s.key] = r.steps[s.key] || { ts: e.ts, type: e.type };

  switch (e.type) {
    case "agent.request.submitted":
    case "request.received": {
      const req = isObj(d.request) ? d.request : d;
      r.request = { ...(r.request || {}), ...req };
      r.agent_id = r.agent_id || str(d.agent_id) || str(req.agent_id);
      r.employee = r.employee || str(d.employee_name);
      r.channel = r.channel || str(d.channel) || str(req.channel);
      if (e.type === "agent.request.submitted") r.submittedTs = e.ts;
      break;
    }
    case "claims.verified":
      r.checks = normalizeChecks(d);
      break;
    case "policy.decided": {
      const dec = isObj(d.decision) ? d.decision : d;
      r.status = str(dec.status) || r.status;
      r.policyStatus = str(dec.status) || r.policyStatus;
      r.reason = str(dec.reason) || r.reason;
      r.trace = Array.isArray(dec.policy_trace) ? dec.policy_trace : Array.isArray(dec.trace) ? dec.trace : r.trace;
      r.counteroffer = dec.counteroffer ?? null;
      r.policyVersion = str(dec.policy_version) || str(d.policy_version);
      r.decidedTs = e.ts;
      break;
    }
    case "escalation.opened": {
      const esc = isObj(d.escalation) ? d.escalation : d;
      r.escalation = { state: "open", ts: e.ts, approver: str(esc.approver_id) || str(d.manager), reason: str(esc.reason) || str(d.reason), id: str(esc.escalation_id) };
      r.status = r.status || "escalated";
      break;
    }
    case "escalation.resolved": {
      const esc = isObj(d.escalation) ? d.escalation : d;
      const dec = str(esc.status) || str(d.decision) || str(d.outcome);
      r.escalation = { ...(r.escalation || {}), state: "resolved", ts: e.ts, decision: dec === "approve" ? "approved" : dec === "deny" ? "denied" : dec, by: str(esc.approver_id) || str(d.resolved_by), note: str(esc.note) };
      if (r.escalation.decision === "denied") r.status = "denied";
      break;
    }
    case "mandate.signed":
      r.mandate = { ...(isObj(d.mandate) ? d.mandate : d), ts: e.ts };
      break;
    case "card.issued": {
      const card = isObj(d.card) ? d.card : d;
      r.card = { ...card, state: card.status && card.status !== "active" ? card.status : "active", ts: e.ts };
      if (str(card.card_id)) m.cardToRequest[card.card_id] = id;
      if (!r.mandate && str(d.mandate_id)) r.mandate = { mandate_id: d.mandate_id };
      r.status = "approved";
      break;
    }
    case "txn.settled": {
      const x = isObj(d.transaction) ? d.transaction : d;
      const t = txn(r, x);
      Object.assign(t, { amount: num(x.amount_usd) ?? num(x.amount), merchant: str(x.merchant), ts: e.ts });
      break;
    }
    case "txn.reconciled": {
      const x = isObj(d.transaction) ? d.transaction : d;
      const t = txn(r, x);
      Object.assign(t, { state: "reconciled", amount: t.amount ?? num(x.amount_usd), merchant: t.merchant ?? str(x.merchant), match: Array.isArray(x.match) ? x.match : t.match, coding: isObj(x.coding) ? x.coding : { gl_account: str(x.gl_account), department: str(x.department), memo: str(x.memo) }, reconciledTs: e.ts });
      if (r.card && r.card.state === "active") r.card.state = "used";
      break;
    }
    case "txn.mismatch": {
      const x = isObj(d.transaction) ? d.transaction : d;
      const t = txn(r, x);
      const failed = Array.isArray(x.match) ? x.match.filter((c) => c.result === "mismatch") : [];
      Object.assign(t, {
        state: "mismatch",
        amount: t.amount ?? num(x.amount_usd),
        merchant: t.merchant ?? str(x.merchant),
        match: Array.isArray(x.match) ? x.match : t.match,
        expected: num(x.expected_max_usd) ?? num(x.expected_usd),
        reason: str(x.reason) || failed.map((c) => `${c.field.replace(/_/g, " ")}: expected ${c.expected}, got ${c.actual}`).join("; "),
        mismatchTs: e.ts,
      });
      break;
    }
    case "card.suspended": {
      const card = isObj(d.card) ? d.card : {};
      r.card = { ...(r.card || {}), ...card, state: "suspended", suspendedReason: str(d.reason), suspendedTs: e.ts };
      break;
    }
    case "injection.blocked": {
      const hit = { pattern: str(d.pattern) || "", field: str(d.field) || "", excerpt: str(d.excerpt) || "" };
      r.injection = { ts: e.ts, hits: [...((r.injection && r.injection.hits) || []), hit], pattern: hit.excerpt || hit.pattern };
      r.status = r.status || "denied";
      break;
    }
  }
  return m;
}

export function applyAll(m, events) {
  for (const e of events) apply(m, e);
  return m;
}

/** Status shown on the request chip. */
export function chipStatus(r) {
  if (r.card && r.card.state === "suspended") return "suspended";
  if (r.txns.some((t) => t.state === "mismatch")) return "mismatch";
  if (r.injection) return "blocked";
  if (r.escalation && r.escalation.state === "open" && r.status !== "approved" && r.status !== "denied") return "escalated";
  return r.status || "pending";
}

/** Requests newest first. */
export function orderedRequests(m) {
  return m.order.map((id) => m.requests[id]).sort((a, b) => (b.firstTs || "").localeCompare(a.firstTs || ""));
}
