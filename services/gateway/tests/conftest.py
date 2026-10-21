import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from gateway.app import create_app

EXAMPLES = Path(__file__).resolve().parents[3] / "api" / "examples"
TOKEN = "test-token"


def example(name: str):
    return json.loads((EXAMPLES / name).read_text())


@pytest.fixture
def app():
    return create_app(api_token=TOKEN)


@pytest.fixture
def client(app):
    with TestClient(app, headers={"Authorization": f"Bearer {TOKEN}"}) as c:
        yield c


@pytest.fixture
def events(app):
    """Events emitted so far, as a list of types; call it after acting."""
    return lambda: [e["type"] for e in app.state.gateway.bus.history]
