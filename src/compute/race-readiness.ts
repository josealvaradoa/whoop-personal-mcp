import { config } from "../config.js";
import { calendarDate, dayDiff } from "./stats.js";
import type { Trend } from "./recovery.js";

export type RecoveryContextStatus =
  | "above_longer_average"
  | "similar_to_longer_average"
  | "below_longer_average"
  | "red_band_streak_alert";
export type EventContextAssessmentStatus =
  | "context_available"
  | "event_not_configured"
  | "insufficient_data"
  | "stale_data";
export type KeyObservation =
  | "red_band_streak_observed"
  | "recovery_below_longer_average"
  | "whoop_sleep_debt_present"
  | "sleep_below_configured_target"
  | "declining_recovery_trend"
  | "declining_hrv_trend";

export function getDaysToEvent(
  now = new Date(),
  timeZone = config.athlete.timezone,
): number | null {
  if (!config.event) return null;
  const ownerToday = calendarDate(now, timeZone);
  return ownerToday == null ? null : dayDiff(config.event.date, ownerToday);
}

export function getCurrentEventPhase(
  now = new Date(),
  timeZone = config.athlete.timezone,
): string | null {
  if (!config.event) return null;
  const date = calendarDate(now, timeZone);
  if (date == null) return null;
  const phase = config.event.phases.find(
    (candidate) => date >= candidate.start && date <= candidate.end,
  );
  return phase?.name ?? "outside_configured_phases";
}

export function computeRecoveryContextStatus(
  avg7d: number | null,
  avg30d: number | null,
  consecutiveRedDays: number,
  daysWithData7d: number,
  daysWithData30d: number,
  recoveryAgeDays: number | null,
): RecoveryContextStatus | null {
  // Never present an old or future-dated observation as current context. A fresh
  // configured red-streak observation may remain visible when averages are sparse;
  // it is still a product-band observation, not a diagnosis or exercise order.
  if (recoveryAgeDays == null || recoveryAgeDays < 0 || recoveryAgeDays > 2) {
    return null;
  }
  if (consecutiveRedDays >= config.thresholds.consecutive_red_alert) {
    return "red_band_streak_alert";
  }
  if (
    daysWithData7d < 4 ||
    daysWithData30d < 14 ||
    avg7d == null ||
    avg30d == null ||
    avg30d === 0
  ) {
    return null;
  }
  const difference = (avg7d - avg30d) / avg30d;
  if (difference > 0.1) return "above_longer_average";
  if (difference > -0.1) return "similar_to_longer_average";
  return "below_longer_average";
}

export function computeEventContextAssessmentStatus(data: {
  eventConfigured: boolean;
  recoveryDays7d: number;
  recoveryDays30d: number;
  hrvDays7d: number;
  hrvDays30d: number;
  sleepNights7d: number;
  recoveryAgeDays: number | null;
  hrvAgeDays: number | null;
  sleepAgeDays: number | null;
}): EventContextAssessmentStatus {
  if (!data.eventConfigured) return "event_not_configured";
  if (
    data.recoveryDays7d < 4 ||
    data.recoveryDays30d < 14 ||
    data.hrvDays7d < 5 ||
    data.hrvDays30d < 14 ||
    data.sleepNights7d < 4
  ) {
    return "insufficient_data";
  }
  const ages = [data.recoveryAgeDays, data.hrvAgeDays, data.sleepAgeDays];
  if (ages.some((age) => age == null || age > 2 || age < 0)) return "stale_data";
  return "context_available";
}

export function computeKeyObservations(data: {
  assessmentStatus: EventContextAssessmentStatus;
  recoveryContextStatus: RecoveryContextStatus | null;
  whoopSleepDebtHrs: number | null;
  sleepDurationBalanceHrs: number | null;
  recoveryTrend: Trend | null;
  hrvTrend: Trend | null;
}): KeyObservation[] {
  // Do not leak interpretations from stale or absent inputs through structured
  // output. The one deliberate exception is a fresh product-band streak when
  // other data coverage is merely sparse; recoveryContextStatus already gates
  // that signal on a 0-2 day age.
  if (data.assessmentStatus !== "context_available") {
    return data.assessmentStatus === "insufficient_data" &&
      data.recoveryContextStatus === "red_band_streak_alert"
      ? ["red_band_streak_observed"]
      : [];
  }
  const observations: KeyObservation[] = [];
  if (data.recoveryContextStatus === "red_band_streak_alert") {
    observations.push("red_band_streak_observed");
  } else if (data.recoveryContextStatus === "below_longer_average") {
    observations.push("recovery_below_longer_average");
  }
  if (data.whoopSleepDebtHrs != null && data.whoopSleepDebtHrs > 0) {
    observations.push("whoop_sleep_debt_present");
  }
  if (data.sleepDurationBalanceHrs != null && data.sleepDurationBalanceHrs < 0) {
    observations.push("sleep_below_configured_target");
  }
  if (data.recoveryTrend === "declining") observations.push("declining_recovery_trend");
  if (data.hrvTrend === "declining") observations.push("declining_hrv_trend");
  return observations;
}

export function buildEventContextSummary(data: {
  assessmentStatus: EventContextAssessmentStatus;
  recoveryTrend: Trend | null;
  recoveryContextStatus: RecoveryContextStatus | null;
  observations: KeyObservation[];
}): string {
  const parts: string[] = [];

  // Keep a fresh red-streak observation at the front even when other coverage is sparse.
  if (data.recoveryContextStatus === "red_band_streak_alert") {
    parts.push(
      "Recent repeated red-band Recovery observation: the configured consecutive-red-band threshold is met.",
    );
  }

  if (data.assessmentStatus === "event_not_configured") {
    parts.push("Event-preparation context is unavailable because no event is configured.");
  } else if (data.assessmentStatus === "insufficient_data") {
    parts.push("Event-preparation context is withheld because recent data coverage is insufficient.");
  } else if (data.assessmentStatus === "stale_data") {
    parts.push("Event-preparation context is withheld because one or more inputs are stale.");
  } else {
    if (data.recoveryTrend === "improving") {
      parts.push("The recent Recovery average is above the longer-window average.");
    } else if (data.recoveryTrend === "declining") {
      parts.push("The recent Recovery average is below the longer-window average.");
    } else if (data.recoveryTrend === "stable") {
      parts.push("The recent and longer-window Recovery averages are similar.");
    }

    if (data.observations.includes("whoop_sleep_debt_present")) {
      parts.push("WHOOP reports a positive sleep-debt contribution to current Sleep Need.");
    }
    if (data.observations.includes("sleep_below_configured_target")) {
      parts.push("Recorded sleep is below the configured duration target over the recent window.");
    }
    if (data.observations.includes("declining_hrv_trend")) {
      parts.push("The recent HRV average is below the longer-window average.");
    }
  }

  parts.push(
    "This is limited wellness context, not medical advice, injury prediction, or event clearance.",
  );
  return parts.join(" ");
}
