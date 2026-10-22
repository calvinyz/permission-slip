# API contract

[`openapi.yaml`](openapi.yaml) defines every endpoint, payload and event between the conversational services and the gateway. Its `components.schemas` are JSON Schema 2020-12 and are the single source of truth: every service validates the requests it sends and the responses and events it receives against them in its own contract tests.

Changes are breaking by default. Bump `info.version`, update the examples, and make sure every service's contract tests pass in the same change.

## Endpoints

| Endpoint | Caller | Purpose |
| --- | --- | --- |
| `POST /v1/requests` | Negotiator, MCP server | Submit a structured purchase request; returns a `Decision` |
| `GET /v1/requests/{request_id}` | Negotiator, MCP server | Current decision (poll while `escalated`) |
| `POST /v1/escalations/{escalation_id}/resolve` | Approvals bot | Manager approves or denies |
| `GET /v1/cards/{card_id}` | MCP server, negotiator | Card PAN/CVC for checkout |
| `GET /v1/mandates/{mandate_id}` | Dashboard | Signed mandate |
| `GET /v1/events` | Dashboard | Server-Sent Events stream of every step; replay with `since` or `Last-Event-ID` |
| `POST /v1/events/tickets` | Dashboard | Single-use, 60-second ticket for opening the stream from a browser (`?ticket=`), since `EventSource` cannot send headers |
| `POST /merchant/charge` | Demo merchant | Charge a card; triggers settlement and reconciliation |

All `/v1/*` routes require `Authorization: Bearer <GATEWAY_API_TOKEN>` (`dev-token` locally).

## Rules worth knowing

- **`request_id` is client-generated and idempotent.** Resubmitting the same body returns the current decision; reusing it with a different body is a `409`.
- **`counter` and `denied` are final for that request.** To accept a counteroffer, submit a new request with `parent_request_id` pointing at the countered one.
- **`escalated` resolves in place.** The same `request_id` moves to `approved` or `denied`; poll it or watch for `escalation.resolved`.
- **Unknown fields are rejected.** Schemas are closed (`additionalProperties: false`).
- **Free text is never trusted.** `justification`, `claims` and `transcript` are verified or scanned, never obeyed.

## Using the schemas

TypeScript (Ajv):

```ts
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { parse } from "yaml";
import { readFileSync } from "node:fs";

const ajv = addFormats(new Ajv2020({ strict: false }));
ajv.addSchema(parse(readFileSync("api/openapi.yaml", "utf8")), "contract");
const validateDecision = ajv.getSchema("contract#/components/schemas/Decision")!;
```

Python (`jsonschema` + `referencing`):

```python
import yaml
from jsonschema import Draft202012Validator
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

doc = yaml.safe_load(open("api/openapi.yaml"))
registry = Registry().with_resource("urn:contract", Resource.from_contents(doc, default_specification=DRAFT202012))
validate_decision = Draft202012Validator({"$ref": "urn:contract#/components/schemas/Decision"}, registry=registry)
```

## Examples

[`examples/`](examples/) holds one payload set per demo scenario. Every service's contract tests should validate them against the schemas; they double as fixtures for tests and mocks.

| File | Schema |
| --- | --- |
| `*.request.json`, `*.requests.json` | `PurchaseRequest` (or an array of them) |
| `*.resolution.json` | `EscalationResolution` |
| `*.charge.json` | `ChargeRequest` (card fields are placeholders; fetch real ones from `GET /v1/cards/{id}`) |

## Seed identities

| ID | Who | Department | Manager |
| --- | --- | --- | --- |
| `emp_maya` | Maya Chen | Engineering | `emp_priya` |
| `emp_noah` | Noah Kim | Sales | `emp_jordan` |
| `emp_priya` | Priya Rao | Engineering (manager) | `emp_sam` |
| `emp_jordan` | Jordan Lee | Sales (manager) | `emp_sam` |
| `emp_sam` | Sam Ortiz | Finance | none |

`agent_id` is `<agent>:<handle>`, where agent is one of `instinct`, `muse`, `claude`, `chatgpt`, `redteam`.
