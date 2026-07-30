import { describe, it, expect } from "vitest";
import { computeTrainingLoad } from "../../src/compute/training-load.js";
import {
  makeCycle,
  makeInProgressCycle,
  makeUnscoredCycle,
  consecutiveCycles,
  shiftDay,
} from "../helpers/fixtures.js";

const D = "2026-06-15"; // fixed anchor "newest" day; results are date-relative, not clock-relative

describe("computeTrainingLoad — empty & missing data", () => {
  it("returns null everywhere (never 0 / NaN) for empty input", () => {
    const r = computeTrainingLoad([]);
    expect(r).toEqual({
      acute_load_7d: null,
      chronic_load_28d: null,
      acwr: null,
      acwr_zone: null,
      monotony: null,
      training_strain_7d: null,
      trend_direction: null,
      days_with_data_7d: 0,
      days_with_data_28d: 0,
      as_of_date: null,
    });
  });

  it("excludes in-progress (end === null) cycles from every aggregate", () => {
    const completed = consecutiveCycles(D, [10, 10, 10, 10]); // 4 days
    const inProgress = makeInProgressCycle({ date: shiftDay(D, 1), strain: 99 });
    const r = computeTrainingLoad([inProgress, ...completed]);
    // If the 99-strain partial day leaked in, acute would not be 10.
    expect(r.acute_load_7d).toBe(10);
    expect(r.days_with_data_7d).toBe(4);
    // Only 4 of the last 28 days have data → the chronic-base gate (< 14) nulls acwr
    // even though acute == chronic. (Chronic-base guard, fix 3.)
    expect(r.days_with_data_28d).toBe(4);
    expect(r.acwr).toBeNull();
  });

  it("excludes unscored (score === null) cycles from every aggregate", () => {
    const completed = consecutiveCycles(D, [10, 10, 10, 10]);
    const unscored = makeUnscoredCycle({ date: shiftDay(D, 1) });
    const r = computeTrainingLoad([unscored, ...completed]);
    expect(r.acute_load_7d).toBe(10);
    expect(r.days_with_data_7d).toBe(4);
  });
});

describe("computeTrainingLoad — calendar-day bucketing", () => {
  it("keeps the latest-start cycle when two share a UTC day", () => {
    const early = makeCycle({ date: D, strain: 5 }); // start 12:00
    const late = { ...makeCycle({ date: D, strain: 99 }), start: `${D}T20:00:00.000Z` };
    const r = computeTrainingLoad([early, late]);
    expect(r.acute_load_7d).toBe(99); // latest start wins the day
    expect(r.days_with_data_7d).toBe(1);
  });

  it("single record: acute == chronic == the value, but acwr is null (< 4 of 7 days)", () => {
    const r = computeTrainingLoad([makeCycle({ date: D, strain: 12 })]);
    expect(r.acute_load_7d).toBe(12);
    expect(r.chronic_load_28d).toBe(12);
    expect(r.acwr).toBeNull();
    expect(r.acwr_zone).toBeNull();
    expect(r.monotony).toBeNull(); // stddev of a single value is null
    expect(r.training_strain_7d).toBe(12);
    expect(r.trend_direction).toBeNull(); // no previous window
    expect(r.days_with_data_7d).toBe(1);
    expect(r.days_with_data_28d).toBe(1);
  });
});

describe("computeTrainingLoad — the < 4-of-7-days ACWR rule", () => {
  it("nulls acwr/acwr_zone when fewer than 4 of the last 7 days have data, even if chronic exists", () => {
    const recent = consecutiveCycles(D, [10, 10, 10]); // only 3 days in the last 7
    const older = Array.from({ length: 15 }, (_, k) =>
      makeCycle({ date: shiftDay(D, -(10 + k)), strain: 10 }),
    ); // D-10 .. D-24 → inside the 28-day window, outside the 7-day one
    const r = computeTrainingLoad([...recent, ...older]);
    expect(r.days_with_data_7d).toBe(3);
    expect(r.days_with_data_28d).toBe(18);
    expect(r.acute_load_7d).toBe(10);
    expect(r.chronic_load_28d).toBe(10); // chronic is available…
    expect(r.acwr).toBeNull(); // …but acwr is suppressed
    expect(r.acwr_zone).toBeNull();
  });
});

describe("computeTrainingLoad — the < 14-of-28-days chronic-base rule (fix 3)", () => {
  it("nulls acwr/acwr_zone for a returning athlete with only ~1 week of history", () => {
    // 7 straight days, no older base. days_with_data_7d = 7 (passes the acute gate),
    // but days_with_data_28d = 7 < 14 → chronic ≈ acute would fake a ~1.0 "optimal".
    const r = computeTrainingLoad(consecutiveCycles(D, Array(7).fill(10)));
    expect(r.days_with_data_7d).toBe(7);
    expect(r.days_with_data_28d).toBe(7);
    expect(r.acute_load_7d).toBe(10);
    expect(r.chronic_load_28d).toBe(10); // chronic value is still reported…
    expect(r.acwr).toBeNull(); // …but ACWR is suppressed for lack of a real chronic base
    expect(r.acwr_zone).toBeNull();
  });

  it("reports acwr once the chronic window reaches 14 days", () => {
    const r = computeTrainingLoad(consecutiveCycles(D, Array(14).fill(10)));
    expect(r.days_with_data_28d).toBe(14);
    expect(r.acwr).toBe(1);
    expect(r.acwr_zone).toBe("optimal");
  });
});

