# Project Audit — whoop-ironman-mcp

**Date:** 2026-07-02
**Scope:** Every file in `src/` (20 files), infra (Dockerfile, CI, Railway config), docs (`README.md`, `agent/`), dependency and git-history review.
**Method:** Full manual code read; `pnpm install`, `typecheck`, `lint`, `build` all run (all pass); an in-memory MCP client smoke test (7 tools register, schemas serialize correctly, zod validation works end-to-end); git history scanned for secrets.

---

## Executive summary

For a first MCP server, this is a **strong project** — well above the typical learning-project bar. The layering is clean (API client → compute → MCP tools → transport), the OAuth work is ambitious (chained WHOOP + MCP authorization, PKCE, token rotation, encrypted tokens at rest), and the commit history shows real debugging of production issues (mobile in-app browser redirects, single-use refresh tokens, pagination params).

The three things standing between this and a public-quality repo:

1. **A critical auth gap:** anyone who knows the server URL can mint valid MCP tokens and read your health data (details below). Must fix before sharing a deployed URL.
2. **Zero tests**, despite a compute layer that is almost entirely pure functions — the easiest-to-test code there is.
3. **Documentation drift:** the README documents wrong tool names, is missing two *required* env vars (following the Quick Start as written fails at boot), and still contains template placeholders.

Git history is clean — no secrets were ever committed (verified; the only match is the `dev-bearer-token-123` placeholder in `test-curls.sh`).

### Scorecard

| Area | Grade | Notes |
|------|-------|-------|
| Architecture & organization | A− | Clean separation, sensible module boundaries |
| MCP implementation | B+ | Correct sessions/annotations/validation; missing structured output, resources |
| Security | C+ | Excellent crypto habits undermined by missing resource-owner consent |
| Correctness & robustness | B− | Edge cases: unscored records, naps, missing-data-as-zero |
| Testing | — | None exist |
| Documentation | B− | Rich but drifted from the code |
| Ops / DX | B | CI + multi-stage Docker + health checks; Node 20 is EOL, two lockfiles |

---

## 1. Security findings

### 1.1 CRITICAL — Any client is auto-approved for your health data

`src/server.ts:139-155` — in `authorize()`, if WHOOP tokens exist (i.e., you've linked your account), the server immediately issues an authorization code to **any** client that asks, with no consent step and no user authentication:

```ts
if (getTokens()) {
  const code = randomBytes(32).toString("hex");
  ...
  res.redirect(url.toString());   // straight back to the requesting client
}
```

Combined with open dynamic client registration (`mcpAuthRouter` exposes `/register`, and `registerClient` in `src/server.ts:113-123` accepts anyone), the attack is three HTTP calls:

1. `POST /register` with the attacker's own `redirect_uri` → get a `client_id`
2. `GET /authorize?...` with their own PKCE challenge → server auto-approves, code delivered to attacker's redirect URI
3. `POST /token` with their verifier → valid access token → call all 7 tools, read recovery/sleep/HRV/workout history

**Fix (pick at least the first):**
- Add a **consent gate** in `authorize()`: instead of silently redirecting, render a page that requires proof of ownership (e.g., enter `MCP_BEARER_TOKEN` or a dedicated `ACCESS_PASSWORD`) before the code is issued. One-time cookie after first approval keeps UX fine.
- **Defense in depth:** allowlist redirect URIs at registration time (e.g., only `https://claude.ai/api/mcp/auth_callback` / `https://claude.com/...`), so codes can only be delivered to Claude. On its own this still lets any Claude user who knows your URL connect — the consent gate is the real fix.

### 1.2 HIGH — `/auth/whoop` is unauthenticated; anyone can overwrite the linked account

`src/server.ts:374-380`. The tokens table is a single row (`id = 1`, `src/db/schema.ts:5-14`), so any stranger visiting `/auth/whoop` on your deployed server can link *their* WHOOP account — overwriting yours (breaks your coach) or poisoning your data. Gate this route behind the same ownership check as 1.1.

### 1.3 MEDIUM — MCP tokens stored in plaintext

WHOOP tokens are AES-256-GCM encrypted at rest (nice), but the MCP access/refresh tokens in `mcp_access_tokens` / `mcp_refresh_tokens` are stored raw (`src/server.ts:69-87`). You only ever *look up* these tokens, never need them back — store `sha256(token)` and hash incoming tokens before lookup. One-line change, removes the "DB leak = live credentials" class.

### 1.4 MEDIUM — Non-timing-safe token comparisons

`src/server.ts:258` (`token === config.security.mcpBearerToken`) and `src/server.ts:357` (`/auth/status` check). Use `crypto.timingSafeEqual` on hashed buffers. Low practical exploitability, but it's the kind of detail reviewers look for.

### 1.5 LOW
- **Error detail leakage:** `err.message` / `String(err)` returned to clients in `src/server.ts:441`, `src/server.ts:449`, and `src/mcp/setup.ts:156`. Log the detail, return a generic message.
- **Static bearer token never expires** (`verifyAccessToken` static path). Fine for curl testing; consider disabling it when `NODE_ENV=production`.
- **`Access-Control-Allow-Origin: *`** on everything including auth routes. Harmless with header-based bearer auth (no cookies), but tighten or remove — MCP traffic comes from Claude's servers, not browsers.
- **Token exchange doesn't validate `redirect_uri`** against the one bound to the code (`exchangeAuthorizationCode` ignores its `_redirectUri` param; you already store it with the code). PKCE mostly covers this, but the check is one `if`.

### What's already good here (worth keeping and talking about)
AES-256-GCM with per-encryption random salt + IV and PBKDF2 key derivation; refresh-token rotation on use; single-flight mutex around WHOOP refresh (their refresh tokens are single-use — this prevents a real race); distinguishing definitive auth failures (delete tokens) from transient errors (preserve tokens); OAuth `state` with TTL; auth-code TTL + cleanup; secrets never logged (only prefixes); `.env` and live config gitignored from day one.

---

## 2. Correctness findings

### 2.1 Missing data is reported as zero — the LLM can't tell the difference

`src/mcp/tools/overview.ts:42-44` defaults absent scores with `?? 0`, and `mean([])` returns `0` in `src/compute/recovery.ts:20-23`. If WHOOP hasn't synced (or the user didn't wear the strap), the overview reports `recovery_score: 0` → readiness `"red"` → recommendation `"active_recovery_only"`. Claude will confidently tell the athlete to rest based on *no data*.

