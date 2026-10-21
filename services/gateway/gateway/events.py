"""In-process event bus behind GET /v1/events, with full replay for reconnecting dashboards."""

import asyncio
import json
import secrets
from collections.abc import AsyncIterator

from . import contract
from .store import Store
from .util import now


class EventBus:
    def __init__(self, store: Store):
        self._store = store
        self._subscribers: set[asyncio.Queue] = set()

    def publish(self, type_: str, request_id: str | None, data: dict) -> dict:
        event = {
            "event_id": f"evt_{secrets.token_hex(6)}",
            "seq": self._store.last_seq() + 1,
            "type": type_,
            "ts": now(),
            "request_id": request_id,
            "data": data,
        }
        contract.check("Event", event)
        self._store.append_event(event)
        for q in self._subscribers:
            q.put_nowait(event)
        return event

    @property
    def history(self) -> list[dict]:
        return self._store.events_after(0)

    async def stream(self, since: int, keepalive_s: float = 15.0) -> AsyncIterator[str]:
        q: asyncio.Queue = asyncio.Queue()
        self._subscribers.add(q)
        try:
            # Subscribe before replaying so nothing published in between is lost.
            backlog = self._store.events_after(since)
            last = since
            for event in backlog:
                last = event["seq"]
                yield _sse(event)
            while True:
                try:
                    event = await asyncio.wait_for(q.get(), keepalive_s)
                except TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                if event["seq"] > last:
                    last = event["seq"]
                    yield _sse(event)
        finally:
            self._subscribers.discard(q)


def _sse(event: dict) -> str:
    return f"id: {event['seq']}\nevent: {event['type']}\ndata: {json.dumps(event)}\n\n"
