"""Card issuing behind one interface, so the in-memory issuer and the Ramp sandbox are interchangeable."""

import secrets
from typing import Protocol

from .store import Store
from .util import new_id


class CardService(Protocol):
    def issue_card(self, mandate_id: str, limit_usd: float, merchant_lock: str, expires_at: str) -> dict:
        """Return a CardDetails dict (Card fields plus pan, cvc, exp_month, exp_year)."""

    def suspend_card(self, card_id: str) -> dict: ...

    def close_card(self, card_id: str) -> dict: ...

    def get_card(self, card_id: str) -> dict | None: ...

    def find_by_pan(self, pan: str) -> dict | None: ...

    def list_transactions(self, card_id: str | None = None) -> list[dict]: ...

    def record_transaction(self, txn: dict) -> None: ...


class LocalCards:
    """Simulated single-use virtual cards, persisted in the store and shaped like Ramp's so the backends are interchangeable."""

    def __init__(self, store: Store):
        self._store = store

    def issue_card(self, mandate_id, limit_usd, merchant_lock, expires_at):
        pan = "4242" + "".join(secrets.choice("0123456789") for _ in range(12))
        card = {
            "card_id": new_id("card"),
            "mandate_id": mandate_id,
            "last4": pan[-4:],
            "limit_usd": limit_usd,
            "merchant_lock": merchant_lock,
            "expires_at": expires_at,
            "status": "active",
            "pan": pan,
            "cvc": f"{secrets.randbelow(1000):03d}",
            "exp_month": int(expires_at[5:7]),
            "exp_year": int(expires_at[:4]),
        }
        self._store.put("card", card["card_id"], card)
        return card

    def suspend_card(self, card_id):
        return self._set_status(card_id, "suspended")

    def close_card(self, card_id):
        return self._set_status(card_id, "closed")

    def get_card(self, card_id):
        return self._store.get("card", card_id)

    def find_by_pan(self, pan):
        return self._store.find("card", "pan", pan)

    def list_transactions(self, card_id=None):
        return [t for t in self._store.items("txn").values() if card_id is None or t["card_id"] == card_id]

    def record_transaction(self, txn):
        self._store.put("txn", txn["txn_id"], txn)

    def _set_status(self, card_id, status):
        card = self._store.get("card", card_id)
        card["status"] = status
        self._store.put("card", card_id, card)
        return card


def public(card: dict) -> dict:
    """Card as it appears in decisions and events: no PAN or CVC."""
    return {k: card[k] for k in ("card_id", "mandate_id", "last4", "limit_usd", "merchant_lock", "expires_at", "status")}
