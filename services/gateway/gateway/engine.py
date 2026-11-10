"""Claim verification and the deterministic policy engine. No model is in the decision path.

Every rule appends to the policy trace so each decision explains itself.
"""

import re
import statistics
import unicodedata
from dataclasses import dataclass, field
from datetime import date

from . import seed
from .util import usd

INJECTION_PATTERNS = {
    "injection.override_instructions": re.compile(
        r"\b(ignore|disregard|forget)\b.{0,40}\b(previous|prior|above|all)\b.{0,20}\b(instructions?|rules?|polic(y|ies))\b",
        re.I,
    ),
    "injection.authority_claim": re.compile(
        r"\b(i\s*('?m| am)|this is)\s+(the\s+)?(ceo|cfo|founder|owner|admin(istrator)?|your (boss|developer))\b", re.I
    ),
    "injection.urgency_bypass": re.compile(
        r"\b(emergency|urgent)\b.{0,60}\b(skip|bypass|override|no time|approve)\b", re.I
    ),
    "injection.system_prompt": re.compile(r"\b(system prompt|developer mode|jailbreak|you are now)\b", re.I),
    "injection.force_approve": re.compile(r"\b(must|always|auto(matically)?)\s+approve\b|\bapprove this\b", re.I),
    "injection.claimed_approval": re.compile(
        r"\b(already|pre-?)\s?approved\b|\bapproved by\b|\bsigned off\b|\bgave (me )?the (ok|okay|go-ahead)\b|\bsaid it'?s (fine|ok|okay)\b",
        re.I,
    ),
}

# Agent-authored transcript roles; negotiator messages relay the gateway's own words and are not scanned.
SCANNED_ROLES = {"employee", "personal_agent"}

PREMIUM_CABIN = re.compile(r"\b(first|business)[\s-]class\b|\bpremium economy\b|\bupgrade\b|\blie[\s-]flat\b|\bsuite\b", re.I)

_ZERO_WIDTH = dict.fromkeys(map(ord, "\u200b\u200c\u200d\u200e\u200f\u2060\ufeff\u00ad"))
_LEET = str.maketrans("0134578@$", "oieastbas")
_DOTTED = re.compile(r"\b(?:[a-z]\.){2,}[a-z]?\b", re.I)


def normalize(text: str) -> str:
    """Undo common obfuscation: compatibility forms, zero-width characters, l33t digits, dotted acronyms."""
    text = unicodedata.normalize("NFKC", text).translate(_ZERO_WIDTH)
    text = _DOTTED.sub(lambda m: m.group(0).replace(".", ""), text)
    return re.sub(r"\w+", lambda m: m.group(0).translate(_LEET) if re.search(r"[a-z]", m.group(0), re.I) else m.group(0), text)


@dataclass
class Outcome:
    status: str
    reason: str
    verification: list[dict]
    policy_trace: list[dict]
    counteroffer: dict | None = None
    escalation_reason: str | None = None
    injections: list[dict] = field(default_factory=list)


def scan_injection(req: dict) -> list[dict]:
    fields = [("description", req["description"]), ("justification", req["justification"])]
    fields += [(f"claims.{k}", str(v)) for k, v in (req.get("claims") or {}).items()]
    fields += [
        (f"transcript[{i}]", m["text"]) for i, m in enumerate(req.get("transcript") or []) if m["role"] in SCANNED_ROLES
    ]
    hits = []
    for name, text in fields:
        for rule, pattern in INJECTION_PATTERNS.items():
            for candidate in (text, normalize(text)):
                if m := pattern.search(candidate):
                    excerpt = candidate[max(0, m.start() - 20) : m.end() + 20]
                    hits.append({"field": name, "pattern": rule, "excerpt": excerpt})
                    break
    return hits


def merchant_category_of(merchant: str) -> str | None:
    """Category implied by a well-known merchant name, if any."""
    return next((cat for cat, pattern in seed.MERCHANT_CATEGORY_HINTS.items() if pattern.search(merchant)), None)


