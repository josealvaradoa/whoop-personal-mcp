<!-- mcp-name: io.github.josealvaradoa/whoop-personal-mcp -->

# WHOOP Personal MCP

A single-user, self-hosted MCP server that gives an AI client read-only access
to one owner's WHOOP wellness and training data. It natively serves the
stateless MCP <code>2026-07-28</code> Streamable HTTP protocol, retains a
stateless fallback for 2025-era clients, supports MCP OAuth, and works with
Grok Build and xAI clients, Claude, Codex, OpenClaw, and compatible clients.

> **Distribution status:** install from a reviewed source checkout today. The
> <code>whoop-personal-mcp</code> npm package, an official container image, and
> <code>io.github.josealvaradoa/whoop-personal-mcp</code> in the MCP Registry are **not
> yet published or registered**. The metadata in this repository prepares those
> releases; it does not claim they exist.

## Is this the right WHOOP MCP for you?

This project is a strong fit if you want to own the deployment and secrets,
connect one personal WHOOP account, and expose focused, structured summaries to
a remote-HTTP MCP client. It keeps missing values explicit, includes data
freshness/coverage, and has no maintainer telemetry.

Choose something else if you need:

- a hosted, zero-operations connector;
- multiple people, a team, patients, customers, roles, or tenant isolation;
- writes back to WHOOP;
- MCP over local stdio instead of an HTTP service;
- every raw WHOOP field rather than six focused tools plus an optional event
  context tool;
- active-active replicas or enterprise high availability; or
- medical advice, diagnosis, injury prediction, or clinical compliance.

There is no universal “best” WHOOP MCP. The meaningful differences are trust
model, deployment burden, protocol/client support, data semantics, maintenance,
and whether a project is honest about missing data and health-related limits.
Review [the architecture](docs/architecture.md), [security model](SECURITY.md),
and [privacy flow](PRIVACY.md) before deciding.

## MCP version support

One authenticated <code>POST /mcp</code> endpoint serves both protocol eras:

- native <code>2026-07-28</code>: <code>server/discover</code>, a per-request
  <code>_meta</code> envelope and routing headers, no initialization handshake,
  and no protocol session; and
- legacy <code>2024-10-07</code> through <code>2025-11-25</code>: the older
  initialization handshake with a stateless POST-only fallback and no
  <code>Mcp-Session-Id</code>.

Client vendors adopt MCP revisions on their own schedules. This project does
not infer support from a product name: a current client may select the 2026 era,
while an older client can use the fallback. Legacy GET streams, DELETE session
teardown, and the deprecated HTTP+SSE transport are not exposed. Read
[the protocol compatibility reference](docs/protocol-compatibility.md) for the
wire behavior and current client-support caveat.

## What it provides

| Tool | What it returns |
|---|---|
| <code>whoop_get_today_overview</code> | Latest recovery, HRV, resting heart rate, sleep, Day Strain, dates, availability, and limited personal-baseline context. |
| <code>whoop_get_recovery_trend</code> | Recent WHOOP Recovery averages, product-band streaks, trend, coverage, and freshness. |
| <code>whoop_get_hrv_trend</code> | Personal HRV averages, coefficient of variation, trend, coverage, and freshness. |
| <code>whoop_get_sleep_trend</code> | Scored nightly sleep, WHOOP Sleep Need/debt, configured-duration balance, neutral duration direction, efficiency, consistency, and freshness. |
| <code>whoop_get_training_load</code> | Descriptive 7/28-day Day Strain means and a clearly labeled experimental ratio of those means, available only with complete windows. WHOOP Strain is nonlinear; do not use the ratio for injury risk, training decisions, periodization, or clearance. |
| <code>whoop_get_workouts</code> | Scored workout history, duration, heart rate/zones, recent volume, sport distribution, and intensity distribution. |
| <code>whoop_get_event_context</code> | **Optional:** event-phase wellness context that abstains when inputs are missing/stale; not a readiness score or clearance. |

The first six tools are always available. The optional tool is registered only
when the active configuration contains a valid <code>event</code> block. All tools are
read-only with respect to WHOOP. A <code>null</code> means no scored value was
available; it never means zero.

## Quick start: Docker Compose + Grok Build

