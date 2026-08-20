# Changelog

Notable project changes will be recorded here. The repository currently carries
version <code>1.0.0</code> in package metadata, but this file does not assert
that an npm package, container image, GitHub release, or MCP Registry entry has
been published.

## Unreleased

### Added

- Provider-neutral setup paths for Grok, Claude, Codex, OpenClaw, and generic
  Streamable HTTP clients.
- Native MCP protocol <code>2026-07-28</code> serving on Streamable HTTP,
  including <code>server/discover</code>, request-scoped protocol metadata,
  standard routing headers, result metadata, and private cache hints.
- A stateless 2025-era fallback on the same endpoint for clients that still use
  the legacy initialization handshake.
- A protocol compatibility reference that separates verified server behavior
  from client-vendor rollout assumptions.
- Docker Compose self-hosting with a persistent SQLite volume and an optional
  Railway guide.
- npm executable, package-content checks, client configuration templates, and
  MCP Registry-format metadata.
- Privacy, wellness/legal, security, support, contributing, deployment, and
  release documentation.
- An owner-confirmed disconnect route that immediately clears local
  account/client/token state, stops active MCP work/streams, and then attempts
  WHOOP revocation.

### Changed

- Product name and npm metadata now describe a generic, single-user
  self-hosted server rather than a client- or event-specific coaching project.
- MCP runtime packages are upgraded from the monolithic TypeScript SDK v1 to
  the official v2 package family. The transport is now stateless: protocol
  sessions, <code>Mcp-Session-Id</code>, the standalone GET stream, and DELETE
  session teardown are removed.
- MCP authorization metadata and challenges advertise the minimal
  <code>mcp:read</code> scope. Authorization responses identify their issuer
  with RFC 9207 <code>iss</code>; DCR remains a compatibility mechanism while
  MCP moves clients toward Client ID Metadata Documents.
- Example training configuration uses neutral placeholder values.
- Public configuration now uses <code>event</code>/<code>EVENT_*</code>, and the
  optional tool is <code>whoop_get_event_context</code>. Older
  <code>race</code>/<code>RACE_*</code> keys and
  <code>whoop_get_race_readiness</code> references must be migrated.
- The main example/CLI initializer no longer enables a placeholder event; an
  event must be explicitly added from the separate optional template.
- WHOOP API responses and computed tool results are no longer persisted; the
  database is limited to encrypted WHOOP OAuth tokens and MCP auth/client
  metadata.
- Sleep window direction is now labeled neutrally as
  <code>longer</code>/<code>shorter</code>/<code>similar</code>, rather than
  implying that duration alone is improving or declining.
