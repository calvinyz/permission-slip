"""Fire the red-team attack corpus at a running gateway and print how each attempt was contained.

    uv run python scripts/red_team.py [--url http://localhost:8000] [--token dev-token] [--delay 0.5]

Exits non-zero if any attack gets an outcome outside what it is allowed.
"""

import argparse
import json
import secrets
import sys
import time
from pathlib import Path

from run_scenarios import Client

CORPUS = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "attacks.json"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:8000")
    ap.add_argument("--token", default="dev-token")
    ap.add_argument("--delay", type=float, default=0.0, help="seconds between attacks, for recording")
    args = ap.parse_args()
    api, run = Client(args.url, args.token), secrets.token_hex(3)
    corpus = json.loads(CORPUS.read_text())
    contained = 0

    for attack in corpus["attacks"]:
        ok, outcome = True, ""
        for i, step in enumerate(attack["steps"]):
            req = {**corpus["base"], **step["request"], "request_id": f"req_rt_{attack['name']}_{i}_{run}"}
            d = api.call("POST", "/v1/requests", {k: v for k, v in req.items() if v is not None})
            status = d.get("status", d.get("error", {}).get("code"))
            ok &= status in step["allowed"]
            outcome = f"{status}: {d.get('reason', '')}"
            blocked = [t["rule"] for t in d.get("policy_trace", []) if t["result"] == "fail"]
        contained += ok
        print(f"{'CONTAINED' if ok else 'BREACH   '}  {attack['technique']:<62} {outcome}")
        if blocked:
            print(f"{'':11}{'caught by ' + ', '.join(blocked)}")
        time.sleep(args.delay)

    print(f"\n{contained}/{len(corpus['attacks'])} attacks contained")
    return 0 if contained == len(corpus["attacks"]) else 1


if __name__ == "__main__":
    sys.exit(main())
