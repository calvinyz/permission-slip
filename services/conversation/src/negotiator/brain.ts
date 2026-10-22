/**
 * The "brain" decides the negotiator's next move for one inbound message. It can only choose one
 * of four actions, and none of them approves anything:
 *   reply     ask the agent for missing details (free text)
 *   submit    send a structured PurchaseRequest to the gateway
 *   status    look up an earlier request
 *   no_reply  stay quiet (acknowledgements; prevents agent-to-agent loops)
 */
import { z } from "zod";
import { CABIN_CLASSES, type Channel, type Decision } from "../contract/schemas.ts";
import type { ConversationTurn } from "../state.ts";

const iata = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "airport codes are 3 capital letters, e.g. SFO");
/** True for a real calendar date (rejects 2026-02-30, which the contract's format: date would). */
export function isRealDate(s: string): boolean {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
const isoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "dates are YYYY-MM-DD").refine(isRealDate, "that date doesn't exist on the calendar");

export const TravelInputSchema = z
  .object({
    cabin_class: z.enum(CABIN_CLASSES).optional(),
    origin: iata.optional(),
    destination: iata.optional(),
    depart_date: isoDate.optional(),
    return_date: isoDate.optional(),
    nights: z.coerce.number().int().min(1).optional(),
  })
  .strict();

export const SubmitInputSchema = z.object({
  merchant: z.string().trim().min(1, "merchant is required").max(200),
  merchant_category: z.string().trim().min(1),
  amount_usd: z.coerce.number().positive("amount_usd must be a positive number").max(100_000),
  description: z.string().trim().min(1, "description is required").max(1000),
  justification: z.string().trim().min(1, "justification is required").max(1000),
  travel: TravelInputSchema.optional(),
  claims: z
    .object({
      meeting: z.string().trim().max(200).optional(),
      event: z.string().trim().max(200).optional(),
      date: isoDate.optional(),
    })
    .catchall(z.string().max(500))
    .default({}),
  /** Set when accepting a counteroffer on an earlier request. */
  parent_request_id: z.string().regex(/^req_[A-Za-z0-9_-]+$/).optional(),
});
export type SubmitInput = z.infer<typeof SubmitInputSchema>;

export type BrainAction =
  | { type: "reply"; text: string }
  | { type: "submit"; input: SubmitInput }
  | { type: "status"; request_id: string }
  | { type: "no_reply" };

export interface RequestSummary {
  request_id: string;
  merchant: string;
  merchant_category: string;
  amount_usd: number;
  description: string;
  justification: string;
  claims: Record<string, unknown>;
  travel?: Record<string, unknown>;
  status?: Decision["status"];
  reason?: string;
  counteroffer?: Decision["counteroffer"];
}

export interface BrainContext {
  company: string;
  employeeName: string;
  employeeId: string;
  /** Default origin airport for this employee's flights (e.g. PHL). */
  homeAirport?: string;
  agentLabel: string;
  channel: Channel;
  merchantCategories: string[];
  /** Full conversation including the message being handled (last turn, role "agent"). */
  turns: ConversationTurn[];
  /** Requests made in this conversation, oldest first. */
  requests: RequestSummary[];
  now: Date;
  timeZone: string;
  /** Returns an error message if the submit input is invalid, otherwise undefined. */
  validateSubmit(input: unknown): string | undefined;
}

export interface Brain {
  readonly name: string;
  decide(ctx: BrainContext): Promise<BrainAction>;
}

/**
 * Checks a request before it goes to the gateway, including what the gateway's policy needs to
 * decide (flights need cabin class and airports; hotels need nights). Missing details come back as
 * an error so the negotiator asks the agent, instead of the gateway denying an incomplete request.
 */
export function validateSubmitInput(input: unknown, categories: string[]): { ok: true; value: SubmitInput } | { ok: false; error: string } {
  const parsed = SubmitInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") };
  }
  const v = parsed.data;
  if (!categories.includes(v.merchant_category)) return { ok: false, error: `merchant_category must be one of: ${categories.join(", ")}` };
  const cents = v.amount_usd * 100;
  if (Math.abs(cents - Math.round(cents)) > 1e-6) return { ok: false, error: "amount_usd must have at most 2 decimal places" };
  const travel = v.travel ?? {};
  if (v.merchant_category === "airlines") {
    const missing = (["cabin_class", "origin", "destination"] as const).filter((k) => !travel[k]);
    if (missing.length) return { ok: false, error: `flights need travel.${missing.join(", travel.")} (cabin class and 3-letter airport codes)` };
  }
  if (v.merchant_category === "lodging") {
    if (!travel.nights) return { ok: false, error: "hotels need travel.nights (number of nights)" };
    if (travel.depart_date && travel.return_date) {
      const stay = Math.round((Date.parse(travel.return_date) - Date.parse(travel.depart_date)) / 86_400_000);
      if (stay !== travel.nights) return { ok: false, error: `travel.nights (${travel.nights}) doesn't match the dates (${stay} nights)` };
    }
  }
  return { ok: true, value: v };
}

/** "Tuesday, October 21, 2026 (2026-10-21)" in the given time zone. */
export function describeToday(now: Date, timeZone: string): string {
  const long = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone });
  return `${long} (${isoDateInZone(now, timeZone)})`;
}

export function isoDateInZone(d: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
