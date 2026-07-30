#!/bin/bash
# MCP Server test commands (dev helper)
# Usage: Run each section separately, replacing SESSION_ID where needed.
#
# BEARER must be the value of your MCP_BEARER_TOKEN env var. This static-bearer
# path only works when MCP_BEARER_TOKEN is set on the server; if it is unset,
# there is no static auth and you must use the OAuth flow (see README / agent/SETUP.md).
# Link your WHOOP account first by opening $BASE/auth/whoop and entering ACCESS_PASSWORD.
BEARER="your-mcp-bearer-token"
BASE="http://localhost:3000"

# 1. Health check
echo "=== Health Check ==="
curl -s "$BASE/health"
echo -e "\n"

# 2. Auth status
echo "=== Auth Status ==="
curl -s "$BASE/auth/status"
echo -e "\n"

# 3. Initialize MCP session (note the session ID in response headers)
echo "=== Initialize MCP Session ==="
curl -s -D - -X POST "$BASE/mcp" \
  -H "Authorization: Bearer $BEARER" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
echo -e "\n"

# 4. List tools (replace SESSION_ID with the mcp-session-id from step 3)
echo "=== List Tools ==="
echo "Replace SESSION_ID below with the value from step 3"
# curl -s -X POST "$BASE/mcp" \
#   -H "Authorization: Bearer $BEARER" \
#   -H "Content-Type: application/json" \
#   -H "Accept: application/json, text/event-stream" \
#   -H "Mcp-Session-Id: SESSION_ID" \
#   -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

# 5. Call a tool (replace SESSION_ID)
echo "=== Call whoop_get_today_overview ==="
echo "Replace SESSION_ID below with the value from step 3"
# curl -s -X POST "$BASE/mcp" \
#   -H "Authorization: Bearer $BEARER" \
#   -H "Content-Type: application/json" \
#   -H "Accept: application/json, text/event-stream" \
#   -H "Mcp-Session-Id: SESSION_ID" \
#   -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"whoop_get_today_overview","arguments":{}}}'

# 6. Test rejection — no session ID on non-initialize request
echo "=== Test No Session (should 400) ==="
curl -s -X POST "$BASE/mcp" \
  -H "Authorization: Bearer $BEARER" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/list","params":{}}'
echo -e "\n"

# 7. Test rejection — no bearer token (should 401)
echo "=== Test No Auth (should 401) ==="
curl -s -X POST "$BASE/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":5,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
echo -e "\n"

# 8. Close session (replace SESSION_ID)
echo "=== Close Session ==="
echo "Replace SESSION_ID below with the value from step 3"
# curl -s -X DELETE "$BASE/mcp" \
#   -H "Authorization: Bearer $BEARER" \
#   -H "Mcp-Session-Id: SESSION_ID"
