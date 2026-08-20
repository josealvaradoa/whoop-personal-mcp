# Command-line interface

The <code>whoop-personal-mcp</code> executable manages a working-directory
configuration and starts the HTTP service. It does not speak MCP over stdin.

The npm package is not published yet. From a source checkout, use
<code>node bin/whoop-personal-mcp.js</code> in place of the installed command and
run <code>pnpm build</code> before local <code>doctor</code> or server start.

## Initialize without overwriting

~~~bash
whoop-personal-mcp init
~~~

In the current directory, <code>init</code> exclusively creates:

- <code>.env</code> with generated independent encryption/access secrets, blank
  WHOOP client credentials, local URLs, and conservative server defaults; and
- <code>whoop-mcp.config.json</code> with a detected IANA timezone (UTC fallback),
  a null/unconfigured sleep target, no target event, and the descriptive
  repeated-red observation count.

On POSIX systems both files are requested with mode <code>0600</code>. If either target already
exists, the command refuses to overwrite anything. It never contacts WHOOP,
links an account, creates a Developer app, or enables a static bearer token.
On Windows, verify the resulting ACLs and prefer the platform's secret store.

Afterward, add the client ID/secret from the owner's personal WHOOP Developer
app to <code>.env</code>. Review the detected timezone. Leave the sleep target
null unless the owner intentionally chooses a duration target; add an
<code>event</code> block only when the optional context is wanted.

## Validate local configuration

~~~bash
whoop-personal-mcp doctor
~~~

Local doctor loads and validates the same built configuration as the server. It
reports only non-secret state: deployment mode, public URL, owner timezone,
whether a sleep target/event/static bearer is configured, and whether
<code>.env</code> has group/other permission bits. It does not print secret
values, link status, WHOOP records, or tool output.

A newly initialized checkout will fail local doctor until the required blank
WHOOP client fields are filled. A passing doctor confirms configuration shape,
not that the callback is registered, the database is writable, WHOOP is linked,
or a live tool call succeeds.

## Probe a running deployment

~~~bash
whoop-personal-mcp doctor --url https://YOUR-HOST.example
~~~

Remote doctor uses the supplied origin and a ten-second request timeout. It
checks:

- <code>GET /health</code> returns an OK health payload;
- protected-resource OAuth metadata advertises an authorization server; and
- an unauthenticated probe of <code>/mcp</code> is rejected with HTTP 401.

Non-loopback probes require HTTPS, and URLs with embedded credentials are
rejected. The probe sends no bearer token and no WHOOP data. It is a liveness,
OAuth-discovery, and access-control check—not proof that WHOOP is linked, data is
fresh, an OAuth callback host is allowed, or an authenticated client works.

## Start and inspect the executable

~~~bash
whoop-personal-mcp
whoop-personal-mcp --help
whoop-personal-mcp --version
~~~

With no command, the executable starts the Streamable HTTP server. The same
<code>POST /mcp</code> endpoint natively serves stateless MCP
<code>2026-07-28</code> and a stateless 2025-era fallback. Use
<code>/mcp</code> as the client URL and <code>/health</code> for liveness. See
[protocol-compatibility.md](protocol-compatibility.md) for the era behavior.
