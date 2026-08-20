# MCP protocol compatibility

WHOOP Personal MCP serves two MCP protocol eras from the same authenticated
Streamable HTTP endpoint. New clients can use the native, stateless
<code>2026-07-28</code> protocol. Clients that still speak a protocol revision
from <code>2024-10-07</code> through <code>2025-11-25</code> use a stateless
legacy fallback.

The server does not require an operator setting to choose an era. The request
shape selects it, and both eras expose the same WHOOP tools, prompt, resource,
authorization boundary, and read-only behavior.

## Compatibility at a glance

| Behavior | Native <code>2026-07-28</code> | Legacy fallback through <code>2025-11-25</code> |
|---|---|---|
| Opening exchange | Optional <code>server/discover</code>; no initialization handshake | <code>initialize</code> / <code>notifications/initialized</code> |
| HTTP methods at <code>/mcp</code> | POST | POST; legacy GET and DELETE session operations return method-not-allowed |
| Protocol session | None | None in this server's stateless fallback |
| <code>Mcp-Session-Id</code> | Not used | Not issued or required |
| Version/capabilities | Carried in every request's <code>_meta</code> envelope | Negotiated during <code>initialize</code> |
| HTTP routing metadata | <code>MCP-Protocol-Version</code>, <code>Mcp-Method</code>, and, when applicable, <code>Mcp-Name</code> | Legacy Streamable HTTP request shape |
| List/resource caching | Required private cache hints supplied by the SDK; tool order remains deterministic | Earlier result shape without 2026 cache fields |

This is protocol compatibility, not a promise that every release of every MCP
client has been tested. Client vendors roll out new protocol revisions on their
own schedules. The dual-era endpoint is deliberate: a current client can use
<code>2026-07-28</code>, while a client that has not upgraded can keep using its
2025-era handshake.

## Native 2026 behavior

The modern protocol is request-scoped:

1. A client may call <code>server/discover</code> to learn the supported version,
   capabilities, and server identity. Discovery is optional for clients that
   already know what they will send.
2. Each JSON-RPC request is an independent HTTP POST. The request includes its
   protocol version and client capabilities in <code>_meta</code> and mirrors
   routing information in the required HTTP headers.
3. The server returns one JSON response or a Server-Sent Events response stream
   scoped to that request. Closing that stream cancels only that request.
4. There is no standalone GET event stream, DELETE teardown, initialization
   handshake, resumable SSE event ID, or hidden protocol session.

The official TypeScript SDK validates the modern envelope/header pair, adds
server identity and result bookkeeping, and emits the required private cache
fields with the conservative default <code>ttlMs: 0</code> and
<code>cacheScope: "private"</code>. Those wire fields do not create an
application data cache. WHOOP Personal MCP registers tools in a fixed order. It does not use
Multi Round-Trip Requests, Tasks, Roots, Sampling, Logging, or change
subscriptions.

See the official
[2026-07-28 specification announcement](https://blog.modelcontextprotocol.io/posts/2026-07-28/),
[revision changelog](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/changelog.mdx),
and [Streamable HTTP specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http).

## Legacy fallback behavior

The fallback accepts the older initialization handshake and later JSON-RPC
POSTs, but it deliberately does not recreate the project's former in-memory
session manager. It uses the official SDK's stateless legacy serving mode: a
fresh MCP server instance handles each request, and the initialize response
does not assign an <code>Mcp-Session-Id</code>.

This project needs no cross-request MCP state. All tool inputs are explicit,
tool data comes from WHOOP on demand, and the tool catalog is fixed for the
lifetime of the process. A stateless fallback therefore preserves the client
surface without carrying hidden session state.

Older clients that incorrectly require a session ID, a standalone GET stream,
or DELETE teardown may not work. Upgrade that client or use a release that
supports stateless Streamable HTTP. The deprecated HTTP+SSE transport from
<code>2024-11-05</code> is not provided.

The official SDK describes the two eras and fallback rules in its
[protocol-version guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md).

## Authorization is shared by both eras

Protocol-era selection happens only after HTTP bearer authentication. Both
eras use the same OAuth protected-resource metadata, authorization server,
owner consent, access-token lifetime, and optional static bearer boundary.

For client identification, the authorization server supports:

1. **Client ID Metadata Documents (CIMD), preferred.** A client uses an HTTPS
   metadata-document URL as its client ID. The server retrieves and validates
   that document and its exact redirect URIs.
2. **Dynamic Client Registration (DCR), compatibility fallback.** A client
   posts metadata to the registration endpoint and receives a generated client
   ID. MCP <code>2026-07-28</code> deprecates DCR, but retains it for clients
   that do not yet support CIMD.

Both paths still require PKCE, an exact approved redirect destination, explicit
owner consent, and the owner access password. Using CIMD does not make a client
trusted automatically. Review the concrete client name and redirect
destination on the consent page.

The MCP transport and resource-server middleware use the v2 package family.
The embedded authorization-server routes currently use the official frozen
<code>@modelcontextprotocol/server-legacy</code> migration package because v2
removed those helpers. That package is not a protocol downgrade—the wire
behavior above is still enforced—but it will not receive new features. A future
managed or multi-user edition should replace the embedded authorization server
with a dedicated, maintained OAuth provider rather than extending this bridge.

The authorization metadata advertises CIMD support and keeps
<code>/register</code> for DCR. CIMD retrieval is HTTPS-only, rejects redirects
and private/reserved destinations, pins vetted DNS resolution, validates a
small JSON document and exact redirects, and is bounded by time, size, and
cache limits. It remains an outbound request surface, so production deployments
should also block private/control-plane networks with egress policy. See the
[security model](../SECURITY.md#cimd-outbound-fetch-boundary).

The authorization server includes the RFC 9207 <code>iss</code> parameter in
authorization responses. A conforming client validates that issuer before it
redeems the code. Protected-resource metadata and bearer challenges advertise
the exact <code>PUBLIC_URL/mcp</code> resource and minimal
<code>mcp:read</code> scope. See the official
[MCP authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).

## Verify a client

Do not infer a client's protocol revision from its product name. Connect it,
complete authorization, and verify that it can list the expected tools and call
one non-sensitive tool. For Grok Build:

~~~bash
grok mcp add --transport http whoop-personal https://YOUR-HOST.example/mcp
grok mcp doctor whoop-personal --json
~~~

xAI currently documents remote Streamable HTTP and automatic OAuth, but does
not state a specific MCP protocol revision in its public setup guide. The
server's dual-era endpoint is intended to cover that uncertainty. See
[client setup](clients.md) for Grok web, the xAI API, Claude, Codex, OpenClaw,
and generic clients.
