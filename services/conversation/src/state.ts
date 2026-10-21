/**
 * In-memory state for conversations and requests, with optional JSON snapshots (STATE_FILE) so a
 * restart between demo takes doesn't lose context.
 *
 * Sessions: one per agent_id, holding the conversation the negotiator sees.
 * Requests: one per request_id, recording who asked, through which channel, and the latest
 * decision. The MCP server uses this for ownership checks; Slack uses it for request details.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Channel, Decision, PurchaseRequest } from "./contract/schemas.ts";

export interface ConversationTurn {
  role: "agent" | "gateway";
  text: string;
  ts: string;
  request_id?: string;
}

export interface Session {
  agent_id: string;
  employee_id: string;
  channel: Channel;
  turns: ConversationTurn[];
  /** Most recent request in this conversation; the negotiator uses it for follow-ups. */
  last_request_id?: string;
  /** Email threading: last inbound Message-ID and subject. */
  email_thread?: { message_id?: string; subject?: string };
  updated_at: string;
}

export interface RequestRecord {
  request: PurchaseRequest;
  decision?: Decision;
  agent_id: string;
  employee_id: string;
  channel: Channel;
  created_at: string;
  updated_at: string;
  /** Status we last told the agent about, so follow-ups are sent exactly once per change. */
  notified_status?: Decision["status"];
  notified_suspended?: boolean;
  notified_reconciled?: boolean;
}

const MAX_TURNS = 40;
const MAX_SLACK_KEYS = 500;

/** What the Slack bot has already posted, kept across restarts so nothing is posted twice. */
export interface SlackPost {
  channel: string;
  ts: string;
  details: unknown;
  resolved?: boolean;
}

export class StateStore {
  private readonly sessions = new Map<string, Session>();
  private readonly requests = new Map<string, RequestRecord>();
  private readonly slackPosts = new Map<string, SlackPost>();
  private readonly slackAlerts = new Set<string>();
  private saveTimer?: NodeJS.Timeout;

  constructor(private readonly file?: string) {
    if (file && existsSync(file)) {
      try {
        const snap = JSON.parse(readFileSync(file, "utf8")) as { sessions?: Session[]; requests?: RequestRecord[]; slack?: { posts?: [string, SlackPost][]; alerts?: string[] } };
        for (const s of snap.sessions ?? []) this.sessions.set(s.agent_id, s);
        for (const r of snap.requests ?? []) this.requests.set(r.request.request_id, r);
        for (const [k, v] of snap.slack?.posts ?? []) this.slackPosts.set(k, v);
        for (const k of snap.slack?.alerts ?? []) this.slackAlerts.add(k);
      } catch {
        // A corrupt snapshot must not block startup; start fresh.
      }
    }
  }

  session(agent: { agent_id: string; employee_id: string; channel: Channel }): Session {
    let s = this.sessions.get(agent.agent_id);
    if (!s) {
      s = { agent_id: agent.agent_id, employee_id: agent.employee_id, channel: agent.channel, turns: [], updated_at: new Date().toISOString() };
      this.sessions.set(agent.agent_id, s);
    }
    return s;
  }

  getSession(agentId: string): Session | undefined {
    return this.sessions.get(agentId);
  }

  addTurn(session: Session, turn: Omit<ConversationTurn, "ts">): ConversationTurn {
    const full = { ...turn, ts: new Date().toISOString() };
    session.turns.push(full);
    if (session.turns.length > MAX_TURNS) session.turns.splice(0, session.turns.length - MAX_TURNS);
    session.updated_at = full.ts;
    this.scheduleSave();
    return full;
  }

  /** Clears a conversation (used between demo takes via POST /admin/reset). */
  resetSession(agentId: string): void {
    this.sessions.delete(agentId);
    this.scheduleSave();
  }

  resetAll(): void {
    this.sessions.clear();
    this.requests.clear();
    this.scheduleSave();
  }

  recordRequest(request: PurchaseRequest, channel: Channel): RequestRecord {
    const now = new Date().toISOString();
    const rec: RequestRecord = {
      request,
      agent_id: request.agent_id,
      employee_id: request.employee_id,
      channel,
      created_at: now,
      updated_at: now,
    };
    this.requests.set(request.request_id, rec);
    this.scheduleSave();
    return rec;
  }

  updateDecision(requestId: string, decision: Decision): RequestRecord | undefined {
    const rec = this.requests.get(requestId);
    if (!rec) return undefined;
    rec.decision = decision;
    rec.updated_at = new Date().toISOString();
    this.scheduleSave();
    return rec;
  }

  getRequest(requestId: string): RequestRecord | undefined {
    return this.requests.get(requestId);
  }

  allRequests(): RequestRecord[] {
    return [...this.requests.values()];
  }

  requestsFor(agentId: string): RequestRecord[] {
    return [...this.requests.values()].filter((r) => r.agent_id === agentId).sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  markNotified(requestId: string, patch: Partial<Pick<RequestRecord, "notified_status" | "notified_suspended" | "notified_reconciled">>): void {
    const rec = this.requests.get(requestId);
    if (!rec) return;
    Object.assign(rec, patch);
    this.scheduleSave();
  }

  getSlackPost(requestId: string): SlackPost | undefined {
    return this.slackPosts.get(requestId);
  }

  setSlackPost(requestId: string, post: SlackPost): void {
    this.slackPosts.set(requestId, post);
    if (this.slackPosts.size > MAX_SLACK_KEYS) this.slackPosts.delete(this.slackPosts.keys().next().value!);
    this.scheduleSave();
  }

  /** Returns false if this alert was already sent; otherwise records it and returns true. */
  claimSlackAlert(key: string): boolean {
    if (this.slackAlerts.has(key)) return false;
    this.slackAlerts.add(key);
    if (this.slackAlerts.size > MAX_SLACK_KEYS) this.slackAlerts.delete(this.slackAlerts.values().next().value!);
    this.scheduleSave();
    return true;
  }

  private scheduleSave(): void {
    if (!this.file) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 250);
    this.saveTimer.unref?.();
  }

  /** Never throws: a failed snapshot (disk full, bad path) must not take the service down. */
  saveNow(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ sessions: [...this.sessions.values()], requests: [...this.requests.values()], slack: { posts: [...this.slackPosts.entries()], alerts: [...this.slackAlerts] } }, null, 2));
      renameSync(tmp, this.file);
    } catch (err) {
      process.stderr.write(`state: snapshot failed: ${(err as Error).message}\n`);
    }
  }
}
