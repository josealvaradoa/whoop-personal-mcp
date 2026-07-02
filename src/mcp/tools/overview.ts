import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { daysAgo, today, getCycles, getRecoveryCollection, getSleepCollection } from "../../whoop/client.js";
import { config } from "../../config.js";
import {
  getReadiness,
  getRecommendation,
  computeBaselineComparison,
  isScoredRecovery,
  type ScoredRecovery,
} from "../../compute/recovery.js";
import { mapSleepToDay, isNightSleep } from "../../compute/sleep.js";
import { kjToKcal, roundTo } from "../../compute/stats.js";
import { defineTool, READ_ONLY_ANNOTATIONS } from "./helpers.js";

export function registerOverviewTool(server: McpServer): void {
  defineTool(
    server,
    "whoop_get_today_overview",
    {
      title: "Today's Whoop Overview",
      description:
        "Get today's Whoop overview: recovery score, HRV, resting heart rate, SpO2, skin temperature, sleep score, sleep duration, strain, and calories. Includes computed readiness assessment (green/yellow/red) and comparison to 30-day baselines. Every metric is null when WHOOP has no scored data for it — null NEVER means zero. Each section reports its own date (cycle_date, recovery_date, sleep_date) so you can detect a stale sync; day_in_progress=true means the strain figure is only today's accumulation so far, not a completed day.",
      inputSchema: {},
      outputSchema: {
        raw: z.object({
          cycle_date: z.string().nullable(),
          recovery_date: z.string().nullable(),
          sleep_date: z.string().nullable(),
          day_in_progress: z.boolean(),
          recovery_score: z.number().nullable(),
          hrv_rmssd: z.number().nullable(),
          resting_heart_rate: z.number().nullable(),
          spo2_pct: z.number().nullable(),
          skin_temp_celsius: z.number().nullable(),
          sleep_performance_pct: z.number().nullable(),
          sleep_duration_hrs: z.number().nullable(),
          sleep_efficiency_pct: z.number().nullable(),
          day_strain: z.number().nullable(),
          day_calories: z.number().nullable(),
        }),
        computed: z.object({
          recovery_available: z.boolean(),
          sleep_available: z.boolean(),
          strain_available: z.boolean(),
          readiness: z.enum(["green", "yellow", "red"]).nullable(),
          hrv_vs_baseline_pct: z.number().nullable(),
          rhr_vs_baseline_pct: z.number().nullable(),
          last_night_vs_target_hrs: z.number().nullable(),
          recommendation: z.enum(["full_training", "reduced_intensity", "active_recovery_only"]).nullable(),
        }),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      errorLabel: "fetching today's overview",
    },
    async () => {
      const start = daysAgo(1);
      const end = today();
      const start30d = daysAgo(30);

      const [cycles, recoveries, sleeps, recoveries30d] = await Promise.all([
        getCycles(start, end),
        getRecoveryCollection(start, end),
        getSleepCollection(start, end),
        getRecoveryCollection(start30d, end),
      ]);

      const cycleDates = new Map(cycles.map((c) => [c.id, c.start.split("T")[0]]));

      // Most recent cycle — may be in-progress (end === null).
      const latestCycle = [...cycles].sort((a, b) => b.start.localeCompare(a.start))[0] ?? null;
      const cycleDate = latestCycle ? latestCycle.start.split("T")[0] : null;
      const dayInProgress = latestCycle ? latestCycle.end === null : false;
      const strain = latestCycle?.score ? latestCycle.score.strain : null;
      const calories = latestCycle?.score ? kjToKcal(latestCycle.score.kilojoule) : null;

      // Most recent scored recovery, dated via its cycle.
      const datedRecoveries = recoveries
        .filter(isScoredRecovery)
        .map((rec) => ({ rec, date: cycleDates.get(rec.cycle_id) ?? null }))
        .filter((x): x is { rec: ScoredRecovery; date: string } => x.date != null)
        .sort((a, b) => b.date.localeCompare(a.date));
      const latestRecovery = datedRecoveries[0] ?? null;

      const recoveryScore = latestRecovery ? latestRecovery.rec.score.recovery_score : null;
      const hrvRmssd = latestRecovery ? latestRecovery.rec.score.hrv_rmssd_milli : null;
      const rhr = latestRecovery ? latestRecovery.rec.score.resting_heart_rate : null;
      const spo2 = latestRecovery ? latestRecovery.rec.score.spo2_percentage : null;
      const skinTemp = latestRecovery ? latestRecovery.rec.score.skin_temp_celsius : null;

      // Most recent night of sleep (naps excluded).
      const latestNight =
        sleeps.filter(isNightSleep).sort((a, b) => b.start.localeCompare(a.start))[0] ?? null;
      const sleepDay = latestNight ? mapSleepToDay(latestNight) : null;
      const sleepDate = latestNight ? latestNight.start.split("T")[0] : null;
      const sleepPerfPct = latestNight ? latestNight.score.sleep_performance_percentage : null;
      const sleepEffPct = latestNight ? latestNight.score.sleep_efficiency_percentage : null;

      const readiness = recoveryScore != null ? getReadiness(recoveryScore) : null;
      const recommendation = readiness != null ? getRecommendation(readiness) : null;

      const scored30d = recoveries30d.filter(isScoredRecovery);
      const hrvValues30d = scored30d.map((r) => r.score.hrv_rmssd_milli);
      const rhrValues30d = scored30d.map((r) => r.score.resting_heart_rate);

      const hrvVsBaseline = computeBaselineComparison(hrvRmssd, hrvValues30d);
      const rhrVsBaseline = computeBaselineComparison(rhr, rhrValues30d);
      const lastNightVsTarget = sleepDay
        ? roundTo(sleepDay.duration_hrs - config.athlete.sleep_target_hrs, 1)
        : null;

      return {
        raw: {
          cycle_date: cycleDate,
          recovery_date: latestRecovery ? latestRecovery.date : null,
          sleep_date: sleepDate,
          day_in_progress: dayInProgress,
          recovery_score: recoveryScore,
          hrv_rmssd: hrvRmssd,
          resting_heart_rate: rhr,
          spo2_pct: spo2,
          skin_temp_celsius: skinTemp,
          sleep_performance_pct: sleepPerfPct,
          sleep_duration_hrs: sleepDay ? sleepDay.duration_hrs : null,
          sleep_efficiency_pct: sleepEffPct,
          day_strain: strain,
          day_calories: calories,
        },
        computed: {
          recovery_available: latestRecovery != null,
          sleep_available: latestNight != null,
          strain_available: latestCycle?.score != null,
          readiness,
          hrv_vs_baseline_pct: hrvVsBaseline,
          rhr_vs_baseline_pct: rhrVsBaseline,
          last_night_vs_target_hrs: lastNightVsTarget,
          recommendation,
        },
      };
    },
  );
}