This is the most important non-security fix, and it's a genuinely interesting AI-engineering problem: **tool outputs are consumed by a model, so absence must be explicit.** Use `null` + a `data_available` / `last_synced` field, and say what it means in the tool description. Same class of issue: `cycles[0]` is assumed to be *today* — if sync is stale it's yesterday's cycle presented as today. Include the record's date in the output so the model can notice staleness.

### 2.2 Unscored recovery/sleep records will throw

`Recovery.score_state` exists in your types (`src/whoop/types.ts:41`), and you correctly filter `score_state === "SCORED"` for workouts (`src/mcp/tools/workouts.ts:30`) — but recovery and sleep records are mapped without that filter (`overview.ts`, `recovery.ts`, `hrv.ts`, `sleep.ts`). A `PENDING_SCORE` record (common in the morning before scoring completes) has no `score`, so `r.score.recovery_score` throws; the try/catch turns it into a tool error, taking down the whole response. Apply the same filter everywhere.

### 2.3 Naps are counted as nights of sleep

`getSleepCollection` → `mapSleepToDay` maps every sleep activity. WHOOP v2 sleep records include naps as separate activities (there's a `nap` boolean on the record — verify against the v2 docs; your own type already models `need_from_recent_nap_milli`). A 40-minute nap becomes a 0.67-hr "night", wrecking sleep debt and consistency. Filter `nap === false` (add the field to the `Sleep` type).

### 2.4 Window math is by record count, not calendar days

All compute functions (`slice(0, 7)`, `slice(0, 28)`) assume: (a) records are newest-first, and (b) one record per day. Neither is enforced — you rely on WHOOP's response ordering (never sorted explicitly), and gaps (device off, unscored days) silently stretch "7 days" into more. ACWR and monotony are exactly the metrics that get distorted. Fix: sort explicitly by date descending, then bucket by calendar day before slicing.

Related subtlety: today's *in-progress* cycle is included in acute load, biasing ACWR low in the morning. Consider excluding the current partial day (or noting it in the output).

### 2.5 Smaller ones
- `computeFitnessTrend` (`src/compute/race-readiness.ts:33-36`): the `optimal && (stable || improving)` condition is dead — both branches return `"on_track"`, so declining recovery in the optimal zone still reads "on track". Probably not what you meant.
- `getDaysToRace` / `getCurrentPhase` use server-local time (UTC on Railway) — phase and day-count boundaries can be off by a day for the athlete's timezone.
- Overview's `sleep_debt_hrs` is *last night vs target* while the sleep tool's `sleep_debt_cumulative_hrs` is a 7-day sum — same-sounding names, different semantics; the model may conflate them. Rename one.
- `fetchAllPages` (`src/whoop/client.ts:64-80`) silently truncates at 50 pages and never passes `limit` (WHOOP default page size is small; max is 25 per docs) — pass `limit: "25"` to cut request count ~2.5×, and log if the page cap is ever hit.
- Zod `.default()` values in an int schema serialize with `"maximum": 9007199254740991` (observed in the smoke test — harmless zod-v4 artifact). Adding sensible `.max()` bounds (e.g. 365) cleans the schema and stops `days: 100000` requests.

---

## 3. Code quality & maintainability

**Dead code / dead config:**
- `MCP_OAUTH_CLIENT_ID` / `MCP_OAUTH_CLIENT_SECRET` are **required at boot** (`src/config.ts:133-134`) but never used anywhere. Worse, the README's env table doesn't mention them — a new user following the Quick Start crashes at startup with a confusing error. Remove them (or actually use them).
- `SPORT_ID_MAP` / `getSportName` (`src/whoop/types.ts:116-128`) — unused.
- `cache.invalidate()` (`src/db/cache.ts:19-22`) — unused.

**Duplication:**
- `stddev` is defined three times (`compute/training-load.ts:4`, `compute/sleep.ts:7`, `compute/hrv.ts:4`) → move to a shared `compute/stats.ts` along with `mean` (currently exported from `recovery.ts`, an odd home) and a `round1`/`round2` helper (the `Math.round(x * 10) / 10` pattern appears ~15 times).
- The kJ→kcal constant `0.239006` appears in two tools.
- All 7 tools repeat the same try/catch + `JSON.stringify` + error-wrapping boilerplate. Extract a `defineTool(server, name, meta, handler)` helper — tools become ~15 lines of pure intent.

**Config:** `src/config.ts` hand-rolls validation and then blind-casts (`raw.athlete as Config["athlete"]`) — a missing `athlete` block only explodes later inside a tool. You already ship zod; a zod schema for the config file gives you validation + types + good error messages in ~30 lines, and deletes `validateConfig`.

**Ops polish:**
- No graceful shutdown: no `SIGTERM`/`SIGINT` handler (Railway sends SIGTERM on deploys), and the three `setInterval`s are never cleared/`unref()`'d. Close sessions, the DB, and the HTTP server on shutdown.
- Logging is `console.log` with inconsistent prefixes (`[auth]`, `[mcp]`, `[whoop-api]`). A tiny logger (or pino) with levels + timestamps is a cheap upgrade; keep the good habit of never logging token values.

**Toolchain:**
- **Two lockfiles** (`pnpm-lock.yaml` + `package-lock.json`). Docker and CI use pnpm — delete `package-lock.json`.
- **Node 20 is EOL** (April 2026): `Dockerfile:1,8`, `ci.yml`, `engines`. Move to `node:22-alpine` / Node 22, and align `@types/node` (currently v25 types against a v20 runtime).
- Dockerfile runs as **root**; add `USER node` (and chown `data/`). Also note the image copies only the *example* config — fine for the personal deploy, but worth a README note that `whoop-mcp.config.json` must be mounted or baked.
- CI runs lint + typecheck only — add `build`, tests (below), and optionally `pnpm audit`.

---

## 4. Testing (the biggest gap)

There are no tests, yet the codebase is unusually testable:

1. **Unit-test the compute layer** (highest value ÷ effort). `computeTrainingLoad`, `computeRecoveryTrend`, `computeSleepTrend`, `computeHrvTrend`, `computeKeyConcerns` are pure functions. Table-driven tests with vitest; cover the edge cases from §2 (empty input, gaps, all-zero strain, single record). Target: an afternoon of work, ~80% of the correctness risk covered.
2. **MCP contract test.** Spin up the server with `InMemoryTransport` + the SDK `Client`, snapshot `tools/list` (names, schemas, annotations), and call each tool against fixture data. (The audit's smoke test did exactly this and it works — this is how you'd have caught schema regressions when upgrading the SDK or zod.)
3. **Auth-flow tests** with supertest: register → authorize → token → `/mcp` call, plus the negative cases already sketched in `test-curls.sh` (which references the old tool name `get_today_overview`, by the way). This also becomes the regression harness for the §1 fixes.
4. To make (2)/(3) clean, add one seam: `whoop/client.ts` hard-codes `fetch` — accept an injectable fetch (or use undici's MockAgent) so tools can run against fixture JSON.

---

## 5. Documentation drift

- **Tool names are wrong everywhere in docs**: README table, `agent/SYSTEM_PROMPT.md`, and `test-curls.sh` all say `get_today_overview` etc.; the registered names are `whoop_get_today_overview` etc. (The system prompt still *works* because Claude fuzzy-matches, but it's exactly the kind of inconsistency a reviewer notices.)
- **README env table is missing `MCP_OAUTH_CLIENT_ID` / `MCP_OAUTH_CLIENT_SECRET`** — which are currently required (see §3). Quick Start as written does not boot. Also missing `PUBLIC_URL`, which matters for the OAuth issuer on Railway.
- Placeholders: clone URL is `github.com/yourusername/...`; the Railway button links to the generic template page; there's a TODO comment for the hero screenshot.
- Architecture diagram says "HTTPS + SSE" — it's Streamable HTTP (SSE is only the response mode). Small, but MCP-literate readers will notice.
- Naming identity: repo is `whoop-mcp-openclaw`, package/README say `whoop-ironman-mcp`. Pick one before publishing.
- `agent/SETUP.md` describes the static-bearer connector setup; since the chained OAuth flow now exists, document that path too (it's the more impressive one).

---

## 6. Going-public checklist

- [x] Git history clean — no real secrets ever committed (verified across all commits)
- [x] `.env` / `whoop-mcp.config.json` / `data/` gitignored; LICENSE (MIT) present
- [ ] **Fix §1.1 and §1.2 before sharing any deployed URL** (the repo being public is fine; the *server* is the exposure)
- [ ] Remove or implement the dead `MCP_OAUTH_*` env vars; fix the README env table
- [ ] Delete `package-lock.json`; bump Node 20 → 22 (Docker, CI, engines)
- [ ] Fix tool names across README / SYSTEM_PROMPT / test-curls
- [ ] Resolve the repo-vs-package name; fix clone URL and Railway button
- [ ] Genericize `whoop-mcp.config.example.json` (your name and race are in it — harmless, but a template reads better with placeholders)
- [ ] Add the hero screenshot / 30-second demo GIF (single highest-impact README change for recruiters)
- [ ] Add a short SECURITY note: single-tenant by design, what the consent gate protects, threat model in three sentences
- [ ] Optional: repo topics (`mcp`, `whoop`, `claude`, `ai-agents`), CI badge

## 7. If you want it to sell you as an AI engineer

The strongest parts of this project for interviews are things you may not be presenting: the **chained OAuth flow** (real problem, ugly constraints, mobile-browser workaround with a documented rationale in `sendAuthRedirectPage`), the **missing-data semantics problem** (§2.1 — "my tool's consumer is a model, so ambiguity is a bug"), and the **agent design** in `agent/` (system prompt forces tool calls before advice — that's tool-orchestration policy, not just prompting). Suggestions, in order of signal-per-hour:

1. **Tests + CI** (§4) — the single loudest differentiator vs. typical AI side projects.
2. **Fix the auth hole and write it up.** A README "Security model" section that says *"v1 auto-approved any client; here's the attack, here's the consent gate"* turns a flaw into evidence you can think adversarially.
3. **A tiny eval harness.** Fixture WHOOP data (e.g., an overtraining week vs. a fresh week) → run Claude with the system prompt + MCP server → assert the recommendation direction (rest vs. train). Even 5 scenarios makes "how do you evaluate LLM behavior?" a show-don't-tell answer. This is rare in portfolios and highly valued.
4. **Modernize the MCP surface**: `outputSchema` + `structuredContent` on tools (you already return JSON; make it official), consider exposing the athlete profile/config as an MCP *resource* and a "daily check-in" *prompt* — demonstrates you know the protocol beyond tools.
5. **A "Design decisions" README section**: cache-first client, encrypted tokens, single-flight refresh, session LRU — you made real decisions; state them and their trade-offs in six bullets.

---

*Build verification: `pnpm install --frozen-lockfile`, `pnpm run typecheck`, `pnpm run lint`, `pnpm run build` all pass on Node 22. In-memory MCP smoke test: 7/7 tools listed with correct schemas + annotations; invalid-argument calls rejected by zod validation as expected.*
