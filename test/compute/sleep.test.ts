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
    const source = makeSleep({
      date: D,
      lightHrs: 3,
      slowWaveHrs: 1.5,
      remHrs: 1.5,
      awakeHrs: 0.5,
      efficiencyPct: 92,
      performancePct: 90,
      respiratoryRate: 15,
    });
    if (!isNightSleep(source)) throw new Error("fixture should be scored nightly sleep");
    const night = mapSleepToDay(source, "UTC");
    if (night == null) throw new Error("valid fixture should map to a sleep day");

    expect(night.date).toBe(D);
    expect(night.duration_hrs).toBe(6); // 3 + 1.5 + 1.5 (awake excluded)
    expect(night.sleep_need_hrs).toBe(8);
    expect(night.whoop_sleep_debt_hrs).toBe(0);
    expect(night.consistency_pct).toBe(80);
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

  it("dates a night by its WAKE day, not its start day (fix 8)", () => {
    // A night that starts the evening before but ends in the morning of D belongs to
    // D — the same day its recovery/cycle is dated by — so trends align.
    const crossMidnight = {
      ...makeSleep({ date: D }),
      start: `${shiftDay(D, -1)}T22:30:00.000Z`,
      end: `${D}T06:15:00.000Z`,
    };
    if (!isNightSleep(crossMidnight)) throw new Error("fixture should be nightly sleep");
    const mapped = mapSleepToDay(crossMidnight, "UTC");
    if (mapped == null) throw new Error("valid fixture should map to a sleep day");
    expect(mapped.date).toBe(D); // wake day, not the start day (D-1)
  });

  it("uses the configured owner timezone for wake-day dating", () => {
    const source = {
      ...makeSleep({ date: D }),
      end: `${D}T01:00:00.000Z`,
    };
    if (!isNightSleep(source)) throw new Error("fixture should be nightly sleep");
    expect(mapSleepToDay(source, "America/New_York")?.date).toBe(shiftDay(D, -1));
  });

  it("drops non-finite stages and normalizes dirty nullable score metrics", () => {
    const badStage = makeSleep({ date: D });
    if (!isNightSleep(badStage)) throw new Error("fixture should be nightly sleep");
    badStage.score.stage_summary.total_rem_sleep_time_milli = Number.NaN;
    expect(mapSleepToDay(badStage, "UTC")).toBeNull();

    const dirtyOptional = makeSleep({ date: D });
    if (!isNightSleep(dirtyOptional)) throw new Error("fixture should be nightly sleep");
    dirtyOptional.score.sleep_efficiency_percentage = Number.NaN;
    dirtyOptional.score.sleep_consistency_percentage = 120;
    dirtyOptional.score.respiratory_rate = Number.NaN;
    const mapped = mapSleepToDay(dirtyOptional, "UTC");
    expect(mapped?.efficiency_pct).toBeNull();
    expect(mapped?.consistency_pct).toBeNull();
    expect(mapped?.respiratory_rate).toBeNull();
  });
});

describe("computeSleepTrend", () => {
  it("empty input → null metrics (never zero)", () => {
    expect(computeSleepTrend([])).toEqual({
      avg_duration_7d_hrs: null,
      avg_sleep_need_7d_hrs: null,
      avg_efficiency_7d_pct: null,
      avg_consistency_7d_pct: null,
      configured_sleep_target_hrs: 8,
      sleep_duration_balance_7d_hrs: null,
      latest_whoop_sleep_debt_hrs: null,
      nights_with_data_7d: 0,
      duration_direction: null,
      as_of_date: null,
    });
  });

  it("reports a negative signed duration balance when sleep is below the configured target", () => {
    const days = consecutiveSleepDays(D, Array(7).fill(6)); // target is 8h
    const r = computeSleepTrend(days, 8);
    expect(r.avg_duration_7d_hrs).toBe(6);
    expect(r.sleep_duration_balance_7d_hrs).toBe(-14); // 7 * (6 - 8)
    expect(r.avg_efficiency_7d_pct).toBe(90);
    expect(r.avg_consistency_7d_pct).toBeNull(); // never invent consistency from duration SD
    expect(r.latest_whoop_sleep_debt_hrs).toBeNull();
    expect(r.duration_direction).toBeNull(); // no previous window
  });

  it("reports a positive signed duration balance when sleep exceeds the target", () => {
    const r = computeSleepTrend(consecutiveSleepDays(D, Array(7).fill(9)), 8);
    expect(r.sleep_duration_balance_7d_hrs).toBe(7); // 7 * (9 - 8)
  });

  it("averages WHOOP's native consistency and Sleep Need fields", () => {
    const days = [
      makeSleepDay({
        date: D,
        durationHrs: 8,
        sleepNeedHrs: 9,
        whoopSleepDebtHrs: 1.5,
        consistencyPct: 80,
      }),
      makeSleepDay({
        date: shiftDay(D, -1),
        durationHrs: 7,
        sleepNeedHrs: 8,
        whoopSleepDebtHrs: 1,
        consistencyPct: 90,
      }),
    ];
    const r = computeSleepTrend(days);
    expect(r.avg_sleep_need_7d_hrs).toBe(8.5);
    expect(r.avg_consistency_7d_pct).toBe(85);
    expect(r.latest_whoop_sleep_debt_hrs).toBe(1.5);
  });

  it("single night keeps native consistency unavailable and balance at a real zero", () => {
    const r = computeSleepTrend(consecutiveSleepDays(D, [8]), 8);
    expect(r.avg_duration_7d_hrs).toBe(8);
    expect(r.avg_consistency_7d_pct).toBeNull();
    expect(r.sleep_duration_balance_7d_hrs).toBe(0);
  });

  it("does not invent a target balance when no sleep target is configured", () => {
    const result = computeSleepTrend(consecutiveSleepDays(D, [8]), null);
    expect(result.configured_sleep_target_hrs).toBeNull();
    expect(result.sleep_duration_balance_7d_hrs).toBeNull();
  });

  it("averages only non-null efficiencies", () => {
    const days = [
      makeSleepDay({ date: D, durationHrs: 8, efficiencyPct: 90 }),
      makeSleepDay({ date: shiftDay(D, -1), durationHrs: 8, efficiencyPct: null }),
      makeSleepDay({ date: shiftDay(D, -2), durationHrs: 8, efficiencyPct: 80 }),
    ];
    expect(computeSleepTrend(days).avg_efficiency_7d_pct).toBe(85); // mean(90, 80)
  });

  it("neutrally reports a longer duration window vs the previous week", () => {
    const days = consecutiveSleepDays(D, [...Array(7).fill(9), ...Array(7).fill(6)]);
    expect(computeSleepTrend(days).duration_direction).toBe("longer");
  });

  it("reports as_of_date as the newest sleep day (fix 4)", () => {
    expect(computeSleepTrend(consecutiveSleepDays(D, [8, 8])).as_of_date).toBe(D);
    expect(computeSleepTrend([]).as_of_date).toBeNull();
  });
});
