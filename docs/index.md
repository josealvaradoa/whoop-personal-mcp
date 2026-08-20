# WHOOP Personal MCP documentation

WHOOP Personal MCP is a single-user, self-hosted Streamable HTTP MCP server. It
turns one person's read-only WHOOP data into six core model-facing tools plus an
optional target-event context tool.

Choose the document that matches what you are trying to do:

## Learn by doing

- [Get from a clean checkout to a working local server](getting-started.md)

## Complete a task

- [Connect Grok, Claude, Codex, OpenClaw, or another client](clients.md)
- [Initialize, validate, probe, and start with the CLI](cli.md)
- [Deploy with Docker Compose, an OCI host, or Railway](deployment.md)
- [Diagnose setup and connection failures](troubleshooting.md)
- [Prepare and verify a release](releasing.md)
- [Historical pre-1.0 self-review](history/initial-code-review-2026-07.md)

## Look something up

- [Environment, profile, tool, route, and token reference](configuration.md)
- [MCP 2026-07-28 and legacy-era protocol compatibility](protocol-compatibility.md)

## Understand the design

- [Architecture, trust boundaries, persistence, and trade-offs](architecture.md)
- [Security model](../SECURITY.md)
- [Privacy and data lifecycle](../PRIVACY.md)
- [Wellness and legal disclaimer](../DISCLAIMER.md)
- [Contributing](../CONTRIBUTING.md)
- [Community code of conduct](../CODE_OF_CONDUCT.md)
- [Support](../SUPPORT.md)

The core server is client-neutral. Client instructions are separate because
each provider owns its UI, callback behavior, data policy, and retention.
