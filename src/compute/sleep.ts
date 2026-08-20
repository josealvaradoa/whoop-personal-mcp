import { config } from "../config.js";
import type { Sleep } from "../whoop/types.js";
import { mean, roundTo, dedupeByDay, windowByDays, calendarDate } from "./stats.js";

const MILLI_TO_HRS = 1 / (1000 * 60 * 60);
export type SleepDurationDirection = "longer" | "shorter" | "similar";

function compareDuration(
  recent: number | null,
  previous: number | null,
): SleepDurationDirection | null {
  if (recent == null || previous == null || previous === 0) return null;
  const difference = (recent - previous) / previous;
  if (difference > 0.05) return "longer";
  if (difference < -0.05) return "shorter";
  return "similar";
}

// A scored, non-nap sleep — the only kind that counts as a night of sleep.
export type NightSleep = Sleep & { score: NonNullable<Sleep["score"]> };

export function isNightSleep(s: Sleep): s is NightSleep {
  return s.score_state === "SCORED" && s.score != null && !s.nap;
}

export interface SleepDayData {
  date: string;
  duration_hrs: number;
  sleep_need_hrs: number | null;
  whoop_sleep_debt_hrs: number | null;
  consistency_pct: number | null;
  efficiency_pct: number | null;
  performance_pct: number | null;
  respiratory_rate: number | null;
  stages: {
    awake_hrs: number;
    light_hrs: number;
    slow_wave_hrs: number;
    rem_hrs: number;
  };
}

export function isSleepDayData(value: SleepDayData | null): value is SleepDayData {
  return value != null;
}

export function mapSleepToDay(
  s: NightSleep,
  timeZone = config.athlete.timezone,
): SleepDayData | null {
  const ss = s.score.stage_summary;
  const need = s.score.sleep_needed;
  const wakeDate = calendarDate(s.end, timeZone);
  const stageMillis = [
    ss.total_awake_time_milli,
    ss.total_light_sleep_time_milli,
    ss.total_slow_wave_sleep_time_milli,
    ss.total_rem_sleep_time_milli,
  ];
  if (
    wakeDate == null ||
    stageMillis.some((value) => !Number.isFinite(value) || value < 0)
  ) {
    return null;
  }
  const totalSleep =
    ss.total_light_sleep_time_milli +
    ss.total_slow_wave_sleep_time_milli +
    ss.total_rem_sleep_time_milli;
  const needComponents = [
    need.baseline_milli,
    need.need_from_sleep_debt_milli,
    need.need_from_recent_strain_milli,
    need.need_from_recent_nap_milli,
  ];
  const totalNeed = needComponents.every(Number.isFinite)
    ? needComponents.reduce((sum, value) => sum + value, 0)
    : null;
  const finiteHours = (millis: number): number | null =>
    Number.isFinite(millis) ? roundTo(millis * MILLI_TO_HRS, 2) : null;
  const finiteNullable = (value: number | null): number | null =>
    value != null && Number.isFinite(value) ? value : null;
  const finitePercentage = (value: number | null): number | null =>
    value != null && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;

  return {
    // Convert the wake instant to the owner's configured calendar so sleep,
    // recovery, and cycle days use the same boundary.
    date: wakeDate,
    duration_hrs: roundTo(totalSleep * MILLI_TO_HRS, 2),
    sleep_need_hrs: totalNeed == null || totalNeed < 0 ? null : finiteHours(totalNeed),
    // This is WHOOP's current debt contribution to Sleep Need. Keep it positive
    // and distinct from the signed duration-vs-configured-target balance below.
    whoop_sleep_debt_hrs: Number.isFinite(need.need_from_sleep_debt_milli)
      ? roundTo(Math.max(0, need.need_from_sleep_debt_milli * MILLI_TO_HRS), 2)
      : null,
    consistency_pct: finitePercentage(s.score.sleep_consistency_percentage),
    efficiency_pct: finitePercentage(s.score.sleep_efficiency_percentage),
    performance_pct: finitePercentage(s.score.sleep_performance_percentage),
    respiratory_rate: finiteNullable(s.score.respiratory_rate),
    stages: {
      awake_hrs: roundTo(ss.total_awake_time_milli * MILLI_TO_HRS, 2),
      light_hrs: roundTo(ss.total_light_sleep_time_milli * MILLI_TO_HRS, 2),
      slow_wave_hrs: roundTo(ss.total_slow_wave_sleep_time_milli * MILLI_TO_HRS, 2),
      rem_hrs: roundTo(ss.total_rem_sleep_time_milli * MILLI_TO_HRS, 2),
    },
  };
}

export function computeSleepTrend(
  sleepDays: SleepDayData[],
  configuredSleepTargetHrs: number | null = config.athlete.sleep_target_hrs,
) {
  const validSleepDays = sleepDays.filter(
    (day) => Number.isFinite(day.duration_hrs) && day.duration_hrs >= 0,
  );
  const buckets = dedupeByDay(
    validSleepDays,
    (d) => d.date,
    (a, b) => b.date.localeCompare(a.date),
  );
  const asOfDate = buckets.length > 0 ? buckets[0].date : null;
  const last7 = windowByDays(buckets, 7).map((b) => b.value);
  const prev7 = windowByDays(buckets, 7, 7).map((b) => b.value);

  const durations7d = last7.map((d) => d.duration_hrs);
  const efficiencies7d = last7
    .map((d) => d.efficiency_pct)
    .filter((e): e is number => e != null && Number.isFinite(e));
  const sleepNeeds7d = last7
    .map((d) => d.sleep_need_hrs)
    .filter((n): n is number => n != null && Number.isFinite(n));
  const consistencies7d = last7
    .map((d) => d.consistency_pct)
    .filter((n): n is number => n != null && Number.isFinite(n));

  const avgDuration = mean(durations7d);
  const avgEfficiency = mean(efficiencies7d);
  const avgSleepNeed = mean(sleepNeeds7d);
  const avgConsistency = mean(consistencies7d);

  const target = configuredSleepTargetHrs;
  // Signed arithmetic balance against the user's configured duration target.
  // Positive means above target; negative means below. This is deliberately not
  // called "sleep debt" because WHOOP exposes its own dynamic debt component.
  const sleepDurationBalance =
    durations7d.length > 0 && target != null
      ? roundTo(durations7d.reduce((sum, d) => sum + (d - target), 0), 1)
      : null;
  const latestWhoopDebt = last7[0]?.whoop_sleep_debt_hrs ?? null;
  const previousDurations = prev7.map((d) => d.duration_hrs);
  const durationDirection: SleepDurationDirection | null =
    durations7d.length >= 4 && previousDurations.length >= 4
      ? compareDuration(avgDuration, mean(previousDurations))
      : null;

  return {
    avg_duration_7d_hrs: avgDuration == null ? null : roundTo(avgDuration, 1),
    avg_sleep_need_7d_hrs: avgSleepNeed == null ? null : roundTo(avgSleepNeed, 1),
    avg_efficiency_7d_pct: avgEfficiency == null ? null : Math.round(avgEfficiency),
    avg_consistency_7d_pct: avgConsistency == null ? null : Math.round(avgConsistency),
    configured_sleep_target_hrs: target,
    sleep_duration_balance_7d_hrs: sleepDurationBalance,
    latest_whoop_sleep_debt_hrs: latestWhoopDebt,
    nights_with_data_7d: durations7d.length,
    duration_direction: durationDirection,
    as_of_date: asOfDate,
  };
}
