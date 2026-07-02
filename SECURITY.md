# Security

This document describes the security model of `whoop-ironman-mcp` and how to report a vulnerability. The project went through a full manual security audit; several of the measures below were added as a direct result.

## Design: single-tenant by design

The server is built for **one WHOOP account per deployment**. WHOOP tokens live in a single-row table (`tokens`, `id = 1`), so there is exactly one linked account at a time. It is meant to be self-hosted by the athlete whose data it serves — it is not a multi-user SaaS, and it does not try to isolate multiple users.

Because a linked account is a shared, overwritable resource, both "who can talk to the MCP server" and "who can link/relink WHOOP" are gated behind a single secret you control: `ACCESS_PASSWORD`.

## The consent gate (and the attack it closes)

**Before:** if a WHOOP account was linked, the OAuth `authorize` endpoint immediately issued an authorization code to *any* client that asked. Combined with open dynamic client registration, anyone who knew the server URL could register a client, get auto-approved, exchange a token, and read your recovery, sleep, HRV, and workout history — with no authentication and no consent step.

**Now:** `authorize` never auto-approves. It renders a browser consent page that requires `ACCESS_PASSWORD` before any authorization code is issued. The same password gates `/auth/whoop`, so a stranger cannot link or overwrite the linked WHOOP account either. The password is verified with a timing-safe comparison, and pending consent requests are single-use with a short TTL.

## Data protection

- **WHOOP tokens are encrypted at rest** with AES-256-GCM. The key is derived from `ENCRYPTION_SECRET` via PBKDF2 (100,000 iterations, SHA-256), with a random 16-byte salt and 12-byte IV generated per encryption and a GCM authentication tag.
- **MCP access/refresh tokens are stored as SHA-256 hashes.** The raw token is only ever returned to the client that owns it; incoming tokens are hashed before lookup. A database leak therefore yields no usable MCP credentials.
- **Timing-safe secret comparisons.** `ACCESS_PASSWORD`, the static bearer token, and MCP tokens are compared with `crypto.timingSafeEqual` over SHA-256 digests (equal-length buffers, input length hidden).
- **HTTPS-only redirect registration.** Dynamic client registration rejects any `redirect_uri` that is not HTTPS (plain HTTP is allowed only for `localhost` / `127.0.0.1`), so authorization codes can only be delivered over TLS.
- **CORS allowlist.** Origins are reflected only for an allowlist — `claude.ai`, `claude.com`, any `localhost`/`127.0.0.1`, plus anything you add via `CORS_ORIGINS` — instead of a blanket wildcard.
- **Refresh-token hygiene.** MCP refresh tokens rotate on use (old token deleted, new one issued). WHOOP refresh tokens are single-use, so refreshes are serialized behind a single-flight mutex to avoid races.
- **Secrets are never logged** — only short, non-reversible prefixes appear in logs. `.env`, `whoop-mcp.config.json`, and `data/` are gitignored.

## Threat model (honest version)

The consent gate and encryption assume `ACCESS_PASSWORD` and `ENCRYPTION_SECRET` stay secret and that you deploy over HTTPS. Anyone who knows `ACCESS_PASSWORD` can link WHOOP and connect a client — that is the intended trust boundary, so choose a strong value and rotate it if exposed. If `MCP_BEARER_TOKEN` is set, it is a long-lived credential with no consent step and no expiry; leave it unset in production unless you specifically need the curl/script path. This is a single-tenant personal tool, not a hardened multi-tenant service: there is no rate limiting, no account isolation, and no audit log beyond application logs.

## Reporting a vulnerability

Please report security issues privately via **GitHub Security Advisories** on the repository (Security → Report a vulnerability), or by opening a GitHub issue if the matter is not sensitive:

<https://github.com/josealvaradoa/whoop-mcp-openclaw>

There is no dedicated security contact address for this project; please use the GitHub channels above.
