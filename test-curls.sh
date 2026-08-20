#!/usr/bin/env bash
set -euo pipefail

# Transport smoke test for a running WHOOP Personal MCP server.
# Required: MCP_BEARER_TOKEN must match the server's configured static token.
# Optional: BASE_URL (default http://localhost:3000), SMOKE_CALL_WHOOP=1.

BASE_URL="${BASE_URL:-http://localhost:3000}"
TOKEN="${MCP_BEARER_TOKEN:-}"

if [[ -z "$TOKEN" ]]; then
  echo "MCP_BEARER_TOKEN is required for this static-auth smoke test." >&2
  exit 2
fi

HEADERS_FILE="$(mktemp)"
BODY_FILE="$(mktemp)"
cleanup() {
  rm -f "$HEADERS_FILE" "$BODY_FILE"
}
trap cleanup EXIT

echo "1/6 health"
curl --fail --silent --show-error "$BASE_URL/health"
echo

echo "2/6 WHOOP link status"
curl --fail --silent --show-error \
  -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/auth/status"
echo

echo "3/6 discover MCP 2026-07-28 server"
curl --fail --silent --show-error \
  --dump-header "$HEADERS_FILE" \
  --output "$BODY_FILE" \
  --request POST "$BASE_URL/mcp" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "MCP-Protocol-Version: 2026-07-28" \
  -H "Mcp-Method: server/discover" \
  --data '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"curl-smoke","version":"1.0"},"io.modelcontextprotocol/clientCapabilities":{}}}}'
cat "$BODY_FILE"
echo

if grep -qi '^mcp-session-id:' "$HEADERS_FILE"; then
  echo "Modern response unexpectedly included the removed Mcp-Session-Id header." >&2
  exit 1
fi
if ! grep -q '2026-07-28' "$BODY_FILE"; then
  echo "Discovery response did not advertise MCP 2026-07-28." >&2
  exit 1
fi

echo "4/6 list tools without a transport session"
curl --fail --silent --show-error \
  --request POST "$BASE_URL/mcp" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "MCP-Protocol-Version: 2026-07-28" \
  -H "Mcp-Method: tools/list" \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"curl-smoke","version":"1.0"},"io.modelcontextprotocol/clientCapabilities":{}}}}'
echo

if [[ "${SMOKE_CALL_WHOOP:-0}" == "1" ]]; then
  echo "optional WHOOP tool call"
  curl --fail --silent --show-error \
    --request POST "$BASE_URL/mcp" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "MCP-Protocol-Version: 2026-07-28" \
    -H "Mcp-Method: tools/call" \
    -H "Mcp-Name: whoop_get_today_overview" \
    --data '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"whoop_get_today_overview","arguments":{},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"curl-smoke","version":"1.0"},"io.modelcontextprotocol/clientCapabilities":{}}}}'
  echo
fi

echo "5/6 reject missing authentication"
STATUS="$(
  curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    --request POST "$BASE_URL/mcp" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "MCP-Protocol-Version: 2026-07-28" \
    -H "Mcp-Method: server/discover" \
    --data '{"jsonrpc":"2.0","id":4,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"unauthorized-smoke","version":"1.0"},"io.modelcontextprotocol/clientCapabilities":{}}}}'
)"
if [[ "$STATUS" != "401" ]]; then
  echo "Expected unauthenticated discovery to return 401; got $STATUS." >&2
  exit 1
fi

echo "6/6 verify legacy 2025 client fallback"
curl --fail --silent --show-error \
  --request POST "$BASE_URL/mcp" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "MCP-Protocol-Version: 2025-11-25" \
  --data '{"jsonrpc":"2.0","id":5,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"legacy-curl-smoke","version":"1.0"}}}'
echo
echo "HTTP smoke test passed."
