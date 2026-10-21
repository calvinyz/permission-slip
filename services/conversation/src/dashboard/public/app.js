// Live dashboard client. Renders the model (model.js) into four panels.
// All untrusted text (agent messages, merchant names) is inserted with textContent, never as HTML.
import { STEPS, applyAll, apply, chipStatus, createModel, orderedRequests } from "./model.js";

const params = new URLSearchParams(location.search);
const token = params.get("token");
const qs = token ? `?token=${encodeURIComponent(token)}` : "";
const TZ = "America/Los_Angeles";

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
const humanize = (text) => String(text || "").replace(/\bamount_usd\b/g, "amount").replace(/\bmerchant_category\b/g, "merchant category").replace(/\btime_window\b/g, "time window");
const delta = (from, to) => {
  if (!from || !to) return "";
  // Clamp: the two laptops' clocks can differ slightly, and negative steps look broken on video.
  const ms = Math.max(0, Date.parse(to) - Date.parse(from));
  return ms < 1000 ? `+${ms} ms` : `+${(ms / 1000).toFixed(1)} s`;
};
const resultClass = (r) => (/^(pass|ok|verified|true|match)/i.test(r) ? "pass" : /^(fail|false|blocked|deny|denied|mismatch)/i.test(r) ? "fail" : /^(warn|flag|review|skip|unverified)/i.test(r) ? "warn" : "");
let employees = {};
const person = (id) => (id && employees[id]) || id || "";
const resultIcon = (c) => (c === "pass" ? "✓" : c === "fail" ? "✕" : c === "warn" ? "!" : "·");
const CHANNEL = { sms: "SMS", mcp: "MCP", email: "Email" };

// ---- clock ----
function tick() {
  const now = new Date();
  $("clock-time").textContent = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: TZ });
  $("clock-date").textContent = `${now.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: TZ })} · PT`;
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
          return h(
            "button",
            { type: "button", class: "chip", "aria-current": x.id === r?.id ? "true" : "false", onclick: () => select(x.id), title: x.id },
            h("b", { text: req.merchant || x.id }),
            h("span", { class: `pill ${st}`, text: st }),
            h("small", { text: [money(req.amount_usd), agent?.kind || (x.agent_id || "").split(":")[0], CHANNEL[x.channel] || x.channel, time(x.firstTs)].filter(Boolean).join(" · ") }),
          );
        })
      : [h("span", { class: "empty", text: "Waiting for the first request…" })]),
  );
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
  $("convo-meta").textContent = agent ? [agent.label, CHANNEL[agent.channel] || agent.channel].filter(Boolean).join(" · ") : "";
  if (!msgs.length) {
    box.replaceChildren(h("p", { class: "empty-state", text: r ? "This request came in without a conversation (e.g. submitted directly to the API)." : "Text the gateway number, or call request_purchase from Claude, to start." }));
    return;
  }
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  // Messages tied to a different request are dimmed so the selected request's exchange stands out.
  const other = (m) => Boolean(r && m.request_id && m.request_id !== r.id);
  box.replaceChildren(
    ...msgs.flatMap((m) => [
      h("div", { class: `msg-meta ${m.dir}${other(m) ? " other" : ""}` }, h("span", { text: m.dir === "in" ? agent?.label || "Agent" : "Permission Slip" }), h("span", { text: time(m.ts) }), m.dry_run ? h("span", { class: "warn", text: "not sent (dry run)" }) : null, m.delivered ? null : h("span", { class: "warn", text: "delivery failed" })),
      h("div", { class: `msg ${m.dir}${m.kind === "followup" ? " followup" : ""}${other(m) ? " other" : ""}`, text: m.text }),
    ]),
  );
  if (atBottom || follow) box.scrollTop = box.scrollHeight;
}

