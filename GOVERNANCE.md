# Project governance

WHOOP Personal MCP is an independent, community-maintained open-source project.
It is intentionally a single-user, self-hosted, read-only bridge to the public
WHOOP Developer API. Governance should preserve that narrow trust boundary and
make changes reviewable without implying a support, compliance, or medical
service obligation.

## Roles

- **Users** run their own instance and are responsible for their deployment,
  credentials, provider choices, consent, backups, and deletion.
- **Contributors** propose changes through issues and pull requests under the
  MIT License and follow the Code of Conduct and security process.
- **Maintainers** triage contributions, protect releases and repository
  settings, review security/privacy impact, and decide what enters the project.

The current maintainer is [`@josealvaradoa`](https://github.com/josealvaradoa).
Maintainer access is granted based on sustained, constructive contributions,
sound security judgment, and agreement with the project's scope. Additions or
removals are recorded in this file through a pull request.

## How changes are accepted

All changes, including maintainer changes, use a non-default branch and a pull
request. The protected default branch requires the repository's aggregate
`quality-gate` check, an up-to-date branch, linear history, and resolution of
review conversations. Direct pushes, force pushes, and branch deletion are
blocked for administrators as well as contributors.

The intended default-branch policy is versioned in
[`.github/rulesets/main.json`](.github/rulesets/main.json). Repository settings
must match that file; a ruleset existing in GitHub is not sufficient unless it
actively targets `~DEFAULT_BRANCH` and has no bypass actors.

Because the project currently has one maintainer, branch policy does not require
an approving review that the author cannot provide to themselves. `CODEOWNERS`
still requests the maintainer automatically. When a second active maintainer is
appointed, the project should require at least one approval and code-owner
review for security-sensitive paths.

Pull requests should be focused, explain user-visible and security/privacy
effects, update tests and documentation together, and use a conventional title
such as `feat(mcp): add a resource` or `fix(auth): bind the redirect`. Squash
merge is the normal integration method so `main` remains linear.

## Decision making

Routine decisions are made in the pull request after considering correctness,
security, privacy, standards compatibility, maintenance cost, and the stated
single-user scope. Material changes should include the alternatives and
trade-offs in the PR description or an architecture decision record.

Maintainers may reject or defer a change that expands the project into a hosted
multi-user service, writes to WHOOP, persists wellness responses, makes medical
or clearance claims, weakens authorization, or adds a vendor dependency to the
core protocol. A separate fork or project may be more appropriate for those
goals.

Security vulnerabilities follow [`SECURITY.md`](SECURITY.md), not public issue
discussion. A maintainer may prepare a private fix and coordinated release, but
the resulting code and advisory should become public once disclosure is safe.

## Releases

Only maintainers publish npm packages, container images, GitHub releases, or MCP
Registry metadata. A release must come from a protected tag/commit, pass the
documented release gate, keep package/server versions aligned, and record what
was independently published. See [`docs/releasing.md`](docs/releasing.md).

## Conduct and conflicts

Participation is governed by [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). A
maintainer with a personal or financial conflict should disclose it and seek an
independent review when another maintainer is available. Security reports and
personal wellness data must never be used to retaliate against or identify a
reporter.
