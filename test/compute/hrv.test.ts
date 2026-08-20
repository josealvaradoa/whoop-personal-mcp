import { describe, it, expect } from "vitest";
import { computeHrvTrend } from "../../src/compute/hrv.js";
import { consecutiveRecovery } from "../helpers/fixtures.js";

const D = "2026-06-15";

describe("computeHrvTrend", () => {
  it("empty input → every computed field null, above_baseline null (never zero)", () => {
    expect(computeHrvTrend([])).toEqual({
      baseline_30d: null,
      current_7d_avg: null,
      cv_pct: null,
      trend: null,
      above_baseline: null,
      days_with_data_7d: 0,
      days_with_data_30d: 0,
      as_of_date: null,
    });
  });

  it("withholds CV and trends when fewer than five recent nights are measured", () => {
    const daily = consecutiveRecovery(D, [60, 60], [40, 60]);
    const r = computeHrvTrend(daily);
    expect(r.current_7d_avg).toBe(50);
    expect(r.cv_pct).toBeNull();
    expect(r.above_baseline).toBeNull();
    expect(r.trend).toBeNull();
    expect(r.days_with_data_7d).toBe(2);
  });

  it("computes recent CV with at least five measured nights", () => {
    const daily = consecutiveRecovery(D, Array(5).fill(60), [40, 60, 50, 50, 50]);
    const r = computeHrvTrend(daily);
    expect(r.current_7d_avg).toBe(50);
    expect(r.cv_pct).toBe(12.6);
    expect(r.trend).toBeNull(); // the longer baseline still has fewer than 14 nights
  });

  it("flags current 7d above the 30d baseline and an improving trend", () => {
    const hrvs = [...Array(7).fill(90), ...Array(23).fill(60)];
    const r = computeHrvTrend(consecutiveRecovery(D, Array(30).fill(60), hrvs));
    expect(r.current_7d_avg).toBe(90);
    expect(r.baseline_30d).toBe(67); // round1(2010/30)
    expect(r.above_baseline).toBe(true);
    expect(r.trend).toBe("improving");
  });

  it("flags current 7d below baseline and a declining trend", () => {
    const hrvs = [...Array(7).fill(60), ...Array(23).fill(90)];
    const r = computeHrvTrend(consecutiveRecovery(D, Array(30).fill(60), hrvs));
    expect(r.above_baseline).toBe(false);
    expect(r.trend).toBe("declining");
  });

  it("reports as_of_date as the newest day with data (fix 4)", () => {
    expect(computeHrvTrend(consecutiveRecovery(D, [60, 60])).as_of_date).toBe(D);
    expect(computeHrvTrend([]).as_of_date).toBeNull();
  });
});