def verify(req: dict) -> list[dict]:
    out = []
    emp = seed.EMPLOYEES.get(req["employee_id"])
    if not emp:
        return [{"check": "employee.exists", "result": "failed", "detail": f"No employee {req['employee_id']}"}]
    out.append({"check": "employee.exists", "result": "verified", "detail": f"{emp['name']}, {emp['department']}"})

    claims = req.get("claims") or {}
    claimed = claims.get("meeting") or claims.get("event")
    if claimed:
        date = claims.get("date") or (req.get("travel") or {}).get("depart_date")
        match = next(
            (
                e
                for e in seed.CALENDAR.get(req["employee_id"], [])
                if claimed.lower() in e["title"].lower() and (date is None or e["date"] == date)
            ),
            None,
        )
        out.append(
            {"check": "calendar.meeting", "result": "verified", "detail": f"{match['title']}, {match['date']}, {match['city']}"}
            if match
            else {"check": "calendar.meeting", "result": "failed", "detail": f"No '{claimed}' on calendar for {date or 'any date'}"}
        )

    travel = req.get("travel") or {}
    route = (travel.get("origin"), travel.get("destination"))
    round_trip = bool(travel.get("return_date"))
    history = (seed.ROUND_TRIP_FARE_HISTORY if round_trip else seed.FARE_HISTORY).get(route)
    if req["merchant_category"] == "airlines" and history:
        median = statistics.median(history)
        ok = req["amount_usd"] <= median * 1.25 or travel.get("cabin_class", "economy") != "economy"
        out.append(
            {
                "check": "price.fare_history",
                "result": "verified" if ok else "failed",
                "detail": f"{'-'.join(route)} {'round-trip ' if round_trip else ''}median {usd(median)}; requested {usd(req['amount_usd'])}",
            }
        )
    return out


