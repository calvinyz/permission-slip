/**
 * Summarizes negotiator latency from logs/conversation.log, for the Instinct and Muse rehearsals
 * (spec: "record latency and any off-script behavior").
 *   npm run latency
 *   npm run latency -- --since 2026-10-24T18:00
 */
import { readFileSync, existsSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { file: { type: "string", default: process.env.LOG_FILE ?? "logs/conversation.log" }, since: { type: "string" } } });
if (!existsSync(values.file)) {
  console.error(`No log file at ${values.file}. Run the gateway first.`);
  process.exit(2);
}
const since = values.since ? Date.parse(values.since) : 0;
type Line = { ts: string; msg: string; agent_id?: string; ms?: number; action?: string; status?: string };
const lines = readFileSync(values.file, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l) as Line;
    } catch {
      return undefined;
    }
  })
  .filter((l): l is Line => Boolean(l) && Date.parse(l!.ts) >= since);

const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};
const groups = new Map<string, { think: number[]; total: number[]; ramp: number[]; actions: Record<string, number>; statuses: Record<string, number> }>();
const g = (agent = "unknown") => {
  if (!groups.has(agent)) groups.set(agent, { think: [], total: [], ramp: [], actions: {}, statuses: {} });
  return groups.get(agent)!;
};
for (const l of lines) {
  if (l.msg === "negotiator: action" && typeof l.ms === "number") {
    g(l.agent_id).think.push(l.ms);
    g(l.agent_id).actions[l.action ?? "?"] = (g(l.agent_id).actions[l.action ?? "?"] ?? 0) + 1;
  }
  if (l.msg === "negotiator: decision relayed" && typeof l.ms === "number") {
    g(l.agent_id).total.push(l.ms);
    g(l.agent_id).statuses[l.status ?? "?"] = (g(l.agent_id).statuses[l.status ?? "?"] ?? 0) + 1;
  }
}
const ramp = lines.filter((l) => l.msg === "ramp: decision" && typeof l.ms === "number").map((l) => l.ms!);
const fmt = (n: number) => (Number.isNaN(n) ? "-" : `${(n / 1000).toFixed(2)} s`);
console.log(`Log: ${values.file}${values.since ? ` since ${values.since}` : ""}\n`);
for (const [agent, s] of groups) {
  console.log(`${agent}`);
  console.log(`  negotiator think   p50 ${fmt(pct(s.think, 50))}  p95 ${fmt(pct(s.think, 95))}  (n=${s.think.length})`);
  console.log(`  message->decision  p50 ${fmt(pct(s.total, 50))}  p95 ${fmt(pct(s.total, 95))}  (n=${s.total.length})`);
  console.log(`  actions ${JSON.stringify(s.actions)}  decisions ${JSON.stringify(s.statuses)}`);
}
console.log(`\nRamp side POST /v1/requests  p50 ${fmt(pct(ramp, 50))}  p95 ${fmt(pct(ramp, 95))}  (n=${ramp.length})`);
console.log("Add the agent's own reply time (Instinct/Muse) from the phone recording to get end-to-end latency.");
