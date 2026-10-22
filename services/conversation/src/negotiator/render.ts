/**
 * Turns a Decision from the gateway into the plain-language message sent back to the agent.
 *
 * This is deliberately deterministic: the language model never writes the outcome of a request,
 * so it cannot tell an agent "approved" when the policy engine said "denied". Card details for
 * checkout come from GET /v1/cards (sandbox PAN), never from the model. Messages are short for SMS.
 *
 * Card numbers in sent messages are masked (maskCardNumbers) everywhere they're stored or shown:
 * conversation history, transcripts sent to the gateway, logs and the dashboard.
 */
import type { Card, CardDetails, Counteroffer, Decision, Transaction } from "../contract/schemas.ts";
import type { GatewayFailure } from "../gateway/client.ts";

export interface RenderOptions {
  demoMerchantUrl?: string;
  timeZone?: string;
}

export function money(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: n % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
}

export function formatTime(iso: string | undefined, timeZone = "America/Los_Angeles"): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone, timeZoneName: "short" });
}

const PAN = /\b(\d{4})[ -]?(\d{4})[ -]?(\d{4})[ -]?(\d{4})\b/g;
const CVC = /\b(CVC|CVV|security code)(:?\s*)\d{3,4}\b/gi;

/** Replaces card numbers and CVCs in free text with masked versions. */
export function maskCardNumbers(text: string): string {
  return text.replace(PAN, (_m, _a, _b, _c, last4: string) => `•••• •••• •••• ${last4}`).replace(CVC, (_m, label: string, sep: string) => `${label}${sep}•••`);
}

export function describeCounteroffer(c: Counteroffer | null | undefined): string | undefined {
  if (!c) return undefined;
  const merchant = c.merchant && !c.description.includes(c.merchant) ? ` at ${c.merchant}` : "";
  return `${c.description}${merchant} for ${money(c.amount_usd)}`;
}

export function describeCard(card: Card, details: CardDetails | undefined, opts: RenderOptions = {}): string {
  const bits = [
    `Card ending ${card.last4}`,
    `limit ${money(card.limit_usd)}`,
    `locked to ${card.merchant_lock.replace(/_/g, " ")}`,
    formatTime(card.expires_at, opts.timeZone) ? `valid until ${formatTime(card.expires_at, opts.timeZone)}` : undefined,
  ].filter(Boolean);
  let out = `${bits.join(", ")}.`;
  if (details) {
    const pan = details.pan.replace(/(\d{4})(?=\d)/g, "$1 ");
    out += ` Card number ${pan}, exp ${String(details.exp_month).padStart(2, "0")}/${String(details.exp_year).slice(-2)}, CVC ${details.cvc}.`;
  } else {
    out += ` Card ID: ${card.card_id}.`;
  }
  if (opts.demoMerchantUrl) out += ` Check out at ${opts.demoMerchantUrl}`;
  return out;
}

function sentence(s: string | undefined): string {
  const t = (s ?? "").trim();
  if (!t) return "";
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

const tidy = (s: string) => s.replace(/\s+/g, " ").trim();

export function renderDecision(decision: Decision, opts: RenderOptions = {}, details?: CardDetails): string {
  const reason = sentence(decision.reason);
  switch (decision.status) {
    case "approved": {
      const card = decision.card ? ` ${describeCard(decision.card, details, opts)}` : " The card is being issued; ask me for it in a moment.";
      return tidy(`Approved. ${reason}${card}`);
    }
    case "counter": {
      const offer = describeCounteroffer(decision.counteroffer);
      const ask = offer ? ` Within-policy alternative: ${offer}. Reply YES to request that instead.` : " Send me a revised request that fits policy.";
      return tidy(`Not approved as requested. ${reason}${ask}`);
    }
    case "escalated":
      return tidy(`Sent to your manager for approval. ${reason} I'll message you as soon as they decide.`);
    case "denied":
      return tidy(`Denied. ${reason}`);
    default:
      return tidy(`Status: ${String((decision as Decision).status)}. ${reason}`);
  }
}

/** Follow-up after a manager resolves an escalation. */
export function renderEscalationOutcome(decision: Decision, opts: RenderOptions = {}, details?: CardDetails): string {
  if (decision.status === "approved") return `Your manager approved it. ${renderDecision(decision, opts, details).replace(/^Approved\.\s*/, "")}`;
  if (decision.status === "denied") return tidy(`Your manager declined it. ${sentence(decision.reason)}`);
  return renderDecision(decision, opts, details);
}

/** The employee's confirmation once the charge is matched and coded. */
export function renderReconciled(txn: Partial<Transaction>, fallbackMerchant?: string): string {
  const merchant = txn.merchant || fallbackMerchant;
  const what = [money(txn.amount_usd), merchant ? `at ${merchant}` : undefined].filter(Boolean).join(" ") || "Your purchase";
  const gl = txn.coding?.gl_account;
  return `Done: ${what} settled and matched to its approval${gl ? `, coded to ${gl}` : ""}. No receipt or expense report needed.`;
}

/** The gateway's mismatch reasons name contract fields; make them read naturally in a text. */
function humanizeFields(text: string): string {
  return text.replace(/\bamount_usd\b/g, "amount").replace(/\bmerchant_category\b/g, "merchant category").replace(/\btime_window\b/g, "time window");
}

/** Heads-up after a settlement mismatch suspends the card (data of card.suspended, plus the mismatch txn if seen). */
export function renderSuspension(card: Partial<Card> | undefined, reason: string | undefined, txn?: Partial<Transaction>): string {
  const last4 = card?.last4 ? ` ending ${card.last4}` : "";
  const charged = txn?.amount_usd !== undefined ? ` The merchant charged ${money(txn.amount_usd)}${card?.limit_usd !== undefined ? ` against an approved ${money(card.limit_usd)}` : ""}.` : "";
  // With the charge in hand, "charged $620 against an approved $480" says it all; otherwise use the gateway's reason.
  const why = reason && !charged ? ` (${humanizeFields(reason).replace(/\.$/, "")})` : "";
  return tidy(`Heads up: the card${last4} was suspended${why}.${charged} Finance has been alerted.`);
}

/** What to tell a personal agent when a gateway call fails. Never implies anything was approved. */
export function renderGatewayFailure(failure: GatewayFailure): string {
  switch (failure) {
    case "rejected":
      return "The approval system rejected that request's format. Nothing was approved or charged; please resend the merchant, total and what it's for.";
    case "not_found":
      return "I can't find that request. Check the request ID.";
    case "conflict":
      return "That request collided with an earlier one, so nothing was approved or charged. Please send it again.";
    case "unauthorized":
    case "forbidden":
    case "unavailable":
      return "I couldn't reach the approval system just now. Nothing was approved or charged. Please try again in a minute.";
  }
}
