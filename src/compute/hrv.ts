import { computeTrend, type Trend, type DailyRecovery } from "./recovery.js";
import { mean, stddev, roundTo, dedupeByDay, windowByDays } from "./stats.js";

// A current large wearable study found that at least five nights are needed for
// a reliable seven-night HRV-CV estimate. A longer baseline also needs enough
// observations to avoid presenting a sparse comparison as a trend.
const MIN_HRV_NIGHTS_7D = 5;
const MIN_HRV_NIGHTS_30D = 14;

export function computeHrvTrend(daily: DailyRecovery[]) {
  const buckets = dedupeByDay(daily, (d) => d.date, (a, b) => b.date.localeCompare(a.date));
  const asOfDate = buckets.length > 0 ? buckets[0].date : null;

  const last7 = windowByDays(buckets, 7).map((b) => b.value.hrv_rmssd);
  const last30 = windowByDays(buckets, 30).map((b) => b.value.hrv_rmssd);

  const mean7 = mean(last7);
  const mean30 = mean(last30);
  const daysWithData7d = last7.length;
  const daysWithData30d = last30.length;
  const hasReliableAcuteWindow = daysWithData7d >= MIN_HRV_NIGHTS_7D;
  const hasReliableTrend =
    hasReliableAcuteWindow && daysWithData30d >= MIN_HRV_NIGHTS_30D;
  const baseline30d = mean30 == null ? null : roundTo(mean30, 1);
  const current7dAvg = mean7 == null ? null : roundTo(mean7, 1);
  const sd = stddev(last7);
  const cvPct =
    hasReliableAcuteWindow && sd != null && mean7 != null && mean7 > 0
      ? roundTo((sd / mean7) * 100, 1)
      : null;
  const trend: Trend | null = hasReliableTrend ? computeTrend(mean7, mean30) : null;
  const aboveBaseline =
    hasReliableTrend && current7dAvg != null && baseline30d != null
      ? current7dAvg > baseline30d
      : null;

  return {
    baseline_30d: baseline30d,
    current_7d_avg: current7dAvg,
    cv_pct: cvPct,
    trend,
    above_baseline: aboveBaseline,
    days_with_data_7d: daysWithData7d,
    days_with_data_30d: daysWithData30d,
    as_of_date: asOfDate,
  };
}
