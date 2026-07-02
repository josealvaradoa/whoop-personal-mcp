import { config } from "../config.js";
import type { Recovery } from "../whoop/types.js";
import { mean, roundTo, dedupeByDay, windowByDays, dayDiff } from "./stats.js";

export type Readiness = "green" | "yellow" | "red";
export type Recommendation = "full_training" | "reduced_intensity" | "active_recovery_only";
export type Trend = "improving" | "declining" | "stable";

// A recovery record WHOOP has finished scoring — `score` is guaranteed present.
export type ScoredRecovery = Recovery & { score: NonNullable<Recovery["score"]> };

export function isScoredRecovery(r: Recovery): r is ScoredRecovery {
  return r.score_state === "SCORED" && r.score != null;
}

// Recovery records carry no timestamp of their own, so we date them via their cycle.
export interface DailyRecovery {
  date: string;
  recovery_score: number;
  hrv_rmssd: number;
  resting_heart_rate: number;
}

export function toDailyRecovery(
  recoveries: Recovery[],
  cycleDates: Map<number, string>
): DailyRecovery[] {
  return recoveries
    .filter(isScoredRecovery)
    .filter((r) => cycleDates.has(r.cycle_id))
    .map((r) => ({
      date: cycleDates.get(r.cycle_id)!,
      recovery_score: r.score.recovery_score,
      hrv_rmssd: r.score.hrv_rmssd_milli,
      resting_heart_rate: r.score.resting_heart_rate,
    }))
    // Defensive: a "scored" record with a null/NaN numeric would otherwise flow into
    // a non-nullable z.number() output field and fail the whole tool. Drop it — one
    // dirty record must degrade gracefully, never fabricate a value.
    .filter(
      (d) =>
        Number.isFinite(d.recovery_score) &&
        Number.isFinite(d.hrv_rmssd) &&
        Number.isFinite(d.resting_heart_rate),
    );
}

export function getReadiness(recoveryScore: number): Readiness {
  if (recoveryScore >= config.thresholds.recovery_yellow) return "green";
  if (recoveryScore >= config.thresholds.recovery_red) return "yellow";
  return "red";
}

export function getRecommendation(readiness: Readiness): Recommendation {
  if (readiness === "green") return "full_training";
  if (readiness === "yellow") return "reduced_intensity";
  return "active_recovery_only";
}

export function computeTrend(shortAvg: number | null, longAvg: number | null): Trend | null {
  if (shortAvg == null || longAvg == null || longAvg === 0) return null;
  const diff = (shortAvg - longAvg) / longAvg;
  if (diff > 0.05) return "improving";
  if (diff < -0.05) return "declining";
  return "stable";
}

export function computeRecoveryTrend(daily: DailyRecovery[]) {
  const buckets = dedupeByDay(daily, (d) => d.date, (a, b) => b.date.localeCompare(a.date));

  const last7 = windowByDays(buckets, 7).map((b) => b.value.recovery_score);
  const last30 = windowByDays(buckets, 30).map((b) => b.value.recovery_score);

  const mean7 = mean(last7);
  const mean30 = mean(last30);
  const asOfDate = buckets.length > 0 ? buckets[0].date : null;

  // Count consecutive days in each zone from the most recent day with data. Buckets
  // are one-per-UTC-day, newest first, but may have CALENDAR gaps — a streak must
  // only extend across immediately-adjacent days, else 3 red readings scattered over
  // 11 days would masquerade as a 3-day red streak and trip a false critical-fatigue
  // alert. A gap (or a zone change) ends the streak.
  let consecutiveRed = 0;
  let consecutiveYellow = 0;
  let consecutiveGreen = 0;
  if (buckets.length > 0) {
    const firstReadiness = getReadiness(buckets[0].value.recovery_score);
    let prevDate: string | null = null;
    for (const b of buckets) {
      const r = getReadiness(b.value.recovery_score);
      if (r !== firstReadiness) break;
      // The newest bucket seeds the streak; every later bucket must be the calendar
      // day immediately before the previous one (prevDate − b.date === 1 day).
      if (prevDate !== null && dayDiff(prevDate, b.date) !== 1) break;
      if (r === "red") consecutiveRed++;
      else if (r === "yellow") consecutiveYellow++;
      else consecutiveGreen++;
      prevDate = b.date;
    }
  }

  return {
    avg_7d: mean7 == null ? null : Math.round(mean7),
    avg_30d: mean30 == null ? null : Math.round(mean30),
    trend: computeTrend(mean7, mean30),
    consecutive_red_days: consecutiveRed,
    consecutive_yellow_days: consecutiveYellow,
    consecutive_green_days: consecutiveGreen,
    as_of_date: asOfDate,
  };
}

export function computeBaselineComparison(
  todayValue: number | null,
  values30d: number[]
): number | null {
  if (todayValue == null) return null;
  const baseline = mean(values30d);
  if (baseline == null || baseline === 0) return null;
  return roundTo(((todayValue - baseline) / baseline) * 100, 1);
}
