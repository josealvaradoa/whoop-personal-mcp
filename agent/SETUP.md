# Setting Up Your Ironman Training Coach in Claude

## Prerequisites

- A deployed whoop-ironman-mcp server. For the OAuth connector below, it must be publicly reachable by Claude's servers (e.g. `https://your-app.railway.app`) — `http://localhost:3000` only works for local curl testing.
- Your MCP server URL ending in `/mcp` (e.g. `https://your-app.railway.app/mcp`).
- Your `ACCESS_PASSWORD` (the value from your `.env`) — you type this in the browser to authorize the connection and to link WHOOP.
- Optional: `MCP_BEARER_TOKEN`, only if you plan to use the static-bearer connector instead of OAuth.

## Steps

### 1. Create a Claude Project

1. Go to [claude.ai](https://claude.ai)
2. Click **Projects** in the left sidebar
3. Click **New Project**
4. Name it something like "Ironman Training Coach"

### 2. Set Custom Instructions

1. In your new Project, click **Project Settings** (gear icon)
2. Find the **Custom Instructions** section
3. Copy the entire contents of `SYSTEM_PROMPT.md` and paste it in
4. Save

### 3. Upload Knowledge Files

1. In Project Settings, find the **Knowledge** section
2. Upload two files:
   - `TRAINING_CONTEXT.md` — fill this in with your personal details first (age, race, fitness level, injuries, schedule)
   - `PERIODIZATION_GUIDE.md` — upload as-is (reference material for Claude)

### 4. Add the MCP Custom Connector

Pick one of the two paths below.

#### Option A — OAuth (recommended)

1. Go to **Settings** (top-right menu) → **Connectors**
2. Click **Add custom connector**
3. Enter your MCP server URL: `https://your-app.railway.app/mcp`. Leave the token field blank.
4. Claude registers itself and starts the OAuth flow. A browser page appears asking for your **access password** (the `ACCESS_PASSWORD` from your `.env`) — this is the consent gate. Enter it to approve.
5. **First time only:** you are then redirected to WHOOP to sign in and authorize. After that your account is linked and the connector is ready. (No separate `/auth/whoop` visit is needed — linking happens as part of this flow.)

#### Option B — Static bearer token (optional)

Only if you set `MCP_BEARER_TOKEN` in your `.env`:

1. Link WHOOP once: open `<your-server>/auth/whoop` in a browser and enter your `ACCESS_PASSWORD`.
2. Go to **Settings** → **Connectors** → **Add custom connector**
3. Enter your MCP server URL: `https://your-app.railway.app/mcp`
4. Set the Authorization header: `Bearer <your MCP_BEARER_TOKEN>`
5. Save

### 5. Verify It Works

1. Start a new conversation in your Ironman Training Coach project
2. Ask: **"What should I do today?"**
3. Claude should:
   - Call `whoop_get_today_overview` to check your recovery and sleep
   - Call `whoop_get_training_load` to check your ACWR
   - Give you a specific training recommendation based on your data

### Troubleshooting

- **Claude doesn't call tools**: Make sure the Custom Connector URL ends with `/mcp`. For Option A, re-run the connection and confirm you entered the correct `ACCESS_PASSWORD`. For Option B, confirm the bearer token matches your `MCP_BEARER_TOKEN` env var.
- **Consent page rejects your password**: The connector uses `ACCESS_PASSWORD`, not `MCP_BEARER_TOKEN`. Confirm the value in your `.env` and that the server was restarted after changing it.
- **"No tokens stored" error**: Your WHOOP account isn't linked. With Option A, re-run the connector to trigger the WHOOP sign-in; with Option B, visit `/auth/whoop` and enter your `ACCESS_PASSWORD`.
- **"Token expired" error**: Visit `/auth/whoop` again (enter your `ACCESS_PASSWORD`) to re-authorize. WHOOP tokens expire periodically.
- **A metric comes back `null`**: That means WHOOP has no scored data for it (no sync, strap not worn, or scoring pending) — it does not mean zero. Sync your WHOOP and retry.
- **No data returned**: Make sure you've been wearing your WHOOP for at least a few days. The tools need historical data for trend calculations.
