# Troubleshooting

Start with the first failing boundary: process startup, local health, WHOOP
linking, client OAuth, MCP transport, or a live tool call. Redact all secrets and
wellness values before sharing logs.

## The server exits during startup

Read the first validation error. Common causes are:

- a missing WHOOP client ID, client secret, callback, encryption secret, or
  access password;
- <code>ENCRYPTION_SECRET</code> shorter than 32 characters or
  <code>ACCESS_PASSWORD</code> shorter than 12;
- a production <code>PUBLIC_URL</code> that is not an HTTPS origin;
- a <code>WHOOP_REDIRECT_URI</code> whose origin differs from
  <code>PUBLIC_URL</code> or whose path is not
  <code>/auth/whoop/callback</code>;
- overlapping event phases, an invalid date, or a phase after the event date;
- both <code>CONFIG_PATH</code> and
  <code>WHOOP_MCP_CONFIG_JSON</code>/<code>CONFIG_JSON</code> being set; or
- a non-writable <code>DATA_DIR</code>.

Production does not fall back to the example configuration. Mount an active
file, set <code>CONFIG_PATH</code>, provide <code>WHOOP_MCP_CONFIG_JSON</code>, or
use the documented environment overrides. The owner/event configuration may be
empty, but the required secret/network environment variables may not.

For Compose:

~~~bash
docker compose config
docker compose logs --tail 100 whoop-personal-mcp
~~~

If the config mount became a directory, create
<code>whoop-mcp.config.json</code> as a file before starting Compose.

## Health works but a cloud client cannot connect

<code>/health</code> proves only that the process responds. Confirm:

- the client URL ends in <code>/mcp</code>, not
  <code>/auth/whoop/callback</code>;
- the URL is public HTTPS—provider-hosted clients cannot reach localhost or a
  private LAN address;
- <code>PUBLIC_URL</code> exactly matches the external origin;
- TLS and DNS are valid from outside your network;
- the proxy forwards the original Host and does not strip Authorization or
  <code>MCP-Protocol-Version</code>, <code>Mcp-Method</code>, or
  <code>Mcp-Name</code>; and
- the deployment has one live replica.

An HTTP 421 with <code>HOST_NOT_ALLOWED</code> means the request Host does not
match <code>PUBLIC_URL</code> or <code>ALLOWED_HOSTS</code>. Add only a host you
actually route to this deployment. An HTTP 403 with
<code>ORIGIN_NOT_ALLOWED</code> means a browser sent an untrusted Origin; add the
exact bare origin to <code>CORS_ORIGINS</code> only after verifying it.

## Client identification rejects the redirect URI

Both Client ID Metadata Documents (CIMD) and Dynamic Client Registration (DCR)
accept only exact approved redirect URIs. Remote callbacks must use HTTPS, no
remote host is trusted by default, and loopback callbacks work locally. List
every remote callback you intend to trust in
<code>ALLOWED_REDIRECT_HOSTS</code>.

Obtain the client's exact current callback hostname from its documentation,
registration error, or provider support. Put only hostnames in the variable—no
scheme, path, wildcard, or comma inside an entry. Preserve every other trusted
hostname you still need, restart, and try again. Never add an attacker-provided
domain just to make a consent link work.

For CIMD, the <code>client_id</code> must be the exact HTTPS URL of the metadata
document, the document's own <code>client_id</code> must match that URL, and the
requested redirect must appear in its <code>redirect_uris</code>. For DCR, a
current client should send <code>application_type</code> appropriate to its
redirects. DCR is deprecated by MCP <code>2026-07-28</code> but intentionally
retained here for clients that have not adopted CIMD.

The CIMD URL cannot contain credentials, a query, fragment, dot segment, or a
root-only path. It must resolve entirely to public addresses, return a JSON
media type within five seconds and 5 KiB, and must not redirect. Local/private
addresses and common internal hostname suffixes are blocked. If a legitimate
document is rejected, fix its hosting or metadata; do not weaken the deployment
firewall or route an internal endpoint through a public-looking DNS name.

## WHOOP says the callback does not match

WHOOP requires an exact registered redirect. Compare all of:

~~~text
WHOOP Developer Dashboard
WHOOP_REDIRECT_URI
PUBLIC_URL + /auth/whoop/callback
the scheme, hostname, port, path, and trailing slash
~~~

Local and production callbacks are different. Add the intended callback in the
WHOOP dashboard, then restart the server after changing the environment.

## Linking says an account already exists

The instance deliberately refuses to overwrite a linked account. It supports
one person only. Disconnect first with an authenticated request, then link the
new account only if it belongs to the same owner and you intend to replace it:

