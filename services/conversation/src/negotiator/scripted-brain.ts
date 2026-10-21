/**
 * Deterministic brain: a rule-based parser with no model calls. Used by tests and as the fallback
 * when Claude is unavailable (NEGOTIATOR_MODE=scripted, or automatically on an API error).
 * It understands the rehearsed demo phrasing well; free-form conversation is the LLM brain's job.
 */
import type { CabinClass } from "../contract/schemas.ts";
import type { Brain, BrainAction, BrainContext, RequestSummary, SubmitInput } from "./brain.ts";
import { isoDateInZone } from "./brain.ts";

const ACK = /^(thanks|thank you|thx|ty|great|perfect|got it|sounds good|cool|ok(ay)?|done|booked( it)?|all set|will do|noted)[.! ]*$/i;
const ACCEPT = /^(yes|y|yep|yeah|sure|ok(ay)?|accept|accepted|do it|go ahead|sounds good|that works|economy is fine|fine)\b/i;
const STATUS = /\b(status|update|any news|approved yet|did (they|my manager|the manager) (approve|decide)|still pending)\b/i;

const CATEGORY_KEYWORDS: [string, RegExp][] = [
  ["airlines", /\b(flight|fly|airline|airfare|plane|economy|business class|first class|united|delta|american airlines|alaska|southwest|jetblue)\b/i],
  ["lodging", /\b(hotel|lodging|room|nights?|airbnb|marriott|hilton|hyatt|inn)\b/i],
  ["conferences", /\b(conference|summit|ticket|registration|expo|pass)\b/i],
  ["ground_transport", /\b(uber|lyft|taxi|cab|rideshare|car rental|train|amtrak)\b/i],
  ["meals", /\b(dinner|lunch|breakfast|meal|restaurant|catering)\b/i],
  ["software", /\b(software|subscription|license|saas|seat)\b/i],
  ["office_supplies", /\b(supplies|monitor|keyboard|desk|chair)\b/i],
];

const KNOWN_MERCHANTS = [
  "United Airlines", "Delta", "American Airlines", "Alaska Airlines", "Southwest", "JetBlue",
  "Marriott", "Hilton", "Hyatt", "Hotel Zephyr", "Uber", "Lyft", "AI Engineer Summit", "Demo Air", "Demo Events",
];

/** City names and nicknames to their main airport. Explicit 3-letter codes always win. */
const CITY_AIRPORTS: [RegExp, string][] = [
  [/\b(sf|san francisco|sfo)\b/i, "SFO"],
  [/\b(philly|philadelphia|phl)\b/i, "PHL"],
  [/\b(nyc|new york|jfk)\b/i, "JFK"],
  [/\b(la|los angeles|lax)\b/i, "LAX"],
  [/\b(boston|bos)\b/i, "BOS"],
  [/\b(seattle|sea)\b/i, "SEA"],
  [/\b(chicago|ord)\b/i, "ORD"],
  [/\b(austin|aus)\b/i, "AUS"],
  [/\b(denver|den)\b/i, "DEN"],
];
const NOT_AIRPORTS = new Set(["USD", "CEO", "CFO", "SMS", "MCP", "API", "PTO", "AND", "THE", "FOR", "YES"]);

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function extractAmount(text: string): number | undefined {
  const m = text.match(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/) ?? text.match(/\b(\d+)(?:\.(\d{1,2}))?\s?(?:usd|dollars)\b/i);
  if (!m) return undefined;
  return Number(`${m[1]!.replace(/,/g, "")}${m[2] ? `.${m[2]}` : ""}`);
}

function extractMerchant(text: string): string | undefined {
  const lower = text.toLowerCase();
  const known = KNOWN_MERCHANTS.find((k) => lower.includes(k.toLowerCase()));
  if (known) return known;
  if (/\bunited\b/i.test(text)) return "United Airlines";
  const m = text.match(/\b(?:on|at|from|with|via)\s+([A-Z][\w&'.-]*(?:\s+[A-Z][\w&'.-]*){0,3})/);
  return m?.[1];
}

/** Meeting (verified against the calendar as a meeting) or conference/event. */
function extractClaim(text: string): { meeting?: string; event?: string } {
  const ev = text.match(/\b(?:for|to|at|register me for)\s+(?:the\s+)?([A-Z][\w&-]*(?:\s+[A-Z][\w&-]*){0,4}\s+(?:Summit|Conference|Expo|Forum))\b/);
  if (ev) return { event: ev[1] };
  const m =
    text.match(/\bfor (?:the |our |my )?([A-Z][\w&-]*(?:\s+[A-Z][\w&-]*){0,3})\s+(meeting|offsite|visit|onsite|demo)\b/) ??
    text.match(/\b(?:meeting with|visit(?:ing)?|meet(?:ing)?)\s+([A-Z][\w&-]*(?:\s+[A-Z][\w&-]*){0,2})/);
  return m ? { meeting: m[1] } : {};
}

