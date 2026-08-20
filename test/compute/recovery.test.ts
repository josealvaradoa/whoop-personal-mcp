import { describe, it, expect } from "vitest";
import {
  isScoredRecovery,
  cycleDateMap,
  toDailyRecovery,
  getRecoveryBand,
  computeTrend,
  computeRecoveryTrend,
  computeBaselineComparison,
} from "../../src/compute/recovery.js";
import {
  makeCycle,
  makeRecovery,
  consecutiveRecovery,
  makeDailyRecovery,
  shiftDay,
} from "../helpers/fixtures.js";

const D = "2026-06-15";

describe("isScoredRecovery", () => {
  it("accepts SCORED records with a score and rejects PENDING_SCORE", () => {
    expect(isScoredRecovery(makeRecovery({ cycleId: 1, scored: true }))).toBe(true);
    expect(isScoredRecovery(makeRecovery({ cycleId: 1, scored: false }))).toBe(false);
    expect(isScoredRecovery(makeRecovery({ cycleId: 1, scoreState: "UNSCORABLE" }))).toBe(false);
  });
});

describe("toDailyRecovery (mirrors how tools build DailyRecovery via a cycle-id→date map)", () => {
  it("builds cycle dates in the configured owner timezone", () => {
    const cycle = {
      ...makeCycle({ date: "2026-06-15", id: 7 }),
      start: "2026-06-15T01:00:00.000Z",
    };
    expect(cycleDateMap([cycle], "America/New_York").get(7)).toBe("2026-06-14");
  });

  it("keeps only scored records whose cycle_id is dated, mapping via the cycle map", () => {
    const cycleDates = new Map([
      [1, "2026-06-10"],
      [2, "2026-06-11"],
    ]);
    const recoveries = [
      makeRecovery({ cycleId: 1, recoveryScore: 70, hrv: 85, rhr: 48 }),
      makeRecovery({ cycleId: 2, recoveryScore: 40, hrv: 60, rhr: 55 }),
      makeRecovery({ cycleId: 1, scored: false }), // unscored → excluded
      makeRecovery({ cycleId: 99, recoveryScore: 50 }), // cycle not in the date map → excluded
    ];
    const daily = toDailyRecovery(recoveries, cycleDates);
    expect(daily).toHaveLength(2);
    const byDate = Object.fromEntries(daily.map((d) => [d.date, d]));
    expect(byDate["2026-06-10"]).toEqual({
      date: "2026-06-10",
      recovery_score: 70,
      hrv_rmssd: 85,
      resting_heart_rate: 48,
    });
    expect(byDate["2026-06-11"].recovery_score).toBe(40);
  });
});

describe("getRecoveryBand (WHOOP product boundaries)", () => {
  it("maps exactly 0-33 red, 34-66 yellow, and 67-100 green", () => {
    expect(getRecoveryBand(0)).toBe("red");
    expect(getRecoveryBand(33)).toBe("red");
    expect(getRecoveryBand(34)).toBe("yellow");
    expect(getRecoveryBand(66)).toBe("yellow");
    expect(getRecoveryBand(67)).toBe("green");
    expect(getRecoveryBand(100)).toBe("green");
  });
});

describe("computeTrend", () => {
  it("returns null when either average is missing or the long average is 0", () => {
    expect(computeTrend(null, 50)).toBeNull();
    expect(computeTrend(50, null)).toBeNull();
    expect(computeTrend(50, 0)).toBeNull();
  });
  it("classifies improving / declining / stable around the +/-5% band", () => {
    expect(computeTrend(110, 100)).toBe("improving"); // +10%
    expect(computeTrend(90, 100)).toBe("declining"); // -10%
    expect(computeTrend(100, 100)).toBe("stable"); // 0%
    expect(computeTrend(95, 100)).toBe("stable"); // exactly -5% is not < -5%
  });
});

