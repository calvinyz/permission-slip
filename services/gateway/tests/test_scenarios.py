"""The five demo scenarios, end to end through the HTTP API. Every response and event is contract-checked by the app."""

from gateway.app import StreamTickets
from gateway.mandates import verify

from .conftest import example


def checkout(client, decision, amount=None, merchant="Demo Air (test merchant)"):
    card = client.get(f"/v1/cards/{decision['card']['card_id']}").json()
    return client.post(
        "/merchant/charge",
        json={
            "pan": card["pan"],
            "cvc": card["cvc"],
            "exp_month": card["exp_month"],
            "exp_year": card["exp_year"],
            "merchant": merchant,
            "merchant_category": card["merchant_lock"],
            "amount_usd": amount or card["limit_usd"],
        },
    ).json()


def test_1_happy_path(client, events):
    d = client.post("/v1/requests", json=example("01-happy-path.request.json")).json()
    assert d["status"] == "approved"
    assert d["card"]["limit_usd"] == 480.00 and d["card"]["merchant_lock"] == "airlines"

    mandate = client.get(f"/v1/mandates/{d['mandate_id']}").json()
    assert verify(mandate)
    assert verify(mandate | {"amount_usd": 4800.00}) is False

    charge = checkout(client, d)
    assert charge["status"] == "authorized"
    assert events() == [
        "request.received", "claims.verified", "policy.decided", "mandate.signed", "card.issued",
        "txn.settled", "txn.reconciled",
    ]
    assert client.get(f"/v1/cards/{d['card']['card_id']}").json()["status"] == "closed"


def test_2_pushback_then_accept(client):
    d = client.post("/v1/requests", json=example("02-pushback.request.json")).json()
    assert d["status"] == "counter"
    assert d["counteroffer"]["amount_usd"] == 480.00
    assert d["card"] is None

    accepted = client.post("/v1/requests", json=example("02-pushback-accept.request.json")).json()
    assert accepted["status"] == "approved"


def test_3_escalation_approved_by_manager(client, events):
    d = client.post("/v1/requests", json=example("03-escalation.request.json")).json()
    assert d["status"] == "escalated" and d["card"] is None
    esc_id = d["escalation"]["escalation_id"]
    assert d["escalation"]["approver_id"] == "emp_priya"

    wrong = client.post(f"/v1/escalations/{esc_id}/resolve", json={"action": "approve", "resolver_id": "emp_maya"})
    assert wrong.status_code == 403

    resolved = client.post(f"/v1/escalations/{esc_id}/resolve", json=example("03-escalation.resolution.json")).json()
    assert resolved["status"] == "approved" and resolved["card"]["limit_usd"] == 2400.00
    assert client.get(f"/v1/requests/{d['request_id']}").json()["status"] == "approved"
    assert client.get(f"/v1/mandates/{resolved['mandate_id']}").json()["approved_by"] == "emp_priya"
    assert "escalation.opened" in events() and "escalation.resolved" in events()

    again = client.post(f"/v1/escalations/{esc_id}/resolve", json=example("03-escalation.resolution.json"))
    assert again.status_code == 409


def test_4_overcharge_suspends_card(client, events):
    d = client.post("/v1/requests", json=example("04-mismatch.request.json")).json()
    charge = checkout(client, d, amount=620.00)
    assert charge["status"] == "authorized"
    assert events()[-3:] == ["txn.settled", "txn.mismatch", "card.suspended"]
    assert client.get(f"/v1/cards/{d['card']['card_id']}").json()["status"] == "suspended"

    retry = checkout(client, d, amount=480.00)
    assert retry == retry | {"status": "declined", "decline_reason": "card_suspended"}


def test_5_red_team_is_always_denied(client, events):
    for req in example("05-red-team.requests.json"):
        d = client.post("/v1/requests", json=req).json()
        assert d["status"] == "denied", req["request_id"]
        assert d["card"] is None and d["mandate_id"] is None
        assert {"rule": "injection.scan", "result": "fail"}.items() <= d["policy_trace"][0].items()
    assert events().count("injection.blocked") >= 4
    assert "card.issued" not in events()


def test_idempotent_resubmit_and_conflict(client):
    req = example("01-happy-path.request.json")
    first = client.post("/v1/requests", json=req).json()
    assert client.post("/v1/requests", json=req).json() == first
    conflict = client.post("/v1/requests", json=req | {"amount_usd": 500.00})
    assert conflict.status_code == 409 and conflict.json()["error"]["code"] == "conflict"


def test_rejects_bad_body_and_missing_token(client):
    bad = client.post("/v1/requests", json={"request_id": "req_x"})
    assert bad.status_code == 400 and bad.json()["error"]["details"]
    assert client.get("/v1/requests/req_x", headers={"Authorization": "Bearer nope"}).status_code == 401


def test_unverifiable_meeting_is_denied(client):
    req = example("01-happy-path.request.json") | {"request_id": "req_fake_meeting", "claims": {"meeting": "Globex", "date": "2026-11-17"}}
    d = client.post("/v1/requests", json=req).json()
    assert d["status"] == "denied" and "Globex" in d["reason"]


