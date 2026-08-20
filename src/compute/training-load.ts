import type { Cycle } from "../whoop/types.js";
import { mean, roundTo, dedupeByDay, windowByDays, calendarDate } from "./stats.js";

export type DayStrainTrend = "lower" | "similar" | "higher";

export const DAY_STRAIN_RATIO_EXPERIMENTAL_NOTICE =
  "Experimental ratio of 7-day to 28-day WHOOP Day Strain means. WHOOP Strain is nonlinear, so this is not a validated acute-to-chronic workload ratio. No threshold bands are applied, and the ratio is not validated for injury prediction, training safety, fitness assessment, periodization, or event clearance.";

// A completed, scored cycle — in-progress cycles (end === null) are excluded from
// all trailing aggregates because their strain is only partial.
type CompletedCycle = Cycle & { score: NonNullable<Cycle["score"]> };

function isCompletedCycle(c: Cycle): c is CompletedCycle {
  return c.end !== null && c.score != null && Number.isFinite(c.score.strain);
}

type DatedCompletedCycle = { date: string; cycle: CompletedCycle };

function datedCompletedCycles(cycles: Cycle[], timeZone: string): DatedCompletedCycle[] {
  return cycles
    .filter(isCompletedCycle)
    .map((cycle) => ({ cycle, date: calendarDate(cycle.start, timeZone) }))
    .filter((entry): entry is DatedCompletedCycle => entry.date != null);
}

// One completed, deduped Strain reading per owner-local day, newest first. Shared so the
// tool's raw.daily_strain is built from exactly the same rows the aggregates use
// (no in-progress / unscored / duplicate-day cycle leaks into raw).
export function completedStrainByDay(
  cycles: Cycle[],
  timeZone = "UTC",
): { date: string; strain: number }[] {
  return dedupeByDay(
    datedCompletedCycles(cycles, timeZone),
    (entry) => entry.date,
    (a, b) => b.cycle.start.localeCompare(a.cycle.start),
  ).map((bucket) => ({ date: bucket.date, strain: bucket.value.cycle.score.strain }));
}

export function computeTrainingLoad(cycles: Cycle[], timeZone = "UTC") {
  const buckets = dedupeByDay(
    datedCompletedCycles(cycles, timeZone),
    (entry) => entry.date,
    (a, b) => b.cycle.start.localeCompare(a.cycle.start),
  );

  // Newest completed day used by the trailing windows — the "as of" anchor.
  const asOfDate = buckets.length > 0 ? buckets[0].date : null;

  const strainOf = (bucket: { value: DatedCompletedCycle }) => bucket.value.cycle.score.strain;
  const last7 = windowByDays(buckets, 7).map(strainOf);
  const last28 = windowByDays(buckets, 28).map(strainOf);
  const prev7 = windowByDays(buckets, 7, 7).map(strainOf);

  const daysWithData7d = last7.length;
  const daysWithData28d = last28.length;

  const meanDayStrain7d = mean(last7);
  const meanDayStrain28d = mean(last28);

  // Retain only an explicitly experimental ratio of two descriptive means. Complete
  // daily coverage is required because missing days alter both means. WHOOP Strain
  // is nonlinear, so this is not represented as a validated workload ratio.
  const rawExperimentalMeanDayStrainRatio =
    daysWithData7d < 7 ||
    daysWithData28d < 28 ||
    meanDayStrain7d == null ||
    meanDayStrain28d == null ||
    meanDayStrain28d === 0
      ? null
      : meanDayStrain7d / meanDayStrain28d;
  const experimentalMeanDayStrainRatio =
    rawExperimentalMeanDayStrainRatio == null
      ? null
      : roundTo(rawExperimentalMeanDayStrainRatio, 2);

  // Compare descriptive means only. Do not infer that the athlete is intentionally
  // building, tapering, or deloading from a proprietary physiological score.
  let dayStrainTrend: DayStrainTrend | null = null;
  const prevAvg = mean(prev7);
  if (
    last7.length === 7 &&
    prev7.length === 7 &&
    meanDayStrain7d != null &&
    prevAvg != null &&
    prevAvg > 0
  ) {
    const change = (meanDayStrain7d - prevAvg) / prevAvg;
    if (change < -0.1) dayStrainTrend = "lower";
    else if (change > 0.1) dayStrainTrend = "higher";
    else dayStrainTrend = "similar";
  }

  return {
    mean_day_strain_7d: meanDayStrain7d == null ? null : roundTo(meanDayStrain7d, 2),
    mean_day_strain_28d: meanDayStrain28d == null ? null : roundTo(meanDayStrain28d, 2),
    experimental_mean_day_strain_ratio_7d_28d: experimentalMeanDayStrainRatio,
    is_experimental: true as const,
    limitations: DAY_STRAIN_RATIO_EXPERIMENTAL_NOTICE,
    day_strain_trend: dayStrainTrend,
    days_with_data_7d: daysWithData7d,
    days_with_data_28d: daysWithData28d,
    as_of_date: asOfDate,
  };
}
