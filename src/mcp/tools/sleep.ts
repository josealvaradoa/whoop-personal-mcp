import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { daysAgo, today, getSleepCollection } from "../../whoop/client.js";
import {
  mapSleepToDay,
  computeSleepTrend,
  isNightSleep,
  isSleepDayData,
} from "../../compute/sleep.js";
import { calendarDaysSince } from "../../compute/stats.js";
import { config } from "../../config.js";
import { defineTool, READ_ONLY_ANNOTATIONS } from "./helpers.js";

export function registerSleepTool(server: McpServer): void {
  defineTool(
    server,
    "whoop_get_sleep_trend",
    {
      title: "Sleep Trend",
      description:
        "Get scored nightly-sleep context. WHOOP Sleep Need and its positive sleep-debt contribution are kept distinct from sleep_duration_balance_7d_hrs, a signed arithmetic balance against an explicitly configured duration target (positive=above, negative=below). duration_direction neutrally reports whether the recent window is longer, shorter, or similar to the prior window; it does not label more sleep as inherently better. Native WHOOP consistency is reported; duration variability is not mislabeled as bedtime consistency. Naps/unscored records are excluded and nights are dated by wake day. This is wellness context, not treatment advice.",
      inputSchema: {
        days: z.number().int().min(3).max(365).optional().default(14).describe("Number of days to look back. Minimum 3, maximum 365, default 14."),
      },
      outputSchema: {
        raw: z.object({
          daily_sleep: z.array(
            z.object({
              date: z.string(),
              duration_hrs: z.number(),
              sleep_need_hrs: z.number().nullable(),
              whoop_sleep_debt_hrs: z.number().nullable(),
              consistency_pct: z.number().nullable(),
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
          avg_sleep_need_7d_hrs: z.number().nullable(),
          avg_efficiency_7d_pct: z.number().nullable(),
          avg_consistency_7d_pct: z.number().nullable(),
          configured_sleep_target_hrs: z.number().nullable(),
          sleep_duration_balance_7d_hrs: z.number().nullable(),
          latest_whoop_sleep_debt_hrs: z.number().nullable(),
          nights_with_data_7d: z.number(),
          duration_direction: z.enum(["longer", "shorter", "similar"]).nullable(),
          as_of_date: z.string().nullable(),
          days_since_last_data: z.number().nullable(),
        }),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      errorLabel: "fetching sleep trend",
    },
    async ({ days }) => {
      const sleeps = await getSleepCollection(daysAgo(days), today());
      const sleepDays = sleeps
        .filter(isNightSleep)
        .map((sleep) => mapSleepToDay(sleep, config.athlete.timezone))
        .filter(isSleepDayData);
      const computed = computeSleepTrend(sleepDays);

      return {
        raw: { daily_sleep: sleepDays },
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
