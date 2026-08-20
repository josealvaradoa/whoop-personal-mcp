import { describe, it, expect } from "vitest";
import {
  DAY_STRAIN_RATIO_EXPERIMENTAL_NOTICE,
  completedStrainByDay,
  computeTrainingLoad,
} from "../../src/compute/training-load.js";
import {
  makeCycle,
  makeInProgressCycle,
  makeUnscoredCycle,
  consecutiveCycles,
  shiftDay,
} from "../helpers/fixtures.js";

const D = "2026-06-15";

describe("computeTrainingLoad — missing and incomplete data", () => {
  it("returns null metrics and explicit experimental limitations for empty input", () => {
    expect(computeTrainingLoad([])).toEqual({
      mean_day_strain_7d: null,
      mean_day_strain_28d: null,
      experimental_mean_day_strain_ratio_7d_28d: null,
      is_experimental: true,
      limitations: DAY_STRAIN_RATIO_EXPERIMENTAL_NOTICE,
      day_strain_trend: null,
      days_with_data_7d: 0,
      days_with_data_28d: 0,
      as_of_date: null,
    });
  });

  it("excludes in-progress and unscored cycles from every aggregate", () => {
    const completed = consecutiveCycles(D, [10, 10, 10, 10]);
    const result = computeTrainingLoad([
      makeInProgressCycle({ date: shiftDay(D, 1), strain: 99 }),
      makeUnscoredCycle({ date: shiftDay(D, 2) }),
      ...completed,
    ]);
    expect(result.mean_day_strain_7d).toBe(10);
    expect(result.days_with_data_7d).toBe(4);
    expect(result.days_with_data_28d).toBe(4);
    expect(result.experimental_mean_day_strain_ratio_7d_28d).toBeNull();
    expect(result.as_of_date).toBe(D);
  });

  it("drops a completed cycle with non-finite Strain from raw and computed output", () => {
    const valid = makeCycle({ date: D, strain: 10 });
    const dirty = makeCycle({ date: shiftDay(D, -1), strain: 9 });
    dirty.score!.strain = Number.NaN;
    expect(completedStrainByDay([valid, dirty])).toEqual([{ date: D, strain: 10 }]);
    const result = computeTrainingLoad([valid, dirty]);
    expect(result.days_with_data_7d).toBe(1);
    expect(result.mean_day_strain_7d).toBe(10);
  });

  it("withholds the experimental ratio unless all 7 and 28 calendar days are present", () => {
    const result = computeTrainingLoad(consecutiveCycles(D, Array(27).fill(10)));
    expect(result.mean_day_strain_7d).toBe(10);
    expect(result.mean_day_strain_28d).toBe(10);
    expect(result.days_with_data_7d).toBe(7);
    expect(result.days_with_data_28d).toBe(27);
    expect(result.experimental_mean_day_strain_ratio_7d_28d).toBeNull();
  });
});

describe("computeTrainingLoad — calendar-day bucketing", () => {
  it("buckets a near-midnight instant in the configured owner timezone", () => {
    const cycle = {
      ...makeCycle({ date: D, strain: 10 }),
      start: `${D}T01:00:00.000Z`,
    };
    expect(completedStrainByDay([cycle], "America/New_York")[0].date).toBe(
      shiftDay(D, -1),
    );
  });

  it("keeps the latest-start completed cycle when two share a UTC day", () => {
    const early = makeCycle({ date: D, strain: 5 });
    const late = { ...makeCycle({ date: D, strain: 99 }), start: `${D}T20:00:00.000Z` };
    const result = computeTrainingLoad([early, late]);
    expect(result.mean_day_strain_7d).toBe(99);
    expect(result.days_with_data_7d).toBe(1);
  });

  it("uses the newest completed day as the staleness anchor", () => {
    const completed = consecutiveCycles(D, [10, 11]);
    const inProgress = makeInProgressCycle({ date: shiftDay(D, 1), strain: 99 });
    expect(computeTrainingLoad([inProgress, ...completed]).as_of_date).toBe(D);
  });
});

describe("computeTrainingLoad — explicitly experimental mean Day Strain ratio", () => {
  it("reports the complete-window ratio without applying a threshold band", () => {
    const result = computeTrainingLoad(consecutiveCycles(D, Array(28).fill(10)));
    expect(result.mean_day_strain_7d).toBe(10);
    expect(result.mean_day_strain_28d).toBe(10);
    expect(result.experimental_mean_day_strain_ratio_7d_28d).toBe(1);
    expect(result.is_experimental).toBe(true);
    expect(result.limitations).toContain("not a validated acute-to-chronic workload ratio");
    expect(result).not.toHaveProperty("acwr_reference_band_experimental");
    expect(result.day_strain_trend).toBe("similar");
  });

  it("describes a lower recent mean without classifying the ratio", () => {
    const strains = [...Array(7).fill(5), ...Array(21).fill(15)];
    const result = computeTrainingLoad(consecutiveCycles(D, strains));
    expect(result.experimental_mean_day_strain_ratio_7d_28d).toBe(0.4);
    expect(result.day_strain_trend).toBe("lower");
  });

  it("describes a higher recent mean without classifying the ratio", () => {
    const strains = [...Array(7).fill(15), ...Array(21).fill(10)];
    const result = computeTrainingLoad(consecutiveCycles(D, strains));
    expect(result.experimental_mean_day_strain_ratio_7d_28d).toBe(1.33);
    expect(result.day_strain_trend).toBe("higher");
  });

  it("reports a high numeric ratio without declaring danger or a mandatory deload", () => {
    const strains = [...Array(7).fill(15), ...Array(21).fill(5)];
    const result = computeTrainingLoad(consecutiveCycles(D, strains));
    expect(result.experimental_mean_day_strain_ratio_7d_28d).toBe(2);
    expect(JSON.stringify(result)).not.toMatch(/injury_risk|danger|deload|optimal/);
  });

  it("keeps zero means real but withholds division by a zero longer-window mean", () => {
    const result = computeTrainingLoad(consecutiveCycles(D, Array(28).fill(0)));
    expect(result.mean_day_strain_7d).toBe(0);
    expect(result.mean_day_strain_28d).toBe(0);
    expect(result.experimental_mean_day_strain_ratio_7d_28d).toBeNull();
    expect(result.day_strain_trend).toBeNull();
  });

  it("does not expose nonlinear Strain sums, monotony, or inferred periodization", () => {
    const result = computeTrainingLoad(consecutiveCycles(D, Array(28).fill(10)));
    expect(result).not.toHaveProperty("training_strain_7d");
    expect(result).not.toHaveProperty("monotony");
    expect(result).not.toHaveProperty("trend_direction");
  });
});
