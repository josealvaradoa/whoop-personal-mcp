import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { daysAgo, today, getRecoveryCollection, getCycles } from "../../whoop/client.js";
import { computeHrvTrend } from "../../compute/hrv.js";
import { cycleDateMap, toDailyRecovery } from "../../compute/recovery.js";
import { calendarDaysSince } from "../../compute/stats.js";
import { config } from "../../config.js";
import { defineTool, READ_ONLY_ANNOTATIONS, CYCLE_DATING_BUFFER_DAYS } from "./helpers.js";

export function registerHrvTool(server: McpServer): void {
  defineTool(
    server,
    "whoop_get_hrv_trend",
    {
      title: "HRV Trend",
      description:
        "Get personal WHOOP HRV context: 30-day and recent averages, coefficient of variation, and trend. HRV is nonspecific and is not a diagnosis or standalone training-readiness decision. CV requires at least 5 nights in the recent 7-day window; trend/baseline comparison additionally requires at least 14 nights in the 30-day window. Counts and freshness fields expose missing or stale input; unavailable estimates are null, never zero.",
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
          days_with_data_7d: z.number(),
          days_with_data_30d: z.number(),
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

      const cycleDates = cycleDateMap(cycles, config.athlete.timezone);
      const daily = toDailyRecovery(recoveries, cycleDates);
      const computed = computeHrvTrend(daily);

      return {
        raw: {
          daily_hrv: daily.map((d) => ({ date: d.date, hrv_rmssd: d.hrv_rmssd })),
        },
        computed: {
          ...computed,
          days_since_last_data: calendarDaysSince(
            computed.as_of_date,
            config.athlete.timezone,
          ),
        },
      };
    },
  );
}