~~~bash
curl --fail --request POST https://YOUR-HOST.example/auth/disconnect \
  -H "Authorization: Bearer $MCP_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  --data "{\"access_password\":\"$ACCESS_PASSWORD\"}"
~~~

The bearer may be a valid issued MCP access token or the configured static
token, but the separate owner password is always required. This operation
immediately and irreversibly deletes local
account, DCR-client, and MCP-token state. An issued access token
used for the request is invalid before remote revocation finishes. It does not delete host backups
or provider-side conversation data.
Inspect <code>whoop_revocation</code> in the response. A value of
<code>failed</code> or <code>unavailable</code> also sets
<code>manual_whoop_revocation_required</code>; revoke the integration directly
in WHOOP. <code>unavailable</code> can occur when the encrypted row exists but
the encryption secret changed or the row is corrupt; local deletion still
completes.

## OAuth succeeds, then the client gets 401

Issued MCP access tokens expire after one hour. A client whose validated
metadata declares the <code>refresh_token</code> grant can use its rotating
refresh token, which expires after 30 days. A client that did not request that
grant must start a new authorization flow. Re-run login if a refresh token was
lost or expired.

For static auth, confirm the server was restarted after setting
<code>MCP_BEARER_TOKEN</code> and that the client sends exactly
<code>Authorization: Bearer &lt;token&gt;</code>. The public health route does not
test bearer authentication. <code>/auth/status</code> accepts only the configured
static bearer and intentionally returns 401 when static auth is disabled.

## The client reports an OAuth issuer mismatch

MCP <code>2026-07-28</code> hardens authorization-server mix-up protection. The
server advertises one issuer derived from <code>PUBLIC_URL</code> and returns the
same RFC 9207 <code>iss</code> value with the authorization code. Keep
<code>PUBLIC_URL</code> stable and make the client start a new authorization
flow after any hostname, scheme, or port change. Do not edit or drop the
<code>iss</code> callback parameter at a proxy. Clear the client's saved
registration/token only after confirming it belongs to the old issuer, then
authenticate again.

## Discovery or initialize works but later MCP calls fail

Do not add a session header. Native <code>2026-07-28</code> has no initialization
handshake or protocol session. The legacy fallback accepts initialize but does
not return an <code>Mcp-Session-Id</code>; later calls are independent POSTs.

For native requests, confirm that the client sends matching
<code>MCP-Protocol-Version</code> and
<code>io.modelcontextprotocol/protocolVersion</code> values, the required client
capabilities in the request <code>_meta</code>, and correct
<code>Mcp-Method</code>/<code>Mcp-Name</code> routing headers. The SDK rejects a
version/header mismatch rather than guessing. For a client that cannot produce
that request shape, enable its legacy/automatic negotiation mode or upgrade it.
See [protocol-compatibility.md](protocol-compatibility.md).

Use the included static-token transport smoke test against a running server:

~~~bash
export BASE_URL=http://localhost:3000
export MCP_BEARER_TOKEN=replace-with-the-server-token
npm run smoke:http
~~~

The smoke checks native discovery/tool listing, legacy stateless fallback, and
authentication rejection. Set <code>SMOKE_CALL_WHOOP=1</code> only after the
account is linked if you also want the script to make a live WHOOP request.

## Only six tools are listed

That is expected when no target event is configured. The six core WHOOP tools
are always present. <code>whoop_get_event_context</code> is registered only when
a valid <code>event</code> block exists in the active configuration. Restart after
adding it.

## An older configuration is rejected after an upgrade

The provider-neutral configuration removed fields that did not affect current
tool output and renamed race-specific public keys. Migrate an older file as
follows:

- rename top-level <code>race</code> to <code>event</code>;
- rename <code>RACE_NAME</code>, <code>RACE_DATE</code>, and
  <code>RACE_PHASES_JSON</code> to their <code>EVENT_*</code> equivalents;
- remove event <code>type</code>, athlete name/max-HR/resting-HR fields,
  configurable Recovery-band/HRV thresholds, all ACWR band values, and every
  cache field; and
- update saved prompts/tool policy from the legacy
  <code>whoop_get_race_readiness</code> name to
  <code>whoop_get_event_context</code>.

Start from the current
[example configuration](../whoop-mcp.config.example.json) rather than trying to
preserve unknown keys; schemas are strict so stale fields fail closed.

## A value is null, stale, or missing

<code>null</code> means WHOOP did not provide a scored value; it never means
zero. WHOOP may still be processing a sleep or recovery record, the strap may
not have synced, or the selected history window may have incomplete coverage.
Check each section's date and availability flags. Calculations deliberately
abstain when minimum coverage or freshness is not met.

Date windows use the configured owner IANA timezone. If results near midnight
look one day different from the WHOOP app, verify
<code>athlete.timezone</code>/<code>ATHLETE_TIMEZONE</code>, then restart.

## Calls are slow or WHOOP returns errors

The application deliberately does not persist WHOOP API responses. Repeated
tool calls can therefore repeat paginated WHOOP requests. Avoid unnecessary
polling and let calls complete rather than retrying them in parallel.

WHOOP rate limiting is surfaced as retryable context; respect the retry delay.
Timeouts default to 30 seconds and can be changed with
<code>WHOOP_REQUEST_TIMEOUT_MS</code> from 1000 to 120000 milliseconds. A
definitive authorization failure requires relinking.

## Railway reports a database permission error

Railway volumes are root-owned. For this image, set
<code>RAILWAY_RUN_UID=0</code> as documented in [deployment.md](deployment.md),
or use a platform that can set volume ownership for the image's Node user.
Confirm <code>DATA_DIR=/app/data</code> and that the volume is attached to the
same single service.

## Asking for help

Include the commit/version, runtime, deployment type, client, exact failing
step, and sanitized HTTP status/error code. Never post the environment file,
database, tokens, authorization codes, client secret, access password, bearer
token, or unredacted tool output. See [SUPPORT.md](../SUPPORT.md).
