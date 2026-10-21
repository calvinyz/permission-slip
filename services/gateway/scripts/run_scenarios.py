"""Drive the five demo scenarios against a running gateway and print each outcome.

    uv run python scripts/run_scenarios.py [--url http://localhost:8000] [--token dev-token]

Request ids get a per-run suffix so the script can be rerun against the same server.
Exits non-zero if any scenario produces an unexpected result.
"""

import argparse
import json
import secrets
import sys
import urllib.error
import urllib.request
from pathlib import Path

EXAMPLES = Path(__file__).resolve().parents[3] / "api" / "examples"


class Client:
    def __init__(self, url: str, token: str):
        self.url, self.token = url.rstrip("/"), token

    def call(self, method: str, path: str, body=None) -> dict:
        req = urllib.request.Request(
            self.url + path,
            method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as e:
            return json.load(e)


def load(name: str, run: str):
    def tag(r):
        if "request_id" not in r:
            return r
        r = dict(r, request_id=f"{r['request_id']}_{run}")
        if "parent_request_id" in r:
            r["parent_request_id"] = f"{r['parent_request_id']}_{run}"
        return r

    data = json.loads((EXAMPLES / name).read_text())
    return [tag(r) for r in data] if isinstance(data, list) else tag(data)


def checkout(api: Client, decision: dict, amount: float) -> dict:
    card = api.call("GET", f"/v1/cards/{decision['card']['card_id']}")
    return api.call(
        "POST",
        "/merchant/charge",
        {
            "pan": card["pan"],
            "cvc": card["cvc"],
            "exp_month": card["exp_month"],
            "exp_year": card["exp_year"],
            "merchant": "Demo Air (test merchant)",
            "merchant_category": card["merchant_lock"],
            "amount_usd": amount,
        },
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:8000")
    ap.add_argument("--token", default="dev-token")
    args = ap.parse_args()
    api, run = Client(args.url, args.token), secrets.token_hex(3)
    results = []

    def report(name: str, ok: bool, detail: str):
        results.append(ok)
        print(f"{'PASS' if ok else 'FAIL'}  {name}: {detail}")

    d = api.call("POST", "/v1/requests", load("01-happy-path.request.json", run))
    c = checkout(api, d, d["card"]["limit_usd"]) if d.get("card") else {}
    report("1 happy path", d.get("status") == "approved" and c.get("status") == "authorized", d.get("reason", d))

    d = api.call("POST", "/v1/requests", load("02-pushback.request.json", run))
    a = api.call("POST", "/v1/requests", load("02-pushback-accept.request.json", run))
    report("2 pushback", d.get("status") == "counter" and a.get("status") == "approved", d.get("reason", d))

    d = api.call("POST", "/v1/requests", load("03-escalation.request.json", run))
    esc = (d.get("escalation") or {}).get("escalation_id")
    r = api.call("POST", f"/v1/escalations/{esc}/resolve", load("03-escalation.resolution.json", run)) if esc else {}
    report("3 escalation", d.get("status") == "escalated" and r.get("status") == "approved", r.get("reason", d))

    d = api.call("POST", "/v1/requests", load("04-mismatch.request.json", run))
    c = checkout(api, d, 620.00) if d.get("card") else {}
    card = api.call("GET", f"/v1/cards/{d['card']['card_id']}") if d.get("card") else {}
    report("4 mismatch", card.get("status") == "suspended", f"card {card.get('status')} after $620 charge on $480 mandate")

    denied = [api.call("POST", "/v1/requests", r).get("status") == "denied" for r in load("05-red-team.requests.json", run)]
    report("5 red team", all(denied), f"{sum(denied)}/{len(denied)} injection attempts denied")

    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
