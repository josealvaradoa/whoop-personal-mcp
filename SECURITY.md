# Security

This document describes the security model of `whoop-ironman-mcp` and how to report a vulnerability. The project went through a full manual security audit; several of the measures below were added as a direct result.

## Design: single-tenant by design

The server is built for **one WHOOP account per deployment**. WHOOP tokens live in a single-row table (`tokens`, `id = 1`), so there is exactly one linked account at a time. It is meant to be self-hosted by the athlete whose data it serves — it is not a multi-user SaaS, and it does not try to isolate multiple users.

Because a linked account is a shared, overwritable resource, both "who can talk to the MCP server" and "who can link/relink WHOOP" are gated behind a single secret you control: `ACCESS_PASSWORD`.

## The consent gate (and the attack it closes)

**Before:** if a WHOOP account was linked, the OAuth `authorize` endpoint immediately issued an authorization code to *any* client that asked. Combined with open dynamic client registration, anyone who knew the server URL could register a client, get auto-approved, exchange a token, and read your recovery, sleep, HRV, and workout history — with no authentication and no consent step.

**Now:** `authorize` never auto-approves. It renders a browser consent page that requires `ACCESS_PASSWORD` before any authorization code is issued. The same password gates `/auth/whoop`, so a stranger cannot link or overwrite the linked WHOOP account either. The password is verified with a timing-safe comparison, and pending consent requests are single-use with a short TTL.

## Phishing the consent gate (and how it's mitigated)

**The attack:** the consent page asks the owner for `ACCESS_PASSWORD`. Because dynamic client registration is open, an attacker could register a client named "Claude" whose `redirect_uri` points at *their own* callback, send the owner the resulting `/authorize` link, and — if the owner typed their password — receive an authorization code at the attacker's domain. The consent page previously showed only the attacker-chosen client name, not the destination, so nothing tipped off the owner.

**Two mitigations, both required:**

- **Registration redirect-host allowlist.** Registration now accepts a `redirect_uri` only when it is https *and* its hostname **exactly** equals an allowed host. The defaults are the Claude hosts (`claude.ai`, `claude.com`, `www.claude.ai`, `www.claude.com`); `ALLOWED_REDIRECT_HOSTS` (comma-separated) replaces that remote list when set. Matching is exact — no suffix/substring logic — so `claude.ai.evil.com` and `sub.claude.ai.evil.com` are rejected. `localhost`/`127.0.0.1` stay allowed (http included) for local development. This keeps registration open for the real Claude while denying an attacker a callback on their own domain.
- **Consent-page destination transparency.** The consent page now also renders the concrete `redirect_uri` host ("This will send your data to: `<host>`", HTML-escaped), so the owner sees where an approval would send data before typing the password.

**Tradeoff:** the allowlist is a deny-by-default policy. Self-hosters who connect a non-Claude MCP client (or a custom callback host) must add their host to `ALLOWED_REDIRECT_HOSTS`; otherwise registration is rejected. This is the intended default — open registration limited to hosts you trust.

## Rate limiting the password endpoints

The two browser password endpoints (`POST /auth/consent`, `POST /auth/whoop`) enforce a small in-memory, per-IP failed-attempt limit: after 5 wrong `ACCESS_PASSWORD` submissions from one IP within 15 minutes, further attempts get `429` with a `Retry-After` until the window elapses; a correct password resets that IP's counter. This throttles online brute-forcing of `ACCESS_PASSWORD`. It is best-effort (in-memory, resets on restart, keyed on `req.ip` behind `trust proxy`), not a substitute for a strong password.

## Data protection

- **WHOOP tokens are encrypted at rest** with AES-256-GCM. The key is derived from `ENCRYPTION_SECRET` via PBKDF2 (100,000 iterations, SHA-256), with a random 16-byte salt and 12-byte IV generated per encryption and a GCM authentication tag.
- **MCP access/refresh tokens are stored as SHA-256 hashes.** The raw token is only ever returned to the client that owns it; incoming tokens are hashed before lookup. A database leak therefore yields no usable MCP credentials.
- **Timing-safe secret comparisons.** `ACCESS_PASSWORD`, the static bearer token, and MCP tokens are compared with `crypto.timingSafeEqual` over SHA-256 digests (equal-length buffers, input length hidden).
- **Redirect-host allowlist (https-only).** Dynamic client registration accepts a `redirect_uri` only when it is https and its hostname exactly matches an allowed host (see "Phishing the consent gate" above); plain HTTP is allowed only for `localhost` / `127.0.0.1`. Authorization codes can therefore only be delivered over TLS to a trusted host.
- **Authorization-code binding and TTL.** MCP authorization codes carry the `redirect_uri` they were issued for and are bound to it at token exchange (the incoming `redirect_uri` must be present and equal). Codes expire 5 minutes after issue, enforced at exchange rather than only by the periodic sweep.
- **CORS allowlist.** Origins are reflected only for an allowlist — `claude.ai`, `claude.com`, any `localhost`/`127.0.0.1`, plus anything you add via `CORS_ORIGINS` — instead of a blanket wildcard.
- **Refresh-token hygiene.** MCP refresh tokens rotate on use (old token deleted, new one issued). WHOOP refresh tokens are single-use, so refreshes are serialized behind a single-flight mutex to avoid races.
- **Secrets are never logged** — only short, non-reversible prefixes appear in logs. `.env`, `whoop-mcp.config.json`, and `data/` are gitignored.

## Threat model (honest version)

The consent gate and encryption assume `ACCESS_PASSWORD` and `ENCRYPTION_SECRET` stay secret and that you deploy over HTTPS. Anyone who knows `ACCESS_PASSWORD` can link WHOOP and connect a client — that is the intended trust boundary, so choose a strong value and rotate it if exposed. If `MCP_BEARER_TOKEN` is set, it is a long-lived credential that never effectively expires and has no consent step (its `expiresAt` is refreshed on every request so the SDK accepts it); leave it unset in production unless you specifically need the curl/script path. This is a single-tenant personal tool, not a hardened multi-tenant service: rate limiting is limited to the browser password endpoints (a best-effort per-IP throttle), and there is no account isolation and no audit log beyond application logs.

## Reporting a vulnerability

Please report security issues privately via **GitHub Security Advisories** on the repository (Security → Report a vulnerability), or by opening a GitHub issue if the matter is not sensitive:

<https://github.com/josealvaradoa/whoop-mcp-openclaw>

There is no dedicated security contact address for this project; please use the GitHub channels above.
