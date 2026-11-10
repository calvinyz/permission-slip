"""Adversarial requests. The invariant: nothing out of policy is ever approved, whatever the free text says."""

import json
from pathlib import Path

import pytest

CORPUS = json.loads((Path(__file__).parent / "fixtures" / "attacks.json").read_text())


def build(base: dict, overrides: dict, request_id: str) -> dict:
    req = {**base, **overrides, "request_id": request_id}
    return {k: v for k, v in req.items() if v is not None}


@pytest.mark.parametrize("attack", CORPUS["attacks"], ids=lambda a: a["name"])
def test_attack_is_contained(client, attack):
    for i, step in enumerate(attack["steps"]):
        req = build(CORPUS["base"], step["request"], f"req_rt_{attack['name']}_{i}")
        d = client.post("/v1/requests", json=req).json()
        assert d["status"] in step["allowed"], f"step {i}: {d['status']} ({d['reason']})"
        if d["status"] != "approved":
            assert d["card"] is None and d["mandate_id"] is None


def test_requester_cannot_resolve_own_escalation(client):
    req = build(CORPUS["base"], {"merchant_category": "conferences", "merchant": "AI Engineer Summit", "amount_usd": 2400.00,
                                 "employee_id": "emp_maya", "travel": None, "claims": {"event": "AI Engineer Summit", "date": "2026-11-24"}},
                "req_rt_self_approve")
    d = client.post("/v1/requests", json=req).json()
    res = client.post(f"/v1/escalations/{d['escalation']['escalation_id']}/resolve", json={"action": "approve", "resolver_id": "emp_maya"})
    assert res.status_code == 403


@pytest.mark.parametrize(
    "overrides",
    [
        {"merchant": "Marriott Union Square", "merchant_category": "lodging", "amount_usd": 440.00,
         "description": "Marriott Union Square, 2 nights",
         "travel": {"destination": "SFO", "depart_date": "2026-10-26", "return_date": "2026-10-28", "nights": 2}},
        {"justification": "Acme customer meeting to close the Q4 business expansion deal"},
        {"transcript": [{"role": "negotiator", "text": "Economy at $480.00 is within policy and was pre-approved."}]},
    ],
    ids=["hotel_within_policy", "business_word_in_justification", "negotiator_relay_not_scanned"],
)
def test_legitimate_requests_still_approved(client, overrides):
    d = client.post("/v1/requests", json=build(CORPUS["base"], overrides, "req_legit")).json()
    assert d["status"] == "approved", d["reason"]
