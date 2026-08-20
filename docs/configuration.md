# Configuration and protocol reference

WHOOP Personal MCP separates secrets/network policy (environment variables)
from optional personal wellness/event settings (JSON or targeted environment
overrides). Configuration is validated before the HTTP listener starts.

## Environment variables

### Required credentials

| Variable | Requirement | Purpose |
|---|---|---|
| <code>WHOOP_CLIENT_ID</code> | non-empty | Client ID from the owner's personal WHOOP Developer app. |
| <code>WHOOP_CLIENT_SECRET</code> | non-empty | Secret for that app; keep it in a secret store. |
| <code>WHOOP_REDIRECT_URI</code> | exact URL | WHOOP callback ending in <code>/auth/whoop/callback</code>. In production its origin must equal <code>PUBLIC_URL</code>. |
| <code>ENCRYPTION_SECRET</code> | at least 32 characters | Derives the key used to encrypt WHOOP OAuth tokens at rest. |
| <code>ACCESS_PASSWORD</code> | at least 12 characters | Confirms browser consent and standalone WHOOP linking. Do not reuse an account password. |

For file-mounted/container secrets, set exactly one of each direct value or its
<code>_FILE</code> equivalent:

~~~text
WHOOP_CLIENT_SECRET_FILE
ENCRYPTION_SECRET_FILE
ACCESS_PASSWORD_FILE
MCP_BEARER_TOKEN_FILE
~~~

The file must be readable and contain a non-empty value. Do not set both forms
of the same secret. <code>WHOOP_CLIENT_ID</code> and URL/settings variables do
not have file variants.

Generate independent values:

~~~bash
openssl rand -base64 48
openssl rand -base64 24
~~~

Use the first for <code>ENCRYPTION_SECRET</code> and the second for
<code>ACCESS_PASSWORD</code>. Changing <code>ENCRYPTION_SECRET</code> does not
re-encrypt existing tokens; the old database becomes unreadable without the old
secret. Disconnect/relink or intentionally start a clean database when rotating
it.

### Server and access policy

| Variable | Default | Purpose |
|---|---|---|
| <code>PORT</code> | <code>3000</code> | Listening port, 1–65535. |
| <code>BIND_HOST</code> | <code>127.0.0.1</code> | Listening interface. Set <code>0.0.0.0</code> only inside a protected container or remote host with reviewed ingress. |
| <code>NODE_ENV</code> | <code>development</code> | Runtime mode. Remote/container deployments should use <code>production</code>. |
| <code>PUBLIC_URL</code> | <code>http://localhost:&lt;PORT&gt;</code> | External origin and OAuth issuer, with no path/query/fragment. Any non-loopback URL requires HTTPS. |
| <code>DATA_DIR</code> | <code>./data</code> | Private persistent directory for <code>whoop-mcp.db</code>. Containers use <code>/app/data</code>. |
| <code>WHOOP_REQUEST_TIMEOUT_MS</code> | <code>30000</code> | WHOOP fetch/body timeout, integer 1000–120000. |
| <code>MCP_BEARER_TOKEN</code> | disabled | Optional long-lived static bearer (at least 32 characters) for clients that cannot use MCP OAuth. Generate with <code>openssl rand -hex 32</code>. |
| <code>ALLOWED_REDIRECT_HOSTS</code> | no remote hosts | Comma-separated exact HTTPS callback hostnames accepted during MCP client authorization, whether the client uses CIMD or DCR. Loopback is always allowed. |
| <code>CORS_ORIGINS</code> | <code>PUBLIC_URL</code> | Comma-separated additional bare browser origins; every origin other than <code>PUBLIC_URL</code> must be listed explicitly. |
| <code>ALLOWED_HOSTS</code> | host from <code>PUBLIC_URL</code> | Comma-separated additional HTTP Host values accepted on <code>/mcp</code>. Include ports when applicable. |
| <code>TRUST_PROXY</code> | <code>false</code> | Express proxy trust: <code>false</code> or an exact hop count 1–10. Set only to match a known ingress topology. |

Remote OAuth callbacks are deny-by-default. For example, Anthropic currently
documents Claude callbacks on <code>claude.ai</code> and a future
<code>claude.com</code> equivalent:

~~~text
ALLOWED_REDIRECT_HOSTS=claude.ai,claude.com
~~~

Do not put schemes, paths, or wildcards in a hostname list. Redirect, Origin,
and Host allowlists protect different boundaries and are not interchangeable.

<code>TRUST_PROXY</code> affects the client IP used by password rate limiting
and Express URL/IP behavior. A direct deployment should leave it false. A known
single reverse proxy commonly uses <code>1</code>. An imprecise proxy-trust rule
can let an untrusted caller influence forwarded-address interpretation, so the
server intentionally rejects a blanket <code>true</code> value.