You need a WHOOP membership, a personal app in the
[WHOOP Developer Dashboard](https://developer.whoop.com/), Git, Node.js 22+ for
the initializer, and Docker Compose.

Register this exact local redirect URI:

~~~text
http://localhost:3000/auth/whoop/callback
~~~

Enable only the scopes the runtime requests:

~~~text
read:recovery read:cycles read:sleep read:workout offline
~~~

Then:

~~~bash
git clone https://github.com/josealvaradoa/whoop-personal-mcp.git
cd whoop-personal-mcp
node bin/whoop-personal-mcp.js init
~~~

On POSIX systems, the non-overwriting initializer requests private mode-0600
files, generates the
two local security values,
detects an IANA timezone, and leaves WHOOP credentials blank. It never
overwrites an existing <code>.env</code> or active config.
On Windows, verify file ACLs yourself and prefer the platform's secret store.

Edit <code>.env</code> with the WHOOP client values. If you are using Docker on a
machine without Node, create the files manually instead:

~~~bash
cp .env.example .env
cp whoop-mcp.config.example.json whoop-mcp.config.json
openssl rand -base64 48
openssl rand -base64 24
~~~

Put those outputs in <code>ENCRYPTION_SECRET</code> and
<code>ACCESS_PASSWORD</code>. Review <code>whoop-mcp.config.json</code>. Replace
the null sleep target only if
you intentionally choose a personal duration target; it is never assumed.
The initializer creates no event. To enable optional event context, add and
edit the block from
[templates/event-config.example.json](templates/event-config.example.json).
The safe-to-copy main example also contains no event. Start the server:

~~~bash
docker compose up --build -d
curl --fail http://localhost:3000/health
~~~

Open <http://localhost:3000/auth/whoop>, enter
<code>ACCESS_PASSWORD</code>, acknowledge the wellness-only notice, and approve
WHOOP access. The deployment never receives your WHOOP password.

Every owner must use their own WHOOP Developer app/credentials and comply with
the current [WHOOP API Terms of Use](https://developer.whoop.com/api-terms-of-use/).
Remote use requires HTTPS. Explicitly consent before sending a tool result to an
AI provider; on termination, disconnect/revoke and remove local, backup, and
provider-side copies as applicable. The server stores no WHOOP API responses.

Connect [Grok Build](https://docs.x.ai/build/features/mcp-servers):

~~~bash
grok mcp add --transport http whoop-personal http://localhost:3000/mcp
grok mcp doctor whoop-personal
~~~

Grok opens the server's MCP OAuth flow. Confirm the destination and enter
<code>ACCESS_PASSWORD</code>. Then ask:

> List the WHOOP tools available, then summarize today's data. State when any
> value is missing or stale, and do not give medical advice.

For a slower, fully explained walkthrough, use
[the getting-started tutorial](docs/getting-started.md).

## Connect another client

- [Grok Build, Grok web, or the xAI Responses API](docs/clients.md#grok)
- [Claude custom connectors](docs/clients.md#claude)
- [Codex](docs/clients.md#codex)
- [OpenClaw](docs/clients.md#openclaw)
- [Any Streamable HTTP client](docs/clients.md#any-streamable-http-client)
- [Provider-specific examples](examples/README.md)

Provider-hosted clients cannot reach localhost. Deploy the server at a stable
public HTTPS origin first, set <code>PUBLIC_URL</code>, register the exact WHOOP
callback, and follow [the deployment guide](docs/deployment.md). Railway is
documented as one optional target; any suitable OCI host works.

## Data, privacy, and safety

The data path is:

~~~text
WHOOP -> your deployment -> your chosen MCP client / AI provider
~~~

The maintainers receive nothing from that path. There is no maintainer
telemetry, analytics, advertising SDK, or automatic crash reporting. WHOOP
API responses and tool results are processed in memory and are not persisted.
The server never receives or stores the AI model's response.

Your hosting provider and AI provider can still process or retain data under
their policies. One owner may connect several clients, but every client sees the
same owner's data. Never use one instance for multiple people. Read
[PRIVACY.md](PRIVACY.md) for storage, provider processing, disconnect, and
deletion limits.

This is a wellness tool, not medical advice, a medical device, injury
prediction, treatment, or clearance. It is not represented as HIPAA compliant
and is not offered to covered entities or business associates. See
[DISCLAIMER.md](DISCLAIMER.md).

## Security summary

- WHOOP tokens are encrypted at rest with AES-256-GCM.
- Issued MCP access/refresh tokens are stored as SHA-256 hashes.
- MCP OAuth uses PKCE, exact redirect checks, short-lived access tokens,
  rotating refresh tokens when the client declares that grant, an RFC 9207
  issuer, and the minimal
  <code>mcp:read</code> scope. It prefers CIMD while retaining DCR for older
  clients.
- <code>ACCESS_PASSWORD</code> gates both client consent and WHOOP linking.
- <code>/mcp</code> validates bearer auth, Host, and browser Origin.
- <code>POST /auth/disconnect</code> requires a valid MCP bearer plus the owner
  <code>ACCESS_PASSWORD</code>, attempts WHOOP revocation, wipes local
  owner/client/token data, and stops active MCP work/response streams.

The design still depends on correct HTTPS ingress, secret management, provider
selection, backups, and a single trusted owner. It has not been independently
certified. Read [SECURITY.md](SECURITY.md) before internet exposure.
Direct CLI/package runs bind to <code>127.0.0.1</code> by default. Container and
remote deployments must deliberately set <code>BIND_HOST=0.0.0.0</code> behind
their restricted ingress.

## Configuration and operations

- [Configuration, tools, routes, and token lifetimes](docs/configuration.md)
- [MCP 2026-07-28 and legacy-era compatibility](docs/protocol-compatibility.md)
- [CLI init, local/remote doctor, and server start](docs/cli.md)
- [Docker Compose, any OCI host, and optional Railway deployment](docs/deployment.md)
- [Client setup](docs/clients.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Architecture and trust boundaries](docs/architecture.md)
- [Full documentation index](docs/index.md)

The npm executable described by the package metadata starts this HTTP server;
it is not an stdio MCP command. Until the package is published, use the source
checkout.

Repository changes go through a protected pull-request workflow. See the
[contribution guide](CONTRIBUTING.md), [governance policy](GOVERNANCE.md),
[maintainer list](MAINTAINERS.md), and [Code of Conduct](CODE_OF_CONDUCT.md).

## Develop and verify

Use Node.js 22 or 24 and pnpm 10:

~~~bash
corepack enable
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run smoke:package
~~~

Start from source with <code>pnpm run dev</code> or build and run with
<code>pnpm run build && pnpm start</code>. Tests use fixtures and do not need
live WHOOP credentials. See [CONTRIBUTING.md](CONTRIBUTING.md) and the
[release checklist](docs/releasing.md).

## License and independence

[MIT](LICENSE). Provided without warranty under the license terms. This
independent project is not affiliated with, endorsed by, or sponsored by WHOOP,
xAI, Anthropic, OpenAI, OpenClaw, Railway, or any other client/hosting provider.
Their names and trademarks belong to their respective owners.
