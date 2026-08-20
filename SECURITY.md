# Security policy and operating model

WHOOP Personal MCP is a personal, self-hosted service for one owner and one
linked WHOOP account. The same owner may authorize several trusted clients, but
the server has no isolation between people. Never use one instance for a team,
patients, employees, customers, research participants, or any other multi-user
case.

This document describes design controls and operator responsibilities. It is not
a security certification, penetration-test report, compliance attestation, or
guarantee. The project has not been independently certified.

## Report a vulnerability

Report a sensitive issue privately through
[GitHub Security Advisories](https://github.com/josealvaradoa/whoop-personal-mcp/security/advisories/new).
Do not include a real database, environment file, credentials, authorization
code, bearer token, or personal wellness data. Include affected versions,
reproduction steps using synthetic data, impact, and any suggested mitigation.

Use a public [GitHub issue](https://github.com/josealvaradoa/whoop-personal-mcp/issues)
only for non-sensitive bugs. There is no guaranteed response time, support SLA,
or dedicated security mailbox. If a live credential may be exposed, rotate or
revoke it immediately rather than waiting for a maintainer response.

## Trust boundaries

The normal path is WHOOP → the owner's deployment → the chosen MCP client/AI
provider. Repository maintainers receive no traffic or telemetry. That does not
make the system local-only: the hosting provider can access infrastructure
traffic, memory, logs, and volumes, while an authorized MCP client/model provider
receives requested tool results under its own policies.

The design trusts:

- the operator, host, image/source, and dependency supply chain;
- the secrecy of <code>WHOOP_CLIENT_SECRET</code>,
  <code>ENCRYPTION_SECRET</code>, <code>ACCESS_PASSWORD</code>, and any static
  bearer token;
- the HTTPS ingress and DNS for <code>PUBLIC_URL</code>;
- the exact OAuth callback hosts the operator allows; and
- every MCP client and AI provider the owner authorizes.

Compromise of the host process, operator account, secret store, reverse proxy,
authorized client, or model-provider account is outside what application-level
database encryption can contain.

## Authentication boundaries

### WHOOP account authorization

<code>ACCESS_PASSWORD</code> and an explicit wellness-only acknowledgment gate
the browser flow that links WHOOP. The server requests only
<code>read:recovery</code>, <code>read:cycles</code>,
<code>read:sleep</code>, <code>read:workout</code>, and
<code>offline</code>. It never receives the owner's WHOOP password.

The instance refuses to silently overwrite an already linked account. A valid
MCP bearer plus the owner <code>ACCESS_PASSWORD</code> is required to call
<code>POST /auth/disconnect</code> before a new account can be linked. An
ordinary client bearer alone is intentionally not an administrative wipe
credential.

### MCP client authorization

The authorization server prefers Client ID Metadata Documents (CIMD) and keeps
Dynamic Client Registration (DCR) as a backwards-compatible fallback. MCP
<code>2026-07-28</code> deprecates DCR, but does not remove it. Neither path
auto-approves a client. The owner sees the concrete client and redirect
destination, enters <code>ACCESS_PASSWORD</code>, and acknowledges the wellness
limit before an authorization code is issued.

Remote callback URIs must use HTTPS and exactly match a hostname in
<code>ALLOWED_REDIRECT_HOSTS</code>. Loopback HTTP/HTTPS is allowed for local
clients. Exact matching prevents lookalike suffixes such as
<code>trusted.example.attacker.example</code>. No remote callback host is allowed
by default; loopback is the only implicit exception. Add only an exact callback
that you verified with the client provider.

### CIMD outbound-fetch boundary

CIMD requires this authorization server to retrieve a client-hosted metadata
document, which creates an unavoidable server-side request-forgery (SSRF)
surface. The implementation accepts only HTTPS client IDs with a non-root path
and no credentials, query, fragment, or dot segments. It rejects local/internal
host suffixes, resolves DNS before connecting, rejects any private, reserved,
link-local, loopback, multicast, documentation, or IPv4-mapped destination,
pins the vetted address for the connection, keeps TLS certificate/hostname
verification, and does not follow redirects.

Fetches have a five-second timeout, JSON media-type requirement, 5 KiB body
limit, and bounded in-flight/cache counts. A document is cached only when its
HTTP response explicitly permits caching; the lifetime is capped at ten
minutes. The document's <code>client_id</code> must byte-match its URL, and its
name, public-client authentication method, grants, response type, application
type, and 1–20 redirect URIs are validated. Every redirect also passes the same
owner allowlist used by DCR.

These application checks are defense in depth, not a substitute for host-level
egress policy. A production operator should deny private/control-plane networks
at the network layer and allow only the outbound destinations the deployment
needs. DCR remains available for clients that cannot publish CIMD and therefore
does not use this outbound fetch path.

Authorization codes expire after five minutes and are bound to the validated
redirect URI and PKCE challenge. Issued MCP access tokens expire after one
hour. A client receives a refresh token only when its validated metadata
declares the <code>refresh_token</code> grant; those tokens expire after 30 days
and rotate on use. Raw issued tokens
are returned only to the client; SHA-256 hashes are stored in SQLite.

The protected-resource metadata, authorization-server metadata, and bearer
challenge advertise the minimal <code>mcp:read</code> scope. An OAuth
<code>resource</code> value, when supplied, must exactly identify this
deployment's canonical <code>/mcp</code> resource. Issued opaque tokens are
accepted only by the local deployment that minted them.

The authorization server advertises RFC 9207 support and includes an exact
<code>iss</code> issuer value on successful and terminal-error redirects to the
already validated client URI. A conforming client validates that value against
the issuer it discovered before redeeming a code. This limits
authorization-server mix-up attacks; it does not make a malicious client or
redirect destination safe.

The optional <code>MCP_BEARER_TOKEN</code> is intentionally long-lived and has
the same read access without browser consent or per-client revocation. Leave it
unset for OAuth-capable clients. If enabled, generate a high-entropy value, give
it to the minimum number of clients, and rotate it after any possible exposure.

## Request and browser controls

The <code>/mcp</code> transport requires a valid bearer token. It also rejects:

- an unexpected HTTP Host, using <code>PUBLIC_URL</code> plus
  <code>ALLOWED_HOSTS</code>; and
- an unexpected browser Origin, using <code>PUBLIC_URL</code> plus the explicit
  <code>CORS_ORIGINS</code> allowlist.

These checks reduce DNS-rebinding and cross-origin browser risk but do not
replace a correctly configured edge proxy. The proxy must preserve Host,
Authorization, <code>MCP-Protocol-Version</code>, <code>Mcp-Method</code>, and
<code>Mcp-Name</code> when present, and terminate trusted HTTPS.

Native MCP <code>2026-07-28</code> requests are stateless. The SDK checks the
per-request protocol/capability envelope against the HTTP protocol and routing
headers. The 2025-era compatibility path is also stateless: it accepts the
legacy initialization lifecycle but does not issue or trust an
<code>Mcp-Session-Id</code>. GET streams and DELETE session teardown are not
exposed.

Password submissions use timing-safe comparisons and a best-effort in-memory,
per-IP throttle: five failed attempts in 15 minutes cause a temporary lockout.
It resets on process restart and depends on correct proxy/IP handling, so apply
edge rate limits as appropriate. Pending consent/WHOOP states are bounded,
single-use where applicable, and expire. Dynamic client records are capped, and
in-flight MCP work is bounded by the HTTP/runtime limits, but these controls are
not comprehensive DDoS protection.

## Data at rest

The persistent SQLite volume contains one account's state:

- WHOOP access/refresh tokens encrypted with AES-256-GCM;
- a per-encryption random salt/IV and authentication tag, with a key derived
  from <code>ENCRYPTION_SECRET</code> using PBKDF2-SHA-256;
- DCR client metadata; and
- hashes/expiration times for issued MCP access and refresh tokens.

The application does not persist WHOOP API responses, MCP tool results, prompts,
or AI/model responses. WHOOP records exist in process memory only while a tool
request is fetched, calculated, and returned. A host, proxy, client, or model
provider can still create its own logs or retained copies.

SQLite uses WAL mode and secure deletion, but filesystems, WAL pages, storage
snapshots, host backups, and deleted blocks can outlive a logical row. Encrypt
and access-control the volume and backups. Store
<code>ENCRYPTION_SECRET</code> separately; losing it makes the encrypted state
unreadable, while losing it together with the database exposes that state to
offline attack.

Application logs avoid raw tokens, upstream response bodies, and tool payloads.
This cannot control logs added by a reverse proxy, platform, client, or future
operator instrumentation. Treat all logs and crash artifacts as potentially
sensitive and review changes before deploying.

## Disconnect and incident response

An owner-confirmed <code>POST /auth/disconnect</code> invalidates local WHOOP
token state, DCR clients, and issued MCP token hashes immediately and
stops active MCP work/response streams, then awaits best-effort remote WHOOP
revocation. Local
deletion therefore does not wait on WHOOP and proceeds even if revocation fails.
The response tells the
caller whether remote revocation succeeded.
If stored WHOOP credentials cannot be decrypted, the response reports remote
revocation as <code>unavailable</code> rather than claiming it was unnecessary;
the owner must then revoke the integration directly in WHOOP.

Disconnect does not delete:

- backups or snapshots managed by the operator/host;
- conversation history or copies held by an MCP client/AI provider; or
- an environment-provided static bearer token.

After suspected compromise: stop public access, disconnect/revoke WHOOP, rotate
the WHOOP app secret if necessary, rotate all deployment secrets, remove old
volumes/backups according to policy, invalidate provider sessions, and inspect
the host/source/dependencies before redeploying. Changing
<code>ENCRYPTION_SECRET</code> does not re-encrypt existing rows; disconnect or
relink using a clean database when rotating it.

## Production checklist

- Use the owner's own WHOOP Developer app/credentials and review the current
  [WHOOP API Terms of Use](https://developer.whoop.com/api-terms-of-use/).
- Obtain explicit owner consent before any tool output is disclosed to an MCP
  client or AI provider.
- Use a reviewed tag/commit and locked dependencies.
- Run one replica with a private persistent volume; never share its SQLite
  directory between active instances.
- Use a stable HTTPS origin and register the exact WHOOP callback.
- Generate independent, high-entropy secrets and store them in the platform's
  secret manager.
- Leave static bearer auth disabled unless required.
- Keep redirect, Host, CORS, firewall, and proxy allowlists narrow; never use a
  wildcard to suppress an OAuth error.
- Run the image as its non-root user where the platform supports volume
  ownership, with a read-only root filesystem and minimal capabilities.
- Restrict platform/project access, logs, backups, shells, and volume exports.
- Keep Node, the base image, dependencies, client, and ingress patched.
- Monitor authentication failures and resource use without recording wellness
  payloads or credentials.
- Do not add WHOOP-response/tool-result persistence; disable payload capture in
  the host, proxy, and observability stack.
- Test backup restoration and the disconnect procedure with synthetic data.
- On termination, disconnect/revoke WHOOP and delete the local volume, backups,
  client/provider records, and credentials as applicable.
- Re-read [PRIVACY.md](PRIVACY.md) and [DISCLAIMER.md](DISCLAIMER.md), including
  provider retention and non-HIPAA scope.

## Known limitations

- No multi-user isolation, role-based access control, per-tool client policy, or
  administrator audit trail.
- No built-in TLS termination, firewall, distributed rate limiter, secret
  rotation service, or automated backup system.
- In-memory pending OAuth/consent state and the local SQLite authorization store
  require one active replica. The MCP 2026 transport itself is stateless, but
  that does not make this application horizontally scalable.
- The embedded OAuth authorization server uses the official frozen
  <code>@modelcontextprotocol/server-legacy</code> migration helpers. They are
  appropriate for this single-user bridge but receive no new features; replace
  them with a dedicated OAuth provider before expanding to managed or
  multi-user service.
- An authorized client can request all registered tools and send output onward.
- Read-only WHOOP access still exposes sensitive, health-adjacent information.
- Self-hosting and encryption do not make a deployment automatically secure,
  private, HIPAA compliant, or compliant with other laws.

See [docs/architecture.md](docs/architecture.md) for component/data flow and
[docs/deployment.md](docs/deployment.md) for host-specific operating guidance.
