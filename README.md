# Permission Slip

Personal AI agents are starting to spend company money. Permission Slip is the company-side agent they negotiate with first: every purchase is verified and approved **before** it happens, enforced by a single-use virtual card scoped to the merchant, amount and time window, and reconciled and coded automatically when it settles. No receipts, no expense reports.

```
Personal agent ──► Conversational services ──► Gateway ──► Card issuer
 (SMS, email,       (channels, negotiator,      (verify, policy,
  MCP)               approvals, dashboard)       mandate, reconcile)
```

The conversational services talk; the gateway decides. Language models negotiate and explain, but no model sits in the approval path: decisions come from deterministic policy rules over verified claims, and every approval is an Ed25519-signed mandate.

## Repository layout

| Path | What it is |
| --- | --- |
| [`api/`](api/) | The HTTP + event-stream contract (OpenAPI 3.1) and example payloads. The only thing services share. |

Services never import each other's code. They integrate only through `api/openapi.yaml`, and each validates its own traffic against it.

## Quick start

Mock the API from the contract (for building clients before the gateway is running):

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
