import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { daysAgo, today, getCycles, getRecoveryCollection, getSleepCollection } from "../../whoop/client.js";
import { config } from "../../config.js";
import {
  getRecoveryBand,
  computeBaselineComparison,
  cycleDateMap,
  isScoredRecovery,
  type ScoredRecovery,
} from "../../compute/recovery.js";
import { mapSleepToDay, isNightSleep } from "../../compute/sleep.js";
import { calendarDate, kjToKcal, roundTo } from "../../compute/stats.js";
import { defineTool, READ_ONLY_ANNOTATIONS, CYCLE_DATING_BUFFER_DAYS } from "./helpers.js";

export function registerOverviewTool(server: McpServer): void {
  defineTool(
    server,
    "whoop_get_today_overview",
    {
      title: "Today's Whoop Overview",
      description:
        "Get today's WHOOP metrics and limited wellness context. recovery_band reproduces WHOOP's product bands (red 0-33, yellow 34-66, green 67-100); it is not a training prescription, medical assessment, injury prediction, or clearance decision. Baseline comparisons require at least 14 scored observations. Every unavailable metric is null, never zero. Each section reports its own date so callers can detect stale data; day_in_progress=true means Day Strain is still accumulating.",
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
          recovery_band: z.enum(["green", "yellow", "red"]).nullable(),
          hrv_vs_baseline_pct: z.number().nullable(),
          rhr_vs_baseline_pct: z.number().nullable(),
          last_night_vs_configured_target_hrs: z.number().nullable(),
          wellness_context_only: z.literal(true),
        }),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      errorLabel: "fetching today's overview",
    },
    async () => {
      const start = daysAgo(1);
      // WHOOP filters sleep collections by the sleep start instant. Fetch far
      // enough back that an ordinary overnight record remains available late
      // the following evening, then choose by owner-local wake date below.
      const sleepStart = daysAgo(3);
      const end = today();
      const start30d = daysAgo(30);

      // Widen the cycle window a few days earlier than the recovery window so this
      // morning's recovery can still be dated by its cycle even if that cycle's start
      // falls just before the tight daysAgo(1) boundary (see fix 10). Otherwise a
      // boundary recovery is silently dropped and recovery_available wrongly reads false.
      const [cycles, recoveries, sleeps, recoveries30d] = await Promise.all([
        getCycles(daysAgo(1 + CYCLE_DATING_BUFFER_DAYS), end),
        getRecoveryCollection(start, end),
        getSleepCollection(sleepStart, end),
        getRecoveryCollection(start30d, end),
      ]);

      const cycleDates = cycleDateMap(cycles, config.athlete.timezone);

      // Most recent cycle — may be in-progress (end === null).
      const latestCycle = [...cycles].sort((a, b) => b.start.localeCompare(a.start))[0] ?? null;
      const cycleDate = latestCycle
        ? calendarDate(latestCycle.start, config.athlete.timezone)
        : null;
      const dayInProgress = latestCycle ? latestCycle.end === null : false;

      // A single non-finite numeric from WHOOP must degrade to null, never NaN: a NaN
      // in a z.number().nullable() field is STILL rejected by the SDK (nullable only
      // permits null), which would fail the whole tool. Coerce every raw numeric here.
      const fin = (n: number | null | undefined): number | null =>
        typeof n === "number" && Number.isFinite(n) ? n : null;

      const strain = fin(latestCycle?.score ? latestCycle.score.strain : null);
      const calories = fin(latestCycle?.score ? kjToKcal(latestCycle.score.kilojoule) : null);

      // Most recent scored recovery, dated via its cycle.
      const datedRecoveries = recoveries
        .filter(isScoredRecovery)
        .map((rec) => ({ rec, date: cycleDates.get(rec.cycle_id) ?? null }))
        .filter((x): x is { rec: ScoredRecovery; date: string } => x.date != null)
        .sort((a, b) => b.date.localeCompare(a.date));
      const latestRecovery = datedRecoveries[0] ?? null;

      const recoveryScore = fin(latestRecovery ? latestRecovery.rec.score.recovery_score : null);
      const hrvRmssd = fin(latestRecovery ? latestRecovery.rec.score.hrv_rmssd_milli : null);
      const rhr = fin(latestRecovery ? latestRecovery.rec.score.resting_heart_rate : null);
      const spo2 = fin(latestRecovery ? latestRecovery.rec.score.spo2_percentage : null);
      const skinTemp = fin(latestRecovery ? latestRecovery.rec.score.skin_temp_celsius : null);

      // Most recent night of sleep (naps excluded).
      const sleepDay = sleeps
        .filter(isNightSleep)
        .map((night) => ({
          night,
          day: mapSleepToDay(night, config.athlete.timezone),
        }))
        .filter((entry): entry is { night: typeof entry.night; day: NonNullable<typeof entry.day> } =>
          entry.day != null,
        )
        .sort((a, b) =>
          b.day.date.localeCompare(a.day.date) || b.night.end.localeCompare(a.night.end),
        )[0]?.day ?? null;
      // Date the night by its wake date in the configured owner timezone.
      const sleepDate = sleepDay?.date ?? null;
      const sleepPerfPct = sleepDay?.performance_pct ?? null;
      const sleepEffPct = sleepDay?.efficiency_pct ?? null;
      const sleepDurationHrs = fin(sleepDay ? sleepDay.duration_hrs : null);

      const recoveryBand = recoveryScore != null ? getRecoveryBand(recoveryScore) : null;

      const scored30d = recoveries30d.filter(isScoredRecovery);
      // Filter the 30-day baselines to finite values so one dirty record can't NaN the mean.
      const hrvValues30d = scored30d.map((r) => r.score.hrv_rmssd_milli).filter(Number.isFinite);
      const rhrValues30d = scored30d.map((r) => r.score.resting_heart_rate).filter(Number.isFinite);

      const hrvVsBaseline =
        hrvValues30d.length >= 14 ? computeBaselineComparison(hrvRmssd, hrvValues30d) : null;
      const rhrVsBaseline =
        rhrValues30d.length >= 14 ? computeBaselineComparison(rhr, rhrValues30d) : null;
      const lastNightVsTarget =
        sleepDurationHrs != null && config.athlete.sleep_target_hrs != null
          ? roundTo(sleepDurationHrs - config.athlete.sleep_target_hrs, 1)
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
          sleep_duration_hrs: sleepDurationHrs,
          sleep_efficiency_pct: sleepEffPct,
          day_strain: strain,
          day_calories: calories,
        },
        computed: {
          recovery_available: latestRecovery != null,
          sleep_available: sleepDay != null,
          strain_available: strain != null,
          recovery_band: recoveryBand,
          hrv_vs_baseline_pct: hrvVsBaseline,
          rhr_vs_baseline_pct: rhrVsBaseline,
          last_night_vs_configured_target_hrs: lastNightVsTarget,
          wellness_context_only: true as const,
        },
      };
    },
  );
}
