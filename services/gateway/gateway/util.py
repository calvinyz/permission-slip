import secrets
from datetime import UTC, datetime, timedelta


def now(offset: timedelta = timedelta()) -> str:
    return (datetime.now(UTC) + offset).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_ts(ts: str) -> datetime:
    return datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(6)}"


def usd(x: float) -> str:
    return f"${x:,.2f}"
