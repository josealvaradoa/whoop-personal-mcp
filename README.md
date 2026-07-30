# whoop-ironman-mcp

A remote MCP server that connects WHOOP fitness tracker data to Claude for AI-powered Ironman 70.3 training coaching.

> The npm package is named `whoop-ironman-mcp`; the GitHub repository is [`whoop-mcp-openclaw`](https://github.com/josealvaradoa/whoop-mcp-openclaw).

**Demo:** _Coming soon._
<!-- Owner TODO: add a screenshot or short GIF of Claude giving a training recommendation from live WHOOP data. -->

## What It Does

- Pulls real-time biometric data from your WHOOP (recovery, HRV, sleep, strain, workouts)
- Computes training metrics: ACWR, sleep debt, recovery trends, race readiness
- Exposes 7 read-only MCP tools that Claude can call to make daily training recommendations
- Includes a Claude Project template that turns Claude into an Ironman 70.3 coach

## Architecture

```
Claude (mobile / desktop / claude.ai)
        |
        v  MCP Streamable HTTP over HTTPS  (SSE is the response mode)
+---------------------------------------------------+
|     whoop-ironman-mcp                             |
|     (Node.js + TypeScript, Express)               |
|                                                   |
|  OAuth authorization server (for MCP clients)     |
|   - /authorize -> consent gate (ACCESS_PASSWORD)  |
|   - /token, /register (dynamic client reg. + PKCE)|
|   - MCP tokens stored as SHA-256 hashes           |
|                                                   |
|  MCP transport                                    |
|   - POST /mcp    (JSON-RPC requests)              |
|   - GET  /mcp    (SSE notifications)              |
|   - DELETE /mcp  (close session)                  |
|   - Bearer auth (OAuth token, or optional static) |
|   - 7 read-only tools, one server per session     |
|                                                   |
|  WHOOP account linking                            |
|   - /auth/whoop  (password-gated)                 |
|   - /auth/whoop/callback                          |
|   - tokens encrypted at rest (AES-256-GCM/PBKDF2) |
|   - single-flight refresh (single-use tokens)     |
|                                                   |
|  Compute layer (pure functions)                   |
|   - ACWR, monotony, trends, race readiness        |
|                                                   |
|  SQLite (better-sqlite3, WAL)                     |
|   - encrypted WHOOP tokens (single row)           |
|   - hashed MCP tokens + registered clients        |
|   - cached API responses                          |
+---------------------------------------------------+
        |
        v  HTTPS
   WHOOP API v2
```

## Deploy on Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template)

> Note: this button points to Railway's generic template page, not a preconfigured template for this project.

After deploying:

- Set the environment variables from the table below in the Railway dashboard.
- Set `PUBLIC_URL` and `WHOOP_REDIRECT_URI` to your Railway URL (e.g. `https://your-app.railway.app` and `https://your-app.railway.app/auth/whoop/callback`), and register that redirect URI in your WHOOP app at developer.whoop.com.
- Attach a persistent volume at `/app/data` so the SQLite database (encrypted tokens) survives redeploys. `DATA_DIR` defaults to `./data` (i.e. `/app/data`).

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/josealvaradoa/whoop-mcp-openclaw.git
cd whoop-mcp-openclaw
corepack enable
pnpm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` (see [Environment Variables](#environment-variables-env) for the full list). At minimum you need:

- `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET`, `WHOOP_REDIRECT_URI` — from developer.whoop.com
- `ENCRYPTION_SECRET` — 32+ random characters (e.g. `openssl rand -base64 32`)
- `ACCESS_PASSWORD` — 12+ characters; you type this in the browser to authorize access

Both length rules are enforced at boot: if `ENCRYPTION_SECRET` is under 32 chars or `ACCESS_PASSWORD` is under 12, the server exits with a clear error.

### 3. Configure your training profile

```bash
cp whoop-mcp.config.example.json whoop-mcp.config.json
```

Edit the `athlete`, `race`, and `thresholds` blocks. (If you skip this step the server falls back to the example file.)

### 4. Build and run

```bash
pnpm run build
node dist/index.js
```

The server listens on `PORT` (default `3000`).

### 5. Connect Claude (OAuth — recommended)

1. In Claude.ai, go to **Settings → Connectors → Add custom connector**.
2. Enter your server's public URL ending in `/mcp` (e.g. `https://your-app.railway.app/mcp`). Leave the token field blank.
3. Claude registers itself and starts the OAuth flow. A browser page appears asking for your `ACCESS_PASSWORD` — this is the **consent gate**. Enter it to approve.
4. **First time only:** you are then sent to WHOOP to sign in and authorize. After that your account is linked and Claude is connected.

> Claude's servers must be able to reach your URL, so the OAuth connector needs a public deployment (Railway, or a tunnel such as ngrok). `http://localhost:3000` works for local curl testing but not for the cloud connector.

### 5b. Static bearer token (optional — curl/scripts)

Only if you set `MCP_BEARER_TOKEN`:

1. Set `MCP_BEARER_TOKEN` in `.env` and restart.
2. Link WHOOP once: open `<server>/auth/whoop` in a browser and enter your `ACCESS_PASSWORD`.
3. Call `/mcp` with the header `Authorization: Bearer <MCP_BEARER_TOKEN>`. See [`test-curls.sh`](test-curls.sh).

When `MCP_BEARER_TOKEN` is unset there is no static auth path — only the OAuth flow can authenticate.

### 6. Ask Claude

> "What should I do today?"

## MCP Tools Reference

| Tool | Description |
|------|-------------|
| `whoop_get_today_overview` | Latest recovery score, HRV, RHR, SpO2, skin temp, sleep, strain, and calories, with a green/yellow/red readiness assessment and 30-day baseline comparisons. Each section reports its own date so a stale sync is visible. |
| `whoop_get_training_load` | 7-day acute load, 28-day chronic load, ACWR, monotony, and trend direction, plus per-window data-completeness counts. (`days`: 28–365, default 42) |
| `whoop_get_recovery_trend` | 7- and 30-day rolling recovery averages, trend direction, and consecutive green/yellow/red day counts. (`days`: 7–365, default 30) |
| `whoop_get_hrv_trend` | HRV baseline, current 7-day average, coefficient of variation, and trend direction. (`days`: 7–365, default 30) |
| `whoop_get_sleep_trend` | Sleep duration, efficiency, consistency, and cumulative sleep debt. Naps and unscored records are excluded. (`days`: 3–365, default 14) |
| `whoop_get_workouts` | Workout history with sport, strain, HR data, and HR-zone distribution, plus weekly volume and intensity. Optional `sport` filter. (`days`: 1–365, default 14) |
| `whoop_get_race_readiness` | Days to race, current periodization phase, fitness trend, fatigue status, key concerns, and a weekly summary. |

**Structured output and `null` semantics.** Every tool returns MCP structured output — a `structuredContent` object validated against an output schema, plus the same JSON as a text block. A metric returned as `null` means WHOOP has no scored data for it (no sync, strap not worn, or scoring still pending) — **`null` never means zero**. This is deliberate: the consumer is a language model, so "no data" must be distinguishable from "a real value of 0." The overview also exposes `recovery_available` / `sleep_available` / `strain_available` flags and per-section dates so the model can detect and report stale or missing data instead of inventing a recommendation.

## Security model

This is a **single-tenant** server: one WHOOP account per deployment, stored in a single-row tokens table. It is meant to be deployed by the athlete, for the athlete.

- **Consent gate.** Connecting a new MCP client, or linking a WHOOP account, requires entering `ACCESS_PASSWORD` in the browser. An earlier version auto-approved any client that reached the server URL; the consent gate closes that hole (see [SECURITY.md](SECURITY.md)).
- **Encryption at rest.** WHOOP access/refresh tokens are encrypted with AES-256-GCM using a PBKDF2-derived key (random salt + IV per encryption).
- **Hashed MCP tokens.** MCP access/refresh tokens are stored as SHA-256 hashes, so a database leak yields no usable credentials.
- **Redirect-host allowlist.** Dynamic client registration only accepts `redirect_uri`s that are https on an allow-listed host (`claude.ai`/`claude.com` by default, or `ALLOWED_REDIRECT_HOSTS`), matched exactly — so an attacker cannot register a "Claude"-named client that points authorization codes at their own domain. The consent page also shows the concrete destination host.
- **Timing-safe comparisons**, a **per-IP password rate limit** on the browser password endpoints, and a **CORS allowlist** (`claude.ai`, `claude.com`, localhost, plus anything in `CORS_ORIGINS`).

This project went through a full security audit; [SECURITY.md](SECURITY.md) documents the threat model and the specific attack the consent gate closes.

## Configuration

### Environment Variables (`.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `WHOOP_CLIENT_ID` | Yes | OAuth client ID from developer.whoop.com |
| `WHOOP_CLIENT_SECRET` | Yes | OAuth client secret from developer.whoop.com |
| `WHOOP_REDIRECT_URI` | Yes | WHOOP OAuth callback. Local: `http://localhost:3000/auth/whoop/callback`. Prod: `https://<your-app>.railway.app/auth/whoop/callback` — must match the URI registered in your WHOOP app |
| `ENCRYPTION_SECRET` | Yes | 32+ char secret; derives the AES-256-GCM key (PBKDF2) used to encrypt WHOOP tokens at rest |
| `ACCESS_PASSWORD` | Yes | 12+ char password entered in the browser to authorize a client or link WHOOP (the consent gate) |
| `MCP_BEARER_TOKEN` | No | Static bearer token for direct MCP access via curl/scripts, sent as `Authorization: Bearer <token>` to `/mcp`. When unset, only the OAuth flow can authenticate |
| `PORT` | No | HTTP port (default `3000`) |
| `NODE_ENV` | No | `development` or `production` (default `development`) |
| `PUBLIC_URL` | No | Public base URL used as the OAuth issuer. Set to your Railway URL in production (default `http://localhost:<PORT>`) |
| `CORS_ORIGINS` | No | Comma-separated extra CORS origins, additive to the built-in allowlist (`claude.ai`, `claude.com`, and any localhost) |
| `ALLOWED_REDIRECT_HOSTS` | No | Comma-separated hostnames whose **https** `redirect_uri`s may be registered by MCP clients. When set it **replaces** the built-in defaults (`claude.ai`, `claude.com`, `www.claude.ai`, `www.claude.com`); `localhost`/`127.0.0.1` are always allowed |
| `DATA_DIR` | No | Directory for the SQLite database (default `./data`) |

### Training Config (`whoop-mcp.config.json`)

Copy `whoop-mcp.config.example.json` to `whoop-mcp.config.json` and customize:

- **athlete**: name, sleep target, max HR, resting-HR baseline
- **race**: race name, date, type, and training phases with date ranges
- **thresholds**: ACWR danger/optimal zones, recovery color thresholds, HRV concern level
- **cache**: TTL and history window

## Training Agent Setup

See [agent/SETUP.md](agent/SETUP.md) for step-by-step instructions to set up Claude as your Ironman training coach.

## Development

### Run locally

```bash
pnpm run dev          # Run with tsx (no build step)
pnpm run build        # Compile TypeScript
pnpm run start        # Run compiled JS
pnpm run typecheck    # Type check without emitting
pnpm run lint         # ESLint
```

### Project structure

```
src/
  index.ts              Entry point
  server.ts             Express app, OAuth provider + consent gate, WHOOP linking, CORS
  config.ts             Config loader and validator
  whoop/
    auth.ts             WHOOP OAuth flow, token encryption (AES-256-GCM), refresh
    client.ts           WHOOP API v2 client with pagination and caching
    types.ts            TypeScript types for WHOOP API responses
  db/
    connection.ts       SQLite singleton (better-sqlite3, WAL mode)
    schema.ts           Tables (tokens, cache, mcp_clients, mcp_access/refresh_tokens)
    cache.ts            TTL-based cache read/write/cleanup
  compute/
    training-load.ts    ACWR, monotony, trend direction
    recovery.ts         Recovery trends, readiness, baseline comparison
    sleep.ts            Sleep debt, consistency, duration trends
    hrv.ts              HRV baseline, coefficient of variation
    race-readiness.ts   Phase detection, fitness/fatigue assessment
    stats.ts            Shared math helpers (mean, stddev, rounding, kJ->kcal)
  mcp/
    setup.ts            MCP transport, session management, tool registration
    tools/              7 tool implementations + shared defineTool helper
agent/
  SYSTEM_PROMPT.md      Claude coaching persona instructions
  TRAINING_CONTEXT.md   Athlete profile template
  PERIODIZATION_GUIDE.md  Training reference document
  SETUP.md              How to set up the Claude Project
```

## How the Computed Metrics Work

### ACWR (Acute-to-Chronic Workload Ratio)
Compares your last 7 days of training strain to your 28-day average. Values between 0.8–1.3 are optimal. Above 1.5 signals injury risk. Below 0.8 means you're undertrained. In-progress days are excluded, and ACWR is reported as `null` when fewer than 4 of the last 7 days have data (rather than a misleadingly low number).

### Training Monotony
How repetitive your training is. High monotony (> 2.0) means every day looks the same — your body needs variety to adapt without breaking down.

### Sleep Debt
`whoop_get_sleep_trend` reports the cumulative difference between actual sleep and your target across the window; a debt of -4.5 hours means you've under-slept by almost a full night over a week. The overview separately reports only last night versus target (`last_night_vs_target_hrs`) — same idea, different window, so they aren't conflated.

### Race Readiness
Combines ACWR, recovery trend, HRV, sleep, and your training phase into a single assessment: fitness trend (`on_track`, `undertrained`, `overreaching`, `injury_risk`), fatigue status, and specific concerns to address.

## License

MIT
