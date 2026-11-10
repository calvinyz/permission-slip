"""Charge the most recently issued active card at the demo merchant, as the merchant would.

    uv run python scripts/charge.py 480                 # the airline charges the approved amount
    uv run python scripts/charge.py 620                 # the merchant overcharges
    uv run python scripts/charge.py 480 --card card_…   # a specific card

Reads cards from the gateway's database (GATEWAY_DB_PATH, default gateway.db) and charges through
POST /merchant/charge on the running gateway, so settlement, matching, coding, suspension and the
agent's follow-up text all happen exactly as they would after a real checkout.
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from gateway.store import Store  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("amount", type=float, help="amount to charge, in dollars")
    ap.add_argument("--card", help="card id; defaults to the most recently issued active card")
    ap.add_argument("--url", default="http://localhost:8000")
    ap.add_argument("--db", default=os.environ.get("GATEWAY_DB_PATH", "gateway.db"))
    args = ap.parse_args()

    store = Store(args.db)
    cards = store.items("card")
    card = cards.get(args.card) if args.card else next((c for c in reversed(cards.values()) if c["status"] == "active"), None)
    if not card:
        print("No active card to charge. Get a request approved first.", file=sys.stderr)
        return 1
    mandate = store.get("mandate", card["mandate_id"]) or {}

    body = {
        "pan": card["pan"],
        "cvc": card["cvc"],
        "exp_month": card["exp_month"],
        "exp_year": card["exp_year"],
        "merchant": f"{mandate.get('merchant', 'Demo merchant')} (demo checkout)",
        "merchant_category": card["merchant_lock"],
        "amount_usd": round(args.amount, 2),
    }
    req = urllib.request.Request(
        f"{args.url.rstrip('/')}/merchant/charge",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            charge = json.load(resp)
    except urllib.error.HTTPError as e:
        print(f"Charge failed: HTTP {e.code} {e.read().decode()}", file=sys.stderr)
        return 1

    limit = card["limit_usd"]
    outcome = "matches the approval" if args.amount <= limit else f"is over the ${limit:,.2f} approval"
    print(f"{charge['status']}: ${args.amount:,.2f} on card …{card['last4']} at {body['merchant']}; {outcome}")
    return 0 if charge["status"] == "authorized" else 1


if __name__ == "__main__":
    sys.exit(main())
