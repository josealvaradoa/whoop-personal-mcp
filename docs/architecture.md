# Architecture and trust boundaries

WHOOP Personal MCP is a one-owner adapter between the WHOOP Developer API and a
Streamable HTTP MCP client. It is not a hosted service, a model, a multi-user
application, or a training-plan engine.

## End-to-end data flow

~~~text
one owner's WHOOP account
        |
        | WHOOP OAuth 2.0 and HTTPS API v2
        v
owner-operated deployment
  Express + MCP server + calculations
  SQLite volume (OAuth tokens and MCP client/auth metadata)
        |
        | requested MCP tool result over Streamable HTTP
        v
chosen MCP client and AI/model provider
~~~

Repository maintainers are not in this path and receive no data or telemetry.
The deployment provider can process container memory, traffic, logs, and the
volume. The MCP client or AI provider can process and retain tool output under
its own product controls and policy. No AI response is sent back to or stored by
this server.

## Two independent OAuth boundaries

The system uses two authorization relationships:

1. **WHOOP authorization.** The owner enters <code>ACCESS_PASSWORD</code> on the
   deployment, then authorizes the personal WHOOP Developer app. WHOOP returns
   access and rotating refresh tokens to <code>/auth/whoop/callback</code>. The
   server encrypts those tokens before writing them to SQLite.
2. **MCP client authorization.** A client discovers the deployment's OAuth
   metadata, identifies itself through a Client ID Metadata Document (CIMD) or
   the backwards-compatible Dynamic Client Registration (DCR) endpoint, and
   uses PKCE. The owner reviews the destination host and enters
   <code>ACCESS_PASSWORD</code>. The server issues a one-hour MCP access token
   and, when the client declares that grant, a rotating 30-day refresh token;
   only hashes are persisted.

On the first MCP connection, both flows can be chained. These boundaries solve
different problems: WHOOP decides whether the server may read the owner's WHOOP
account, while the server decides which MCP client may read its tool output.
The optional static bearer token bypasses the second browser flow and should be
used only when a trusted client cannot perform OAuth.

## Runtime components

| Component | Responsibility |
|---|---|
| Configuration loader | Validates environment, URL/host policy, and optional owner/event context before startup. |
| Express server | Hosts health, OAuth discovery/registration/token routes, browser consent, WHOOP linking/disconnect, and MCP transport. |
| MCP request handler | Creates a short-lived MCP server for each HTTP exchange, natively serves protocol <code>2026-07-28</code>, and uses the same factory for the stateless 2025-era fallback. |
| WHOOP client | Refreshes WHOOP tokens, paginates API v2 collections, enforces request timeouts, and normalizes upstream errors. |
| Compute/tool layer | Produces structured, read-only wellness/training summaries without writing to WHOOP. |
| SQLite | Persists the single linked account's encrypted WHOOP tokens, DCR client metadata, and hashed issued MCP tokens. |

Six core tools are always registered. <code>whoop_get_event_context</code> is
registered only when an <code>event</code> block is explicitly configured. Tool output is
structured JSON plus an equivalent text block. Missing scored values remain
<code>null</code>; they are never converted to zero.

## Persistence and lifecycle

The database is <code>DATA_DIR/whoop-mcp.db</code> with SQLite WAL mode and
<code>secure_delete</code> enabled. Persistent records include:

- one account row (<code>id = 1</code>) with AES-256-GCM-encrypted WHOOP
  credentials and their expiry/granted scopes;
- DCR client metadata; and
- SHA-256 hashes and expirations for MCP access/refresh tokens.

WHOOP API responses and computed tool results are processed in memory and are
not persisted by the application. Prompts and model responses never pass back
through this server. SQLite WAL files, volume snapshots, and infrastructure
backups still require the same protection as the main authentication database.

<code>POST /auth/disconnect</code>, authenticated with a valid MCP bearer plus
the owner access password, immediately deletes the local account, DCR clients,
and issued MCP-token hashes and stops active MCP work/response streams,
then attempts WHOOP revocation. Copies already sent to a model provider
or retained in a host backup are outside that operation.

## One owner, several clients

The single account row is an intentional product boundary. One owner may connect
Grok, Claude, Codex, OpenClaw, and other trusted clients to the same instance;
all of them can see that owner's tool data. The application has no tenant ID,
user roles, per-client field permissions, or isolation between people. A second
person requires a completely separate deployment, secrets, database, WHOOP app,
and hostname.

The process should run as one replica. MCP <code>2026-07-28</code> itself is
stateless, but this application's SQLite authorization store and in-memory
pending OAuth/consent state are not distributed. Active-active replicas would
need a shared transactional store and coordinated authorization state before
they could be correct.

## Network boundaries

The public MCP endpoint is authenticated Streamable HTTP at
<code>POST /mcp</code>. Native <code>2026-07-28</code> requests are stateless and
self-describing. Requests without the modern envelope use a stateless fallback
for protocol revisions through <code>2025-11-25</code>; that fallback accepts the
legacy initialization exchange but does not issue a session ID. GET and DELETE
session operations are not provided. Remote deployments require HTTPS at the
ingress.

On <code>/mcp</code>, the server validates:

- the request Host against <code>PUBLIC_URL</code> plus
  <code>ALLOWED_HOSTS</code>;
- a browser Origin against <code>PUBLIC_URL</code> plus explicit
  <code>CORS_ORIGINS</code>; and
- a CIMD- or DCR-supplied remote callback as exact-host HTTPS against
  <code>ALLOWED_REDIRECT_HOSTS</code> (loopback is allowed for local clients).

These lists are intentionally different. A CORS origin, an HTTP Host, and an
OAuth redirect hostname are not interchangeable security controls.

Protocol-era selection happens after bearer authentication and changes the MCP
wire lifecycle, not the authorization or WHOOP data boundary. See
[protocol-compatibility.md](protocol-compatibility.md) for the modern/legacy
matrix and current client-support caveat.

## Deliberate limitations

- Read-only means the server does not mutate WHOOP; it does not mean tool output
  is harmless or anonymous.
- Health is process liveness only, not readiness or data freshness.
- Calendar dates, freshness, day bucketing, and event phases use the explicitly
  configured owner IANA timezone (UTC when none is configured).
- Computed metrics are wellness context, not clinical validation, injury
  prediction, medical advice, or a guarantee of training outcome.
- No remote OAuth callback hostname is trusted by default. Cloud clients require
  an explicit, verified <code>ALLOWED_REDIRECT_HOSTS</code> entry.
- Rate limiting is in-memory and applies to password forms; it is not a complete
  edge abuse-control system.

See [configuration.md](configuration.md) for exact settings,
[SECURITY.md](../SECURITY.md) for the threat model, and
[PRIVACY.md](../PRIVACY.md) for provider-side processing and deletion limits.
