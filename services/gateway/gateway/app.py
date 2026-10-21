"""HTTP surface defined by api/openapi.yaml. Bodies are validated against the contract in both directions."""

import hmac
import os
import secrets
from datetime import UTC, datetime, timedelta
from pathlib import Path

from fastapi import FastAPI, Header, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

from . import contract, merchant
from .cards import LocalCards
from .events import EventBus
from .mandates import MandateSigner
from .service import Conflict, Forbidden, Gateway, NotFound
from .store import Store


class StreamTickets:
    """Single-use, short-lived credentials for the event stream, so the API token never appears in a URL."""

    TTL = timedelta(seconds=60)

    def __init__(self):
        self._expiry: dict[str, datetime] = {}

    def issue(self) -> dict:
        now_ = datetime.now(UTC)
        self._expiry = {t: exp for t, exp in self._expiry.items() if exp > now_}
        ticket = f"tkt_{secrets.token_urlsafe(24)}"
        self._expiry[ticket] = now_ + self.TTL
        return {"ticket": ticket, "expires_at": self._expiry[ticket].strftime("%Y-%m-%dT%H:%M:%SZ")}

    def redeem(self, ticket: str) -> bool:
        expiry = self._expiry.pop(ticket, None)
        return expiry is not None and expiry > datetime.now(UTC)


def build_gateway(db_path: str) -> Gateway:
    store = Store(db_path)
    return Gateway(store, LocalCards(store), MandateSigner(), EventBus(store))


def create_app(gateway: Gateway | None = None, api_token: str | None = None) -> FastAPI:
    gw = gateway or build_gateway(os.environ.get("GATEWAY_DB_PATH", "gateway.db"))
    token = api_token or os.environ.get("GATEWAY_API_TOKEN", "dev-token")
    app = FastAPI(title="Permission Slip Gateway", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.gateway = gw
    tickets = StreamTickets()

    def error(status: int, code: str, message: str, details=None) -> JSONResponse:
        body = {"error": {"code": code, "message": message}}
        if details is not None:
            body["error"]["details"] = details
        return JSONResponse(contract.check("Error", body), status_code=status)

    def ok(schema: str, body: dict) -> JSONResponse:
        return JSONResponse(contract.check(schema, body))

    async def parse(request: Request, schema: str):
        try:
            body = await request.json()
        except ValueError:
            return None, error(400, "bad_request", "Body is not valid JSON")
        if problems := contract.errors(schema, body):
            return None, error(400, "bad_request", f"Body does not match {schema}", problems)
        return body, None

    @app.middleware("http")
    async def auth(request: Request, call_next):
        if request.url.path.startswith("/v1/"):
            supplied = request.headers.get("authorization", "")
            if request.url.path == "/v1/events" and "ticket" in request.query_params:
                if not tickets.redeem(request.query_params["ticket"]):
                    return error(401, "unauthorized", "Stream ticket is invalid, used or expired")
            elif not hmac.compare_digest(supplied, f"Bearer {token}"):
                return error(401, "unauthorized", "Missing or invalid bearer token")
        return await call_next(request)

    @app.exception_handler(NotFound)
    async def _not_found(_, exc):
        return error(404, "not_found", str(exc))

    @app.exception_handler(Conflict)
    async def _conflict(_, exc):
        return error(409, "conflict", str(exc))

    @app.exception_handler(Forbidden)
    async def _forbidden(_, exc):
        return error(403, "forbidden", str(exc))

    @app.get("/healthz")
    async def health():
        return {"ok": True}

    @app.get("/issuer", include_in_schema=False)
    async def issuer_console():
        return FileResponse(Path(__file__).parent / "static" / "issuer.html", media_type="text/html")

    @app.get("/openapi.yaml")
    async def openapi():
        return FileResponse(contract.OPENAPI_PATH, media_type="application/yaml")

    @app.post("/v1/requests")
    async def submit_request(request: Request):
        body, err = await parse(request, "PurchaseRequest")
        return err or ok("Decision", gw.submit(body))

    @app.get("/v1/requests/{request_id}")
    async def get_request(request_id: str):
        return ok("Decision", gw.get_decision(request_id))

    @app.post("/v1/escalations/{escalation_id}/resolve")
    async def resolve_escalation(escalation_id: str, request: Request):
        body, err = await parse(request, "EscalationResolution")
        return err or ok("Decision", gw.resolve(escalation_id, body["action"], body["resolver_id"], body.get("note")))

    @app.get("/v1/mandates/{mandate_id}")
    async def get_mandate(mandate_id: str):
        return ok("Mandate", gw.get_mandate(mandate_id))

    @app.get("/v1/cards/{card_id}")
    async def get_card(card_id: str):
        return ok("CardDetails", gw.get_card(card_id))

    @app.post("/v1/events/tickets")
    async def create_stream_ticket():
        return JSONResponse(contract.check("StreamTicket", tickets.issue()), status_code=201)

    @app.get("/v1/events")
    async def events(since: int = 0, last_event_id: str | None = Header(default=None)):
        if last_event_id and last_event_id.isdigit():
            since = max(since, int(last_event_id))
        return StreamingResponse(
            gw.bus.stream(since),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    app.include_router(merchant.router(gw))

    @app.post("/merchant/charge")
    async def merchant_charge(request: Request):
        body, err = await parse(request, "ChargeRequest")
        return err or ok("Charge", gw.charge(body))

    return app

