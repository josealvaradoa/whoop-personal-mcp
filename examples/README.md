# Client examples

WHOOP Personal MCP is provider-neutral. The server contract, tools, OAuth
flows, and privacy boundaries do not depend on any model vendor. These examples
show optional client-side setup and prompting patterns only:

- [Grok Build](grok/README.md)
- [Codex](codex/README.md)
- [Claude Projects](claude/README.md)

OpenClaw and generic Streamable HTTP configuration templates remain in
[`templates/`](../templates/), and the maintained command reference for every
client is [`docs/clients.md`](../docs/clients.md).

Never add a real `.env`, database, token, access password, OAuth code, or
unredacted wellness output to an example. Treat any model provider as a separate
data recipient: connect only an account and client you trust, review its data
controls, and disconnect the server when access is no longer needed.

The example prompts intentionally ask for dated observations, missing-data
handling, and abstention. They are not medical instructions, training plans, or
evidence that a particular client has been live-tested. Dated client
compatibility evidence belongs in the release notes and compatibility matrix.
