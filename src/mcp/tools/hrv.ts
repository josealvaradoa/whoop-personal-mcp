import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { daysAgo, today, getRecoveryCollection, getCycles } from "../../whoop/client.js";
import { computeHrvTrend } from "../../compute/hrv.js";
import { toDailyRecovery } from "../../compute/recovery.js";
import { defineTool, READ_ONLY_ANNOTATIONS, daysSinceUTC, CYCLE_DATING_BUFFER_DAYS } from "./helpers.js";

export function registerHrvTool(server: McpServer): void {
  defineTool(
    server,
    "whoop_get_hrv_trend",
    {
      title: "HRV Trend",
      description:
        "Get heart rate variability (HRV) trend: baseline, current 7-day average, coefficient of variation, and trend direction. Key indicator of autonomic nervous system recovery and training readiness. Only WHOOP-scored days are included; every computed field is null when there is no data for the window (null never means zero). as_of_date is the most recent day with data; if days_since_last_data is more than a day or two the figures are stale.",
      inputSchema: {
        days: z.number().int().min(7).max(365).optional().default(30).describe("Number of days to look back. Minimum 7, maximum 365, default 30."),
      },
      outputSchema: {
        raw: z.object({
          daily_hrv: z.array(
            z.object({
              date: z.string(),
              hrv_rmssd: z.number(),
            }),
          ),
        }),
        computed: z.object({
          baseline_30d: z.number().nullable(),
          current_7d_avg: z.number().nullable(),
          cv_pct: z.number().nullable(),
          trend: z.enum(["improving", "declining", "stable"]).nullable(),
          above_baseline: z.boolean().nullable(),
          as_of_date: z.string().nullable(),
          days_since_last_data: z.number().nullable(),
        }),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      errorLabel: "fetching HRV trend",
    },
    async ({ days }) => {
      const start = daysAgo(days);
      const end = today();
      // Widen the cycle window vs the recovery window so boundary recoveries still
      // find a cycle to date them by (see fix 10).
      const [recoveries, cycles] = await Promise.all([
        getRecoveryCollection(start, end),
        getCycles(daysAgo(days + CYCLE_DATING_BUFFER_DAYS), end),
      ]);

      const cycleDates = new Map(cycles.map((c) => [c.id, c.start.split("T")[0]]));
      const daily = toDailyRecovery(recoveries, cycleDates);
      const computed = computeHrvTrend(daily);

      return {
        raw: {
          daily_hrv: daily.map((d) => ({ date: d.date, hrv_rmssd: d.hrv_rmssd })),
        },
        computed: {
          ...computed,
          days_since_last_data: daysSinceUTC(computed.as_of_date),
        },
      };
    },
  );
}
