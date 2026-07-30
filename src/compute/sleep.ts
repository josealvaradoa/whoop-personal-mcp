import { config } from "../config.js";
import type { Sleep } from "../whoop/types.js";
import { computeTrend, type Trend } from "./recovery.js";
import { mean, stddev, roundTo, dedupeByDay, windowByDays } from "./stats.js";

const MILLI_TO_HRS = 1 / (1000 * 60 * 60);

// A scored, non-nap sleep — the only kind that counts as a night of sleep.
export type NightSleep = Sleep & { score: NonNullable<Sleep["score"]> };

export function isNightSleep(s: Sleep): s is NightSleep {
  return s.score_state === "SCORED" && s.score != null && !s.nap;
}

export interface SleepDayData {
  date: string;
  duration_hrs: number;
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

export function mapSleepToDay(s: NightSleep): SleepDayData {
  const ss = s.score.stage_summary;
  const totalSleep =
    ss.total_light_sleep_time_milli +
    ss.total_slow_wave_sleep_time_milli +
    ss.total_rem_sleep_time_milli;

  return {
    // Date the night by its WAKE day (s.end) so it aligns with the recovery/cycle
    // day it belongs to — recovery is dated by cycle-day, and a night that starts
    // before midnight but ends after belongs to the morning it wakes into.
    date: s.end.split("T")[0],
    duration_hrs: roundTo(totalSleep * MILLI_TO_HRS, 2),
    efficiency_pct: s.score.sleep_efficiency_percentage,
    performance_pct: s.score.sleep_performance_percentage,
    respiratory_rate: s.score.respiratory_rate,
    stages: {
      awake_hrs: roundTo(ss.total_awake_time_milli * MILLI_TO_HRS, 2),
      light_hrs: roundTo(ss.total_light_sleep_time_milli * MILLI_TO_HRS, 2),
      slow_wave_hrs: roundTo(ss.total_slow_wave_sleep_time_milli * MILLI_TO_HRS, 2),
      rem_hrs: roundTo(ss.total_rem_sleep_time_milli * MILLI_TO_HRS, 2),
    },
  };
}

export function computeSleepTrend(sleepDays: SleepDayData[]) {
  const buckets = dedupeByDay(sleepDays, (d) => d.date, (a, b) => b.date.localeCompare(a.date));
  const asOfDate = buckets.length > 0 ? buckets[0].date : null;
  const last7 = windowByDays(buckets, 7).map((b) => b.value);
  const prev7 = windowByDays(buckets, 7, 7).map((b) => b.value);

  const durations7d = last7.map((d) => d.duration_hrs);
  const efficiencies7d = last7
    .map((d) => d.efficiency_pct)
    .filter((e): e is number => e != null);

  const avgDuration = mean(durations7d);
  const avgEfficiency = mean(efficiencies7d);

  const target = config.athlete.sleep_target_hrs;
  const sleepDebtCumulative =
    durations7d.length > 0
      ? roundTo(durations7d.reduce((sum, d) => sum + (d - target), 0), 1)
      : null;

  // Consistency: 1.0 - normalized stddev of sleep durations as proxy
  let consistencyScore: number | null = null;
  const durationStddev = stddev(durations7d);
  if (durationStddev != null && avgDuration != null && avgDuration > 0) {
    consistencyScore = roundTo(Math.max(0, 1.0 - durationStddev / avgDuration), 2);
  }

  const trend: Trend | null = computeTrend(avgDuration, mean(prev7.map((d) => d.duration_hrs)));

  return {
    avg_duration_7d_hrs: avgDuration == null ? null : roundTo(avgDuration, 1),
    avg_efficiency_7d_pct: avgEfficiency == null ? null : Math.round(avgEfficiency),
    sleep_debt_cumulative_hrs: sleepDebtCumulative,
    consistency_score: consistencyScore,
    trend,
    as_of_date: asOfDate,
  };
}
