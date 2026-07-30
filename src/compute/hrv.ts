import { computeTrend, type Trend, type DailyRecovery } from "./recovery.js";
import { mean, stddev, roundTo, dedupeByDay, windowByDays } from "./stats.js";

export function computeHrvTrend(daily: DailyRecovery[]) {
  const buckets = dedupeByDay(daily, (d) => d.date, (a, b) => b.date.localeCompare(a.date));
  const asOfDate = buckets.length > 0 ? buckets[0].date : null;

  const last7 = windowByDays(buckets, 7).map((b) => b.value.hrv_rmssd);
  const last30 = windowByDays(buckets, 30).map((b) => b.value.hrv_rmssd);

  const mean7 = mean(last7);
  const mean30 = mean(last30);
  const baseline30d = mean30 == null ? null : roundTo(mean30, 1);
  const current7dAvg = mean7 == null ? null : roundTo(mean7, 1);
  const sd = stddev(last7);
  const cvPct = sd != null && mean7 != null && mean7 > 0 ? roundTo((sd / mean7) * 100, 1) : null;
  const trend: Trend | null = computeTrend(mean7, mean30);
  const aboveBaseline =
    current7dAvg != null && baseline30d != null ? current7dAvg > baseline30d : null;

  return {
    baseline_30d: baseline30d,
    current_7d_avg: current7dAvg,
    cv_pct: cvPct,
    trend,
    above_baseline: aboveBaseline,
    as_of_date: asOfDate,
  };
}
