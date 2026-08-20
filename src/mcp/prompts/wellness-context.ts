import type { McpServer } from "@modelcontextprotocol/server";

export const WELLNESS_CONTEXT_PROMPT = `Summarize the user's available wearable wellness context.

Use only relevant registered tools. Start with data availability, measurement dates, coverage counts, and staleness. Treat null as unavailable, never zero. Clearly separate observations from possible explanations and say when sparse or stale data prevents interpretation.

Use WHOOP Recovery colors only as product bands (red 0-33, yellow 34-66, green 67-100), never as permission to exercise. Treat HRV as a nonspecific personal trend. Distinguish WHOOP's positive sleep-debt contribution from the signed balance against a user-configured sleep-duration target. If the experimental 7-day-to-28-day mean Day Strain ratio appears, state that WHOOP Strain is nonlinear, the ratio is not a validated acute-to-chronic workload ratio, and it has no safety or injury threshold.

Do not diagnose, predict injury, prescribe a workout, infer an unconfigured event or person, or provide exercise/event clearance. Note that symptoms, clinician restrictions, personal context, and an established plan take priority. End by naming the missing context that would be needed for any further discussion.`;

export function registerWellnessContextPrompt(server: McpServer): void {
  server.registerPrompt(
    "summarize_wellness_context",
    {
      title: "Summarize Wellness Context",
      description:
        "Provider-neutral prompt for a dated, coverage-aware WHOOP wellness summary without prescriptions or clearance.",
    },
    () => ({
      description:
        "Summarize wearable observations conservatively, with explicit missing-data and wellness-only boundaries.",
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text: WELLNESS_CONTEXT_PROMPT },
        },
      ],
    }),
  );
}
