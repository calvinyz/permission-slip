# Gateway

The decisioning service. It receives structured purchase requests, verifies every claim, applies deterministic policy, and on approval signs a mandate and issues a single-use card. When the charge settles it reconciles against the mandate, codes the transaction, or suspends the card on a mismatch. Every step is published on the event stream.

## Run

```bash
uv sync
uv run uvicorn gateway.app:app --reload           # http://localhost:8000
uv run pytest
uv run python scripts/run_scenarios.py --url http://localhost:8000
```

The demo merchant is at http://localhost:8000/merchant (`?item=<item_id>` preselects an item). Its operator panel toggles a $140 undisclosed fee for the settlement-mismatch scenario.

| Variable | Default | Purpose |
| --- | --- | --- |
| `GATEWAY_API_TOKEN` | `dev-token` | Bearer token required on `/v1/*` |
| `GATEWAY_MANDATE_KEY` | generated per process | Base64 Ed25519 seed for signing mandates; set it to keep signatures stable across restarts |

## Public URL

To reach the gateway from outside (SMS webhooks, agents browsing the demo merchant, the dashboard), expose it with Tailscale Funnel:

```bash
cp .env.example .env          # set GATEWAY_API_TOKEN to a strong value
./scripts/serve_public.sh     # prints https://<machine>.<tailnet>.ts.net
```

The script refuses to start with the default token and turns the funnel off on exit.

## Modules

| Module | Responsibility |
| --- | --- |
| [`app.py`](gateway/app.py) | HTTP routes, auth, request and response validation against the contract |
| [`service.py`](gateway/service.py) | Request lifecycle: decide, escalate, sign, issue, settle, reconcile |
| [`engine.py`](gateway/engine.py) | Claim verification, prompt-injection scan, and policy rules with a full trace |
| [`mandates.py`](gateway/mandates.py) | Ed25519 signing over RFC 8785 canonical JSON |
| [`merchant.py`](gateway/merchant.py) | Demo merchant storefront at `/merchant`: catalog, server-side pricing, overcharge toggle |
| [`cards.py`](gateway/cards.py) | `CardService` interface and the in-memory issuer |
| [`events.py`](gateway/events.py) | Event bus and Server-Sent Events stream with replay |
| [`contract.py`](gateway/contract.py) | Loads `api/openapi.yaml` and validates payloads against it |
| [`seed.py`](gateway/seed.py) | Demo company: employees, calendars, policy, budgets, fare history, GL accounts |

Every response and every event is validated against the contract before it leaves the service, so a contract drift fails loudly in development rather than silently in a client.

State is in memory; restarting the process clears it.
