# How to connect an MCP client

Use the server URL ending in <code>/mcp</code>. Prefer MCP OAuth because it gives
each client short-lived access and can issue rotating refresh tokens when the
client declares that grant. Enable the optional static bearer token only for a
client that supports an Authorization header but cannot complete OAuth.

Local clients can connect to <code>http://localhost:3000/mcp</code>. A client
running in a provider's cloud needs a publicly reachable HTTPS URL. In every
remote deployment, set <code>PUBLIC_URL</code> to the exact external origin
without <code>/mcp</code>.

Loopback OAuth callbacks are allowed automatically. Remote callback hosts are
deny-by-default: set <code>ALLOWED_REDIRECT_HOSTS</code> to the exact, verified
hostnames for every cloud client you trust, then restart the server. This list
does not accept wildcards and is separate from <code>CORS_ORIGINS</code>.

The endpoint natively serves MCP <code>2026-07-28</code> and automatically falls
back to the stateless 2025-era lifecycle. Client vendors roll out protocol and
OAuth registration changes independently, and their public setup pages do not
always name a protocol revision. A successful connection is the compatibility
test; see [protocol-compatibility.md](protocol-compatibility.md) for the exact
server behavior.

## Grok

### Grok Build with OAuth

[xAI documents remote HTTP MCP servers](https://docs.x.ai/build/features/mcp-servers)
through the <code>grok mcp</code> command. The server's loopback OAuth callbacks
are allowed by default.

~~~bash
export WHOOP_PERSONAL_MCP_URL=http://localhost:3000
grok mcp add --transport http whoop-personal "$WHOOP_PERSONAL_MCP_URL/mcp"
grok mcp doctor whoop-personal
~~~

For a remote deployment, replace the exported origin with its HTTPS origin.
Grok starts OAuth in a browser on first use. Review the destination shown by the
server, enter <code>ACCESS_PASSWORD</code>, and approve.

Useful checks:

~~~bash
grok mcp list
grok mcp doctor whoop-personal --json
~~~

To use a static token instead:

~~~bash
export WHOOP_PERSONAL_MCP_URL=https://YOUR-HOST.example
export MCP_BEARER_TOKEN=replace-with-the-server-token
grok mcp add --transport http whoop-personal "$WHOOP_PERSONAL_MCP_URL/mcp" --header "Authorization: Bearer $MCP_BEARER_TOKEN"
grok mcp doctor whoop-personal
~~~

Do not commit the expanded command or token to shell history, dotfiles, or a
project config. Grok can expand environment variables in
<code>~/.grok/config.toml</code>; start from
[templates/grok-config.toml](../templates/grok-config.toml).

### Grok on the web

[Grok custom connectors](https://docs.x.ai/grok/connectors) connect from xAI's
infrastructure, so deploy the server on public HTTPS first.

1. Open <code>grok.com/connectors</code>.
2. Select **New Connector**, then **Custom**.
3. Enter <code>https://YOUR-HOST.example/mcp</code>.
4. Complete the server's OAuth consent and, on first use, WHOOP linking.

xAI's connector documentation does not publish a fixed OAuth callback hostname.
If Grok reports a rejected redirect URI, identify the exact HTTPS callback
hostname from Grok's current connector flow or xAI support, add only that
hostname to <code>ALLOWED_REDIRECT_HOSTS</code>, restart, and retry. Do not use a
wildcard or guess a parent domain.

### Grok through the xAI Responses API

xAI's [Remote MCP Tools reference](https://docs.x.ai/developers/tools/remote-mcp)
accepts a Streamable HTTP URL and an <code>authorization</code token. This path
requires a public server and static bearer auth:

~~~bash
export XAI_API_KEY=replace-with-your-xai-key
export XAI_MODEL=grok-4.6
export WHOOP_PERSONAL_MCP_URL=https://YOUR-HOST.example/mcp
export MCP_BEARER_TOKEN=replace-with-the-server-token

curl https://api.x.ai/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $XAI_API_KEY" \
  --data-binary @- <<JSON
{
  "model": "$XAI_MODEL",
  "input": "Summarize today's WHOOP data. State when data is missing or stale.",
  "tools": [
    {
      "type": "mcp",
      "server_url": "$WHOOP_PERSONAL_MCP_URL",
      "server_label": "whoop_personal",
      "server_description": "Read-only personal WHOOP wellness and training data",
      "authorization": "Bearer $MCP_BEARER_TOKEN"
    }
  ]
}
JSON
~~~

Use a currently supported Grok model from xAI's docs. The MCP tool result is
processed by xAI under the account and API data controls you selected.

## Claude

[Anthropic's remote connector guide](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
states that Claude connects from Anthropic's cloud. The server therefore needs
public HTTPS even when you use Claude Desktop's account-based remote connector.

Anthropic currently documents <code>https://claude.ai/api/mcp/auth_callback</code>
and says it may move to the equivalent <code>claude.com</code> callback. Set:

~~~text
ALLOWED_REDIRECT_HOSTS=claude.ai,claude.com
~~~

Restart the deployment before adding the connector.

1. In Claude, open **Customize → Connectors**.
2. Select **+ → Add custom connector**.
3. Enter a name and <code>https://YOUR-HOST.example/mcp</code>.
4. Leave advanced client credentials empty. This server accepts a Client ID
   Metadata Document (CIMD) from clients that support the 2026 preference and
   retains Dynamic Client Registration (DCR) as a compatibility fallback.
5. Select **Connect**, enter <code>ACCESS_PASSWORD</code> on the server's
   consent page, and complete WHOOP OAuth if prompted.
6. Enable the connector for the conversation and ask Claude to list its tools.

For Team or Enterprise accounts, an owner must add the connector before members
connect it. Anthropic documents those role-specific steps on the same page.

## Codex

[OpenAI's Codex MCP guide](https://developers.openai.com/codex/mcp/) supports
Streamable HTTP, bearer tokens, and OAuth. The explicit DCR command remains the
documented compatibility path for a server that supports both registration
styles:

~~~bash
codex mcp add whoop_personal --url http://localhost:3000/mcp
codex mcp login whoop_personal --oauth-client-registration dcr
codex mcp list
~~~

For a remote deployment, replace the URL with its HTTPS <code>/mcp</code> URL.
The equivalent <code>~/.codex/config.toml</code> table contains only the URL:

~~~toml
[mcp_servers.whoop_personal]
url = "http://localhost:3000/mcp"
~~~

In the Codex TUI, <code>/mcp</code> shows active servers. The Codex app and IDE
extension also expose **MCP servers → Add server**; choose Streamable HTTP,
enter the same URL, restart, and select **Authenticate**.

For static bearer auth, export the token and use the environment-variable
reference instead of putting a secret in TOML:

~~~bash
codex mcp add whoop_personal \
  --url https://YOUR-HOST.example/mcp \
  --bearer-token-env-var WHOOP_PERSONAL_MCP_TOKEN
~~~

Or use the equivalent TOML:

~~~toml
[mcp_servers.whoop_personal]
url = "https://YOUR-HOST.example/mcp"
bearer_token_env_var = "WHOOP_PERSONAL_MCP_TOKEN"
~~~

The matching template is
[templates/codex-config.toml](../templates/codex-config.toml).

## OpenClaw

Current OpenClaw releases document a native Streamable HTTP registry and MCP
OAuth. Save, authenticate, and probe the server:

~~~bash
export WHOOP_PERSONAL_MCP_URL=https://YOUR-HOST.example
openclaw mcp add whoop-personal --url "$WHOOP_PERSONAL_MCP_URL/mcp" --transport streamable-http --auth oauth
openclaw mcp login whoop-personal
openclaw mcp doctor whoop-personal --probe
~~~

You can also merge
[templates/openclaw-mcp.json](../templates/openclaw-mcp.json) into the
OpenClaw configuration, then run the login and doctor commands. Refer to
[OpenClaw's maintained MCP CLI documentation](https://github.com/openclaw/openclaw/blob/main/docs/cli/mcp.md)
for the version you installed.

## Any Streamable HTTP client

The server is dual-era Streamable HTTP, not stdio:

- endpoint: <code>POST https://YOUR-HOST.example/mcp</code>;
- native protocol: <code>2026-07-28</code>, with optional
  <code>server/discover</code>, the required per-request <code>_meta</code>
  envelope, <code>MCP-Protocol-Version</code> and <code>Mcp-Method</code> on each
  request, and <code>Mcp-Name</code> on tool calls, prompt gets, and resource
  reads;
- fallback protocol: revisions through <code>2025-11-25</code>, using the
  initialization exchange but no protocol session or
  <code>Mcp-Session-Id</code>;
- OAuth: discover the authorization server from the protected-resource
  metadata, prefer a Client ID Metadata Document when the client supports it,
  otherwise use DCR, perform PKCE, and send the issued bearer token;
- callback: loopback works locally; otherwise the exact HTTPS callback hostname
  must be configured in <code>ALLOWED_REDIRECT_HOSTS</code>;
- static alternative: send
  <code>Authorization: Bearer &lt;MCP_BEARER_TOKEN&gt;</code>;
- authorization scope: request <code>mcp:read</code> as advertised by the
  protected-resource metadata/challenge; and
- response types: accept <code>application/json</code> and
  <code>text/event-stream</code> on POST.

GET and DELETE session operations are not supported. A legacy client must
continue without a session header after initialization. The deprecated
HTTP+SSE transport is not supported.

The npm executable starts this HTTP server; it does not speak MCP over stdin.
Do not configure <code>whoop-personal-mcp</code> as a stdio command.

For a protocol-level static-token check:

~~~bash
export MCP_BEARER_TOKEN=replace-with-the-server-token
export BASE_URL=http://localhost:3000
npm run smoke:http
~~~

The script checks native <code>2026-07-28</code> discovery/tool listing, the
legacy stateless fallback, and missing-token rejection. Set
<code>SMOKE_CALL_WHOOP=1</code> only after linking WHOOP if you also want a live
tool call.

## Client safety checklist

- Use the owner's own WHOOP Developer app/credentials and review the current
  [WHOOP API Terms](https://developer.whoop.com/api-terms-of-use/).
- Connect only a deployment you own and a client/provider you trust.
- Explicitly opt in before a tool result is disclosed to the client/AI provider.
- Confirm the destination hostname on every consent screen.
- Keep static tokens out of tracked configuration and revoke/rotate them if
  exposed.
- Treat tool output as sensitive wellness data.
- Check dates, availability flags, and <code>null</code> values before acting.
- Read [PRIVACY.md](../PRIVACY.md): the chosen AI provider may retain tool
  output even though the repository maintainers receive nothing.