function extractDate(text: string, now: Date, timeZone: string): string | undefined {
  const iso = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];
  const lower = text.toLowerCase();
  if (/\btomorrow\b/.test(lower)) return isoDateInZone(new Date(now.getTime() + 86_400_000), timeZone);
  // Month names must be whole words ("Marriott 2 nights" is not March 2).
  const md = text.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i);
  if (md && Number(md[2]) >= 1 && Number(md[2]) <= 31) {
    const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(md[1]!.toLowerCase().slice(0, 3));
    const today = isoDateInZone(now, timeZone);
    let year = Number(today.slice(0, 4));
    const candidate = `${year}-${String(month + 1).padStart(2, "0")}-${md[2]!.padStart(2, "0")}`;
    if (candidate < today && Number(today.slice(5, 7)) - (month + 1) > 2) year += 1;
    return `${year}-${String(month + 1).padStart(2, "0")}-${md[2]!.padStart(2, "0")}`;
  }
  // The claim date is the meeting's date: prefer a weekday mentioned after "meeting"/"conference".
  const hits = WEEKDAYS.flatMap((d, i) => [...lower.matchAll(new RegExp(`\\b(${d}|${d.slice(0, 3)})\\b`, "g"))].map((m) => ({ i, at: m.index ?? 0 }))).sort((a, b) => a.at - b.at);
  const anchor = lower.search(/\b(meeting|conference|summit|offsite|visit|onsite|demo)\b/);
  const pick = (anchor >= 0 ? hits.find((h) => h.at > anchor) : undefined) ?? hits[0];
  if (!pick) return undefined;
  const today = new Date(`${isoDateInZone(now, timeZone)}T12:00:00Z`);
  let delta = (pick.i - today.getUTCDay() + 7) % 7;
  if (delta === 0) delta = 7;
  return new Date(today.getTime() + delta * 86_400_000).toISOString().slice(0, 10);
}

function extractCabin(raw: string): CabinClass | undefined {
  // "economy, not business class" / "no upgrade" name a cabin the agent does NOT want.
  const text = raw.replace(/\b(not|no|without|instead of|rather than)\s+(?:an?\s+)?(?:first|business|premium(?:\s+economy)?|upgrade)(?:[\s-]class)?\b/gi, " ");
  if (/\bfirst[\s-]class\b/i.test(text)) return "first";
  if (/\bbusiness[\s-]class\b|\bbusiness cabin\b/i.test(text)) return "business";
  if (/\bpremium[\s-]economy\b/i.test(text)) return "premium_economy";
  if (/\b(economy|coach)\b/i.test(text)) return "economy";
  return undefined;
}

/** Origin and destination: explicit codes ("PHL to SFO"), then city names; origin defaults to home. */
function extractRoute(text: string, home?: string): { origin?: string; destination?: string } {
  const pair = text.match(/\b([A-Z]{3})\s*(?:to|-|→|->)\s*([A-Z]{3})\b/);
  if (pair && !NOT_AIRPORTS.has(pair[1]!) && !NOT_AIRPORTS.has(pair[2]!)) return { origin: pair[1], destination: pair[2] };
  const from = text.match(/\bfrom\s+([A-Za-z .]+?)\s+to\s+([A-Za-z .]+?)\b(?:[,.]|\s+for|\s+on|$)/i);
  const city = (s: string | undefined) => (s ? CITY_AIRPORTS.find(([rx]) => rx.test(s))?.[1] : undefined);
  if (from) return { origin: city(from[1]) ?? home, destination: city(from[2]) };
  const to = text.match(/\bto\s+(?:the\s+)?([A-Za-z]{2,}(?:\s+[A-Za-z]+)?)/i);
  return { origin: home, destination: city(to?.[1]) ?? CITY_AIRPORTS.find(([rx]) => rx.test(text))?.[1] };
}

function category(text: string, categories: string[]): string | undefined {
  const order = /\b(conference|summit|registration)\b/i.test(text) ? ["conferences", ...CATEGORY_KEYWORDS.map((c) => c[0])] : CATEGORY_KEYWORDS.map((c) => c[0]);
  for (const name of order) {
    const rx = CATEGORY_KEYWORDS.find((c) => c[0] === name)?.[1];
    if (rx?.test(text) && categories.includes(name)) return name;
  }
  return undefined;
}

function describe(cat: string, merchant: string, travel: SubmitInput["travel"], claim: { meeting?: string; event?: string }, date: string): string {
  if (cat === "airlines" && travel?.origin && travel.destination) return `${travel.origin} to ${travel.destination}, ${(travel.cabin_class ?? "economy").replace(/_/g, " ")}, ${date}`;
  if (cat === "lodging" && travel?.nights) return `${merchant}, ${travel.nights} night${travel.nights === 1 ? "" : "s"} from ${date}`;
  if (cat === "conferences") return `${claim.event ?? merchant} pass, ${date}`;
  return `${merchant}, ${date}`;
}

