# Permission Slip

Built for the Ramp hackathon, November 2026. Site and live approval simulator: [calvinyz.github.io/permission-slip](https://calvinyz.github.io/permission-slip/).

Personal AI agents are starting to spend company money. Permission Slip makes them ask first. An agent asks for approval over SMS or MCP, and policy code checks verified facts before anything is bought. If the request is approved, the agent gets a single-use virtual card locked to the merchant, the amount and a time window. When the charge settles, the gateway matches it to the approval and codes it to the general ledger, so nobody files an expense report.

Cards come from a simulated issuer modeled on Ramp's virtual cards, and no real money moves. This project is not affiliated with or endorsed by Ramp.

```
Personal agent ──► Conversation service ──► Gateway ──► Card issuer
 (SMS, email,       (channels, negotiator,  (verify, policy,
  MCP)               approvals, dashboard)   mandate, reconcile)
```

Language models in the conversation service read agent messages and write the replies. No model sits in the approval path. The gateway decides with deterministic policy rules over verified claims, and every approval is an Ed25519-signed mandate.

## Repository layout

| Path | What it is |
| --- | --- |
| [`api/`](api/) | The HTTP + event-stream contract (OpenAPI 3.1) and example payloads. The only thing services share. |
| [`services/gateway/`](services/gateway/) | Decisioning service: claim verification, policy engine, signed mandates, card issuing, settlement and reconciliation, plus the demo merchant. Python / FastAPI. |
| [`services/conversation/`](services/conversation/) | Conversation service: SMS (including a Google Voice bridge) and email channels, the LLM negotiator, the MCP server, Slack approvals, and the live dashboard. TypeScript / Node. |
| [`site/`](site/) | The project site, published to GitHub Pages by `.github/workflows/pages.yml`. Static HTML, no build step. |

Services never import each other's code. They integrate only through `api/openapi.yaml`, and each validates its own traffic against it.

## Quick start

```bash
cd services/gateway
uv sync
uv run pytest                                   # contract + scenario tests
uv run uvicorn --factory gateway.app:create_app --reload         # http://localhost:8000
uv run python scripts/run_scenarios.py          # drive all demo scenarios against it
```

Then the conversation service, in a second terminal (starts the gateway itself if it isn't running):

```bash
cd services/conversation
npm install
npm run demo:local                              # http://localhost:8787/dashboard/
npm run scenarios                               # all five scenarios through SMS, MCP and Slack
npm test                                        # includes end-to-end tests against the real gateway
```

Mock the API from the contract instead (for building clients without the gateway):

```bash
npx @stoplight/prism-cli mock api/openapi.yaml   # http://localhost:4010
```

## Demo scenarios

| # | Scenario | Result |
| --- | --- | --- |
| 1 | Economy flight to a verified customer meeting | Approved, card issued, charge reconciled and coded |
| 2 | First-class request | Counteroffer for the compliant economy fare; accepted and approved |
| 3 | Conference ticket over team budget | Escalated to the manager, approved, card issued |
| 4 | Merchant charges more than the mandate | Mismatch detected, card suspended |
| 5 | Prompt-injection attempts | Denied, `injection.blocked` emitted |