def merchant_checkout(client, decision, item_id):
    card = client.get(f"/v1/cards/{decision['card']['card_id']}").json()
    return client.post(
        "/merchant/checkout",
        json={"item_id": item_id, **{k: card[k] for k in ("pan", "cvc", "exp_month", "exp_year")}},
    )


def test_merchant_checkout_reconciles_at_listed_price(client, events):
    d = client.post("/v1/requests", json=example("01-happy-path.request.json")).json()
    res = merchant_checkout(client, d, "flight_phl_sfo_economy").json()
    assert res["charge"]["status"] == "authorized" and res["charge"]["amount_usd"] == 480.00
    assert events()[-1] == "txn.reconciled"


def local(app):
    """A client that looks like a request made on the gateway's own machine."""
    from fastapi.testclient import TestClient

    from .conftest import TOKEN

    return TestClient(app, client=("127.0.0.1", 50000), headers={"Authorization": f"Bearer {TOKEN}"})


def test_merchant_overcharge_toggle_triggers_mismatch(app, client, events):
    with local(app) as operator:
        assert operator.put("/merchant/settings", json={"overcharge_usd": 140}).json() == {"overcharge_usd": 140.0}
    d = client.post("/v1/requests", json=example("04-mismatch.request.json")).json()
    res = merchant_checkout(client, d, "flight_phl_sfo_economy").json()
    assert res["charge"]["amount_usd"] == 620.00
    assert events()[-2:] == ["txn.mismatch", "card.suspended"]


def test_merchant_rejects_bad_input(client):
    assert client.post("/merchant/checkout", json={"item_id": "nope"}).status_code == 400
    assert client.post("/merchant/checkout", json={"item_id": "flight_phl_sfo_economy", "pan": "123"}).status_code == 400
    assert client.put("/merchant/settings", json={"overcharge_usd": -5}).status_code == 403, "remote clients can't toggle"
    assert client.get("/merchant").headers["content-type"].startswith("text/html")


def test_approvals_draw_down_team_budget(client):
    base = example("03-escalation.request.json")
    first = client.post("/v1/requests", json=base | {"request_id": "req_conf_a", "amount_usd": 900.00}).json()
    second = client.post("/v1/requests", json=base | {"request_id": "req_conf_b", "amount_usd": 900.00}).json()
    assert first["status"] == "approved"
    assert second["status"] == "escalated", "second pass should exceed the $600 left of the $1,500 budget"


def test_state_survives_restart(tmp_path):
    from fastapi.testclient import TestClient

    from gateway.app import build_gateway, create_app

    from .conftest import TOKEN

    db = str(tmp_path / "gateway.db")
    headers = {"Authorization": f"Bearer {TOKEN}"}
    with TestClient(create_app(build_gateway(db), api_token=TOKEN), headers=headers) as before:
        d = before.post("/v1/requests", json=example("03-escalation.request.json")).json()

    restarted = create_app(build_gateway(db), api_token=TOKEN)
    with TestClient(restarted, headers=headers) as after:
        assert after.get(f"/v1/requests/{d['request_id']}").json() == d
        resolved = after.post(f"/v1/escalations/{d['escalation']['escalation_id']}/resolve", json=example("03-escalation.resolution.json"))
        assert resolved.json()["status"] == "approved"
        assert after.get(f"/v1/cards/{resolved.json()['card']['card_id']}").json()["status"] == "active"
    seqs = [e["seq"] for e in restarted.state.gateway.bus.history]
    assert seqs == list(range(1, len(seqs) + 1)), "event seq continues across restarts"


def test_event_stream_tickets(client, app):
    from fastapi.testclient import TestClient

    res = client.post("/v1/events/tickets")
    assert res.status_code == 201 and res.json()["ticket"].startswith("tkt_")

    with TestClient(app) as anon:
        assert anon.post("/v1/events/tickets").status_code == 401, "issuing a ticket needs the bearer token"
        assert anon.get("/v1/events", params={"ticket": "tkt_forged"}).status_code == 401
        assert anon.get("/v1/requests/req_x", params={"ticket": res.json()["ticket"]}).status_code == 401, "tickets only open the stream"
        assert anon.get("/issuer").headers["content-type"].startswith("text/html")

    tickets = StreamTickets()
    t = tickets.issue()["ticket"]
    assert tickets.redeem(t) is True
    assert tickets.redeem(t) is False, "single use"


def test_overcharge_toggle_is_local_only(app):
    with local(app) as operator:
        assert operator.put("/merchant/settings", json={"overcharge_usd": -5}).status_code == 400
        assert operator.put("/merchant/settings", json={"overcharge_usd": 0}).status_code == 200
        tunneled = operator.put("/merchant/settings", json={"overcharge_usd": 140}, headers={"X-Forwarded-For": "203.0.113.7"})
        assert tunneled.status_code == 403, "a request relayed through a tunnel is not local"
