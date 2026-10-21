"""Ed25519-signed mandates over RFC 8785 (JCS) canonical JSON."""

import base64
import json
import os

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat


def canonical(obj) -> bytes:
    """JCS for the values mandates contain: sorted keys, no whitespace, ES-style numbers."""

    def norm(v):
        if isinstance(v, float) and v.is_integer():
            return int(v)
        if isinstance(v, dict):
            return {k: norm(x) for k, x in v.items()}
        if isinstance(v, list):
            return [norm(x) for x in v]
        return v

    return json.dumps(norm(obj), sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


class MandateSigner:
    def __init__(self, seed_b64: str | None = None):
        seed_b64 = seed_b64 or os.environ.get("GATEWAY_MANDATE_KEY")
        if seed_b64:
            self._key = Ed25519PrivateKey.from_private_bytes(base64.b64decode(seed_b64))
        else:
            self._key = Ed25519PrivateKey.generate()
        raw = self._key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
        self.public_key = base64.b64encode(raw).decode()
        self.key_id = f"ed25519:{raw.hex()[:16]}"

    def sign(self, unsigned: dict) -> dict:
        body = {**unsigned, "key_id": self.key_id, "public_key": self.public_key}
        signature = base64.b64encode(self._key.sign(canonical(body))).decode()
        return {**body, "signature": signature}


def verify(mandate: dict) -> bool:
    body = {k: v for k, v in mandate.items() if k != "signature"}
    key = Ed25519PublicKey.from_public_bytes(base64.b64decode(mandate["public_key"]))
    try:
        key.verify(base64.b64decode(mandate["signature"]), canonical(body))
        return True
    except Exception:
        return False
