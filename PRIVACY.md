# Privacy

WHOOP Personal MCP is software one owner operates for themself. The maintainers
do not run a hosted service for this repository and receive nothing from its
normal data flow.

## Data flow

~~~text
one owner's WHOOP account
        |
        | requested records over the WHOOP API
        v
owner's deployment (processes in memory; stores OAuth/MCP auth state)
        |
        | only the requested MCP tool result
        v
owner's chosen MCP client and AI/model provider
~~~

There is no maintainer analytics, telemetry, advertising SDK, central
collection, or automatic crash reporting. The application does not store WHOOP
API responses, MCP tool results, prompts, conversation history, or AI/model
responses. WHOOP records are processed in memory to produce the requested tool
result.

Native MCP <code>2026-07-28</code> list/resource responses carry protocol cache
fields. This server uses <code>ttlMs: 0</code> and
<code>cacheScope: "private"</code>; those client-facing hints do not persist a
WHOOP response or tool result in this application. A client/provider remains
responsible for its own retention behavior.

This does **not** mean the data stays only on the owner's device. A deployment
provider can process container memory, traffic, infrastructure logs, and the
persistent volume. An MCP client or AI provider can process or retain tool
inputs and outputs in conversation history, safety/abuse systems, memory, or
other product systems under its terms, plan, settings, and policy. Review every
host and client/provider before connecting it.

## What the local database stores

The SQLite database at <code>DATA_DIR/whoop-mcp.db</code> contains authentication
and connection state only:

- one linked WHOOP account's encrypted access and refresh tokens and granted
  scope string;
- DCR client metadata; and
- SHA-256 hashes and expiry times for issued MCP access and refresh tokens.

A Client ID Metadata Document, when used, is client-hosted public metadata
retrieved for authorization validation. It is not a WHOOP record or tool result
and is not added to the local client-registration table. The server can keep it
in a bounded in-memory cache only when the client's HTTP response explicitly
permits caching, for no more than ten minutes. A process restart clears that
cache.

The project does not request WHOOP profile or body-measurement scopes and does
not store a fetched name, email, height, weight, WHOOP response record, or
derived wellness result in SQLite. Owner/event values in
<code>whoop-mcp.config.json</code> are settings the operator supplies, not
records fetched from WHOOP.

Secrets such as <code>WHOOP_CLIENT_SECRET</code>,
<code>ENCRYPTION_SECRET</code>, <code>ACCESS_PASSWORD</code>, and an optional
static bearer token live in the environment or secret store the owner configures.
WHOOP credentials and response records necessarily exist briefly in process
memory while a request is authorized, fetched, calculated, and returned.

The application avoids logging credentials, upstream response bodies, and tool
payloads. A platform, reverse proxy, operator-added instrumentation, core dump,
or client can have different behavior. Protect logs and disable payload capture.

## One owner, possibly several clients

One instance supports exactly one person and one WHOOP account. That owner may
connect several trusted clients, but every authorized client can access the same
owner's tools. Never share an instance, database, hostname, WHOOP developer
credentials, or static bearer among different people/accounts.

The owner must use their own WHOOP Developer app and credentials. The project
does not supply shared production credentials. The owner must give explicit
consent before their WHOOP data is disclosed to an MCP client/AI provider and
must review the destination shown during authorization.

## WHOOP API operator checklist

Use of the API is governed by the current
[WHOOP API Terms of Use](https://developer.whoop.com/api-terms-of-use/), not by
this notice. Each operator should, at minimum:

- create and maintain their own accurate WHOOP Developer app and keep its
  credentials confidential;
- use only the scopes and one-owner purpose documented by this project;
- obtain explicit owner authorization/consent before access and explicit opt-in
  before disclosure to a third-party MCP client or AI provider;
- use HTTPS for every remote deployment and protect data in transit and at rest;
- avoid response persistence—the current server stores no WHOOP response or
  tool-result cache;
- provide an accurate privacy notice and support route for any use beyond the
  operator themself;
- handle required security-incident notices; and
- on termination, disconnect, revoke access, delete local state/backups as
  appropriate, and delete downstream provider copies using provider controls.

The WHOOP terms can change and contain additional restrictions, including on
third-party disclosure, credentials, permanent copies, branding, commercial
use, and covered-entity/PHI use. Operators are responsible for reviewing the
current text and obtaining any permissions or advice they need. This checklist
is not a complete interpretation of those terms.

## What a tool can disclose

The six core tools and optional event-context tool are read-only with respect to
WHOOP, but results can contain sensitive, health-adjacent and activity data:
Recovery, HRV, resting heart rate, sleep, Day Strain, calories, workouts,
heart-rate zones, and derived descriptive metrics. Read-only does not mean
anonymous or low-risk.

Use client/provider accounts and retention settings appropriate for the data.
Delete relevant conversations or provider-side records separately; deleting
the local database cannot delete copies already sent elsewhere.

## Owner controls and deletion

The owner controls deployment access, secrets, clients, and the SQLite volume.
They can:

- stop the service to stop new access;
- disconnect the connector in each MCP client;
- call <code>POST /auth/disconnect</code> with a valid MCP bearer token and the
  owner <code>ACCESS_PASSWORD</code>;
- revoke the integration in WHOOP and rotate the WHOOP app secret;
- rotate <code>ACCESS_PASSWORD</code> and any static bearer token;
- delete AI-provider conversations/records under that provider's controls; and
- delete local database files and every host backup/snapshot they manage.

The disconnect route immediately deletes the local encrypted
WHOOP tokens, DCR clients, and issued MCP token hashes, and stops active MCP
work/response streams, then awaits best-effort WHOOP revocation. Check the
response and revoke in WHOOP manually when needed. It cannot remove host backups,
AI-provider copies, or an environment-provided static bearer token.
If the encrypted row is unreadable because <code>ENCRYPTION_SECRET</code> was
lost/changed or storage was corrupted, the response reports WHOOP revocation as
<code>unavailable</code>; local deletion still completes, but the owner must
revoke the integration from WHOOP directly.

For Docker Compose, <code>docker compose down -v</code> removes the service's
named data volume. This is destructive and not recoverable without a backup. For
a source installation, stop the server and remove
<code>DATA_DIR/whoop-mcp.db</code> plus <code>-wal</code>/<code>-shm</code>
companions and every managed backup. Keep <code>ENCRYPTION_SECRET</code> until
the encrypted database/backups are intentionally deleted or no longer needed.

## Security and legal scope

Self-hosting changes who operates the service; it does not automatically make a
system private, secure, HIPAA compliant, or compliant with another law. See
[SECURITY.md](SECURITY.md) for operating controls and
[DISCLAIMER.md](DISCLAIMER.md) for the medical, HIPAA, FTC/state-law, API-terms,
and no-warranty limits.

This notice describes intended repository behavior and is not legal advice. It
cannot identify every law, contract term, or risk and cannot eliminate
liability. Operators are responsible for their own notices, consent, contracts,
security, incident response, retention, deletion, and legal review.
