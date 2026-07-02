import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { daysAgo, today, getSleepCollection } from "../../whoop/client.js";
import { mapSleepToDay, computeSleepTrend, isNightSleep } from "../../compute/sleep.js";
import { defineTool, READ_ONLY_ANNOTATIONS } from "./helpers.js";

export function registerSleepTool(server: McpServer): void {
  defineTool(
    server,
    "whoop_get_sleep_trend",
    {
      title: "Sleep Trend",
      description:
        "Get sleep trend data: duration, efficiency, consistency, and cumulative sleep debt over a time window. Naps and unscored records are excluded — only full nights of sleep are counted. Computed fields are null when there is no scored nightly-sleep data for the window (null never means zero).",
      inputSchema: {
        days: z.number().int().min(3).max(365).optional().default(14).describe("Number of days to look back. Minimum 3, maximum 365, default 14."),
      },
      outputSchema: {
        raw: z.object({
          daily_sleep: z.array(
            z.object({
              date: z.string(),
              duration_hrs: z.number(),
              efficiency_pct: z.number().nullable(),
              performance_pct: z.number().nullable(),
              respiratory_rate: z.number().nullable(),
              stages: z.object({
                awake_hrs: z.number(),
                light_hrs: z.number(),
                slow_wave_hrs: z.number(),
                rem_hrs: z.number(),
              }),
            }),
          ),
        }),
        computed: z.object({
          avg_duration_7d_hrs: z.number().nullable(),
          avg_efficiency_7d_pct: z.number().nullable(),
          sleep_debt_cumulative_hrs: z.number().nullable(),
          consistency_score: z.number().nullable(),
          trend: z.enum(["improving", "declining", "stable"]).nullable(),
        }),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      errorLabel: "fetching sleep trend",
    },
    async ({ days }) => {
      const sleeps = await getSleepCollection(daysAgo(days), today());
      const sleepDays = sleeps.filter(isNightSleep).map(mapSleepToDay);
      const computed = computeSleepTrend(sleepDays);

      return {
        raw: { daily_sleep: sleepDays },
        computed,
      };
    },
  );
}
