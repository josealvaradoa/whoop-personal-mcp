# Run your first local WHOOP Personal MCP server

You will create a personal WHOOP OAuth app, start the server with Docker
Compose, link your own WHOOP account, and let Grok Build discover six core
read-only tools plus an optional target-event context tool.

## What you need

- a WHOOP membership and access to the
  [WHOOP Developer Dashboard](https://developer.whoop.com/);
- Git and Node.js 22+ for the privacy-first initializer; and
- Docker Engine/Desktop with the Compose plugin.

This tutorial uses <code>http://localhost:3000</code>. A cloud-hosted client
such as Grok on the web or Claude cannot reach that address; finish locally,
then follow [the deployment guide](deployment.md).

## Step 1: Create your WHOOP app

In the WHOOP Developer Dashboard, create an app for your personal use.
[WHOOP's setup guide](https://developer.whoop.com/docs/developing/getting-started/)
requires the authorization redirect to match exactly.

Use this redirect URI:

~~~text
http://localhost:3000/auth/whoop/callback
~~~

Enable only the scopes the server requests:

~~~text
read:recovery read:cycles read:sleep read:workout offline
~~~

The <code>offline</code> scope lets WHOOP return a rotating refresh token. If
the dashboard asks for a privacy-policy URL, use the public URL for this
repository's [PRIVACY.md](../PRIVACY.md). Save the client ID and client secret.

## Step 2: Create the local configuration

~~~bash
git clone https://github.com/josealvaradoa/whoop-personal-mcp.git
cd whoop-personal-mcp
node bin/whoop-personal-mcp.js init
~~~

The initializer refuses to overwrite either target and, on POSIX, requests mode
0600 for both files. It generates independent security values, detects the local IANA
timezone, and leaves the WHOOP client fields blank. Edit <code>.env</code> and
set the WHOOP client ID and secret.
On Windows, verify file ACLs and prefer the platform's secret store.

On a Docker-only machine without Node, use the manual alternative:

~~~bash
cp .env.example .env
cp whoop-mcp.config.example.json whoop-mcp.config.json
openssl rand -base64 48
openssl rand -base64 24
~~~

Put the first output in <code>ENCRYPTION_SECRET</code> and the second in
<code>ACCESS_PASSWORD</code>. Do not reuse your WHOOP password. Leave
<code>MCP_BEARER_TOKEN</code> empty for OAuth-only access.

Review <code>whoop-mcp.config.json</code> before continuing. Confirm the IANA
timezone. The sleep target is null by default; replace it with a number only if
you intentionally choose a personal duration target. The initializer creates no
event. To enable optional event context, copy and edit the event block from the
[event template](../templates/event-config.example.json). The safe-to-copy main
example also contains no event, so forgetting this step cannot silently register
placeholder event context.

## Step 3: Start and verify the server

~~~bash
docker compose up --build -d
curl --fail http://localhost:3000/health
~~~

Expected response:

~~~json
{"status":"ok"}
~~~

If Compose reports that the config mount is a directory, stop it, remove the
accidental <code>whoop-mcp.config.json</code> directory, and repeat Step 2.
Compose requires that file to exist before the first start.

## Step 4: Link your WHOOP account

Open this URL in a browser:

~~~text
http://localhost:3000/auth/whoop
~~~

Enter <code>ACCESS_PASSWORD</code>, sign in to WHOOP, review the scopes, and
approve. The server stores the returned WHOOP tokens encrypted in the Compose
volume. It does not receive your WHOOP account password.

## Step 5: Connect Grok Build

With the current Grok CLI installed, run:

~~~bash
grok mcp add --transport http whoop-personal http://localhost:3000/mcp
grok mcp doctor whoop-personal
~~~

On first use, Grok opens the MCP OAuth flow. Enter
<code>ACCESS_PASSWORD</code> on the server's consent page. Then ask Grok:

> List the WHOOP tools you can use, then summarize today's data without
> guessing when a value is missing.

Grok should expose six core tools with names beginning <code>whoop_</code>, plus
<code>whoop_get_event_context</code> when a target event is configured.
[xAI's MCP documentation](https://docs.x.ai/build/features/mcp-servers)
describes <code>grok mcp list</code>, <code>doctor</code>, and project-scoped
configuration. It does not name a specific MCP protocol revision, so the
server accepts either native stateless <code>2026-07-28</code> or the stateless
2025-era fallback on this same URL. See
[protocol-compatibility.md](protocol-compatibility.md) for that distinction.

## What you built

You now have one local server linked to one WHOOP account, with authentication
state persisted in a Docker volume and access protected by MCP
OAuth. WHOOP API responses are not persisted. Next:

- [connect another supported client](clients.md);
- [put the server behind public HTTPS](deployment.md); or
- [review exactly what is stored and sent](../PRIVACY.md).
