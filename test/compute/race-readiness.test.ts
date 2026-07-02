import { describe, it, expect } from "vitest";
import {
  computeFitnessTrend,
  computeFatigueStatus,
  computeKeyConcerns,
  buildWeeklySummary,
  getDaysToRace,
  getCurrentPhase,
  weeklyWorkoutVolumeHrs,
} from "../../src/compute/race-readiness.js";
import { makeWorkout } from "../helpers/fixtures.js";

describe("computeFitnessTrend", () => {
  it("returns null when the ACWR zone is unknown", () => {
    expect(computeFitnessTrend(null, "declining")).toBeNull();
  });
  it("maps danger/caution/undertrained zones directly", () => {
    expect(computeFitnessTrend("danger", "improving")).toBe("injury_risk");
    expect(computeFitnessTrend("caution", "stable")).toBe("overreaching");
    expect(computeFitnessTrend("undertrained", "improving")).toBe("undertrained");
  });
  it("optimal zone with DECLINING recovery is an early-overreach signal (the fixed branch)", () => {
    expect(computeFitnessTrend("optimal", "declining")).toBe("overreaching");
  });
  it("optimal zone otherwise reads on_track", () => {
    expect(computeFitnessTrend("optimal", "improving")).toBe("on_track");
    expect(computeFitnessTrend("optimal", "stable")).toBe("on_track");
    expect(computeFitnessTrend("optimal", null)).toBe("on_track");
  });
});

describe("computeFatigueStatus (consecutive-red alert threshold 3)", () => {
  it("is critical once the consecutive-red alert threshold is reached, regardless of averages", () => {
    expect(computeFatigueStatus(null, null, 3)).toBe("critical");
    expect(computeFatigueStatus(80, 80, 5)).toBe("critical");
  });
  it("returns null when averages are missing (and no red alert)", () => {
    expect(computeFatigueStatus(null, 50, 0)).toBeNull();
    expect(computeFatigueStatus(50, null, 0)).toBeNull();
    expect(computeFatigueStatus(50, 0, 0)).toBeNull();
  });
  it("classifies fresh / manageable / accumulating from the 7d-vs-30d delta", () => {
    expect(computeFatigueStatus(60, 50, 0)).toBe("fresh"); // +20%
    expect(computeFatigueStatus(52, 50, 0)).toBe("manageable"); // +4%
    expect(computeFatigueStatus(40, 50, 0)).toBe("accumulating"); // -20%
  });
});

describe("computeKeyConcerns", () => {
  const base = {
    sleepDebtHrs: -1,
    monotony: 1,
    acwr: 1.0,
    recoveryTrend: "stable" as const,
    hrvTrend: "stable" as const,
    weeklyVolumeHrs: 10,
    currentPhase: "build",
  };

  it("returns no concerns when everything is within range", () => {
    expect(computeKeyConcerns(base)).toEqual([]);
  });

  it("flags sleep debt, monotony, danger-zone ACWR and declining recovery/HRV", () => {
    const c = computeKeyConcerns({
      ...base,
      sleepDebtHrs: -5,
      monotony: 2.5,
      acwr: 1.6,
      recoveryTrend: "declining",
      hrvTrend: "declining",
    });
    expect(c).toEqual(
      expect.arrayContaining([
        "sleep_debt",
        "high_monotony",
        "acwr_danger",
        "declining_recovery",
        "declining_hrv",
      ]),
    );
    expect(c).not.toContain("acwr_high"); // danger and high are mutually exclusive
  });

  it("uses acwr_high (not danger) for elevated-but-not-dangerous ACWR", () => {
    expect(computeKeyConcerns({ ...base, acwr: 1.4 })).toContain("acwr_high");
  });

  it("flags low_volume only in build/peak phases", () => {
    expect(computeKeyConcerns({ ...base, weeklyVolumeHrs: 3, currentPhase: "build" })).toContain(
      "low_volume",
    );
    expect(
      computeKeyConcerns({ ...base, weeklyVolumeHrs: 3, currentPhase: "base_building" }),
    ).not.toContain("low_volume");
  });

  it("never invents concerns from null inputs", () => {
    expect(
      computeKeyConcerns({
        sleepDebtHrs: null,
        monotony: null,
        acwr: null,
        recoveryTrend: null,
        hrvTrend: null,
        weeklyVolumeHrs: null,
        currentPhase: "build",
      }),
    ).toEqual([]);
  });
});

