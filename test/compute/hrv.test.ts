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
    });
  });

  it("computes the coefficient of variation over the acute window", () => {
    // last-7 window has two days: hrv 40 (newest) and 60 → mean 50, stddev 10 → cv 20%
    const daily = consecutiveRecovery(D, [60, 60], [40, 60]);
    const r = computeHrvTrend(daily);
    expect(r.current_7d_avg).toBe(50);
    expect(r.cv_pct).toBe(20);
    expect(r.above_baseline).toBe(false); // 50 is not > baseline 50
    expect(r.trend).toBe("stable");
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
});
