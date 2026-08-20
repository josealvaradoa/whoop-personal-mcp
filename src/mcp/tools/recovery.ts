import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { daysAgo, today, getRecoveryCollection, getCycles } from "../../whoop/client.js";
import {
  computeRecoveryTrend,
  cycleDateMap,
  toDailyRecovery,
} from "../../compute/recovery.js";
import { calendarDaysSince } from "../../compute/stats.js";
import { config } from "../../config.js";
import { defineTool, READ_ONLY_ANNOTATIONS, CYCLE_DATING_BUFFER_DAYS } from "./helpers.js";

export function registerRecoveryTool(server: McpServer): void {
  defineTool(
    server,
    "whoop_get_recovery_trend",
    {
      title: "Recovery Score Trend",
      description:
        "Get WHOOP Recovery-score context over recent windows. WHOOP product bands are red 0-33, yellow 34-66, and green 67-100; band streaks are descriptive and are not exercise prescriptions. Trend requires at least 4 scored days in the recent 7-day window and 14 in the 30-day window. Streaks only span adjacent calendar days. Use data counts and freshness fields to identify missing or stale input. This is wellness context, not medical advice or clearance.",
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
          days_with_data_7d: z.number(),
          days_with_data_30d: z.number(),
          as_of_date: z.string().nullable(),
          days_since_last_data: z.number().nullable(),
        }),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      errorLabel: "fetching recovery trend",
    },
    async ({ days }) => {
      const start = daysAgo(days);
      const end = today();
      // Fetch cycles from a few days earlier than the recovery window so a recovery
      // whose cycle sits just outside the window still finds its date (see fix 10).
      const [recoveries, cycles] = await Promise.all([
        getRecoveryCollection(start, end),
        getCycles(daysAgo(days + CYCLE_DATING_BUFFER_DAYS), end),
      ]);

      const cycleDates = cycleDateMap(cycles, config.athlete.timezone);
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