describe("buildWeeklySummary", () => {
  it("summarizes a healthy week and appends the default recommendation", () => {
    const s = buildWeeklySummary({
      recoveryTrend: "improving",
      acwrZone: "optimal",
      acwr: 1.0,
      concerns: [],
      fatigueStatus: "fresh",
    });
    expect(s).toContain("Recovery trending well.");
    expect(s).toContain("ACWR is 1 (optimal zone).");
    expect(s).toContain("Continue current plan.");
  });

  it("surfaces declining recovery and a danger-zone concern (no default recommendation)", () => {
    const s = buildWeeklySummary({
      recoveryTrend: "declining",
      acwrZone: "danger",
      acwr: 1.8,
      concerns: ["acwr_danger"],
      fatigueStatus: "critical",
    });
    expect(s).toContain("Recovery has been declining.");
    expect(s).toContain("ACWR is 1.8 (danger zone).");
    expect(s).toContain("mandatory deload");
    expect(s).not.toContain("Continue current plan.");
  });

  it("states when the recovery trend and ACWR are unavailable", () => {
    const s = buildWeeklySummary({
      recoveryTrend: null,
      acwrZone: null,
      acwr: null,
      concerns: [],
      fatigueStatus: null,
    });
    expect(s).toContain("Recovery trend is unavailable (insufficient recent data).");
    expect(s).not.toContain("ACWR is"); // null ACWR is omitted entirely
    expect(s).toContain("Continue current plan.");
  });
});

describe("weeklyWorkoutVolumeHrs (fix 6 — SCORED workouts only)", () => {
  it("sums only SCORED workouts; unscored activities never inflate volume", () => {
    const workouts = [
      makeWorkout({ date: "2026-06-15", durationMin: 60 }), // SCORED → 1.0h
      makeWorkout({ date: "2026-06-14", durationMin: 90, scoreState: "PENDING_SCORE" }), // excluded
      makeWorkout({ date: "2026-06-13", durationMin: 30 }), // SCORED → 0.5h
    ];
    // Only the two SCORED workouts count: 60 + 30 min = 1.5h (the 90-min pending is out).
    expect(weeklyWorkoutVolumeHrs(workouts)).toBe(1.5);
  });

  it("is a real 0 (never NaN) when there are no scored workouts", () => {
    expect(weeklyWorkoutVolumeHrs([])).toBe(0);
    expect(
      weeklyWorkoutVolumeHrs([makeWorkout({ date: "2026-06-15", scoreState: "PENDING_SCORE" })]),
    ).toBe(0);
  });

  it("skips a workout with a non-finite duration (bad timestamp) rather than NaN-ing the sum", () => {
    const good = makeWorkout({ date: "2026-06-15", durationMin: 60 });
    const badTs = makeWorkout({ date: "2026-06-14", durationMin: 60 });
    (badTs as { end: string }).end = "not-a-timestamp";
    expect(weeklyWorkoutVolumeHrs([good, badTs])).toBe(1); // only the good 60-min workout
  });
});

describe("getDaysToRace / getCurrentPhase (config-driven, clock-dependent)", () => {
  it("returns an integer number of days to the configured race", () => {
    expect(Number.isInteger(getDaysToRace())).toBe(true);
  });
  it("returns a known phase name or off_season", () => {
    const valid = new Set(["base_building", "build", "peak", "taper", "race_week", "off_season"]);
    expect(valid.has(getCurrentPhase())).toBe(true);
  });
});
