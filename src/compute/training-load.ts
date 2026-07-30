import { config } from "../config.js";
import type { Cycle } from "../whoop/types.js";
import { mean, stddev, roundTo, dedupeByDay, windowByDays } from "./stats.js";

export type AcwrZone = "undertrained" | "optimal" | "caution" | "danger";
export type TrendDirection = "building" | "maintaining" | "tapering" | "deloading";

// A completed, scored cycle — in-progress cycles (end === null) are excluded from
// all trailing aggregates because their strain is only partial.
type CompletedCycle = Cycle & { score: NonNullable<Cycle["score"]> };

function isCompletedCycle(c: Cycle): c is CompletedCycle {
  return c.end !== null && c.score != null;
}

// One completed, deduped strain reading per UTC day, newest first. Shared so the
// tool's raw.daily_strain is built from exactly the same rows the aggregates use
// (no in-progress / unscored / duplicate-day cycle leaks into raw).
export function completedStrainByDay(cycles: Cycle[]): { date: string; strain: number }[] {
  return dedupeByDay(
    cycles.filter(isCompletedCycle),
    (c) => c.start.split("T")[0],
    (a, b) => b.start.localeCompare(a.start),
  ).map((b) => ({ date: b.date, strain: b.value.score.strain }));
}

export function computeTrainingLoad(cycles: Cycle[]) {
  const buckets = dedupeByDay(
    cycles.filter(isCompletedCycle),
    (c) => c.start.split("T")[0],
    (a, b) => b.start.localeCompare(a.start),
  );

  // Newest completed day used by the trailing windows — the "as of" anchor.
  const asOfDate = buckets.length > 0 ? buckets[0].date : null;

  const strainOf = (b: { value: CompletedCycle }) => b.value.score.strain;
  const last7 = windowByDays(buckets, 7).map(strainOf);
  const last28 = windowByDays(buckets, 28).map(strainOf);
  const prev7 = windowByDays(buckets, 7, 7).map(strainOf);

  const daysWithData7d = last7.length;
  const daysWithData28d = last28.length;

  const acuteLoad = mean(last7);
  const chronicLoad = mean(last28);

  // ACWR needs both a real trailing week AND an adequate chronic base. Too few days
  // in the last 7 makes the acute leg noise; too few in the last 28 makes chronic
  // collapse toward acute (a returning athlete with ~1 week of data would otherwise
  // read a fake ~1.0 "optimal"). Gate both legs — report unknown (null) if either is thin.
  const acwr =
    daysWithData7d < 4 ||
    daysWithData28d < 14 ||
    acuteLoad == null ||
    chronicLoad == null ||
    chronicLoad === 0
      ? null
      : roundTo(acuteLoad / chronicLoad, 2);

  let acwrZone: AcwrZone | null = null;
  if (acwr !== null) {
    const { acwr_optimal_low, acwr_optimal_high, acwr_danger } = config.thresholds;
    if (acwr < acwr_optimal_low) acwrZone = "undertrained";
    else if (acwr <= acwr_optimal_high) acwrZone = "optimal";
    else if (acwr < acwr_danger) acwrZone = "caution";
    else acwrZone = "danger";
  }

  // Monotony = mean/stddev over present days. With no completeness guard a light
  // 2-day week like [15,16] yields a tiny stddev and an absurd monotony (~31) that
  // trips a false "high_monotony" concern. Gate it to the same trailing-week
  // completeness the acute ACWR leg uses — null when the 7-day window is too sparse.
  const sd7 = stddev(last7);
  const monotony =
    daysWithData7d < 4 || sd7 == null || sd7 <= 0 || acuteLoad == null
      ? null
      : roundTo(acuteLoad / sd7, 2);

  const trainingStrain7d =
    last7.length > 0 ? roundTo(last7.reduce((a, b) => a + b, 0), 1) : null;

  let trendDirection: TrendDirection | null = null;
  const prevAvg = mean(prev7);
  if (acuteLoad != null && prevAvg != null && prevAvg > 0) {
    const change = (acuteLoad - prevAvg) / prevAvg;
    if (change < -0.2) trendDirection = "deloading";
    else if (change < -0.1) trendDirection = "tapering";
    else if (change > 0.1) trendDirection = "building";
    else trendDirection = "maintaining";
  }

  return {
    acute_load_7d: acuteLoad == null ? null : roundTo(acuteLoad, 2),
    chronic_load_28d: chronicLoad == null ? null : roundTo(chronicLoad, 2),
    acwr,
    acwr_zone: acwrZone,
    monotony,
    training_strain_7d: trainingStrain7d,
    trend_direction: trendDirection,
    days_with_data_7d: daysWithData7d,
    days_with_data_28d: daysWithData28d,
    as_of_date: asOfDate,
  };
}