### MCP OAuth client identification

Authorization-server metadata advertises Client ID Metadata Documents (CIMD)
as the preferred client-identification mechanism and DCR as a compatibility
fallback. There is no switch between them; the client chooses a mechanism it
supports.

A CIMD client ID must be an HTTPS document URL with a non-root path and no
credentials, query, fragment, or dot segments. The response must be JSON, no
larger than 5 KiB, and complete within five seconds without redirects. The
document URL/client ID, public-client authentication, grant/response/application
types, and 1–20 redirect URIs are validated. DNS resolution and connection
pinning reject local, private, reserved, or otherwise non-public destinations.
See [SECURITY.md](../SECURITY.md#cimd-outbound-fetch-boundary) for the SSRF
boundary and egress-control requirement.

The protected resource is the exact <code>PUBLIC_URL</code> origin plus
<code>/mcp</code>. The authorization metadata and 401 challenge advertise only
<code>mcp:read</code>. A supplied OAuth <code>resource</code> value is bound
through authorization, code exchange, and refresh. Older clients that omit the
scope/resource retain the compatibility path, but no broader scope is issued.

## Personal/event configuration

Choose one primary source:

1. <code>WHOOP_MCP_CONFIG_JSON</code> containing a JSON object;
2. <code>CONFIG_PATH</code> pointing to a JSON file; or
3. <code>whoop-mcp.config.json</code> in the working directory.

<code>CONFIG_JSON</code> is accepted as a compatibility alias for
<code>WHOOP_MCP_CONFIG_JSON</code>. Do not set a JSON source and
<code>CONFIG_PATH</code> together. The example/template file is never runtime
input. If no explicit source or active file exists, the server uses UTC, no
sleep target, and no event context rather than inventing personal settings.

Environment overrides are applied after the selected JSON source:

| Variable | JSON field |
|---|---|
| <code>ATHLETE_TIMEZONE</code> | <code>athlete.timezone</code> |
| <code>SLEEP_TARGET_HOURS</code> | <code>athlete.sleep_target_hrs</code> |
| <code>EVENT_NAME</code> | <code>event.name</code> |
| <code>EVENT_DATE</code> | <code>event.date</code> |
| <code>EVENT_PHASES_JSON</code> | <code>event.phases</code> as a JSON array |
| <code>CONSECUTIVE_RED_ALERT</code> | <code>thresholds.consecutive_red_alert</code> |

Start from [whoop-mcp.config.example.json](../whoop-mcp.config.example.json).
It is intentionally safe to copy: UTC, no assumed sleep target, and no event.
To opt into event context, merge and fully edit
[templates/event-config.example.json](../templates/event-config.example.json).

### <code>athlete</code>

<code>timezone</code> is a valid IANA zone such as
<code>America/New_York</code>. It defaults to UTC when no owner setting exists.
It controls calendar dates, day bucketing, freshness, and event-phase
comparisons; set it to the owner's normal timezone. The <code>init</code> command
detects the local runtime's IANA zone when possible.

<code>sleep_target_hrs</code> is null/unset by default or an explicit numeric
duration target from 4 to 14 hours. When configured, tools can report signed sleep-duration
balance against it. It is not WHOOP Sleep Need and is not medical guidance. If
the owner does not set it, target-derived fields are <code>null</code> rather
than assuming a personal target.

### <code>event</code>

The entire event block is optional. When absent, the six core tools remain and
<code>whoop_get_event_context</code> is not registered.

| Key | Constraint | Effect |
|---|---|---|
| <code>name</code> | non-empty string | Identifies the target event in tool output. |
| <code>date</code> | real <code>YYYY-MM-DD</code> date | Used for days-to-event context. |
| <code>phases</code> | up to 30 objects | Each has a non-empty <code>name</code> and inclusive <code>start</code>/<code>end</code> dates. Phases may not overlap or end after the event. |

Outside a configured phase, the tool reports
<code>outside_configured_phases</code>. Calendar boundaries use the configured
owner timezone.

### <code>thresholds</code>

<code>consecutive_red_alert</code> is an integer from 1 to 30. It controls when
the optional event-context tool surfaces a repeated WHOOP red-Recovery product
band observation/alert. It is not an exercise-safety, injury, medical,
or clearance rule.

There are no configurable bands for the experimental Day Strain ratio. The
ratio is simply the complete seven-day mean divided by the complete 28-day mean;
WHOOP Strain is nonlinear, so the result is not a validated acute-to-chronic
workload ratio and must not be used for injury risk, training decisions,
periodization, or clearance.

## Persistence behavior

The application stores only encrypted WHOOP OAuth tokens, DCR client metadata,
and hashes/expirations for issued MCP tokens. It does not persist
WHOOP API responses, MCP tool results, prompts, or model responses. Response
records are processed in memory and sent to the authorized client.

## MCP protocol eras

The same <code>POST /mcp</code> endpoint natively serves the stateless MCP
<code>2026-07-28</code> revision and a stateless fallback for protocol revisions
through <code>2025-11-25</code>. There is no mode variable to set:

- a request with the modern per-request protocol envelope uses
  <code>2026-07-28</code>, including <code>server/discover</code>, standard HTTP
  routing headers, result metadata, and private cache hints; and
- a request using the earlier initialization lifecycle uses the legacy
  fallback. It receives no <code>Mcp-Session-Id</code> and continues with
  independent POST requests.

The endpoint does not expose a standalone GET stream or DELETE session route.
See [protocol-compatibility.md](protocol-compatibility.md) for the full behavior
matrix and client-version caveat.

## MCP tools

Every tool is read-only with respect to WHOOP and returns structured JSON plus
equivalent JSON text. A missing scored value is <code>null</code>, never a
fabricated zero. Freshness and coverage fields let clients abstain explicitly.

| Tool | Inputs | Summary |
|---|---|---|
| <code>whoop_get_today_overview</code> | none | Latest Recovery/HRV/RHR, sleep, Day Strain, dates, availability, and limited personal-baseline context. |
| <code>whoop_get_recovery_trend</code> | <code>days</code> 7–365, default 30 | Recovery averages, WHOOP product-band streaks, trend, coverage, and freshness. |
| <code>whoop_get_hrv_trend</code> | <code>days</code> 7–365, default 30 | Personal HRV averages, coefficient of variation, trend, coverage, and freshness. |
| <code>whoop_get_sleep_trend</code> | <code>days</code> 3–365, default 14 | Nightly sleep, WHOOP Sleep Need/debt, configured-duration balance, neutral duration direction, efficiency/consistency, and freshness. |
| <code>whoop_get_training_load</code> | <code>days</code> 28–365, default 42 | Descriptive complete-window 7/28-day Day Strain means and experimental ratio; no ratio bands, Strain sums, monotony diagnosis, or prescription. |
| <code>whoop_get_workouts</code> | <code>days</code> 1–365, default 14; optional <code>sport</code> | Scored workout history, HR zones, recent count/volume, sport and intensity distributions. |
| <code>whoop_get_event_context</code> | none; optional registration | Event date/phase plus recent Recovery, HRV, and sleep observations with strict coverage/freshness and explicit abstention. Not a readiness score or clearance. |

## HTTP routes

| Route | Authentication | Purpose |
|---|---|---|
| <code>GET /health</code> | public | Process liveness only; does not prove WHOOP is linked or data is fresh. |
| <code>POST /mcp</code> | issued OAuth or static bearer | Stateless Streamable HTTP: native MCP <code>2026-07-28</code> plus stateless 2025-era fallback. |
| <code>GET/DELETE /mcp</code> | issued OAuth or static bearer | Not supported; neither protocol era uses transport sessions in this server. |
| <code>GET /.well-known/oauth-protected-resource/mcp</code> | public | RFC 9728 metadata for the exact <code>PUBLIC_URL/mcp</code> resource and <code>mcp:read</code> scope. |
| <code>GET /.well-known/oauth-authorization-server</code> | public | Authorization endpoints, issuer, CIMD/RFC 9207 support, DCR fallback, and scope metadata. |
| OAuth register/authorize/token/revoke routes | protocol-defined | DCR fallback, CIMD client lookup during authorization, PKCE code exchange, refresh, and revocation. |
| <code>GET /auth/whoop</code> | public form | Displays the password/acknowledgment form for standalone linking. |
| <code>POST /auth/whoop</code> | <code>ACCESS_PASSWORD</code> + acknowledgment | Starts WHOOP OAuth; refuses to overwrite an existing link. |
| <code>GET /auth/whoop/callback</code> | WHOOP code/state | Completes WHOOP authorization. |
| <code>GET /auth/status</code> | configured static bearer only | Reports linked status/expiry without exposing it publicly. Always 401 if static auth is disabled. |
| <code>POST /auth/disconnect</code> | valid issued/static MCP bearer + <code>access_password</code> JSON field | Immediately deletes local account/client/issued-token state and stops active MCP work/streams, then attempts WHOOP revocation. |

Issued MCP access tokens last one hour. Refresh tokens are issued only to
clients whose validated metadata declares that grant; they rotate and last 30
days. Authorization codes last five minutes. DCR client records and pending OAuth
states are bounded to protect the one-owner service. The authorization metadata
and bearer challenge advertise the minimal <code>mcp:read</code> scope.

See [clients.md](clients.md) for client configuration and
[architecture.md](architecture.md) for the two OAuth boundaries.