def decide(req: dict, budgets: dict[str, dict[str, float]]) -> Outcome:
    """Decide a request. `budgets` is remaining spend by department and category."""
    verification = verify(req)
    trace: list[dict] = []
    p = seed.POLICY
    emp = seed.EMPLOYEES.get(req["employee_id"])
    amount, category = req["amount_usd"], req["merchant_category"]
    travel = req.get("travel") or {}

    def rule(name, passed, detail):
        trace.append({"rule": name, "result": "pass" if passed else "fail", "detail": detail})
        return passed

    def deny(reason, **kw):
        return Outcome("denied", reason, verification, trace, **kw)

    injections = scan_injection(req)
    if not rule("injection.scan", not injections, ", ".join(sorted({h["pattern"] for h in injections})) or "clean"):
        return deny("Request contains instructions aimed at the approver; claims of authority, urgency or prior approval do not change policy.", injections=injections)

    if not rule("employee.exists", emp is not None, emp["name"] if emp else req["employee_id"]):
        return deny("Unknown employee.")

    failed = [v for v in verification if v["result"] == "failed"]
    if not rule("claims.verified", not failed, "; ".join(v["detail"] for v in failed) or "all claims verified"):
        # Fare history is internal; tell the agent the outcome without the numbers it could price against.
        if failed[0]["check"] == "price.fare_history":
            return deny("This fare is well above recent prices for the route, so it can't be approved.")
        return deny(f"Could not verify: {failed[0]['detail']}.")

    if not rule("merchant.blocked", req["merchant"] not in p["blocked_merchants"], req["merchant"]):
        return deny(f"{req['merchant']} is a blocked merchant.")

    implied = merchant_category_of(req["merchant"])
    if not rule("merchant.category", implied in (None, category), f"{req['merchant']} filed as {category}" + (f", looks like {implied}" if implied else "")):
        return deny(f"{req['merchant']} must be filed as {implied.replace('_', ' ')}, not {category.replace('_', ' ')}.")

    if category == "airlines":
        missing = [f for f in ("cabin_class", "origin", "destination") if f not in travel]
        if not rule("travel.air.details", not missing, "missing " + ", ".join(missing) if missing else "complete"):
            return deny(f"Flight requests need {', '.join(missing).replace('_', ' ')}.")
        cabin = travel["cabin_class"]
        text = f"{req['description']} {req['justification']}"
        mismatch = cabin == "economy" and PREMIUM_CABIN.search(normalize(text))
        if not rule("claims.consistency", not mismatch, f"declared {cabin}" + (f", text says '{mismatch.group(0)}'" if mismatch else "")):
            return deny(f"The request declares economy but describes '{mismatch.group(0)}'.")
        round_trip = bool(travel.get("return_date"))
        if not rule("travel.air.class", cabin in p["air_cabin_classes"], cabin):
            quotes = seed.ROUND_TRIP_ECONOMY_QUOTES if round_trip else seed.ECONOMY_QUOTES
            quote = quotes.get((travel.get("origin"), travel.get("destination")))
            if quote:
                dates = travel.get("depart_date", "") + (f", returning {travel['return_date']}" if round_trip else "")
                offer = {
                    "merchant": quote["merchant"],
                    "merchant_category": "airlines",
                    "amount_usd": quote["amount_usd"],
                    "description": f"{travel['origin']} to {travel['destination']}{' round trip' if round_trip else ''}, economy, {dates}".strip(", "),
                    "travel": {**travel, "cabin_class": "economy"},
                    "reason": f"Policy allows economy only; economy at {usd(quote['amount_usd'])} can be booked now.",
                }
                return Outcome("counter", offer["reason"], verification, trace, counteroffer=offer)
            return deny(f"Policy allows economy only; {cabin.replace('_', ' ')} is out of policy.")
        cap = p["air_round_trip_cap_usd"] if round_trip else p["air_cap_usd"]
        kind = "round trip" if round_trip else "one way"
        if not rule("travel.air.cap", amount <= cap, f"{usd(amount)} of a {usd(cap)} {kind} limit"):
            return deny("This fare is above the travel policy limit for this trip.")

    if category == "lodging":
        nights = travel.get("nights")
        if travel.get("depart_date") and travel.get("return_date"):
            stay = (date.fromisoformat(travel["return_date"]) - date.fromisoformat(travel["depart_date"])).days
        else:
            stay = nights
        if not rule("travel.lodging.nights", nights is not None and nights == stay, f"{nights} nights declared, dates give {stay}"):
            return deny("Hotel requests need a night count that matches the stay dates.")
        nightly = amount / nights
        if not rule("travel.lodging.nightly", nightly <= p["lodging_nightly_cap_usd"], f"{usd(nightly)}/night"):
            return deny(f"Hotels are capped at {usd(p['lodging_nightly_cap_usd'])} per night.")

    budget = budgets.get(emp["department"], {}).get(category)
    if budget is not None and not rule("budget.team", amount <= budget, f"{usd(amount)} vs {usd(budget)} remaining in {emp['department']} {category}"):
        return Outcome(
            "escalated",
            f"{usd(amount)} exceeds the {usd(budget)} left in the {emp['department']} {category} budget; sent to your manager.",
            verification,
            trace,
            escalation_reason=f"Over {emp['department']} {category} budget by {usd(amount - budget)}",
        )

    if not rule("approval.auto_limit", amount <= p["auto_approve_limit_usd"], f"{usd(amount)} of a {usd(p['auto_approve_limit_usd'])} limit"):
        return Outcome(
            "escalated",
            f"{usd(amount)} is above the {usd(p['auto_approve_limit_usd'])} auto-approve limit; sent to your manager.",
            verification,
            trace,
            escalation_reason="Above auto-approve limit",
        )

    verified = [v["detail"] for v in verification if v["check"] == "calendar.meeting"]
    return Outcome(
        "approved",
        "Within policy" + (f"; verified {verified[0]}" if verified else "") + ".",
        verification,
        trace,
    )