function renderPolicy(r) {
  const box = $("policy");
  $("policy-version").textContent = r?.policyVersion || "";
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
        ...hits.slice(0, 3).map((x) => h("div", { class: "mono", style: "font-size:12px;margin-top:4px", text: `${x.pattern} in ${x.field}: “${x.excerpt.trim()}”` })),
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
        : h("div", { class: `callout ${e.decision === "denied" ? "bad" : "good"}` }, h("b", { text: `Manager ${e.decision || "resolved"}` }), `${person(e.by) || "In Slack"} at ${time(e.ts)}${e.note ? ` · ${e.note}` : ""}`),
    );
  }
  if (r.checks.length) {
    parts.push(h("div", {}, h("p", { class: "sub", text: "Claims verified" }), h("ul", { class: "checks" }, ...r.checks.map((c) => { const cls = resultClass(c.result); return h("li", {}, h("span", { class: `ico ${cls}`, text: resultIcon(cls) }), h("div", {}, h("span", { text: c.name.replace(/_/g, " ") }), c.detail ? h("small", { text: c.detail }) : null), h("span", { class: `pill ${cls}`, text: c.result })); }))));
  }
  if (r.trace.length) {
    parts.push(h("div", {}, h("p", { class: "sub", text: "Policy trace (deterministic rules, no LLM)" }), h("ul", { class: "trace" }, ...r.trace.map((t) => { const cls = resultClass(String(t.result)); return h("li", {}, h("span", { class: `ico ${cls}`, text: resultIcon(cls) }), h("div", {}, h("code", { text: t.rule }), t.detail ? h("small", { text: t.detail }) : null), h("span", { class: `pill ${cls}`, text: String(t.result) })); }))));
  }
  box.replaceChildren(...parts);
}

function renderCard(r) {
  const box = $("card");
  const card = r?.card;
  const mandate = r?.mandate;
  if (!card && !mandate) {
    box.replaceChildren(h("p", { class: "empty-state", text: r && ["denied", "counter", "escalated"].includes(r.status) ? "No card. A card only exists after a signed mandate." : "When a request is approved, the signed mandate and its single-use Ramp card appear here." }));
    return;
  }
  const state = card?.state || "pending";
  const vcard = card
    ? h(
        "div",
        { class: `vcard ${state}` },
        h("div", { class: "vcard-top" }, h("span", { text: "Ramp · single-use virtual card" }), h("span", { class: "vcard-state", text: state.toUpperCase() })),
        h("div", { class: "vcard-num", text: `•••• •••• •••• ${card.last4 || (card.card_id || "").slice(-4)}` }),
        h("div", { class: "vcard-bot" }, h("div", {}, "Limit", h("b", { text: money(card.limit_usd) || "—" })), h("div", {}, "Locked to", h("b", { text: card.merchant_lock || "—" })), h("div", {}, "Expires", h("b", { text: card.expires_at ? when(card.expires_at) : "—" }))),
      )
    : h("p", { class: "empty-state", text: "Issuing card…" });
  const sig = mandate && (mandate.signature || mandate.sig);
  const rows = [
    ["Mandate", mandate?.mandate_id || mandate?.id],
    ["Employee", mandate?.employee_id || r?.request?.employee_id],
    ["Agent", mandate?.agent_id || r?.agent_id],
    ["Max", typeof mandate?.max_amount_usd === "number" ? money(mandate.max_amount_usd) : typeof mandate?.amount_usd === "number" ? money(mandate.amount_usd) : undefined],
    ["Policy", mandate?.policy_version],
    ["Approved by", mandate?.approved_by ? person(mandate.approved_by) : undefined],
    ["Valid until", mandate?.valid_until ? when(mandate.valid_until) : undefined],
    ["Key", mandate?.key_id],
    ["Card ID", card?.card_id],
  ].filter(([, v]) => v);
  const kv = h("dl", { class: "kv" }, ...rows.flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { text: String(v) })]), sig ? [h("dt", { text: "Signature" }), h("dd", { class: "sig", text: `${String(sig).slice(0, 34)}${String(sig).length > 34 ? "…" : ""} ✓` })] : []);
  const extra = card?.state === "suspended" ? h("div", { class: "callout bad" }, h("b", { text: "Card suspended" }), humanize(card.suspendedReason) || "Settlement didn't match the mandate.") : null;
  box.replaceChildren(h("div", {}, vcard), h("div", {}, kv, extra));
}

