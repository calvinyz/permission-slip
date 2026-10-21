"""Card issuing behind one interface, so the in-memory issuer and the Ramp sandbox are interchangeable."""

import secrets
from typing import Protocol

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


class InMemoryCards:
    """Single-use virtual cards held in memory, shaped like Ramp's so the backends are interchangeable."""

    def __init__(self):
        self._cards: dict[str, dict] = {}
        self._txns: list[dict] = []

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
        self._cards[card["card_id"]] = card
        return dict(card)

    def suspend_card(self, card_id):
        self._cards[card_id]["status"] = "suspended"
        return dict(self._cards[card_id])

    def close_card(self, card_id):
        self._cards[card_id]["status"] = "closed"
        return dict(self._cards[card_id])

    def get_card(self, card_id):
        card = self._cards.get(card_id)
        return dict(card) if card else None

    def find_by_pan(self, pan):
        return next((dict(c) for c in self._cards.values() if c["pan"] == pan), None)

    def list_transactions(self, card_id=None):
        return [t for t in self._txns if card_id is None or t["card_id"] == card_id]

    def record_transaction(self, txn):
        self._txns.append(txn)


def public(card: dict) -> dict:
    """Card as it appears in decisions and events: no PAN or CVC."""
    return {k: card[k] for k in ("card_id", "mandate_id", "last4", "limit_usd", "merchant_lock", "expires_at", "status")}
