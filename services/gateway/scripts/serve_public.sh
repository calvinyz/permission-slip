#!/usr/bin/env bash
# Run the gateway and expose it at a public HTTPS URL through Tailscale Funnel.
# Reads configuration from services/gateway/.env (see .env.example).
set -euo pipefail

cd "$(dirname "$0")/.."
PORT="${PORT:-8000}"

if [[ -f .env ]]; then
  set -a; source .env; set +a
fi

if [[ -z "${GATEWAY_API_TOKEN:-}" || "${GATEWAY_API_TOKEN}" == "dev-token" ]]; then
  echo "Set a strong GATEWAY_API_TOKEN in services/gateway/.env before exposing the gateway." >&2
  echo "  e.g. echo \"GATEWAY_API_TOKEN=\$(openssl rand -hex 24)\" >> .env" >&2
  exit 1
fi

cleanup() {
  tailscale funnel --https=443 off >/dev/null 2>&1 || true
  kill "${SERVER_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

uv run uvicorn --factory gateway.app:create_app --host 127.0.0.1 --port "$PORT" &
SERVER_PID=$!

tailscale funnel --bg "$PORT"
URL="https://$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
echo
echo "Gateway:  $URL"
echo "Merchant: $URL/merchant"
echo "Events:   $URL/v1/events"
echo

wait "$SERVER_PID"
