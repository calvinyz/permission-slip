"""Claim verification and the deterministic policy engine. No model is in the decision path.

Every rule appends to the policy trace so each decision explains itself.
"""

import re
import statistics
from dataclasses import dataclass, field

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
}


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
    fields += [(f"transcript[{i}]", m["text"]) for i, m in enumerate(req.get("transcript") or [])]
    hits = []
    for name, text in fields:
        for rule, pattern in INJECTION_PATTERNS.items():
            if m := pattern.search(text):
                hits.append({"field": name, "pattern": rule, "excerpt": text[max(0, m.start() - 20) : m.end() + 20]})
    return hits


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
    if req["merchant_category"] == "airlines" and route in seed.FARE_HISTORY:
        median = statistics.median(seed.FARE_HISTORY[route])
        ok = req["amount_usd"] <= median * 1.25 or travel.get("cabin_class", "economy") != "economy"
        out.append(
            {
                "check": "price.fare_history",
                "result": "verified" if ok else "failed",
                "detail": f"{'-'.join(route)} median {usd(median)}; requested {usd(req['amount_usd'])}",
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
        return deny("Request contains instructions aimed at the approver; claims of authority or urgency do not change policy.", injections=injections)

    if not rule("employee.exists", emp is not None, req["employee_id"]):
        return deny("Unknown employee.")

    failed = [v for v in verification if v["result"] == "failed"]
    if not rule("claims.verified", not failed, "; ".join(v["detail"] for v in failed) or "all claims verified"):
        return deny(f"Could not verify: {failed[0]['detail']}.")

    if not rule("merchant.blocked", req["merchant"] not in p["blocked_merchants"], req["merchant"]):
        return deny(f"{req['merchant']} is a blocked merchant.")

    if category == "airlines":
        cabin = travel.get("cabin_class", "economy")
        if not rule("travel.air.class", cabin in p["air_cabin_classes"], cabin):
            quote = seed.ECONOMY_QUOTES.get((travel.get("origin"), travel.get("destination")))
            if quote:
                offer = {
                    "merchant": quote["merchant"],
                    "merchant_category": "airlines",
                    "amount_usd": quote["amount_usd"],
                    "description": f"{travel['origin']} to {travel['destination']}, economy, {travel.get('depart_date', '')}".strip(", "),
                    "travel": {**travel, "cabin_class": "economy"},
                    "reason": f"Policy allows economy only; economy at {usd(quote['amount_usd'])} is pre-approved.",
                }
                return Outcome("counter", offer["reason"], verification, trace, counteroffer=offer)
            return deny(f"Policy allows economy only; {cabin.replace('_', ' ')} is out of policy.")
        if not rule("travel.air.cap", amount <= p["air_cap_usd"], f"{usd(amount)} <= {usd(p['air_cap_usd'])}"):
            return deny(f"Flights are capped at {usd(p['air_cap_usd'])}.")

    if category == "lodging":
        nightly = amount / travel.get("nights", 1)
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

    if not rule("approval.auto_limit", amount <= p["auto_approve_limit_usd"], f"{usd(amount)} <= {usd(p['auto_approve_limit_usd'])}"):
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
