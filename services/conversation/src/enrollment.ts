/**
 * Agent enrollment: which personal agents may talk to the gateway, and on whose behalf.
 *
 * The file (data/enrollment.json) holds no secrets. Phone numbers, email addresses and MCP tokens
 * are written as ${ENV_VAR} placeholders and resolved from the environment at startup, so real
 * values live only in .env. An entry whose placeholder is unset is skipped with a warning.
 */
import { readFileSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { AGENT_KINDS, type Channel } from "./contract/schemas.ts";
import type { Logger } from "./logger.ts";

const EmployeeSchema = z.object({
  /** Must match the gateway's directory (services/gateway/gateway/seed.py). */
  employee_id: z.string().regex(/^emp_[a-z0-9_]+$/),
  name: z.string().min(1),
  title: z.string().optional(),
  /**
   * This person's Slack user id (U…). For managers it decides who may click Approve on the
   * escalations the gateway assigns to them; unset means anyone in the channel can (demo mode).
   */
  slack_user_id: z.string().optional(),
  /** Default origin airport for this employee's flights. */
  home_airport: z.string().regex(/^[A-Z]{3}$/).optional(),
});

const AgentSchema = z.object({
  /** Agent family; becomes the agent_id prefix. The contract allows only these. */
  kind: z.enum(AGENT_KINDS),
  channel: z.enum(["sms", "email", "mcp"]),
  employee_id: z.string().min(1),
  /** sms: E.164 number the agent texts from. email: sender address. mcp: bearer token. */
  credential: z.string().min(1),
  label: z.string().optional(),
});

const EnrollmentFileSchema = z.object({
  company: z.string().optional(),
  employees: z.array(EmployeeSchema).min(1),
  agents: z.array(AgentSchema),
});

export type Employee = z.infer<typeof EmployeeSchema>;

export interface EnrolledAgent {
  agent_id: string;
  kind: string;
  channel: Channel;
  employee: Employee;
  /** Normalized phone, lowercase email, or raw MCP token. */
  credential: string;
  label: string;
}

export function normalizePhone(input: string): string {
  const trimmed = input.trim();
  const digits = trimmed.replace(/[^\d]/g, "");
  if (trimmed.startsWith("+")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

/** Extracts the bare address from "Name <addr@x.com>" and lowercases it. */
export function normalizeEmail(input: string): string {
  const match = input.match(/<([^>]+)>/);
  return (match ? match[1]! : input).trim().toLowerCase();
}

function interpolate(value: string, env: NodeJS.ProcessEnv): string | undefined {
  let missing = false;
  const out = value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => {
    const v = env[name];
    if (v === undefined || v.trim() === "") {
      missing = true;
      return "";
    }
    return v.trim();
  });
  return missing ? undefined : out;
}

function hash(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

export class Enrollment {
  readonly employees = new Map<string, Employee>();
  readonly agents: EnrolledAgent[] = [];
  private readonly bySms = new Map<string, EnrolledAgent>();
  private readonly byEmail = new Map<string, EnrolledAgent>();
  private readonly mcpAgents: { tokenHash: Buffer; agent: EnrolledAgent }[] = [];

  constructor(data: unknown, env: NodeJS.ProcessEnv = process.env, log?: Logger) {
    const file = EnrollmentFileSchema.parse(data);
    for (const e of file.employees) {
      // Optional placeholders (e.g. a Slack id) resolve to undefined when unset.
      const slack_user_id = e.slack_user_id ? interpolate(e.slack_user_id, env) : undefined;
      const { slack_user_id: _raw, ...rest } = e;
      this.employees.set(e.employee_id, { ...rest, ...(slack_user_id ? { slack_user_id } : {}) });
    }
    for (const a of file.agents) {
      const employee = this.employees.get(a.employee_id);
      if (!employee) throw new Error(`Enrollment: agent ${a.kind}/${a.channel} references unknown employee ${a.employee_id}`);
      const raw = interpolate(a.credential, env);
      if (!raw) {
        log?.warn("enrollment: skipping agent with unset credential", { kind: a.kind, channel: a.channel, employee_id: a.employee_id, placeholder: a.credential });
        continue;
      }
      const credential = a.channel === "sms" ? normalizePhone(raw) : a.channel === "email" ? normalizeEmail(raw) : raw;
      if (a.channel === "mcp" && credential.length < 24) {
        throw new Error(`Enrollment: MCP token for ${a.kind}/${a.employee_id} is too short (min 24 chars). Generate one with: openssl rand -hex 24`);
      }
      const agent: EnrolledAgent = {
        agent_id: a.channel === "mcp" ? `${a.kind}:${employee.employee_id}` : `${a.kind}:${credential}`,
        kind: a.kind,
        channel: a.channel,
        employee,
        credential,
        label: a.label ?? `${capitalize(a.kind)} for ${employee.name}`,
      };
      if (a.channel === "sms") this.addUnique(this.bySms, credential, agent);
      else if (a.channel === "email") this.addUnique(this.byEmail, credential, agent);
      else this.mcpAgents.push({ tokenHash: hash(credential), agent });
      this.agents.push(agent);
    }
  }

  static fromFile(path: string, env: NodeJS.ProcessEnv = process.env, log?: Logger): Enrollment {
    return new Enrollment(JSON.parse(readFileSync(path, "utf8")), env, log);
  }

  private addUnique(map: Map<string, EnrolledAgent>, key: string, agent: EnrolledAgent) {
    const existing = map.get(key);
    if (existing) throw new Error(`Enrollment: ${key} is enrolled twice (${existing.agent_id} and ${agent.agent_id})`);
    map.set(key, agent);
  }

  findSmsSender(from: string): EnrolledAgent | undefined {
    return this.bySms.get(normalizePhone(from));
  }

  findEmailSender(from: string): EnrolledAgent | undefined {
    return this.byEmail.get(normalizeEmail(from));
  }

  /** Constant-time token lookup. */
  findMcpToken(token: string | undefined): EnrolledAgent | undefined {
    if (!token) return undefined;
    const h = hash(token);
    let found: EnrolledAgent | undefined;
    for (const entry of this.mcpAgents) {
      if (timingSafeEqual(entry.tokenHash, h)) found = entry.agent;
    }
    return found;
  }

  /** The employee whose Slack id this is (managers resolving escalations). */
  findBySlackId(slackUserId: string): Employee | undefined {
    return [...this.employees.values()].find((e) => e.slack_user_id === slackUserId);
  }

  findAgent(agentId: string): EnrolledAgent | undefined {
    return this.agents.find((a) => a.agent_id === agentId);
  }

  /** Safe summary for logs and /healthz (no credentials). */
  summary() {
    return this.agents.map((a) => ({
      agent_id: a.channel === "mcp" ? a.agent_id : `${a.kind}:${maskCredential(a)}`,
      channel: a.channel,
      employee_id: a.employee.employee_id,
    }));
  }
}

function maskCredential(a: EnrolledAgent): string {
  if (a.channel === "sms") return `…${a.credential.slice(-4)}`;
  const [user, domain] = a.credential.split("@");
  return `${(user ?? "").slice(0, 2)}…@${domain ?? ""}`;
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
