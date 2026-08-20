# Grok Build example

This example uses Grok Build on the same machine as a local server. It does not
configure the `@grok` account on X, for which xAI currently documents no custom
MCP setup path.

Start and link the server by following
[`docs/getting-started.md`](../../docs/getting-started.md), then add the local
Streamable HTTP endpoint:

```bash
grok mcp add --transport http whoop-personal http://localhost:3000/mcp
grok mcp doctor whoop-personal --json
grok mcp list
```

Grok opens the MCP OAuth flow in a browser. Verify the destination shown on the
consent page, enter the server's `ACCESS_PASSWORD`, and approve only the client
you intended to connect. In Grok, try:

> List the WHOOP tools you can use. Call today's overview and report the source
> dates, coverage, and any stale or missing values. Treat null as unavailable,
> do not infer a diagnosis, and do not prescribe a workout.

Expected behavior:

- six core tools are discoverable;
- `whoop_get_event_context` appears only when the owner configured an event;
- the response identifies dates and missing/stale data; and
- the client does not turn a Recovery band into medical advice or clearance.

For Grok.com or the xAI Responses API, use the public-HTTPS and static-bearer
guidance in [`docs/clients.md`](../../docs/clients.md#grok). Do not guess a
remote OAuth callback hostname or commit a bearer token to Grok configuration.
