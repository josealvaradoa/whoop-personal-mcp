import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { daysAgo, today, getCycles, getRecoveryCollection, getSleepCollection, getWorkoutCollection } from "../../whoop/client.js";
import { config } from "../../config.js";
import { computeRecoveryTrend, toDailyRecovery } from "../../compute/recovery.js";
import { computeHrvTrend } from "../../compute/hrv.js";
import { mapSleepToDay, computeSleepTrend, isNightSleep } from "../../compute/sleep.js";
import { computeTrainingLoad } from "../../compute/training-load.js";
import {
  getDaysToRace,
  getCurrentPhase,
  computeFitnessTrend,
  computeFatigueStatus,
  computeKeyConcerns,
  buildWeeklySummary,
  weeklyWorkoutVolumeHrs,
} from "../../compute/race-readiness.js";
import { defineTool, READ_ONLY_ANNOTATIONS } from "./helpers.js";

export function registerRaceReadinessTool(server: McpServer): void {
  defineTool(
    server,
    "whoop_get_race_readiness",
    {
      title: "Race Readiness Assessment",
      description:
        "Get a comprehensive race readiness assessment: days to race, current training phase, fitness trend, fatigue status, key concerns, and a weekly summary. Uses the configured race date and periodization phases. fitness_trend and fatigue_status are null when there is not enough recent scored data to assess them (null never means zero).",
      inputSchema: {},
      outputSchema: {
        computed: z.object({
          days_to_race: z.number(),
          race_name: z.string(),
          race_date: z.string(),
          current_phase: z.string(),
          fitness_trend: z.enum(["on_track", "undertrained", "overreaching", "injury_risk"]).nullable(),
          fatigue_status: z.enum(["fresh", "manageable", "accumulating", "critical"]).nullable(),
          key_concerns: z.array(z.string()),
          weekly_summary: z.string(),
        }),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      errorLabel: "fetching race readiness",
    },
    async () => {
      const start42d = daysAgo(42);
      const start30d = daysAgo(30);
      const start14d = daysAgo(14);
      const end = today();

      const [cycles, recoveries, sleeps, workouts] = await Promise.all([
        getCycles(start42d, end),
        getRecoveryCollection(start30d, end),
        getSleepCollection(start14d, end),
        getWorkoutCollection(daysAgo(7), end),
      ]);

      const cycleDates = new Map(cycles.map((c) => [c.id, c.start.split("T")[0]]));
      const dailyRecovery = toDailyRecovery(recoveries, cycleDates);

      // Training load
      const trainingLoad = computeTrainingLoad(cycles);

      // Recovery + HRV
      const recoveryResult = computeRecoveryTrend(dailyRecovery);
      const hrvResult = computeHrvTrend(dailyRecovery);

      // Sleep
      const sleepDays = sleeps.filter(isNightSleep).map(mapSleepToDay);
      const sleepResult = computeSleepTrend(sleepDays);

      // Weekly volume — SCORED workouts only (see weeklyWorkoutVolumeHrs).
      const weeklyVolumeHrs = weeklyWorkoutVolumeHrs(workouts);

      const currentPhase = getCurrentPhase();
      const fitnessTrend = computeFitnessTrend(trainingLoad.acwr_zone, recoveryResult.trend);
      const fatigueStatus = computeFatigueStatus(
        recoveryResult.avg_7d,
        recoveryResult.avg_30d,
        recoveryResult.consecutive_red_days
      );
      const concerns = computeKeyConcerns({
        sleepDebtHrs: sleepResult.sleep_debt_cumulative_hrs,
        monotony: trainingLoad.monotony,
        acwr: trainingLoad.acwr,
        recoveryTrend: recoveryResult.trend,
        hrvTrend: hrvResult.trend,
        weeklyVolumeHrs,
        currentPhase,
      });
      const weeklySummary = buildWeeklySummary({
        recoveryTrend: recoveryResult.trend,
        acwrZone: trainingLoad.acwr_zone,
        acwr: trainingLoad.acwr,
        concerns,
        fatigueStatus,
      });

      return {
        computed: {
          days_to_race: getDaysToRace(),
          race_name: config.race.name,
          race_date: config.race.date,
          current_phase: currentPhase,
          fitness_trend: fitnessTrend,
          fatigue_status: fatigueStatus,
          key_concerns: concerns,
          weekly_summary: weeklySummary,
        },
      };
    },
  );
}
