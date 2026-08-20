# Deploy WHOOP Personal MCP

Every deployment is for one owner and one linked WHOOP account. The same owner
may connect several trusted MCP clients; do not share one instance between
people. Run exactly one application replica. MCP <code>2026-07-28</code> removes
transport sessions, but this application's SQLite authorization store and
in-memory pending OAuth/consent state are not designed for horizontal scaling.

The owner must create their own WHOOP Developer app/credentials and review the
current [WHOOP API Terms of Use](https://developer.whoop.com/api-terms-of-use/).
Get explicit owner opt-in before disclosing tool output to an AI provider. The
application persists no WHOOP API response or tool result; do not add host-level
payload logging or response storage. When use ends, disconnect/revoke access and
delete the local volume, backups, and provider copies as applicable.

## Production requirements

Before choosing a host, make sure it can provide:

- a stable public HTTPS origin for cloud-based MCP clients;
- one persistent, private volume mounted at <code>/app/data</code>;
- secret environment variables;
- outbound HTTPS access to WHOOP and public client metadata documents;
- egress policy that blocks private, link-local, and platform/control-plane
  networks as defense in depth for CIMD metadata retrieval;
- one container replica listening on port <code>3000</code>; and
- a health probe at <code>GET /health</code>.

Set <code>PUBLIC_URL</code> to the external origin, such as
<code>https://whoop.example.com</code>, with no path or trailing slash. Set
<code>WHOOP_REDIRECT_URI</code> to the same origin plus
<code>/auth/whoop/callback</code>, and register that exact URI in the WHOOP
Developer Dashboard. Production startup rejects non-HTTPS public URLs (except
loopback) and rejects a WHOOP callback on a different origin.

Keep <code>ENCRYPTION_SECRET</code> stable. Losing it makes stored WHOOP tokens
unreadable. Keep <code>ACCESS_PASSWORD</code>
and any static bearer token in the host's secret store, not in an image or
repository.

The initializer makes the active config owner-readable on POSIX. A Linux
container runs as UID 1000, so a file created by another UID (especially root)
may not be readable through the bind mount. Before starting Compose, verify with
<code>docker compose run --rm --no-deps whoop-personal-mcp node -e
&quot;require('node:fs').accessSync('/app/whoop-mcp.config.json')&quot;</code>. If it
fails, grant UID 1000 read access with a narrowly scoped ACL or adjust ownership
and mode to <code>0640</code> for a trusted group; never make <code>.env</code>
world-readable.

## Docker Compose

Compose is the most reproducible self-hosted path. Start from a private checkout:

~~~bash
cp .env.example .env
cp whoop-mcp.config.example.json whoop-mcp.config.json
docker compose up --build -d
curl --fail http://localhost:3000/health
~~~

Edit both copied files before the first start. The Compose service forces
<code>NODE_ENV=production</code>, persists SQLite in the named volume, mounts
the active wellness/event configuration read-only, and runs the application
filesystem read-only. The volume is not deleted by an ordinary
<code>docker compose down</code>.

For internet access, terminate TLS at a reverse proxy or secure ingress, forward
to port 3000, then update <code>PUBLIC_URL</code>,
<code>WHOOP_REDIRECT_URI</code>, and the registered WHOOP callback. Restart after
an environment change:

~~~bash
docker compose up -d
~~~

Do not publish port 3000 directly to the internet without an HTTPS ingress.
Restrict the ingress to the expected hostname; the server independently checks
the request Host and browser Origin on <code>/mcp</code>. The ingress must pass
<code>Authorization</code>, <code>MCP-Protocol-Version</code>,
<code>Mcp-Method</code>, <code>Mcp-Name</code> when present, and response content
types without rewriting them. It must not require a sticky session.

Set <code>TRUST_PROXY</code> to the exact number of trusted proxy hops (commonly
<code>1</code> for one ingress), not a blanket trust value. Leave it false for
direct access. If an internal forwarding Host legitimately differs from
<code>PUBLIC_URL</code>, add only that exact value to
<code>ALLOWED_HOSTS</code>. Add each verified cloud-client OAuth callback to
<code>ALLOWED_REDIRECT_HOSTS</code>; no remote callback is trusted by default.

### Back up and update

The database and its WAL files must be copied as one stopped set. Use a new,
access-controlled destination directory:

~~~bash
docker compose stop whoop-personal-mcp
docker compose cp whoop-personal-mcp:/app/data ./whoop-personal-mcp-backup
docker compose start whoop-personal-mcp
~~~

Back up <code>ENCRYPTION_SECRET</code> separately in a secret manager; the
database backup is not sufficient without it. A hosting-volume snapshot taken
while the service is stopped is also suitable.

To update, review [CHANGELOG.md](../CHANGELOG.md), take a backup, fetch the
desired tagged source, then rebuild with <code>docker compose up --build -d</code>.
Verify <code>/health</code> and reconnect a client. Health is a liveness check,
not proof that WHOOP is linked or that current data is available.

## Any OCI container host

Build the same image for a Docker-, Podman-, Kubernetes-, or Nomad-compatible
host:

~~~bash
docker build --tag whoop-personal-mcp:local .
docker volume create whoop-personal-mcp-data
docker run --detach --name whoop-personal-mcp \
  --env-file .env \
  --env BIND_HOST=0.0.0.0 \
  --publish 127.0.0.1:3000:3000 \
  --read-only \
  --tmpfs /tmp \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --volume whoop-personal-mcp-data:/app/data \
  --volume "$PWD/whoop-mcp.config.json:/app/whoop-mcp.config.json:ro" \
  whoop-personal-mcp:local
~~~

The Compose and raw-container examples bind only to localhost. If an HTTPS
reverse proxy runs on another host or network, deliberately change the bind
address and restrict ingress to that proxy; do not expose the plain HTTP port
directly to the internet or an untrusted LAN.

The image runs as the unprivileged Node user. Ensure the persistent volume is
writable by that user, or use the platform's documented ownership mechanism.
Mount an active configuration at <code>/app/whoop-mcp.config.json</code>, set
<code>CONFIG_PATH</code> to another mounted path, or supply the non-secret
configuration as <code>WHOOP_MCP_CONFIG_JSON</code>. In production, the server
does not silently load the example configuration.

Use a deployment strategy that stops the old replica before starting the new
one against the same volume. Do not configure multiple replicas, shared network
filesystems, or independent instances against one SQLite directory.

## Railway (optional)

Railway is one possible OCI host, not a requirement or an official project
service. The repository's <code>railway.toml</code> selects the Dockerfile and
the <code>/health</code> probe. There is no maintained one-click template.

With the current Railway CLI authenticated:

~~~bash
railway init --name whoop-personal-mcp
railway add --service whoop-personal-mcp
railway volume add --mount-path /app/data --service whoop-personal-mcp
railway domain --service whoop-personal-mcp
~~~

Use the generated domain to register the exact WHOOP callback. In the Railway
dashboard, add the required values from [.env.example](../.env.example), plus:

~~~text
NODE_ENV=production
PORT=3000
BIND_HOST=0.0.0.0
DATA_DIR=/app/data
PUBLIC_URL=https://YOUR-GENERATED-DOMAIN
WHOOP_REDIRECT_URI=https://YOUR-GENERATED-DOMAIN/auth/whoop/callback
TRUST_PROXY=1
RAILWAY_RUN_UID=0
~~~

Railway documents that mounted volumes are root-owned; its
<code>RAILWAY_RUN_UID=0</code> compatibility setting lets this image write that
volume. This weakens the image's normal non-root runtime, so keep the service
private except for its HTTPS domain and prefer a platform that can assign volume
ownership when available.

Set the non-secret personal/event settings with
<code>WHOOP_MCP_CONFIG_JSON</code> or the documented environment overrides in
Railway. Production does not load the example file. Then deploy:

~~~bash
railway up --service whoop-personal-mcp
curl --fail https://YOUR-GENERATED-DOMAIN/health
~~~

Keep the service at one replica. Confirm the volume remains attached after a
redeploy and use Railway's volume backup/export facilities according to your
plan. Railway and any DNS/TLS provider may process traffic, logs, and stored
data under their own policies; see [PRIVACY.md](../PRIVACY.md).

## After any remote deployment

1. Open <code>https://YOUR-HOST/auth/whoop</code> and link the owner's account.
2. Connect a client using <code>https://YOUR-HOST/mcp</code>.
3. Complete MCP OAuth and verify the destination hostname on the consent page.
4. Ask the client to list tools and call the overview tool.
5. Check the result's dates, availability flags, and null values.

A successful tool list/call is the compatibility check. Client product names
do not prove which protocol era they selected; both native
<code>2026-07-28</code> and the stateless 2025-era fallback use the same URL.

Read [SECURITY.md](../SECURITY.md) before exposing the service and
[clients.md](clients.md) for provider-specific setup. See
[protocol-compatibility.md](protocol-compatibility.md) for the two protocol
eras.
