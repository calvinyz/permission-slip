"""The examples in api/examples must always satisfy the contract they illustrate."""

import pytest
import yaml
from jsonschema import Draft202012Validator

from gateway import contract

from .conftest import EXAMPLES, example


def test_openapi_schemas_are_valid_json_schema():
    doc = yaml.safe_load(contract.OPENAPI_PATH.read_text())
    for schema in doc["components"]["schemas"].values():
        Draft202012Validator.check_schema(schema)


def test_inline_openapi_examples_match_their_schemas():
    doc = yaml.safe_load(contract.OPENAPI_PATH.read_text())
    ex = doc["components"]["examples"]
    assert contract.errors("PurchaseRequest", ex["HappyPathRequest"]["value"]) == []
    assert contract.errors("Decision", ex["ApprovedDecision"]["value"]) == []


@pytest.mark.parametrize("path", sorted(EXAMPLES.glob("*.json")), ids=lambda p: p.name)
def test_example_files_match_their_schemas(path):
    schema = {"request": "PurchaseRequest", "requests": "PurchaseRequest", "resolution": "EscalationResolution", "charge": "ChargeRequest"}[
        path.name.split(".")[-2]
    ]
    payload = example(path.name)
    for item in payload if isinstance(payload, list) else [payload]:
        assert contract.errors(schema, item) == []


def test_unknown_fields_are_rejected():
    req = example("01-happy-path.request.json") | {"approved": True}
    assert contract.errors("PurchaseRequest", req)
