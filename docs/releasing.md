# Release checklist

This repository contains release-ready metadata, but it does not claim that
<code>whoop-personal-mcp</code> is published on npm, that a container image or
GitHub release exists, or that
<code>io.github.josealvaradoa/whoop-personal-mcp</code> is
registered in the MCP Registry. Until a maintainer completes and records those
steps, install from a reviewed source checkout.

## 1. Prepare the version

Choose a semantic version and update every public version together:

- <code>package.json</code>;
- <code>server.json</code> package and server versions; and
- the MCP server version in <code>src/mcp/setup.ts</code>.

Move release notes from **Unreleased** into a dated section in
[CHANGELOG.md](../CHANGELOG.md). Re-read all security, privacy, configuration,
tool, and deployment changes. Confirm the npm package name and Registry server
name are still controlled by the intended publisher.

## 2. Run the local quality gate

From a clean checkout with the lockfile-resolved dependencies:

~~~bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run smoke:package
bash -n test-curls.sh
git diff --check
~~~

<code>smoke:package</code> builds TypeScript, checks local documentation links,
smokes CLI help/version/private init/no-overwrite behavior, verifies required
source/package paths, and checks the actual
<code>npm pack --dry-run --json</code> manifest. It
must show <code>dist/</code>, the executable wrapper, documentation, client
templates, legal files, and Registry metadata.

Also inspect the human-readable package manifest:

~~~bash
npm pack --dry-run
node bin/whoop-personal-mcp.js --help
node bin/whoop-personal-mcp.js --version
~~~

Do not run a live server from a release candidate with real owner secrets in CI.

## 3. Verify the container and protocol

Build the release image without injecting secrets:

~~~bash
docker build --tag whoop-personal-mcp:release-candidate .
~~~

Run it locally with disposable test credentials/configuration, then verify:

~~~bash
curl --fail http://localhost:3000/health
export BASE_URL=http://localhost:3000
export MCP_BEARER_TOKEN=replace-with-the-disposable-server-token
npm run smoke:http
~~~

The HTTP smoke checks native <code>2026-07-28</code> discovery/tool listing, the
stateless 2025-era fallback, and missing-authentication rejection. The automated
test suite separately checks required header/envelope validation,
<code>Mcp-Name</code>, and GET/DELETE method rejection. The smoke's optional live
WHOOP call should be reserved for a maintainer-owned non-sensitive test account.

## 4. Validate Registry metadata

The current <code>server.json</code> follows the MCP Registry schema and points
at the npm package. Install the official publisher separately, then validate:

~~~bash
mcp-publisher validate server.json
~~~

The date in the Registry schema URL versions the <code>server.json</code> file
format; it is not the server's supported MCP wire revision. Keep the latest
published Registry schema required by the official Registry documentation, and
verify MCP <code>2026-07-28</code> separately through the protocol smoke tests.

The package's <code>mcpName</code> and README
<code>mcp-name</code> marker must exactly equal the Registry name. Validate again
after any schema or package change. Do not publish Registry metadata before the
referenced npm version exists and can be installed.

## 5. Publish in dependency order

Only an authorized maintainer should perform state-changing release steps:

1. publish the reviewed npm tarball with provenance/2FA controls appropriate to
   the maintainer account;
2. install that exact version in a clean environment and verify the executable's
   help/version output and a disposable server start;
3. create the signed/annotated source tag and GitHub release with checksums or
   image references, if used;
4. publish an OCI image from the tagged source, if the project operates a
   registry; and
5. publish <code>server.json</code> through the MCP Registry publisher.

Record the resulting URLs and digests in the release notes. Never describe a
package, image, Registry entry, security review, or compatibility result as
published/verified until the artifact can be independently fetched and tested.

## 6. Post-release checks

- Install from the public npm registry in a clean environment.
- Confirm documentation links resolve from both GitHub and the npm tarball.
- Deploy the tagged container with a fresh volume and verify account link,
  OAuth, tool listing, disconnect, and relink.
- Exercise one native <code>2026-07-28</code> client and one 2025-era fallback
  client; record concrete client versions rather than claiming every vendor
  release is compatible.
- Confirm one-replica deployment guidance and protocol migration notes remain
  accurate.
- Watch private security reports and public issues for release regressions.

There is currently no automated publish workflow. That is intentional until
publisher identities, secret handling, provenance, rollback, and protected
release environments are configured and reviewed.
