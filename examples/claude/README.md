# Claude connector example

This example connects the provider-neutral server to Claude without adding a
second coaching prompt or collecting extra personal context in Project files.
The server already exposes the canonical `summarize_wellness_context` MCP
prompt and `whoop://server/usage-policy` resource.

A cloud connector needs a public HTTPS deployment. Follow
[`docs/deployment.md`](../../docs/deployment.md), set the exact Claude callback
hosts documented in [`docs/clients.md`](../../docs/clients.md#claude), and then:

1. Open **Customize → Connectors** in Claude.
2. Add the deployment URL ending in `/mcp`.
3. Leave advanced client credentials empty.
4. Review the concrete destination on the server's consent page, enter
   `ACCESS_PASSWORD`, and approve only the intended client.
5. Complete WHOOP OAuth if the owner account is not linked.

Try:

> List the WHOOP tools you can use. Call today's overview and report the source
> dates, coverage, and any stale or missing values. Use the server's wellness
> usage policy. Do not infer a diagnosis, prescribe a workout, or provide event
> clearance.

Expected behavior:

- six core tools are discoverable;
- `whoop_get_event_context` appears only when the owner configured an event;
- `null` remains unavailable rather than becoming zero; and
- the answer separates dated observations from possible explanations.

Do not upload injury history, medication lists, clinician notes, or other
sensitive context merely to make this connector work. Any optional context sent
to Claude is handled under the data controls selected for that Anthropic
account, not by this repository.