function offerTravel(original: NonNullable<SubmitInput["travel"]>, offerDescription: string): NonNullable<SubmitInput["travel"]> {
  const { cabin_class: _rejected, ...rest } = original;
  const cabin = extractCabin(offerDescription);
  return cabin ? { ...rest, cabin_class: cabin } : original.cabin_class ? { ...rest, cabin_class: "economy" } : rest;
}

export class ScriptedBrain implements Brain {
  readonly name = "scripted";

  async decide(ctx: BrainContext): Promise<BrainAction> {
    const current = ctx.turns.at(-1);
    if (!current || current.role !== "agent") return { type: "no_reply" };
    const text = current.text.trim();
    const last: RequestSummary | undefined = ctx.requests.at(-1);

    if (last?.status === "counter" && ACCEPT.test(text) && last.counteroffer) {
      const offer = last.counteroffer;
      const input: SubmitInput = {
        merchant: offer.merchant,
        merchant_category: offer.merchant_category,
        amount_usd: offer.amount_usd,
        description: offer.description,
        justification: last.justification,
        // The gateway's counteroffer carries its own travel block. If one ever arrives without it,
        // reuse the original route but never the original (rejected) cabin.
        ...(offer.travel ? { travel: offer.travel } : last.travel ? { travel: offerTravel(last.travel as NonNullable<SubmitInput["travel"]>, offer.description) } : {}),
        claims: last.claims as SubmitInput["claims"],
        parent_request_id: last.request_id,
      };
      const err = ctx.validateSubmit(input);
      return err ? { type: "reply", text: `I couldn't build the revised request (${err}). Please resend the details.` } : { type: "submit", input };
    }
    if (ACK.test(text)) return { type: "no_reply" };
    if (STATUS.test(text) && last) return { type: "status", request_id: last.request_id };

    // Gather every agent message since the last request was submitted, so details can arrive over several texts.
    const sinceIdx = (() => {
      for (let i = ctx.turns.length - 2; i >= 0; i--) if (ctx.turns[i]!.request_id) return i + 1;
      return 0;
    })();
    const pending = ctx.turns.slice(sinceIdx).filter((t) => t.role === "agent").map((t) => t.text);
    const joined = pending.join("\n");

    const amount = extractAmount(joined);
    const cat = category(joined, ctx.merchantCategories);
    const claim = extractClaim(joined);
    const merchant = extractMerchant(joined) ?? (cat === "conferences" ? claim.event : undefined);
    const date = extractDate(joined, ctx.now, ctx.timeZone);

    const missing: string[] = [];
    if (!merchant) missing.push("the merchant");
    if (amount === undefined) missing.push("the total price");
    if (!cat) missing.push("what kind of purchase it is");
    if (!claim.meeting && !claim.event) missing.push("which meeting or event it's for");
    if (!date) missing.push("the date");

    let travel: SubmitInput["travel"];
    if (cat === "airlines") {
      const route = extractRoute(joined, ctx.homeAirport);
      const cabin = extractCabin(joined) ?? "economy";
      if (!route.destination) missing.push("the destination airport");
      if (!route.origin) missing.push("the departure airport");
      travel = { cabin_class: cabin, ...(route.origin ? { origin: route.origin } : {}), ...(route.destination ? { destination: route.destination } : {}), ...(date ? { depart_date: date } : {}) };
    } else if (cat === "lodging") {
      const nights = joined.match(/\b(\d{1,2})\s+nights?\b/i);
      if (!nights) missing.push("how many nights");
      else travel = { nights: Number(nights[1]) };
    }
    if (missing.length) return { type: "reply", text: `Happy to get this approved. I still need ${joinList(missing)}.` };

    const input: SubmitInput = {
      merchant: merchant!,
      merchant_category: cat!,
      amount_usd: amount!,
      // A clean description: the agent's own words stay in the transcript, and free text here
      // (e.g. "no upgrade needed") would trip the gateway's claims-consistency check.
      description: describe(cat!, merchant!, travel, claim, date!),
      justification: justificationFor(claim, joined),
      ...(travel ? { travel } : {}),
      claims: { ...claim, date: date! },
    };
    const err = ctx.validateSubmit(input);
    return err ? { type: "reply", text: `Something's off with that request (${err}). Can you resend it?` } : { type: "submit", input };
  }
}

/**
 * The business reason only ("Acme customer meeting"), so cabin or price words in the agent's
 * message don't leak into it (the gateway denies an economy request whose text says "first class").
 * Anything that reads like an instruction to the approver is kept verbatim for the policy engine;
 * the gateway also scans the transcript, which carries the full messages.
 */
function justificationFor(claim: { meeting?: string; event?: string }, text: string): string {
  const reason = claim.event ? claim.event : `${claim.meeting} customer meeting`;
  const pushy = /\b(ceo|cfo|founder|ignore|disregard|emergency|urgent|override|bypass|system prompt|developer mode|approve (this|it)|already approved|pre-?approved)\b/i.test(text);
  return (pushy ? `${reason}. Agent said: ${text.replace(/\s+/g, " ")}` : reason).slice(0, 1000);
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