function renderTimer() {
  const r = selected ? model.requests[selected] : null;
  const el = $("card-timer");
  if (!r?.card?.expires_at || r.card.state !== "active") {
    el.textContent = r?.card ? r.card.state : "";
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
    box.replaceChildren(h("p", { class: "empty-state", text: r?.card ? "Waiting for the merchant to charge the card…" : "Settled charges, reconciliation against the mandate, and GL coding appear here." }));
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
        h("div", { class: "muted", text: [t.merchant, time(t.ts)].filter(Boolean).join(" · ") }),
        typeof limit === "number" ? h("div", {}, h("div", { class: `meter${over ? " over" : ""}` }, h("i", { style: `width:${pct}%` })), h("div", { class: "meter-l" }, h("span", { text: `Charged ${money(t.amount)}` }), h("span", { text: `Mandate max ${money(limit)}` }))) : null,
        t.state === "mismatch" ? h("div", { class: "callout bad" }, h("b", { text: "Mismatch" }), `${(t.reason || `Charged ${money(t.amount)} against ${money(t.expected ?? limit)}`).replace(/[.\s]*$/, "")}. Card auto-suspended; finance alerted in Slack.`) : null,
        Array.isArray(t.match) && t.match.length
          ? h("ul", { class: "checks" }, ...t.match.map((c) => { const cls = resultClass(c.result); return h("li", {}, h("span", { class: `ico ${cls}`, text: resultIcon(cls) }), h("div", {}, h("span", { text: c.field.replace(/_/g, " ") }), h("small", { text: c.field === "time_window" ? `settled ${time(c.actual)}` : `expected ${c.expected}, got ${c.actual}` })), h("span", { class: `pill ${cls}`, text: c.result })); }))
          : null,
        t.state === "reconciled"
          ? h("div", {}, h("p", { class: "sub", text: "Auto-coded" }), h("dl", { class: "kv" }, ...[["GL account", coding.gl_account || coding.gl], ["Department", coding.department || coding.dept], ["Memo", coding.memo]].filter(([, v]) => v).flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { text: String(v) })])), h("div", { class: "callout good" }, h("b", { text: "No expense report" }), "Matched to its mandate and coded automatically."))
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
  } else if (ev.key === "ArrowLeft" && idx > 0) select(list[idx - 1].id);
  else if (ev.key === "ArrowRight" && idx >= 0 && idx < list.length - 1) select(list[idx + 1].id);
});

// ---- data ----
async function loadConfig() {
  try {
    const cfg = await (await fetch(`config${qs}`)).json();
    $("company").textContent = cfg.company ? `for ${cfg.company}` : "";
    employees = cfg.employees || employees;
    $("brain").textContent = cfg.negotiator ? `negotiator: ${cfg.negotiator}` : "";
    $("conn-ramp").dataset.state = cfg.ramp_events_connected ? "up" : "down";
    $("conn-ramp").title = cfg.gateway_url || "";
  } catch {
    $("conn-ramp").dataset.state = "down";
  }
}
loadConfig();
setInterval(loadConfig, 5000);

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
  const es = new EventSource(`stream${qs}`);
  es.addEventListener("open", () => ($("conn-dash").dataset.state = "up"));
  es.addEventListener("error", () => ($("conn-dash").dataset.state = "down"));
  es.addEventListener("reset", () => {
    model = createModel();
    selected = null;
    scheduleRender();
  });
  es.addEventListener("snapshot", (ev) => {
    model = applyAll(createModel(), JSON.parse(ev.data));
    scheduleRender();
  });
  es.addEventListener("gw", (ev) => {
    apply(model, JSON.parse(ev.data));
    scheduleRender();
  });
}
connect();
render();
