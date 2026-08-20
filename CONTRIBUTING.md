# Contributing

Thanks for helping improve WHOOP Personal MCP. The project is intentionally
single-user, read-only with respect to WHOOP, and provider-neutral. Changes
should preserve those boundaries unless a proposal explicitly explains and
tests a new security model.

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
Repository roles and merge policy are defined in
[GOVERNANCE.md](GOVERNANCE.md), with current stewards listed in
[MAINTAINERS.md](MAINTAINERS.md).

## Set up a development checkout

Use Node.js 22 or 24 and pnpm 10:

~~~bash
git clone https://github.com/josealvaradoa/whoop-personal-mcp.git
cd whoop-personal-mcp
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
cp whoop-mcp.config.example.json whoop-mcp.config.json
~~~

Corepack is no longer bundled with Node.js 25 and later. On those versions,
install pnpm using its official installation instructions instead of assuming
<code>corepack enable</code> exists.

Tests do not need live WHOOP credentials. Run the full local gate before opening
a pull request:

~~~bash
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run smoke:package
~~~

## Pull request expectations

- Work from a non-default branch and open a pull request; direct pushes to
  `main` are blocked, including for maintainers.
- Use a Conventional Commit title such as `feat(mcp): add a resource` or
  `fix(auth): bind the redirect`. The title becomes the squash-merge commit.
- Add or update tests for behavior changes.
- Do not include real WHOOP data, OAuth credentials, database files, access
  passwords, bearer tokens, or screenshots containing personal metrics.
- Keep tool results explicit about missing and stale data. A missing value must
  not become a fabricated zero.
- Update README and <code>docs/</code> when a public tool, route, environment
  variable, deployment step, retention behavior, or security boundary changes.
- Treat changes to authentication, redirect handling, token storage, logging,
  caching, and model-facing tool descriptions as security/privacy changes.
- Keep provider-specific examples in client documentation; do not make one AI
  vendor part of the core server contract.
- Resolve review conversations and keep the branch up to date until the
  protected `quality-gate` succeeds.

For a security vulnerability, do not open a public pull request or issue first.
Follow [SECURITY.md](SECURITY.md).

By contributing, you agree that your contribution is licensed under the
repository's [MIT License](LICENSE).
