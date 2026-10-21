"""SQLite persistence: JSON documents keyed by (kind, id), plus the append-only event log."""

import json
import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager

SCHEMA = """
CREATE TABLE IF NOT EXISTS records (
    kind TEXT NOT NULL,
    id   TEXT NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (kind, id)
);
CREATE TABLE IF NOT EXISTS events (
    seq  INTEGER PRIMARY KEY,
    body TEXT NOT NULL
);
"""


class Store:
    def __init__(self, path: str = ":memory:"):
        self._db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.executescript(SCHEMA)
        self._lock = threading.RLock()
        self._depth = 0

    @contextmanager
    def transaction(self) -> Iterator[None]:
        """Serialize writers and commit all changes made inside the block atomically. Nests."""
        with self._lock:
            if self._depth == 0:
                self._db.execute("BEGIN IMMEDIATE")
            self._depth += 1
            try:
                yield
            except BaseException:
                self._depth -= 1
                if self._depth == 0:
                    self._db.execute("ROLLBACK")
                raise
            self._depth -= 1
            if self._depth == 0:
                self._db.execute("COMMIT")

    # ---- documents --------------------------------------------------------

    def get(self, kind: str, id_: str) -> dict | None:
        row = self._query("SELECT body FROM records WHERE kind = ? AND id = ?", kind, id_).fetchone()
        return json.loads(row[0]) if row else None

    def put(self, kind: str, id_: str, body: dict) -> None:
        with self.transaction():
            self._db.execute(
                "INSERT INTO records (kind, id, body) VALUES (?, ?, ?) "
                "ON CONFLICT (kind, id) DO UPDATE SET body = excluded.body",
                (kind, id_, json.dumps(body)),
            )

    def items(self, kind: str) -> dict[str, dict]:
        rows = self._query("SELECT id, body FROM records WHERE kind = ? ORDER BY rowid", kind)
        return {id_: json.loads(body) for id_, body in rows}

    def find(self, kind: str, field: str, value) -> dict | None:
        row = self._query(
            "SELECT body FROM records WHERE kind = ? AND json_extract(body, ?) = ? LIMIT 1", kind, f"$.{field}", value
        ).fetchone()
        return json.loads(row[0]) if row else None

    # ---- events -----------------------------------------------------------

    def append_event(self, event: dict) -> None:
        with self.transaction():
            self._db.execute("INSERT INTO events (seq, body) VALUES (?, ?)", (event["seq"], json.dumps(event)))

    def last_seq(self) -> int:
        return self._query("SELECT COALESCE(MAX(seq), 0) FROM events").fetchone()[0]

    def events_after(self, seq: int) -> list[dict]:
        return [json.loads(b) for (b,) in self._query("SELECT body FROM events WHERE seq > ? ORDER BY seq", seq)]

    def _query(self, sql: str, *args) -> sqlite3.Cursor:
        with self._lock:
            return self._db.execute(sql, args)