describe("computeRecoveryTrend", () => {
  it("empty input → null averages/trend and zero consecutive counts (never fabricated)", () => {
    expect(computeRecoveryTrend([])).toEqual({
      avg_7d: null,
      avg_30d: null,
      trend: null,
      consecutive_red_days: 0,
      consecutive_yellow_days: 0,
      consecutive_green_days: 0,
      days_with_data_7d: 0,
      days_with_data_30d: 0,
      as_of_date: null,
    });
  });

  it("counts consecutive same-zone days from the most recent day", () => {
    // newest-first: green, green, then yellow breaks the streak
    const daily = consecutiveRecovery(D, [70, 68, 40, 80, 80]);
    const r = computeRecoveryTrend(daily);
    expect(r.consecutive_green_days).toBe(2);
    expect(r.consecutive_yellow_days).toBe(0);
    expect(r.consecutive_red_days).toBe(0);
    expect(r.avg_7d).toBe(68); // round(mean([70,68,40,80,80]))
    expect(r.trend).toBeNull(); // fewer than 14 observations in the 30-day window
    expect(r.days_with_data_7d).toBe(5);
    expect(r.days_with_data_30d).toBe(5);
  });

  it("counts a red streak (feeds the consecutive-red alert)", () => {
    const daily = consecutiveRecovery(D, [20, 25, 30, 70]);
    const r = computeRecoveryTrend(daily);
    expect(r.consecutive_red_days).toBe(3);
  });

  it("does NOT count calendar-gapped red readings as a streak (fix 2)", () => {
    // Three red readings scattered over 11 days (D, D-5, D-10) are NOT a 3-day streak;
    // a gap after the newest day ends it, so it cannot masquerade as repeated daily red bands.
    const daily = [
      makeDailyRecovery({ date: D, recoveryScore: 20 }),
      makeDailyRecovery({ date: shiftDay(D, -5), recoveryScore: 25 }),
      makeDailyRecovery({ date: shiftDay(D, -10), recoveryScore: 30 }),
    ];
    const r = computeRecoveryTrend(daily);
    expect(r.consecutive_red_days).toBe(1); // was 3 before the calendar-adjacency fix
  });

  it("extends the streak only across adjacent days, stopping at the first gap (fix 2)", () => {
    // Red on D and D-1 (adjacent) → streak 2; the gap before D-6 stops it there.
    const daily = [
      makeDailyRecovery({ date: D, recoveryScore: 20 }),
      makeDailyRecovery({ date: shiftDay(D, -1), recoveryScore: 22 }),
      makeDailyRecovery({ date: shiftDay(D, -6), recoveryScore: 24 }),
    ];
    expect(computeRecoveryTrend(daily).consecutive_red_days).toBe(2);
  });

  it("reports as_of_date as the newest day with data (fix 4)", () => {
    const daily = consecutiveRecovery(D, [70, 68, 40]);
    expect(computeRecoveryTrend(daily).as_of_date).toBe(D);
    expect(computeRecoveryTrend([]).as_of_date).toBeNull();
  });

  it("drops a 'scored' record carrying a non-finite numeric instead of failing (fix 9)", () => {
    // A dirty SCORED recovery (null hrv) must not flow a null into a z.number() field.
    const cycleDates = new Map([
      [1, "2026-06-10"],
      [2, "2026-06-11"],
    ]);
    const dirty = makeRecovery({ cycleId: 2, recoveryScore: 50 });
    // Simulate WHOOP returning a scored record with a missing numeric.
    (dirty.score as { hrv_rmssd_milli: number }).hrv_rmssd_milli = NaN;
    const daily = toDailyRecovery(
      [makeRecovery({ cycleId: 1, recoveryScore: 70, hrv: 85, rhr: 48 }), dirty],
      cycleDates,
    );
    expect(daily).toHaveLength(1);
    expect(daily[0].date).toBe("2026-06-10");
  });

  it("detects a declining trend (recent 7d well below the 30d window)", () => {
    const daily = consecutiveRecovery(D, [...Array(7).fill(40), ...Array(23).fill(80)]);
    const r = computeRecoveryTrend(daily);
    expect(r.avg_7d).toBe(40);
    expect(r.avg_30d).toBe(71); // round(2120/30)
    expect(r.trend).toBe("declining");
    expect(r.consecutive_yellow_days).toBe(7); // seven 40s are all yellow
  });

  it("detects an improving trend", () => {
    const daily = consecutiveRecovery(D, [...Array(7).fill(80), ...Array(23).fill(40)]);
    expect(computeRecoveryTrend(daily).trend).toBe("improving");
  });
});

describe("computeBaselineComparison", () => {
  it("returns null when today's value is missing or the baseline is empty", () => {
    expect(computeBaselineComparison(null, [100, 100])).toBeNull();
    expect(computeBaselineComparison(50, [])).toBeNull();
  });
  it("returns the signed percent difference vs the 30-day mean", () => {
    expect(computeBaselineComparison(110, [100, 100])).toBe(10);
    expect(computeBaselineComparison(90, [100])).toBe(-10);
    expect(computeBaselineComparison(100, [100])).toBe(0); // a real 0, not missing
  });
});
