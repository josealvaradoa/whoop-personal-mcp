import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { daysAgo, today, getCycles } from "../../whoop/client.js";
import { computeTrainingLoad, completedStrainByDay } from "../../compute/training-load.js";
import { calendarDaysSince } from "../../compute/stats.js";
import { config } from "../../config.js";
import { defineTool, READ_ONLY_ANNOTATIONS } from "./helpers.js";

export function registerTrainingLoadTool(server: McpServer): void {
  defineTool(
    server,
    "whoop_get_training_load",
    {
      title: "Day Strain Trends and Experimental Mean Ratio",
      description:
        "Get descriptive 7-day and 28-day WHOOP Day Strain means plus an experimental ratio of those means. WHOOP Strain is nonlinear, so this is not a validated acute-to-chronic workload ratio; no threshold band is applied, and it is not validated for injury prediction, training safety, fitness assessment, periodization, or event clearance. The ratio requires all 7 and 28 calendar days; otherwise it is null. No Strain totals, monotony diagnoses, or inferred build/taper/deload prescriptions are produced.",
      inputSchema: {
        days: z.number().int().min(28).max(365).optional().default(42).describe("Number of days of strain history to use for calculation. Minimum 28, maximum 365, default 42."),
      },
      outputSchema: {
        raw: z.object({
          daily_strain: z.array(
            z.object({
              date: z.string(),
              strain: z.number().nullable(),
            }),
          ),
        }),
        computed: z.object({
          mean_day_strain_7d: z.number().nullable(),
          mean_day_strain_28d: z.number().nullable(),
          experimental_mean_day_strain_ratio_7d_28d: z.number().nullable(),
          is_experimental: z.literal(true),
          limitations: z.string(),
          day_strain_trend: z.enum(["lower", "similar", "higher"]).nullable(),
          days_with_data_7d: z.number(),
          days_with_data_28d: z.number(),
          as_of_date: z.string().nullable(),
          days_since_last_data: z.number().nullable(),
        }),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      errorLabel: "fetching training load",
    },
    async ({ days }) => {
      const cycles = await getCycles(daysAgo(days), today());

      // Build raw from the same completed + deduped buckets the aggregates use, so
      // raw and computed agree and no in-progress / unscored / duplicate-day row leaks.
      const dailyStrain = completedStrainByDay(cycles, config.athlete.timezone);

      const computed = computeTrainingLoad(cycles, config.athlete.timezone);

      return {
        raw: { daily_strain: dailyStrain },
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
