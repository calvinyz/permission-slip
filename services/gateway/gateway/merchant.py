"""Demo merchant: a labeled test storefront whose backend charges cards through POST /merchant/charge.

The merchant prices each item server-side and can be set to overcharge, so the settlement-mismatch
scenario works no matter which agent or browser completes checkout.
"""

from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, JSONResponse

from . import contract
from .service import Gateway

PAGE = Path(__file__).parent / "static" / "merchant.html"

CATALOG = [
    {
        "item_id": "flight_phl_sfo_economy",
        "title": "PHL → SFO · Economy",
        "subtitle": "Tue Nov 17 · 7:05 AM nonstop",
        "merchant": "Demo Air",
        "merchant_category": "airlines",
        "price_usd": 480.00,
    },
    {
        "item_id": "flight_phl_sfo_first",
        "title": "PHL → SFO · First",
        "subtitle": "Tue Nov 17 · 7:05 AM nonstop",
        "merchant": "Demo Air",
        "merchant_category": "airlines",
        "price_usd": 1850.00,
    },
    {
        "item_id": "conf_ai_engineer_summit",
        "title": "AI Engineer Summit · Full pass",
        "subtitle": "Nov 24–25 · San Francisco",
        "merchant": "Demo Events",
        "merchant_category": "conferences",
        "price_usd": 2400.00,
    },
]


# Headers a tunnel or proxy adds; a request carrying any of them did not come from this machine directly.
FORWARDED_HEADERS = ("x-forwarded-for", "forwarded", "x-real-ip", "cf-connecting-ip")


def is_local(request: Request) -> bool:
    """True only for a request made on this machine, not one relayed through a tunnel."""
    host = request.client.host if request.client else ""
    return host in ("127.0.0.1", "::1") and not any(h in request.headers for h in FORWARDED_HEADERS)


def router(gw: Gateway) -> APIRouter:
    r = APIRouter(prefix="/merchant")
    settings = {"overcharge_usd": 0.0}

    def error(status: int, message: str) -> JSONResponse:
        return JSONResponse({"error": {"code": "bad_request", "message": message}}, status_code=status)

    @r.get("", include_in_schema=False)
    async def page():
        return FileResponse(PAGE, media_type="text/html")

    @r.get("/catalog")
    async def catalog():
        return {"items": CATALOG}

    @r.get("/settings")
    async def get_settings():
        return settings

    @r.put("/settings")
    async def put_settings(request: Request):
        # The overcharge toggle is the demo operator's, so it only works from this machine.
        if not is_local(request):
            return JSONResponse({"error": {"code": "forbidden", "message": "Merchant settings can only be changed locally"}}, status_code=403)
        body = await request.json()
        fee = body.get("overcharge_usd")
        if not isinstance(fee, (int, float)) or not 0 <= fee <= 10000:
            return error(400, "overcharge_usd must be a number between 0 and 10000")
        settings["overcharge_usd"] = round(float(fee), 2)
        return settings

    @r.post("/checkout")
    async def checkout(request: Request):
        body = await request.json()
        item = next((i for i in CATALOG if i["item_id"] == body.get("item_id")), None)
        if not item:
            return error(400, f"Unknown item {body.get('item_id')!r}")
        charge_req = {
            "pan": str(body.get("pan", "")).replace(" ", ""),
            "cvc": str(body.get("cvc", "")),
            "exp_month": body.get("exp_month"),
            "exp_year": body.get("exp_year"),
            "merchant": f"{item['merchant']} (test merchant)",
            "merchant_category": item["merchant_category"],
            "amount_usd": round(item["price_usd"] + settings["overcharge_usd"], 2),
            "description": item["title"],
        }
        if problems := contract.errors("ChargeRequest", charge_req):
            return error(400, "Card details are incomplete: " + "; ".join(problems))
        charge = contract.check("Charge", gw.charge(charge_req))
        return {"charge": charge, "item": item, "listed_price_usd": item["price_usd"]}

    return r
