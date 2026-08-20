# Codex example

Start and link the server by following
[`docs/getting-started.md`](../../docs/getting-started.md). Add the local
Streamable HTTP endpoint and use the documented DCR compatibility path:

```bash
codex mcp add whoop_personal --url http://localhost:3000/mcp
codex mcp login whoop_personal --oauth-client-registration dcr
codex mcp list
```

In the Codex TUI, `/mcp` shows connection and authentication status. The Codex
app and IDE extension expose the same server under MCP settings. After OAuth,
try:

> Use the WHOOP MCP to list available tools, then call today's overview. State
> the measurement dates and whether any value is missing or stale. Do not turn
> the data into a diagnosis, training prescription, or event clearance.

Expected behavior:

- six core tools are discoverable;
- `whoop_get_event_context` appears only when the owner configured an event;
- `null` remains unavailable rather than becoming zero; and
- any interpretation is bounded by the tool's coverage and freshness fields.

For a remote deployment or static bearer, copy
[`templates/codex-config.toml`](../../templates/codex-config.toml) and follow
[`docs/clients.md`](../../docs/clients.md#codex). Keep the bearer in the named
environment variable, never in committed TOML.
