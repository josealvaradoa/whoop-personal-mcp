import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { daysAgo, today, getCycles } from "../../whoop/client.js";
import { computeTrainingLoad, completedStrainByDay } from "../../compute/training-load.js";
import { defineTool, READ_ONLY_ANNOTATIONS, daysSinceUTC } from "./helpers.js";

export function registerTrainingLoadTool(server: McpServer): void {
  defineTool(
    server,
    "whoop_get_training_load",
    {
      title: "Training Load Analysis",
      description:
        "Get training load analysis: 7-day acute load, 28-day chronic load, acute-to-chronic workload ratio (ACWR), training monotony, and trend direction. Critical for injury prevention and periodization decisions. In-progress (unfinished) days are excluded; days_with_data_7d/28d report completeness. ACWR needs an adequate chronic base: acwr/acwr_zone are null when fewer than 4 of the last 7 days OR fewer than 14 of the last 28 days have data (a returning athlete without a real chronic baseline gets null, not a fake 'optimal'). monotony is null when the last 7 days are too sparse to be meaningful. as_of_date is the most recent day with completed data; if days_since_last_data is more than a day or two the figures are stale. A null field means no data, never zero.",
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
          acute_load_7d: z.number().nullable(),
          chronic_load_28d: z.number().nullable(),
          acwr: z.number().nullable(),
          acwr_zone: z.enum(["undertrained", "optimal", "caution", "danger"]).nullable(),
          monotony: z.number().nullable(),
          training_strain_7d: z.number().nullable(),
          trend_direction: z.enum(["building", "maintaining", "tapering", "deloading"]).nullable(),
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
      const dailyStrain = completedStrainByDay(cycles);

      const computed = computeTrainingLoad(cycles);

      return {
        raw: { daily_strain: dailyStrain },
        computed: {
          ...computed,
          days_since_last_data: daysSinceUTC(computed.as_of_date),
        },
      };
    },
  );
}
