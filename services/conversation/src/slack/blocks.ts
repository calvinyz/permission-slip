/**
 * Slack Block Kit builders. Pure functions so the message layout can be unit tested and reviewed
 * without a Slack workspace.
 */
import { money } from "../negotiator/render.ts";

export interface EscalationDetails {
  request_id: string;
  /** From the gateway; needed to resolve. */
  escalation_id?: string;
  /** Employee the gateway assigned to approve (e.g. emp_priya). */
  approver_id?: string;
  approver_name?: string;
  /** That approver's Slack user id, for the @-mention and the click check. */
  approver_slack_id?: string;
  employee_name: string;
  employee_id: string;
  agent_label?: string;
  channel?: string;
  merchant?: string;
  merchant_category?: string;
  amount_usd?: number;
  description?: string;
  justification?: string;
  claims?: Record<string, unknown>;
  reason?: string;
}

type Block = Record<string, unknown>;

export const APPROVE_ACTION = "escalation_approve";
export const DENY_ACTION = "escalation_deny";

function mrkdwnEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Slack rejects the whole message if a field exceeds 2000 characters, so trim long agent text. */
export function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function field(label: string, value: string | undefined): Block | undefined {
  if (!value) return undefined;
  return { type: "mrkdwn", text: clip(`*${label}*\n${mrkdwnEscape(value)}`, 1900) };
}

function detailFields(d: EscalationDetails): Block[] {
  const claims = d.claims ? Object.entries(d.claims).map(([k, v]) => `${k}: ${String(v)}`).join(", ") : undefined;
  return [
    field("Amount", d.amount_usd !== undefined ? money(d.amount_usd) : undefined),
    field("Merchant", d.merchant ? `${d.merchant}${d.merchant_category ? ` (${d.merchant_category})` : ""}` : undefined),
    field("What", d.description),
    field("Why", d.justification),
    field("Claims", claims),
    field("Asked by", d.agent_label ? `${d.agent_label}${d.channel ? ` over ${d.channel.toUpperCase()}` : ""}` : undefined),
  ].filter((f): f is Block => Boolean(f));
}

export function escalationText(d: EscalationDetails): string {
  return `Approval needed: ${d.employee_name} wants ${d.amount_usd !== undefined ? money(d.amount_usd) : "a purchase"}${d.merchant ? ` at ${d.merchant}` : ""}.`;
}

export function escalationBlocks(d: EscalationDetails): Block[] {
  const mention = d.approver_slack_id ? `<@${d.approver_slack_id}> ` : d.approver_name ? `*For ${mrkdwnEscape(d.approver_name)}:* ` : "";
  return [
    { type: "header", text: { type: "plain_text", text: "Purchase needs your approval", emoji: false } },
    {
      type: "section",
      text: { type: "mrkdwn", text: clip(`${mention}*${mrkdwnEscape(d.employee_name)}*'s agent asked for a purchase the policy engine can't approve on its own.\n>${mrkdwnEscape(d.reason ?? "Over policy limits.")}`, 2900) },
    },
    { type: "section", fields: detailFields(d).slice(0, 10) },
    {
      type: "actions",
      block_id: `escalation:${d.request_id}`,
      elements: [
        {
          type: "button",
          action_id: APPROVE_ACTION,
          style: "primary",
          text: { type: "plain_text", text: "Approve" },
          value: d.request_id,
          confirm: {
            title: { type: "plain_text", text: "Approve this purchase?" },
            text: { type: "mrkdwn", text: `A single-use card for ${d.amount_usd !== undefined ? money(d.amount_usd) : "this amount"}${d.merchant ? ` at ${mrkdwnEscape(d.merchant)}` : ""} will be issued to ${mrkdwnEscape(d.employee_name)}'s agent.` },
            confirm: { type: "plain_text", text: "Approve" },
            deny: { type: "plain_text", text: "Cancel" },
          },
        },
        {
          type: "button",
          action_id: DENY_ACTION,
          style: "danger",
          text: { type: "plain_text", text: "Deny" },
          value: d.request_id,
          confirm: {
            title: { type: "plain_text", text: "Deny this purchase?" },
            text: { type: "mrkdwn", text: `${mrkdwnEscape(d.employee_name)}'s agent will be told it was declined.` },
            confirm: { type: "plain_text", text: "Deny" },
            deny: { type: "plain_text", text: "Cancel" },
          },
        },
      ],
    },
    { type: "context", elements: [{ type: "mrkdwn", text: `Request \`${d.request_id}\` · Permission Slip` }] },
  ];
}

export function resolvedBlocks(d: EscalationDetails, outcome: "approved" | "denied" | string, by: string, note?: string): Block[] {
  const verb = outcome === "approved" ? "Approved" : outcome === "denied" ? "Denied" : `Resolved (${outcome})`;
  return [
    { type: "header", text: { type: "plain_text", text: `${verb}: ${d.employee_name}'s purchase`, emoji: false } },
    { type: "section", fields: detailFields(d).slice(0, 10) },
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: `${verb} by ${by} at ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles", timeZoneName: "short" })}${note ? ` · ${mrkdwnEscape(note)}` : ""} · Request \`${d.request_id}\`` },
      ],
    },
  ];
}

export interface SuspensionAlert {
  request_id?: string;
  employee_name?: string;
  card_last4?: string;
  card_id?: string;
  merchant?: string;
  charged_usd?: number;
  approved_usd?: number;
  reason?: string;
  mandate_id?: string;
}

export function suspensionText(a: SuspensionAlert): string {
  return `Card ${a.card_last4 ? `ending ${a.card_last4} ` : ""}auto-suspended: ${a.reason ?? "settlement didn't match its mandate"}.`;
}

export function suspensionBlocks(a: SuspensionAlert): Block[] {
  const facts = [
    a.charged_usd !== undefined ? `*Charged*\n${money(a.charged_usd)}` : undefined,
    a.approved_usd !== undefined ? `*Approved*\n${money(a.approved_usd)}` : undefined,
    a.merchant ? `*Merchant*\n${mrkdwnEscape(a.merchant)}` : undefined,
    a.employee_name ? `*Employee*\n${mrkdwnEscape(a.employee_name)}` : undefined,
  ].filter((t): t is string => Boolean(t));
  return [
    { type: "header", text: { type: "plain_text", text: "Card auto-suspended", emoji: false } },
    { type: "section", text: { type: "mrkdwn", text: `${mrkdwnEscape(suspensionText(a))} No further charges will go through on this card.` } },
    ...(facts.length ? [{ type: "section", fields: facts.map((t) => ({ type: "mrkdwn", text: t })) }] : []),
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: [a.request_id ? `Request \`${a.request_id}\`` : undefined, a.mandate_id ? `Mandate \`${a.mandate_id}\`` : undefined, a.card_id ? `Card \`${a.card_id}\`` : undefined].filter(Boolean).join(" · ") || "Permission Slip" }],
    },
  ];
}
