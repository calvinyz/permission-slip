"""Request lifecycle: decide, escalate, sign, issue, settle, reconcile. Emits every step as an event."""

import json
from datetime import timedelta

from . import cards as cardlib
from . import engine, seed
from .cards import CardService
from .events import EventBus
from .mandates import MandateSigner
from .store import Store
from .util import new_id, now, parse_ts, usd

CARD_TTL = timedelta(hours=24)


class NotFound(Exception):
    pass


class Conflict(Exception):
    pass


class Forbidden(Exception):
    pass


class Gateway:
    def __init__(self, store: Store, cards: CardService, signer: MandateSigner, bus: EventBus):
        self.store = store
        self.cards = cards
        self.signer = signer
        self.bus = bus
        with store.transaction():
            for department, remaining in seed.TEAM_BUDGETS_REMAINING.items():
                if store.get("budget", department) is None:
                    store.put("budget", department, remaining)

    # ---- requests ---------------------------------------------------------

    def submit(self, req: dict) -> dict:
        with self.store.transaction():
            rid = req["request_id"]
            if existing := self.store.get("request", rid):
                if _same(existing, req):
                    return self.store.get("decision", rid)
                raise Conflict(f"request_id {rid} was already used with a different body")
            self.store.put("request", rid, req)
            self.bus.publish("request.received", rid, {"request": req})

            outcome = engine.decide(req, self.store.items("budget"))
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
                self.store.put("escalation", esc["escalation_id"], esc)
                decision["escalation"] = esc
                self.bus.publish("escalation.opened", rid, {"escalation": esc})
            elif outcome.status == "approved":
                self._approve(req, decision)

            self.store.put("decision", rid, decision)
            return decision

    def get_decision(self, request_id: str) -> dict:
        return self._get("decision", request_id)

    # ---- escalations ------------------------------------------------------

    def resolve(self, escalation_id: str, action: str, resolver_id: str, note: str | None) -> dict:
        with self.store.transaction():
            esc = self._get("escalation", escalation_id)
            if esc["status"] != "open":
                raise Conflict(f"Escalation {escalation_id} is already {esc['status']}")
            if resolver_id != esc["approver_id"]:
                raise Forbidden(f"{resolver_id} is not the approver for {escalation_id}")

            esc.update(status="approved" if action == "approve" else "denied", resolved_at=now())
            if note:
                esc["note"] = note
            self.store.put("escalation", escalation_id, esc)
            self.bus.publish("escalation.resolved", esc["request_id"], {"escalation": esc})

            decision = self.store.get("decision", esc["request_id"])
            req = self.store.get("request", esc["request_id"])
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
            self.store.put("decision", esc["request_id"], decision)
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
        self.store.put("mandate", mandate_id, mandate)

        department = seed.EMPLOYEES[req["employee_id"]]["department"]
        budget = self.store.get("budget", department) or {}
        if req["merchant_category"] in budget:
            budget[req["merchant_category"]] -= req["amount_usd"]
            self.store.put("budget", department, budget)

        self.bus.publish("mandate.signed", req["request_id"], {"mandate": mandate})
        self.bus.publish("card.issued", req["request_id"], {"card": cardlib.public(card)})
        decision["mandate_id"] = mandate_id
        decision["card"] = cardlib.public(card)

    def get_mandate(self, mandate_id: str) -> dict:
        return self._get("mandate", mandate_id)

    def get_card(self, card_id: str) -> dict:
        card = self.cards.get_card(card_id)
        if not card:
            raise NotFound(f"No card {card_id}")
        return card

    # ---- settlement -------------------------------------------------------

    def charge(self, body: dict) -> dict:
        with self.store.transaction():
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

            mandate = self.store.get("mandate", card["mandate_id"])
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
            self.bus.publish("txn.settled", txn["request_id"], {"transaction": dict(txn)})
            self._reconcile(txn, card, mandate)
            self.cards.record_transaction(txn)
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
                "memo": f"{mandate['justification']} ({self.store.get('request', rid)['description']})",
            }
            self.cards.close_card(card["card_id"])
            self.bus.publish("txn.reconciled", rid, {"transaction": txn})
        else:
            txn["status"] = "mismatch"
            self.bus.publish("txn.mismatch", rid, {"transaction": txn})
            suspended = self.cards.suspend_card(card["card_id"])
            failed = ", ".join(f"{m['field']} expected {m['expected']}, got {m['actual']}" for m in txn["match"] if m["result"] == "mismatch")
            self.bus.publish("card.suspended", rid, {"card": cardlib.public(suspended), "reason": f"Settlement mismatch: {failed}"})

    def _get(self, kind: str, id_: str) -> dict:
        if (doc := self.store.get(kind, id_)) is None:
            raise NotFound(f"No {kind} {id_}")
        return doc


def _check(field: str, expected: str, actual: str, ok: bool) -> dict:
    return {"field": field, "expected": expected, "actual": actual, "result": "match" if ok else "mismatch"}


def _same(a: dict, b: dict) -> bool:
    return json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)
