import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { daysAgo, today, getRecoveryCollection, getCycles } from "../../whoop/client.js";
import { computeRecoveryTrend, toDailyRecovery } from "../../compute/recovery.js";
import { defineTool, READ_ONLY_ANNOTATIONS } from "./helpers.js";

export function registerRecoveryTool(server: McpServer): void {
  defineTool(
    server,
    "whoop_get_recovery_trend",
    {
      title: "Recovery Score Trend",
      description:
        "Get recovery score trend over a time window. Includes 7-day and 30-day rolling averages, trend direction (improving/stable/declining), and consecutive green/yellow/red day counts. Only WHOOP-scored days are included; averages and trend are null when there is no data for the window (null never means zero).",
      inputSchema: {
        days: z.number().int().min(7).max(365).optional().default(30).describe("Number of days to look back. Minimum 7, maximum 365, default 30."),
      },
      outputSchema: {
        raw: z.object({
          daily_recovery: z.array(
            z.object({
              date: z.string(),
              score: z.number(),
              hrv_rmssd: z.number(),
              resting_heart_rate: z.number(),
            }),
          ),
        }),
        computed: z.object({
          avg_7d: z.number().nullable(),
          avg_30d: z.number().nullable(),
          trend: z.enum(["improving", "declining", "stable"]).nullable(),
          consecutive_red_days: z.number(),
          consecutive_yellow_days: z.number(),
          consecutive_green_days: z.number(),
        }),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      errorLabel: "fetching recovery trend",
    },
    async ({ days }) => {
      const start = daysAgo(days);
      const end = today();
      const [recoveries, cycles] = await Promise.all([
        getRecoveryCollection(start, end),
        getCycles(start, end),
      ]);

      const cycleDates = new Map(cycles.map((c) => [c.id, c.start.split("T")[0]]));
      const daily = toDailyRecovery(recoveries, cycleDates);
      const computed = computeRecoveryTrend(daily);

      return {
        raw: {
          daily_recovery: daily.map((d) => ({
            date: d.date,
            score: d.recovery_score,
            hrv_rmssd: d.hrv_rmssd,
            resting_heart_rate: d.resting_heart_rate,
          })),
        },
        computed,
      };
    },
  );
}
