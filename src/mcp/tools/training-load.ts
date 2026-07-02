import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { daysAgo, today, getCycles } from "../../whoop/client.js";
import { computeTrainingLoad } from "../../compute/training-load.js";
import { defineTool, READ_ONLY_ANNOTATIONS } from "./helpers.js";

export function registerTrainingLoadTool(server: McpServer): void {
  defineTool(
    server,
    "whoop_get_training_load",
    {
      title: "Training Load Analysis",
      description:
        "Get training load analysis: 7-day acute load, 28-day chronic load, acute-to-chronic workload ratio (ACWR), training monotony, and trend direction. Critical for injury prevention and periodization decisions. In-progress (unfinished) days are excluded; days_with_data_7d/28d report completeness, and acwr/acwr_zone are null when fewer than 4 of the last 7 days have data. A null field means no data, never zero.",
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
        }),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      errorLabel: "fetching training load",
    },
    async ({ days }) => {
      const cycles = await getCycles(daysAgo(days), today());

      const dailyStrain = cycles.map((c) => ({
        date: c.start.split("T")[0],
        strain: c.score?.strain ?? null,
      }));

      const computed = computeTrainingLoad(cycles);

      return {
        raw: { daily_strain: dailyStrain },
        computed,
      };
    },
  );
}