describe("computeTrainingLoad — as_of_date staleness anchor (fix 4)", () => {
  it("null when there is no data", () => {
    expect(computeTrainingLoad([]).as_of_date).toBeNull();
  });
  it("is the newest completed-cycle day used by the trailing windows", () => {
    const r = computeTrainingLoad(consecutiveCycles(D, [10, 10, 10, 10]));
    expect(r.as_of_date).toBe(D);
  });
  it("ignores in-progress cycles when choosing the anchor", () => {
    // A partial cycle on D+1 must NOT become the as_of anchor — only completed days do.
    const completed = consecutiveCycles(D, [10, 10, 10, 10]);
    const inProgress = makeInProgressCycle({ date: shiftDay(D, 1), strain: 99 });
    expect(computeTrainingLoad([inProgress, ...completed]).as_of_date).toBe(D);
  });
});

describe("computeTrainingLoad — ACWR zones (config thresholds 0.8 / 1.3 / 1.5)", () => {
  it("optimal zone (ratio 1.0) with a maintaining trend", () => {
    const r = computeTrainingLoad(consecutiveCycles(D, Array(28).fill(10)));
    expect(r.acute_load_7d).toBe(10);
    expect(r.chronic_load_28d).toBe(10);
    expect(r.acwr).toBe(1);
    expect(r.acwr_zone).toBe("optimal");
    expect(r.training_strain_7d).toBe(70);
    expect(r.trend_direction).toBe("maintaining");
    expect(r.days_with_data_7d).toBe(7);
    expect(r.days_with_data_28d).toBe(28);
  });

  it("undertrained zone (ratio 0.4) with a deloading trend", () => {
    const strains = [...Array(7).fill(5), ...Array(21).fill(15)];
    const r = computeTrainingLoad(consecutiveCycles(D, strains));
    expect(r.acute_load_7d).toBe(5);
    expect(r.chronic_load_28d).toBe(12.5);
    expect(r.acwr).toBe(0.4);
    expect(r.acwr_zone).toBe("undertrained");
    expect(r.trend_direction).toBe("deloading");
  });

  it("caution zone (ratio ~1.33) with a building trend", () => {
    const strains = [...Array(7).fill(15), ...Array(21).fill(10)];
    const r = computeTrainingLoad(consecutiveCycles(D, strains));
    expect(r.acute_load_7d).toBe(15);
    expect(r.chronic_load_28d).toBe(11.25);
    expect(r.acwr).toBe(1.33);
    expect(r.acwr_zone).toBe("caution");
    expect(r.trend_direction).toBe("building");
  });

  it("danger zone (ratio 2.0) with a building trend", () => {
    const strains = [...Array(7).fill(15), ...Array(21).fill(5)];
    const r = computeTrainingLoad(consecutiveCycles(D, strains));
    expect(r.acute_load_7d).toBe(15);
    expect(r.chronic_load_28d).toBe(7.5);
    expect(r.acwr).toBe(2);
    expect(r.acwr_zone).toBe("danger");
    expect(r.training_strain_7d).toBe(105);
    expect(r.trend_direction).toBe("building");
  });
});

describe("computeTrainingLoad — monotony & all-zero strain", () => {
  it("computes monotony = mean/stddev over the acute window (4 days meets the monotony gate)", () => {
    // last 7 window has 4 days: [10,20,10,20] → mean 15, stddev 5 → monotony 3
    const r = computeTrainingLoad(consecutiveCycles(D, [10, 20, 10, 20]));
    expect(r.acute_load_7d).toBe(15);
    expect(r.monotony).toBe(3); // 4 >= 4-day monotony gate → computed, not nulled
    expect(r.days_with_data_7d).toBe(4);
    // …but only 4 of 28 days → chronic-base gate (< 14) still nulls acwr (fix 3).
    expect(r.acwr).toBeNull();
  });

  it("nulls monotony on a light/sparse week (< 4 days) instead of exploding it (fix 1)", () => {
    // [15,16] over 2 present days → mean 15.5, stddev 0.5 → naive monotony 31 (absurd).
    // The completeness gate nulls it so no false "high_monotony" concern fires.
    const r = computeTrainingLoad(consecutiveCycles(D, [15, 16]));
    expect(r.days_with_data_7d).toBe(2);
    expect(r.monotony).toBeNull();
    expect(r.acute_load_7d).toBe(15.5); // acute still reported honestly
  });

  it("all-zero strain → loads 0 but acwr null (chronic 0) and monotony null (stddev 0)", () => {
    const r = computeTrainingLoad(consecutiveCycles(D, Array(28).fill(0)));
    expect(r.acute_load_7d).toBe(0);
    expect(r.chronic_load_28d).toBe(0);
    expect(r.acwr).toBeNull(); // not NaN, not 0
    expect(r.acwr_zone).toBeNull();
    expect(r.monotony).toBeNull();
    expect(r.training_strain_7d).toBe(0);
    expect(r.trend_direction).toBeNull(); // prev window average is 0 → not > 0
    expect(r.days_with_data_7d).toBe(7);
    expect(r.days_with_data_28d).toBe(28);
  });
});
