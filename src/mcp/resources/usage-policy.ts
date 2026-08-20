import type { McpServer } from "@modelcontextprotocol/server";

export const USAGE_POLICY_URI = "whoop://server/usage-policy";

export const USAGE_POLICY_TEXT = `# WHOOP MCP usage policy

## Scope

This is a read-only, single-user, self-hosted connector for personal WHOOP wellness and fitness data. It is not a medical device or a source of diagnosis, treatment, injury prediction, training prescriptions, or exercise/event clearance.

## Interpretation rules

- Report dates, coverage counts, and staleness with every interpretation. Null means unavailable, never zero. Abstain when a tool's minimum coverage is not met or its inputs are stale.
- WHOOP Recovery colors are product bands: red 0-33, yellow 34-66, and green 67-100. They are not permissions or prohibitions.
- HRV is a nonspecific personal signal and should not be treated as a diagnosis or standalone readiness decision.
- WHOOP's positive sleep-debt contribution is distinct from the signed duration balance against an explicitly configured sleep target.
- WHOOP Strain is nonlinear and must not be summed. The optional 7-day-to-28-day mean Day Strain ratio is experimental, is not a validated acute-to-chronic workload ratio, has no threshold bands, and must not be used for injury, safety, fitness, periodization, or clearance decisions.
- Event context is exposed only for an explicitly configured event. It abstains on missing or stale Recovery, HRV, or sleep inputs and never represents readiness or clearance.

Symptoms, clinician restrictions, personal circumstances, and an established training plan take priority over wearable observations. Concerning or persistent symptoms require appropriate professional evaluation; urgent symptoms require urgent care.`;

export function registerUsagePolicyResource(server: McpServer): void {
  server.registerResource(
    "usage-policy",
    USAGE_POLICY_URI,
    {
      title: "WHOOP MCP Usage Policy",
      description:
        "Static wellness-only, missing-data, experimental-ratio, and single-user interpretation policy.",
      mimeType: "text/markdown",
    },
    (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: "text/markdown",
          text: USAGE_POLICY_TEXT,
        },
      ],
    }),
  );
}
