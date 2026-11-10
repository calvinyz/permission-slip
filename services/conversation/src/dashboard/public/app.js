// Live dashboard client. Renders the model (model.js) into four panels.
// All untrusted text (agent messages, merchant names) is inserted with textContent, never as HTML.
import { STEPS, applyAll, apply, chipStatus, createModel, orderedRequests } from "./model.js";

const params = new URLSearchParams(location.search);
const TZ = "America/New_York";

const theme = params.get("theme");
if (theme === "dark" || theme === "light") document.documentElement.dataset.theme = theme;

let model = createModel();
let selected = null;
let follow = true;
const $ = (id) => document.getElementById(id);

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c !== undefined && c !== null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

const money = (n) => (typeof n === "number" && Number.isFinite(n) ? `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "");
const time = (iso) => (iso ? new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: TZ }) : "");
const dayKey = (d) => d.toLocaleDateString("en-US", { timeZone: TZ });
/** Time only when it's today, otherwise "Oct 22, 3:44 PM" (card and mandate expiry run into tomorrow). */
const when = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (dayKey(d) === dayKey(new Date())) return time(iso);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: TZ });
};
/** The gateway's mismatch reasons name contract fields; read them naturally. */
const delta = (from, to) => {
  if (!from || !to) return "";
  // Clamp: the two laptops' clocks can differ slightly, and negative steps look broken on video.
  const ms = Math.max(0, Date.parse(to) - Date.parse(from));
  // Sub-second gaps are noise to a viewer; only show waits that took real time.
  return ms < 1000 ? "" : `+${(ms / 1000).toFixed(1)} s`;
};

// Plain-English names for the gateway's policy rules and checks; the raw id stays as a tooltip.
const RULE_LABELS = {
  "injection.scan": "Prompt-injection scan",
  "employee.exists": "Employee on file",
  "claims.verified": "Claims verified",
  "merchant.blocked": "Merchant allowed",
  "merchant.category": "Merchant category matches",
  "travel.air.details": "Flight details complete",
  "claims.consistency": "Request matches its description",
  "travel.air.class": "Economy cabin",
  "travel.air.cap": "Within the fare limit",
  "travel.lodging.nights": "Nights match the dates",
  "travel.lodging.nightly": "Within the nightly hotel limit",
  "budget.team": "Team budget",
  "approval.auto_limit": "Within the auto-approve limit",
};
const CHECK_LABELS = {
  "employee.exists": "Employee",
  "calendar.meeting": "Meeting on the calendar",
  "price.fare_history": "Fare against recent prices",
};
const ruleLabel = (id) => RULE_LABELS[id] || String(id).replace(/[._]/g, " ");
const checkLabel = (id) => CHECK_LABELS[id] || String(id).replace(/[._]/g, " ");
const resultClass = (r) => (/^(pass|ok|verified|true|match)/i.test(r) ? "pass" : /^(fail|false|blocked|deny|denied|mismatch)/i.test(r) ? "fail" : /^(warn|flag|review|skip|unverified)/i.test(r) ? "warn" : "");
let employees = {};
const person = (id) => (id && employees[id]) || id || "";
const resultIcon = (c) => (c === "pass" ? "✓" : c === "fail" ? "✕" : c === "warn" ? "!" : "·");
const CHANNEL = { sms: "SMS", mcp: "MCP", email: "Email" };

// Line icons (Lucide, ISC licence), drawn with currentColor.
const ICONS = {
  airlines: "M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z",
  lodging: "M2 4v16M2 8h18a2 2 0 0 1 2 2v10M2 17h20M6 8v9",
  conferences: "M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2ZM13 5v2M13 17v2M13 11v2",
  ground_transport: "M8 6v6M15 6v6M2 12h19.6M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3M7 18h7M9 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM19 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z",
  meals: "M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2M7 2v20M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7",
  card: "M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2zM2 10h20",
  inbox: "M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z",
  check: "M20 6 9 17l-5-5",
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4",
  ledger: "M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1ZM16 8h-6M16 12H8M13 16H8",
};
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[name] || ICONS.card);
  svg.append(path);
  return svg;
}
const catIcon = (category) => (ICONS[category] ? category : "card");
const BAD = new Set(["denied", "blocked", "suspended"]);

// ---- clock ----
function tick() {
  const now = new Date();
  $("clock-time").textContent = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: TZ });
  $("clock-date").textContent = `${now.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: TZ })}, Eastern`;
  renderTimer();
}
setInterval(tick, 250);
tick();

// ---- selection ----
function current() {
  const list = orderedRequests(model);
  if (follow || !selected || !model.requests[selected]) selected = list[0]?.id ?? null;
  return selected ? model.requests[selected] : null;
}
function select(id) {
  selected = id;
  follow = false;
  render();
}
function setFollow(on) {
  follow = on;
  $("follow").setAttribute("aria-pressed", String(on));
  render();
}

// ---- render ----
function render() {
  const r = current();
  renderChips(r);
  renderKpis();
  renderHead(r);
  renderSteps(r);
  renderConvo(r);
  renderPolicy(r);
  renderCard(r);
  renderTxn(r);
  renderLog();
}

function renderChips(r) {
  const list = orderedRequests(model);
  const box = $("chips");
  box.replaceChildren(
    ...(list.length
      ? list.map((x) => {
          const st = chipStatus(x);
          const req = x.request || {};
          const agent = model.agents[x.agent_id];
          const who = agent?.label || (x.agent_id || "").split(":")[0];
          return h(
            "button",
            { type: "button", class: "chip", "aria-current": x.id === r?.id ? "true" : "false", onclick: () => select(x.id), title: x.id },
            h("span", { class: `cat${BAD.has(st) ? " alt" : ""}` }, icon(catIcon(req.merchant_category))),
            h("span", { class: "chip-m", text: req.merchant || x.id }),
            h("span", { class: "chip-a", text: money(req.amount_usd) }),
            h("small", { text: [who, time(x.firstTs)].filter(Boolean).join(", ") }),
            h("span", { class: `pill ${st}`, text: st }),
          );
        })
      : [h("span", { class: "empty", text: "Waiting for the first request…" })]),
  );
}

function renderKpis() {
  const list = orderedRequests(model);
  const by = (pred) => list.filter((x) => pred(chipStatus(x), x));
  const approved = by((st) => ["approved", "used", "suspended"].includes(st));
  const stopped = by((st) => ["blocked", "denied"].includes(st));
  const injections = by((st) => st === "blocked");
  const txns = list.flatMap((x) => x.txns || []);
  const coded = txns.filter((t) => t.state === "reconciled");
  const mismatches = txns.filter((t) => t.state === "mismatch");
  const agents = new Set(list.map((x) => x.agent_id).filter(Boolean));
  const sum = (xs, f) => xs.reduce((a, x) => a + (Number(f(x)) || 0), 0);
  const tile = (ic, label, value, note, dark) =>
    h("div", { class: "kpi" }, h("span", { class: `cat${dark ? " dark" : ""}` }, icon(ic)), h("span", { text: label }), h("b", { text: value }), h("small", {}, ...note));
  $("kpis").replaceChildren(
    tile("inbox", "Requests", String(list.length), [`from ${agents.size} agent${agents.size === 1 ? "" : "s"}`]),
    tile("check", "Approved spend", money(sum(approved, (x) => x.request?.amount_usd)) || "$0.00", [h("em", { text: String(approved.length) }), ` request${approved.length === 1 ? "" : "s"} approved`], true),
    tile("shield", "Stopped", String(stopped.length), [h("em", { class: injections.length ? "bad" : "", text: String(injections.length) }), ` injection attempt${injections.length === 1 ? "" : "s"} blocked`]),
    tile("ledger", "Settled and coded", money(sum(coded, (t) => t.amount)) || "$0.00", mismatches.length ? [h("em", { class: "bad", text: String(mismatches.length) }), ` mismatch${mismatches.length === 1 ? "" : "es"} caught`] : ["no receipts needed"]),
  );
}

function renderHead(r) {
  if (!r) {
    $("rq-title").textContent = "No requests yet";
    $("rq-desc").textContent = "Waiting for an agent to ask Permission Slip for approval.";
    $("rq-meta").textContent = "";
    $("rq-amount").textContent = "";
    $("rq-status").replaceChildren();
    $("rq-icon").replaceChildren();
    return;
  }
  const req = r.request || {};
  const agent = model.agents[r.agent_id];
  const employee = r.employee || person(req.employee_id);
  const via = agent ? `${agent.label}${CHANNEL[r.channel] ? ` over ${CHANNEL[r.channel]}` : ""}` : CHANNEL[r.channel] || "";
  $("rq-title").textContent = req.merchant || r.id;
  $("rq-icon").replaceChildren(icon(catIcon(req.merchant_category)));
  $("rq-desc").textContent = req.description || "";
  $("rq-meta").textContent = [employee ? `For ${employee}` : "", via ? `requested by ${via}` : "", r.firstTs ? `at ${time(r.firstTs)}` : ""].filter(Boolean).join(", ").replace(/^requested/, "Requested");
  $("rq-amount").textContent = money(req.amount_usd);
  const st = chipStatus(r);
  $("rq-status").replaceChildren(h("span", { class: `pill big ${st}`, text: st }));
}

function renderSteps(r) {
  let prevTs = r?.submittedTs || r?.firstTs;
  const escalated = Boolean(r?.escalation);
  $("steps").replaceChildren(
    ...STEPS.map((s) => {
      const step = r?.steps[s.key];
      let cls = step ? "done" : "";
      if (s.key === "manager" && !escalated) cls = r?.steps.decided ? "skipped" : "";
      const verdict = r?.policyStatus || r?.status;
      if (s.key === "decided" && step && ["denied", "counter", "escalated"].includes(verdict)) cls += verdict === "denied" ? " bad" : " warn";
      if (s.key === "manager" && r?.escalation?.state === "open") cls = "done warn";
      if (s.key === "reconciled" && step?.type === "txn.mismatch") cls += " bad";
      const label = s.key === "reconciled" && step?.type === "txn.mismatch" ? "Mismatch" : s.key === "decided" && (r?.policyStatus || r?.status) ? (r.policyStatus || r.status)[0].toUpperCase() + (r.policyStatus || r.status).slice(1) : s.label;
      const d = step ? delta(prevTs, step.ts) : "";
      if (step) prevTs = step.ts;
      return h("li", { class: cls }, h("b", { text: label }), h("span", { class: "mono", text: step ? `${time(step.ts)} ${d}` : s.key === "manager" && !escalated && r?.steps.decided ? "not needed" : "—" }));
    }),
  );
}

function renderConvo(r) {
  const box = $("convo");
  const agentId = r?.agent_id || Object.keys(model.convos).at(-1);
  const msgs = agentId ? model.convos[agentId] || [] : [];
  const agent = agentId ? model.agents[agentId] : null;
  $("convo-meta").textContent = agent ? `${agent.label}${CHANNEL[agent.channel] ? `, ${CHANNEL[agent.channel]}` : ""}` : "";
  if (!msgs.length) {
    box.replaceChildren(h("p", { class: "empty-state", text: r ? "This request came in without a conversation (e.g. submitted directly to the API)." : "Waiting for an agent to ask Permission Slip for approval." }));
    return;
  }
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  // Messages tied to a different request are dimmed so the selected request's exchange stands out.
  const other = (m) => Boolean(r && m.request_id && m.request_id !== r.id);
  const initial = (agent?.label || "A").trim()[0].toUpperCase();
  box.replaceChildren(
    ...msgs.map((m) =>
      h(
        "div",
        { class: `turn ${m.dir}${other(m) ? " other" : ""}` },
        m.dir === "in" ? h("span", { class: "avatar", text: initial }) : null,
        h("div", { class: "msg-meta" }, h("span", { text: m.dir === "in" ? agent?.label || "Agent" : "Permission Slip" }), h("span", { text: time(m.ts) }), m.dry_run ? h("span", { class: "warn", text: "dry run" }) : null, m.delivered ? null : h("span", { class: "warn", text: "delivery failed" })),
        h("div", { class: `msg ${m.dir}${m.kind === "followup" ? " followup" : ""}`, text: m.text }),
      ),
    ),
  );
  if (atBottom || follow) box.scrollTop = box.scrollHeight;
}

function renderPolicy(r) {
  const box = $("policy");
  $("policy-version").textContent = r?.policyVersion ? `Policy ${r.policyVersion}` : "";
  if (!r) return box.replaceChildren(h("p", { class: "empty-state", text: "Verification checks and the policy engine's rule-by-rule decision appear here." }));
  const parts = [];
  if (r.injection) {
    const hits = r.injection.hits || [];
    parts.push(
      h(
        "div",
        { class: "callout bad" },
        h("b", { text: "Injection blocked" }),
        "The request tried to instruct the approver. Claims of authority, urgency or prior approval don't change policy.",
        ...hits.slice(0, 3).map((x) => h("div", { style: "font-size:13px;margin-top:6px" }, h("span", { class: "mono", text: x.pattern }), ` in ${x.field}: “${x.excerpt.trim()}”`)),
      ),
    );
  }
  if (r.status) {
    // The policy engine's own verdict; for an escalation, the manager's outcome shows in the callout below.
    const st = chipStatus(r) === "blocked" ? "denied" : r.policyStatus || r.status;
    parts.push(h("div", { class: "verdict" }, h("span", { class: `pill big ${st}`, text: st }), h("p", { text: r.reason || "" })));
  } else {
    parts.push(h("div", { class: "verdict" }, h("span", { class: "pill big pending", text: "deciding" }), h("p", { class: "muted", text: "Waiting for the policy engine…" })));
  }
  if (r.counteroffer) {
    const c = r.counteroffer;
    const text = typeof c === "string" ? c : [c.description, c.merchant && !(c.description || "").includes(c.merchant) ? `at ${c.merchant}` : "", typeof c.amount_usd === "number" ? `for ${money(c.amount_usd)}` : ""].filter(Boolean).join(" ");
    parts.push(h("div", { class: "callout warn" }, h("b", { text: "Counteroffer" }), text));
  }
  if (r.escalation) {
    const e = r.escalation;
    parts.push(
      e.state === "open"
        ? h("div", { class: "callout warn" }, h("b", { text: "Escalated to manager" }), h("span", { class: "spinner", "aria-hidden": "true" }), `Waiting for ${person(e.approver) || "the manager"} in Slack${e.reason ? `. ${e.reason}.` : ""}`)
        : h("div", { class: `callout ${e.decision === "denied" ? "bad" : "good"}` }, h("b", { text: `Manager ${e.decision || "resolved"}` }), `${person(e.by) || "In Slack"} at ${time(e.ts)}${e.note ? `: “${e.note}”` : ""}`),
    );
  }
  if (r.checks.length) {
    parts.push(h("div", {}, h("p", { class: "sub", text: "Claims checked" }), h("ul", { class: "checks" }, ...r.checks.map((c) => { const cls = resultClass(c.result); return h("li", {}, h("span", { class: `ico ${cls}`, text: resultIcon(cls) }), h("div", { title: c.name }, h("span", { text: checkLabel(c.name) }), c.detail ? h("small", { text: c.detail }) : null), h("span", { class: `pill ${cls}`, text: c.result })); }))));
  }
  if (r.trace.length) {
    parts.push(h("div", {}, h("p", { class: "sub", text: "Policy rules" }), h("ul", { class: "trace" }, ...r.trace.map((t) => { const cls = resultClass(String(t.result)); return h("li", {}, h("span", { class: `ico ${cls}`, text: resultIcon(cls) }), h("div", { title: t.rule }, h("span", { text: ruleLabel(t.rule) }), t.detail ? h("small", { text: t.detail }) : null), h("span", { class: `pill ${cls}`, text: String(t.result) })); }))));
  }
  box.replaceChildren(...parts);
}

function renderCard(r) {
  const box = $("card");
  const card = r?.card;
  const mandate = r?.mandate;
  if (!card && !mandate) {
    box.replaceChildren(h("p", { class: "empty-state", text: r && ["denied", "counter", "escalated"].includes(r.status) ? "No card. A card is only issued against a signed mandate." : "When a request is approved, its signed mandate and single-use card appear here." }));
    return;
  }
  const state = card?.state || "pending";
  const vcard = card
    ? h(
        "div",
        { class: `vcard ${state}` },
        h("div", { class: "vcard-top" }, h("span", { text: "Single-use card" }), h("span", { class: "vcard-state", text: state[0].toUpperCase() + state.slice(1) })),
        h("span", { class: "vcard-chip", "aria-hidden": "true" }),
        h("div", { class: "vcard-num", text: `•••• •••• •••• ${card.last4 || (card.card_id || "").slice(-4)}` }),
        h("div", { class: "vcard-bot" }, h("div", {}, "Limit", h("b", { text: money(card.limit_usd) || "—" })), h("div", {}, "Locked to", h("b", { text: card.merchant_lock || "—" })), h("div", {}, "Expires", h("b", { text: card.expires_at ? when(card.expires_at) : "—" }))),
      )
    : h("p", { class: "empty-state", text: "Issuing card…" });
  const sig = mandate && (mandate.signature || mandate.sig);
  const rows = [
    ["Mandate", mandate?.mandate_id || mandate?.id],
    ["Max", typeof mandate?.max_amount_usd === "number" ? money(mandate.max_amount_usd) : typeof mandate?.amount_usd === "number" ? money(mandate.amount_usd) : undefined],
    ["Policy", mandate?.policy_version],
    ["Approved by", mandate?.approved_by ? person(mandate.approved_by) : undefined],
    ["Valid until", mandate?.valid_until ? when(mandate.valid_until) : undefined],

  ].filter(([, v]) => v);
  const IDS = new Set(["Mandate"]);
  const kv = h("dl", { class: "kv" }, ...rows.flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { class: IDS.has(k) ? "id" : undefined, text: String(v) })]), sig ? [h("dt", { text: "Signature" }), h("dd", { class: "sig", text: "Verified", title: `Ed25519 ${String(sig).slice(0, 18)}…` })] : []);
  const extra = card?.state === "suspended" ? h("div", { class: "callout bad" }, h("b", { text: "Card frozen" }), "Charge didn't match.") : null;
  box.replaceChildren(h("div", {}, vcard), h("div", {}, kv, extra));
}

function renderTimer() {
  const r = selected ? model.requests[selected] : null;
  const el = $("card-timer");
  if (!r?.card?.expires_at || r.card.state !== "active") {
    el.textContent = r?.card?.state ? r.card.state[0].toUpperCase() + r.card.state.slice(1) : "";
    return;
  }
  const left = Math.max(0, Math.floor((Date.parse(r.card.expires_at) - Date.now()) / 1000));
  const hrs = Math.floor(left / 3600);
  const mins = Math.floor((left % 3600) / 60);
  el.textContent = hrs ? `expires in ${hrs}h ${String(mins).padStart(2, "0")}m` : `expires in ${mins}:${String(left % 60).padStart(2, "0")}`;
}

function renderTxn(r) {
  const box = $("txn");
  if (!r || !r.txns.length) {
    box.replaceChildren(h("p", { class: "empty-state", text: r?.card ? "Waiting for the merchant to charge the card…" : r && ["denied", "counter"].includes(r.status) ? "Nothing to charge. No card was issued for this request." : "When the card is charged, the settlement is matched to its mandate and coded here." }));
    return;
  }
  const limit = r.card?.limit_usd;
  box.replaceChildren(
    ...r.txns.map((t) => {
      const over = typeof limit === "number" && typeof t.amount === "number" && t.amount > limit + 0.005;
      const pct = typeof limit === "number" && limit > 0 && typeof t.amount === "number" ? Math.min(100, (t.amount / limit) * 100) : 100;
      const coding = t.coding || {};
      return h(
        "div",
        { class: `txn ${t.state}` },
        h("div", { class: "txn-top" }, h("span", { class: "txn-amt", text: money(t.amount) }), h("span", { class: `pill ${t.state}`, text: t.state })),
        t.state === "mismatch" ? h("div", { class: "callout bad" }, h("b", { text: "Mismatch caught" }), `Charged ${money(t.amount)} against a ${money(t.expected ?? limit)} approval. Card frozen; finance alerted${slackOn ? " in Slack" : ""}.`) : null,
        h("div", { class: "muted", text: [t.merchant, t.ts ? `settled at ${time(t.ts)}` : ""].filter(Boolean).join(", ") }),
        typeof limit === "number" ? h("div", {}, h("div", { class: `meter${over ? " over" : ""}` }, h("i", { style: `width:${pct}%` })), h("div", { class: "meter-l" }, h("span", { text: `Charged ${money(t.amount)}` }), h("span", { text: `Mandate max ${money(limit)}` }))) : null,
        t.state === "reconciled"
          ? h("div", {}, h("p", { class: "sub", text: "Auto-coded" }), h("dl", { class: "kv" }, ...[["GL account", coding.gl_account || coding.gl], ["Department", coding.department || coding.dept], ["Memo", coding.memo]].filter(([, v]) => v).flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { text: String(v) })])), h("div", { class: "callout good" }, h("b", { text: "No expense report" }), "Matched to its mandate and coded automatically."))
          : null,
        Array.isArray(t.match) && t.match.length
          ? h("ul", { class: "checks" }, ...t.match.map((c) => { const cls = resultClass(c.result); return h("li", {}, h("span", { class: `ico ${cls}`, text: resultIcon(cls) }), h("div", {}, h("span", { text: c.field.replace(/_/g, " ") }), h("small", { text: c.field === "time_window" ? `settled ${time(c.actual)}` : `expected ${c.expected}, got ${c.actual}` })), h("span", { class: `pill ${cls}`, text: c.result })); }))
          : null,
      );
    }),
  );
}

function renderLog() {
  const pre = $("rawlog-pre");
  if ($("rawlog").hidden) return;
  pre.replaceChildren(
    ...model.log.slice(-60).flatMap((e) => [h("span", { class: "s", text: `${e.ts} ` }), h("span", { class: "t", text: e.type.padEnd(24) }), document.createTextNode(` ${JSON.stringify({ request_id: e.request_id, ...e.data }).slice(0, 400)}\n`)]),
  );
  pre.parentElement.scrollTop = pre.parentElement.scrollHeight;
}

// ---- controls ----
$("follow").addEventListener("click", () => setFollow(!follow));
$("logbtn").addEventListener("click", toggleLog);
function toggleLog() {
  const el = $("rawlog");
  el.hidden = !el.hidden;
  $("logbtn").setAttribute("aria-expanded", String(!el.hidden));
  renderLog();
}
document.addEventListener("keydown", (ev) => {
  if (ev.target instanceof HTMLInputElement || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const list = orderedRequests(model);
  const idx = list.findIndex((x) => x.id === selected);
  if (ev.key === "l" || ev.key === "L") toggleLog();
  else if (ev.key === "f" || ev.key === "F") setFollow(!follow);
  else if (ev.key === "t" || ev.key === "T") {
    const dark = document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "light" : "dark";
  } else if ((ev.key === "n" || ev.key === "N") && !ev.shiftKey && presenter) presenterNext();
  else if (ev.key === "R" && ev.shiftKey && presenter) presenterReset();
  else if ((ev.key === "p" || ev.key === "P") && presenter) togglePresenter();
  else if (ev.key === "ArrowLeft" && idx > 0) select(list[idx - 1].id);
  else if (ev.key === "ArrowRight" && idx >= 0 && idx < list.length - 1) select(list[idx + 1].id);
});

// ---- data ----
async function loadConfig() {
  try {
    const cfg = await (await fetch("config")).json();
    $("company").textContent = cfg.company || "";
    employees = cfg.employees || employees;
    $("brain").textContent = cfg.negotiator ? (cfg.negotiator === "scripted" ? "Scripted negotiator" : "Claude negotiator") : "";
    $("conn-gateway").dataset.state = cfg.gateway_events_connected ? "up" : "down";
    $("conn-gateway").title = cfg.gateway_url || "";
    slackOn = Boolean(cfg.channels?.slack);
    if (cfg.presenter && !presenterBusy) {
      presenter = cfg.presenter;
      renderPresenter();
    }
  } catch {
    $("conn-gateway").dataset.state = "down";
  }
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function connect() {
  const es = new EventSource("stream");
  es.addEventListener("open", () => ($("conn-dash").dataset.state = "up"));
  es.addEventListener("error", () => ($("conn-dash").dataset.state = "down"));
  es.addEventListener("reset", () => {
    leaveRecording();
    model = createModel();
    selected = null;
    scheduleRender();
    showRecording();
  });
  es.addEventListener("snapshot", (ev) => {
    const events = JSON.parse(ev.data);
    if (events.length) {
      leaveRecording();
      model = applyAll(createModel(), events);
      scheduleRender();
    } else if (!showingRecording) {
      model = createModel();
      scheduleRender();
      showRecording();
    }
  });
  es.addEventListener("bus", (ev) => {
    leaveRecording();
    apply(model, JSON.parse(ev.data));
    scheduleRender();
  });
}
// ---- recorded run ----
// With no live data (the service or gateway isn't running, or nothing has happened yet), show a
// recorded run of the demo script, clearly labeled. The first live event replaces it. ?live=1, or
// Shift+R in presenter mode, keeps the view empty instead (for a clean take).
let showingRecording = false;
let recordingAllowed = !params.has("live");

async function showRecording() {
  if (!recordingAllowed || showingRecording) return;
  try {
    const events = await (await fetch("recorded-run.json")).json();
    if (!recordingAllowed) return;
    model = applyAll(createModel(), events);
    selected = null;
    showingRecording = true;
    setRecordingLabel(true);
    scheduleRender();
  } catch {
    /* no recording available */
  }
}

function leaveRecording() {
  if (!showingRecording) return;
  showingRecording = false;
  model = createModel();
  selected = null;
  setRecordingLabel(false);
}

function setRecordingLabel(on) {
  $("replay-tag").hidden = !on;
  $("conn-gateway").hidden = on;
  $("conn-dash").hidden = on;
}

// ---- presenter ----
// With DEMO_PRESENTER=true, N plays the next step of the demo script through the real pipeline.
// P shows the step list (hidden by default, so it stays off camera); Shift+R resets for a new take.
let presenter = null;
let slackOn = false;
let presenterBusy = false;
let presenterError = "";

function presenterPanel() {
  let panel = $("presenter");
  if (!panel) {
    panel = document.createElement("aside");
    panel.id = "presenter";
    panel.className = "presenter";
    panel.hidden = true;
    panel.setAttribute("aria-label", "Presenter steps");
    document.body.append(panel);
  }
  return panel;
}

function renderPresenter() {
  if (!presenter) return;
  const panel = presenterPanel();
  panel.replaceChildren();
  const h = document.createElement("h2");
  h.textContent = `Presenter · ${Math.min(presenter.next + 1, presenter.steps.length)} of ${presenter.steps.length}`;
  const ol = document.createElement("ol");
  presenter.steps.forEach((step, i) => {
    const li = document.createElement("li");
    li.textContent = step.label;
    li.className = step.done ? "done" : i === presenter.next ? (presenterBusy ? "running" : "next") : "";
    ol.append(li);
  });
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = presenter.next >= presenter.steps.length ? "Script finished. Shift+R to reset." : "N next step · Shift+R reset · P hide";
  panel.append(h, ol, hint);
  if (presenterError) {
    const err = document.createElement("p");
    err.className = "error";
    err.textContent = presenterError;
    panel.append(err);
  }
}

function togglePresenter() {
  const panel = presenterPanel();
  panel.hidden = !panel.hidden;
  renderPresenter();
}

async function presenterNext() {
  if (presenterBusy || presenter.next >= presenter.steps.length) return;
  presenterBusy = true;
  presenterError = "";
  renderPresenter();
  try {
    const res = await fetch("presenter/next", { method: "POST" });
    const body = await res.json();
    presenter = { next: body.next, running: body.running, steps: body.steps };
    if (res.status === 502) {
      presenterError = body.error || "That step failed.";
      presenterPanel().hidden = false;
    }
  } catch {
    presenterError = "Couldn't reach the service.";
    presenterPanel().hidden = false;
  } finally {
    presenterBusy = false;
    renderPresenter();
  }
}

async function presenterReset() {
  presenterError = "";
  recordingAllowed = false;
  const res = await fetch("presenter/reset", { method: "POST" }).catch(() => undefined);
  if (res?.ok) presenter = await res.json();
  renderPresenter();
}

// ---- access ----
// With DASHBOARD_TOKEN set, the token is exchanged once for an HttpOnly session cookie.
function showSignIn() {
  if ($("signin")) return;
  const form = document.createElement("form");
  form.id = "signin";
  form.className = "signin";
  form.innerHTML = '<h2>Permission Slip dashboard</h2><label for="signin-token">Dashboard token</label><input id="signin-token" type="password" autocomplete="current-password" required><button type="submit">Open dashboard</button><p id="signin-error" role="alert"></p>';
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const res = await fetch("session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: $("signin-token").value }) });
    if (!res.ok) {
      $("signin-error").textContent = "That token was not accepted.";
      return;
    }
    form.remove();
    start();
  });
  document.body.append(form);
  $("signin-token").focus();
}

let started = false;
async function start() {
  const res = await fetch("config").catch(() => undefined);
  if (res?.status === 401) return showSignIn();
  // No service answering (or a static copy of the page): show the recorded run, keep trying live.
  if (!res?.ok) showRecording();
  if (started) return;
  started = true;
  loadConfig();
  setInterval(loadConfig, 5000);
  connect();
}

render();
start();
