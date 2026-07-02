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

export function computeTrainingLoad(cycles: Cycle[]) {
  const buckets = dedupeByDay(
    cycles.filter(isCompletedCycle),
    (c) => c.start.split("T")[0],
    (a, b) => b.start.localeCompare(a.start),
  );

  const strainOf = (b: { value: CompletedCycle }) => b.value.score.strain;
  const last7 = windowByDays(buckets, 7).map(strainOf);
  const last28 = windowByDays(buckets, 28).map(strainOf);
  const prev7 = windowByDays(buckets, 7, 7).map(strainOf);

  const daysWithData7d = last7.length;
  const daysWithData28d = last28.length;

  const acuteLoad = mean(last7);
  const chronicLoad = mean(last28);

  // Too few days in the trailing week make ACWR meaningless — report it as unknown.
  const acwr =
    daysWithData7d < 4 || acuteLoad == null || chronicLoad == null || chronicLoad === 0
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

  const sd7 = stddev(last7);
  const monotony =
    sd7 != null && sd7 > 0 && acuteLoad != null ? roundTo(acuteLoad / sd7, 2) : null;

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
  };
}
