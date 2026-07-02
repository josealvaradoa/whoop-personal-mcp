import { describe, it, expect } from "vitest";
import { isNightSleep, mapSleepToDay, computeSleepTrend } from "../../src/compute/sleep.js";
import { makeSleep, makeSleepDay, consecutiveSleepDays, shiftDay } from "../helpers/fixtures.js";

const D = "2026-06-15";

describe("isNightSleep (naps and unscored records excluded)", () => {
  it("accepts a scored, non-nap sleep; rejects naps and unscored records", () => {
    expect(isNightSleep(makeSleep({ date: D }))).toBe(true);
    expect(isNightSleep(makeSleep({ date: D, nap: true }))).toBe(false);
    expect(isNightSleep(makeSleep({ date: D, scored: false }))).toBe(false);
  });

  it("filters a mixed collection down to full nights only", () => {
    const mixed = [
      makeSleep({ date: D }), // night
      makeSleep({ date: D, nap: true }), // 40-min nap style record
      makeSleep({ date: shiftDay(D, -1), scored: false }), // pending
    ];
    expect(mixed.filter(isNightSleep)).toHaveLength(1);
  });
});

describe("mapSleepToDay", () => {
  it("derives duration from light+SWS+REM and passes through the score fields", () => {
    const night = [
      makeSleep({
        date: D,
        lightHrs: 3,
        slowWaveHrs: 1.5,
        remHrs: 1.5,
        awakeHrs: 0.5,
        efficiencyPct: 92,
        performancePct: 90,
        respiratoryRate: 15,
      }),
    ]
      .filter(isNightSleep)
      .map(mapSleepToDay)[0];

    expect(night.date).toBe(D);
    expect(night.duration_hrs).toBe(6); // 3 + 1.5 + 1.5 (awake excluded)
    expect(night.efficiency_pct).toBe(92);
    expect(night.performance_pct).toBe(90);
    expect(night.respiratory_rate).toBe(15);
    expect(night.stages).toEqual({
      awake_hrs: 0.5,
      light_hrs: 3,
      slow_wave_hrs: 1.5,
      rem_hrs: 1.5,
    });
  });
});

describe("computeSleepTrend", () => {
  it("empty input → null metrics (never zero)", () => {
    expect(computeSleepTrend([])).toEqual({
      avg_duration_7d_hrs: null,
      avg_efficiency_7d_pct: null,
      sleep_debt_cumulative_hrs: null,
      consistency_score: null,
      trend: null,
    });
  });

  it("sleep debt is negative (a deficit) when nightly duration is below target", () => {
    const days = consecutiveSleepDays(D, Array(7).fill(6)); // target is 8h
    const r = computeSleepTrend(days);
    expect(r.avg_duration_7d_hrs).toBe(6);
    expect(r.sleep_debt_cumulative_hrs).toBe(-14); // 7 * (6 - 8)
    expect(r.avg_efficiency_7d_pct).toBe(90);
    expect(r.consistency_score).toBe(1); // identical durations → perfectly consistent
    expect(r.trend).toBeNull(); // no previous window
  });

  it("sleep debt is positive (a surplus) when nightly duration exceeds target", () => {
    const r = computeSleepTrend(consecutiveSleepDays(D, Array(7).fill(9)));
    expect(r.sleep_debt_cumulative_hrs).toBe(7); // 7 * (9 - 8)
  });

  it("consistency score drops below 1 as durations vary", () => {
    const r = computeSleepTrend(consecutiveSleepDays(D, [8, 6])); // mean 7, stddev 1
    expect(r.avg_duration_7d_hrs).toBe(7);
    expect(r.consistency_score).toBe(0.86); // round(1 - 1/7, 2)
  });

  it("single night → consistency null (stddev undefined) but debt is a real 0", () => {
    const r = computeSleepTrend(consecutiveSleepDays(D, [8]));
    expect(r.avg_duration_7d_hrs).toBe(8);
    expect(r.consistency_score).toBeNull();
    expect(r.sleep_debt_cumulative_hrs).toBe(0);
  });

  it("averages only non-null efficiencies", () => {
    const days = [
      makeSleepDay({ date: D, durationHrs: 8, efficiencyPct: 90 }),
      makeSleepDay({ date: shiftDay(D, -1), durationHrs: 8, efficiencyPct: null }),
      makeSleepDay({ date: shiftDay(D, -2), durationHrs: 8, efficiencyPct: 80 }),
    ];
    expect(computeSleepTrend(days).avg_efficiency_7d_pct).toBe(85); // mean(90, 80)
  });

  it("detects an improving duration trend vs the previous week", () => {
    const days = consecutiveSleepDays(D, [...Array(7).fill(9), ...Array(7).fill(6)]);
    expect(computeSleepTrend(days).trend).toBe("improving");
  });
});
