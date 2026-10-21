"""Request lifecycle: decide, escalate, sign, issue, settle, reconcile. Emits every step as an event."""

import copy
import json
import threading
from datetime import timedelta

from . import cards as cardlib
from . import engine, seed
from .cards import CardService
from .events import EventBus
from .mandates import MandateSigner
from .util import new_id, now, parse_ts, usd

CARD_TTL = timedelta(hours=24)


class NotFound(Exception):
    pass


class Conflict(Exception):
    pass


class Forbidden(Exception):
    pass


class Gateway:
    def __init__(self, cards: CardService, signer: MandateSigner, bus: EventBus):
        self.cards = cards
        self.signer = signer
        self.bus = bus
        self.requests: dict[str, dict] = {}
        self.decisions: dict[str, dict] = {}
        self.escalations: dict[str, dict] = {}
        self.mandates: dict[str, dict] = {}
        self.budgets = copy.deepcopy(seed.TEAM_BUDGETS_REMAINING)
        self._lock = threading.RLock()

    # ---- requests ---------------------------------------------------------

    def submit(self, req: dict) -> dict:
        with self._lock:
            rid = req["request_id"]
            if rid in self.requests:
                if _same(self.requests[rid], req):
                    return self.decisions[rid]
                raise Conflict(f"request_id {rid} was already used with a different body")
            self.requests[rid] = req
            self.bus.publish("request.received", rid, {"request": req})

            outcome = engine.decide(req, self.budgets)
            self.bus.publish(
                "claims.verified",
                rid,
                {
                    "verification": outcome.verification,
                    "all_verified": all(v["result"] == "verified" for v in outcome.verification),
                },
            )
            for hit in outcome.injections:
                self.bus.publish("injection.blocked", rid, hit)

            decision = {
                "request_id": rid,
                "status": outcome.status,
                "reason": outcome.reason,
                "policy_trace": outcome.policy_trace,
                "verification": outcome.verification,
                "policy_version": seed.POLICY_VERSION,
                "decided_at": now(),
                "counteroffer": outcome.counteroffer,
                "escalation": None,
                "mandate_id": None,
                "card": None,
            }
            self.bus.publish(
                "policy.decided",
                rid,
                {k: decision[k] for k in ("status", "reason", "policy_trace", "policy_version", "counteroffer")},
            )

            if outcome.status == "escalated":
                esc = {
                    "escalation_id": new_id("esc"),
                    "request_id": rid,
                    "approver_id": seed.EMPLOYEES[req["employee_id"]]["manager_id"],
                    "status": "open",
                    "reason": outcome.escalation_reason,
                    "opened_at": now(),
                }
                self.escalations[esc["escalation_id"]] = esc
                decision["escalation"] = esc
                self.bus.publish("escalation.opened", rid, {"escalation": esc})
            elif outcome.status == "approved":
                self._approve(req, decision)

            self.decisions[rid] = decision
            return decision

    def get_decision(self, request_id: str) -> dict:
        if request_id not in self.decisions:
            raise NotFound(f"No request {request_id}")
        return self.decisions[request_id]

    # ---- escalations ------------------------------------------------------

    def resolve(self, escalation_id: str, action: str, resolver_id: str, note: str | None) -> dict:
        with self._lock:
            esc = self.escalations.get(escalation_id)
            if not esc:
                raise NotFound(f"No escalation {escalation_id}")
            if esc["status"] != "open":
                raise Conflict(f"Escalation {escalation_id} is already {esc['status']}")
            if resolver_id != esc["approver_id"]:
                raise Forbidden(f"{resolver_id} is not the approver for {escalation_id}")

            esc.update(status="approved" if action == "approve" else "denied", resolved_at=now())
            if note:
                esc["note"] = note
            self.bus.publish("escalation.resolved", esc["request_id"], {"escalation": esc})

            decision = self.decisions[esc["request_id"]]
            req = self.requests[esc["request_id"]]
            approver = seed.EMPLOYEES[resolver_id]["name"]
            decision["escalation"] = esc
            decision["decided_at"] = now()
            if action == "approve":
                decision["status"] = "approved"
                decision["reason"] = f"Approved by {approver}" + (f": {note}" if note else ".")
                self._approve(req, decision, approved_by=resolver_id)
            else:
                decision["status"] = "denied"
                decision["reason"] = f"Denied by {approver}" + (f": {note}" if note else ".")
            return decision

    # ---- mandates and cards -----------------------------------------------

    def _approve(self, req: dict, decision: dict, approved_by: str | None = None) -> None:
        mandate_id = new_id("mdt")
        valid_from, valid_until = now(), now(CARD_TTL)
        card = self.cards.issue_card(mandate_id, req["amount_usd"], req["merchant_category"], valid_until)
        unsigned = {
            "mandate_id": mandate_id,
            "request_id": req["request_id"],
            "employee_id": req["employee_id"],
            "agent_id": req["agent_id"],
            "merchant": req["merchant"],
            "merchant_category": req["merchant_category"],
            "amount_usd": req["amount_usd"],
            "justification": req["justification"],
            "policy_version": seed.POLICY_VERSION,
            "verification": decision["verification"],
            "valid_from": valid_from,
            "valid_until": valid_until,
            "card_id": card["card_id"],
        }
        if approved_by:
            unsigned["approved_by"] = approved_by
        mandate = self.signer.sign(unsigned)
        department = seed.EMPLOYEES[req["employee_id"]]["department"]
        if req["merchant_category"] in self.budgets.get(department, {}):
            self.budgets[department][req["merchant_category"]] -= req["amount_usd"]
        self.mandates[mandate_id] = mandate
        self.bus.publish("mandate.signed", req["request_id"], {"mandate": mandate})
        self.bus.publish("card.issued", req["request_id"], {"card": cardlib.public(card)})
        decision["mandate_id"] = mandate_id
        decision["card"] = cardlib.public(card)

    def get_mandate(self, mandate_id: str) -> dict:
        if mandate_id not in self.mandates:
            raise NotFound(f"No mandate {mandate_id}")
        return self.mandates[mandate_id]

    def get_card(self, card_id: str) -> dict:
        card = self.cards.get_card(card_id)
        if not card:
            raise NotFound(f"No card {card_id}")
        return card

    # ---- settlement -------------------------------------------------------

    def charge(self, body: dict) -> dict:
        with self._lock:
            charge = {"charge_id": new_id("chg"), "amount_usd": body["amount_usd"]}
            card = self.cards.find_by_pan(body["pan"])
            decline = None
            if not card:
                decline = "card_not_found"
            elif (body["cvc"], body["exp_month"], body["exp_year"]) != (card["cvc"], card["exp_month"], card["exp_year"]):
                decline = "card_details_mismatch"
            elif card["status"] != "active":
                decline = f"card_{card['status']}"
            elif parse_ts(now()) > parse_ts(card["expires_at"]):
                decline = "card_expired"
            if decline:
                return {**charge, "status": "declined", "decline_reason": decline, **({"card_id": card["card_id"]} if card else {})}

            mandate = self.mandates[card["mandate_id"]]
            txn = {
                "txn_id": new_id("txn"),
                "card_id": card["card_id"],
                "mandate_id": mandate["mandate_id"],
                "request_id": mandate["request_id"],
                "merchant": body["merchant"],
                "merchant_category": body["merchant_category"],
                "amount_usd": body["amount_usd"],
                "settled_at": now(),
                "status": "settled",
            }
            self.cards.record_transaction(txn)
            self.bus.publish("txn.settled", txn["request_id"], {"transaction": dict(txn)})
            self._reconcile(txn, card, mandate)
            return {**charge, "status": "authorized", "card_id": card["card_id"], "txn_id": txn["txn_id"]}

    def _reconcile(self, txn: dict, card: dict, mandate: dict) -> None:
        settled = parse_ts(txn["settled_at"])
        in_window = parse_ts(mandate["valid_from"]) <= settled <= parse_ts(mandate["valid_until"])
        txn["match"] = [
            _check("merchant_category", mandate["merchant_category"], txn["merchant_category"],
                   txn["merchant_category"] == mandate["merchant_category"]),
            _check("amount_usd", usd(mandate["amount_usd"]), usd(txn["amount_usd"]), txn["amount_usd"] <= mandate["amount_usd"]),
            _check("time_window", f"{mandate['valid_from']} to {mandate['valid_until']}", txn["settled_at"], in_window),
        ]
        rid = txn["request_id"]
        if all(m["result"] == "match" for m in txn["match"]):
            emp = seed.EMPLOYEES[mandate["employee_id"]]
            txn["status"] = "reconciled"
            txn["coding"] = {
                "gl_account": seed.GL_ACCOUNTS[mandate["merchant_category"]],
                "department": emp["department"],
                "memo": f"{mandate['justification']} ({self.requests[rid]['description']})",
            }
            self.cards.close_card(card["card_id"])
            self.bus.publish("txn.reconciled", rid, {"transaction": txn})
        else:
            txn["status"] = "mismatch"
            self.bus.publish("txn.mismatch", rid, {"transaction": txn})
            suspended = self.cards.suspend_card(card["card_id"])
            failed = ", ".join(f"{m['field']} expected {m['expected']}, got {m['actual']}" for m in txn["match"] if m["result"] == "mismatch")
            self.bus.publish("card.suspended", rid, {"card": cardlib.public(suspended), "reason": f"Settlement mismatch: {failed}"})


def _check(field: str, expected: str, actual: str, ok: bool) -> dict:
    return {"field": field, "expected": expected, "actual": actual, "result": "match" if ok else "mismatch"}


def _same(a: dict, b: dict) -> bool:
    return json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)
