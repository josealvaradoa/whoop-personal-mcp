import type { Cycle, Recovery } from "../whoop/types.js";
import {
  mean,
  roundTo,
  dedupeByDay,
  windowByDays,
  dayDiff,
  calendarDate,
} from "./stats.js";

export type RecoveryBand = "green" | "yellow" | "red";
export type Trend = "improving" | "declining" | "stable";

// WHOOP's published Recovery bands are product definitions, not configurable
// exercise prescriptions: red 0-33, yellow 34-66, green 67-100.
const GREEN_RECOVERY_MIN = 67;
const YELLOW_RECOVERY_MIN = 34;
const MIN_RECOVERY_DAYS_7D = 4;
const MIN_RECOVERY_DAYS_30D = 14;

// A recovery record WHOOP has finished scoring — `score` is guaranteed present.
export type ScoredRecovery = Recovery & { score: NonNullable<Recovery["score"]> };

export function isScoredRecovery(r: Recovery): r is ScoredRecovery {
  return r.score_state === "SCORED" && r.score != null;
}

export function cycleDateMap(cycles: Cycle[], timeZone: string): Map<number, string> {
  const dated = cycles
    .map((cycle) => [cycle.id, calendarDate(cycle.start, timeZone)] as const)
    .filter((entry): entry is readonly [number, string] => entry[1] != null);
  return new Map(dated);
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

export function getRecoveryBand(recoveryScore: number): RecoveryBand {
  if (recoveryScore >= GREEN_RECOVERY_MIN) return "green";
  if (recoveryScore >= YELLOW_RECOVERY_MIN) return "yellow";
  return "red";
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
  const daysWithData7d = last7.length;
  const daysWithData30d = last30.length;
  const hasEnoughTrendData =
    daysWithData7d >= MIN_RECOVERY_DAYS_7D &&
    daysWithData30d >= MIN_RECOVERY_DAYS_30D;

  // Count consecutive days in each zone from the most recent day with data. Buckets
  // are one-per-owner-calendar-day, newest first, but may have gaps — a streak must
  // only extend across immediately-adjacent days, else 3 red readings scattered over
  // 11 days would masquerade as a three-day red-band streak. A gap (or a band
  // change) ends the streak.
  let consecutiveRed = 0;
  let consecutiveYellow = 0;
  let consecutiveGreen = 0;
  if (buckets.length > 0) {
    const firstBand = getRecoveryBand(buckets[0].value.recovery_score);
    let prevDate: string | null = null;
    for (const b of buckets) {
      const r = getRecoveryBand(b.value.recovery_score);
      if (r !== firstBand) break;
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
    trend: hasEnoughTrendData ? computeTrend(mean7, mean30) : null,
    consecutive_red_days: consecutiveRed,
    consecutive_yellow_days: consecutiveYellow,
    consecutive_green_days: consecutiveGreen,
    days_with_data_7d: daysWithData7d,
    days_with_data_30d: daysWithData30d,
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
