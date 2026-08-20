import { describe, it, expect } from "vitest";
import { config } from "../../src/config.js";
import {
  computeRecoveryContextStatus,
  computeEventContextAssessmentStatus,
  computeKeyObservations,
  buildEventContextSummary,
  getDaysToEvent,
  getCurrentEventPhase,
} from "../../src/compute/race-readiness.js";

describe("computeRecoveryContextStatus", () => {
  it("surfaces a repeated red-band observation despite sparse averages", () => {
    expect(computeRecoveryContextStatus(null, null, 3, 0, 0, 0)).toBe(
      "red_band_streak_alert",
    );
    expect(computeRecoveryContextStatus(80, 80, 5, 7, 30, 0)).toBe(
      "red_band_streak_alert",
    );
  });

  it("abstains when recent or longer-window coverage is insufficient", () => {
    expect(computeRecoveryContextStatus(40, 50, 0, 3, 30, 0)).toBeNull();
    expect(computeRecoveryContextStatus(40, 50, 0, 7, 13, 0)).toBeNull();
    expect(computeRecoveryContextStatus(null, 50, 0, 7, 30, 0)).toBeNull();
  });

  it("withholds repeated red-band observations when Recovery is stale or future-dated", () => {
    expect(computeRecoveryContextStatus(20, 30, 3, 7, 30, 3)).toBeNull();
    expect(computeRecoveryContextStatus(20, 30, 3, 7, 30, -1)).toBeNull();
    expect(computeRecoveryContextStatus(20, 30, 3, 7, 30, null)).toBeNull();
  });

  it("describes the recent Recovery average relative to the longer average", () => {
    expect(computeRecoveryContextStatus(60, 50, 0, 7, 30, 0)).toBe("above_longer_average");
    expect(computeRecoveryContextStatus(52, 50, 0, 7, 30, 0)).toBe("similar_to_longer_average");
    expect(computeRecoveryContextStatus(40, 50, 0, 7, 30, 0)).toBe("below_longer_average");
  });
});

describe("computeEventContextAssessmentStatus", () => {
  const complete = {
    eventConfigured: true,
    recoveryDays7d: 7,
    recoveryDays30d: 30,
    hrvDays7d: 7,
    hrvDays30d: 30,
    sleepNights7d: 7,
    recoveryAgeDays: 0,
    hrvAgeDays: 0,
    sleepAgeDays: 0,
  };

  it("abstains when no event is configured", () => {
    expect(computeEventContextAssessmentStatus({ ...complete, eventConfigured: false })).toBe(
      "event_not_configured",
    );
  });

  it("abstains when any required signal has insufficient coverage", () => {
    expect(computeEventContextAssessmentStatus({ ...complete, recoveryDays30d: 13 })).toBe(
      "insufficient_data",
    );
    expect(computeEventContextAssessmentStatus({ ...complete, hrvDays7d: 4 })).toBe(
      "insufficient_data",
    );
    expect(computeEventContextAssessmentStatus({ ...complete, sleepNights7d: 3 })).toBe(
      "insufficient_data",
    );
  });

  it("abstains when any required signal is missing, stale, or future-dated", () => {
    expect(computeEventContextAssessmentStatus({ ...complete, sleepAgeDays: null })).toBe(
      "stale_data",
    );
    expect(computeEventContextAssessmentStatus({ ...complete, hrvAgeDays: 3 })).toBe("stale_data");
    expect(computeEventContextAssessmentStatus({ ...complete, recoveryAgeDays: -1 })).toBe(
      "stale_data",
    );
  });

  it("returns context_available only with complete, recent inputs", () => {
    expect(computeEventContextAssessmentStatus(complete)).toBe("context_available");
  });
});

describe("computeKeyObservations", () => {
  it("uses neutral observations and never considers the experimental ratio or monotony", () => {
    expect(
      computeKeyObservations({
        assessmentStatus: "context_available",
        recoveryContextStatus: "red_band_streak_alert",
        whoopSleepDebtHrs: 1.5,
        sleepDurationBalanceHrs: -2,
        recoveryTrend: "declining",
        hrvTrend: "declining",
      }),
    ).toEqual([
      "red_band_streak_observed",
      "whoop_sleep_debt_present",
      "sleep_below_configured_target",
      "declining_recovery_trend",
      "declining_hrv_trend",
    ]);
  });

  it("does not invent observations from unavailable values", () => {
    expect(
      computeKeyObservations({
        assessmentStatus: "context_available",
        recoveryContextStatus: null,
        whoopSleepDebtHrs: null,
        sleepDurationBalanceHrs: null,
        recoveryTrend: null,
        hrvTrend: null,
      }),
    ).toEqual([]);
  });

  it("withholds structured interpretations when inputs are stale", () => {
    expect(
      computeKeyObservations({
        assessmentStatus: "stale_data",
        recoveryContextStatus: "below_longer_average",
        whoopSleepDebtHrs: 2,
        sleepDurationBalanceHrs: -2,
        recoveryTrend: "declining",
        hrvTrend: "declining",
      }),
    ).toEqual([]);
  });

  it("keeps only a fresh red-band streak when other coverage is insufficient", () => {
    expect(
      computeKeyObservations({
        assessmentStatus: "insufficient_data",
        recoveryContextStatus: "red_band_streak_alert",
        whoopSleepDebtHrs: 2,
        sleepDurationBalanceHrs: -2,
        recoveryTrend: "declining",
        hrvTrend: "declining",
      }),
    ).toEqual(["red_band_streak_observed"]);
  });
});

describe("buildEventContextSummary", () => {
  it("leads with a neutral repeated red-band observation even while abstaining", () => {
    const summary = buildEventContextSummary({
      assessmentStatus: "insufficient_data",
      recoveryTrend: null,
      recoveryContextStatus: "red_band_streak_alert",
      observations: ["red_band_streak_observed"],
    });
    expect(summary.startsWith("Recent repeated red-band Recovery observation")).toBe(true);
    expect(summary).toContain("withheld");
    expect(summary).toContain("not medical advice");
    expect(summary).not.toMatch(/critical|fatigue|continue current plan|mandatory deload/i);
  });

  it("describes available context without issuing a training prescription", () => {
    const summary = buildEventContextSummary({
      assessmentStatus: "context_available",
      recoveryTrend: "declining",
      recoveryContextStatus: "below_longer_average",
      observations: ["declining_recovery_trend", "whoop_sleep_debt_present"],
    });
    expect(summary).toContain("recent Recovery average is below");
    expect(summary).toContain("WHOOP reports a positive sleep-debt contribution");
    expect(summary).toContain("not medical advice");
    expect(summary).not.toMatch(/rest day|deload|safe|injury risk/i);
  });
});

describe("configured event helpers", () => {
  it("returns null rather than inventing an event when none is configured", () => {
    if (config.event) {
      expect(Number.isInteger(getDaysToEvent())).toBe(true);
      expect(typeof getCurrentEventPhase()).toBe("string");
    } else {
      expect(getDaysToEvent()).toBeNull();
      expect(getCurrentEventPhase()).toBeNull();
    }
  });

  it("uses the owner timezone's local date for days-to-event", () => {
    if (!config.event) return;
    const nearMidnightUtc = new Date(`${config.event.date}T01:00:00.000Z`);
    expect(getDaysToEvent(nearMidnightUtc, "UTC")).toBe(0);
    expect(getDaysToEvent(nearMidnightUtc, "America/New_York")).toBe(1);
  });
});
