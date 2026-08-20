import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  daysAgo,
  today,
  getCycles,
  getRecoveryCollection,
  getSleepCollection,
} from "../../whoop/client.js";
import { config } from "../../config.js";
import {
  computeRecoveryTrend,
  cycleDateMap,
  toDailyRecovery,
} from "../../compute/recovery.js";
import { computeHrvTrend } from "../../compute/hrv.js";
import {
  mapSleepToDay,
  computeSleepTrend,
  isNightSleep,
  isSleepDayData,
} from "../../compute/sleep.js";
import { calendarDaysSince } from "../../compute/stats.js";
import {
  getDaysToEvent,
  getCurrentEventPhase,
  computeRecoveryContextStatus,
  computeEventContextAssessmentStatus,
  computeKeyObservations,
  buildEventContextSummary,
} from "../../compute/race-readiness.js";
import {
  defineTool,
  READ_ONLY_ANNOTATIONS,
  CYCLE_DATING_BUFFER_DAYS,
} from "./helpers.js";

export function registerEventContextTool(server: McpServer): void {
  defineTool(
    server,
    "whoop_get_event_context",
    {
      title: "Event Preparation Wellness Context",
      description:
        "Summarize recent WHOOP Recovery, HRV, and sleep observations alongside an explicitly configured event. This is not a readiness score, physiological-fatigue assessment, injury prediction, medical assessment, training prescription, or event clearance. assessment_status is context_available only when minimum data coverage is met and every input is at most two days old; otherwise the tool explicitly abstains. A fresh consecutive-red-band observation may remain visible when other coverage is insufficient, but stale or future-dated observations are withheld. Experimental Day Strain ratios are never used.",
      inputSchema: {},
      outputSchema: {
        computed: z.object({
          days_to_event: z.number().nullable(),
          event_name: z.string().nullable(),
          event_date: z.string().nullable(),
          current_phase: z.string().nullable(),
          assessment_status: z.enum([
            "context_available",
            "event_not_configured",
            "insufficient_data",
            "stale_data",
          ]),
          assessment_available: z.boolean(),
          is_clearance: z.literal(false),
          recovery_context_status: z
            .enum([
              "above_longer_average",
              "similar_to_longer_average",
              "below_longer_average",
              "red_band_streak_alert",
            ])
            .nullable(),
          red_streak_alert: z.boolean(),
          key_observations: z.array(
            z.enum([
              "red_band_streak_observed",
              "recovery_below_longer_average",
              "whoop_sleep_debt_present",
              "sleep_below_configured_target",
              "declining_recovery_trend",
              "declining_hrv_trend",
            ]),
          ),
          weekly_summary: z.string(),
          data_quality: z.object({
            recovery_days_7d: z.number(),
            recovery_days_30d: z.number(),
            hrv_days_7d: z.number(),
            hrv_days_30d: z.number(),
            sleep_nights_7d: z.number(),
            recovery_age_days: z.number().nullable(),
            hrv_age_days: z.number().nullable(),
            sleep_age_days: z.number().nullable(),
          }),
        }),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      errorLabel: "fetching event-preparation wellness context",
    },
    async () => {
      const end = today();
      const [cycles, recoveries, sleeps] = await Promise.all([
        getCycles(daysAgo(30 + CYCLE_DATING_BUFFER_DAYS), end),
        getRecoveryCollection(daysAgo(30), end),
        getSleepCollection(daysAgo(14), end),
      ]);

      const cycleDates = cycleDateMap(cycles, config.athlete.timezone);
      const dailyRecovery = toDailyRecovery(recoveries, cycleDates);
      const recoveryResult = computeRecoveryTrend(dailyRecovery);
      const hrvResult = computeHrvTrend(dailyRecovery);
      const sleepResult = computeSleepTrend(
        sleeps
          .filter(isNightSleep)
          .map((sleep) => mapSleepToDay(sleep, config.athlete.timezone))
          .filter(isSleepDayData),
      );

      const recoveryAgeDays = calendarDaysSince(
        recoveryResult.as_of_date,
        config.athlete.timezone,
      );
      const hrvAgeDays = calendarDaysSince(hrvResult.as_of_date, config.athlete.timezone);
      const sleepAgeDays = calendarDaysSince(sleepResult.as_of_date, config.athlete.timezone);
      const recoveryContextStatus = computeRecoveryContextStatus(
        recoveryResult.avg_7d,
        recoveryResult.avg_30d,
        recoveryResult.consecutive_red_days,
        recoveryResult.days_with_data_7d,
        recoveryResult.days_with_data_30d,
        recoveryAgeDays,
      );
      const assessmentStatus = computeEventContextAssessmentStatus({
        eventConfigured: config.event != null,
        recoveryDays7d: recoveryResult.days_with_data_7d,
        recoveryDays30d: recoveryResult.days_with_data_30d,
        hrvDays7d: hrvResult.days_with_data_7d,
        hrvDays30d: hrvResult.days_with_data_30d,
        sleepNights7d: sleepResult.nights_with_data_7d,
        recoveryAgeDays,
        hrvAgeDays,
        sleepAgeDays,
      });
      const observations = computeKeyObservations({
        assessmentStatus,
        recoveryContextStatus,
        whoopSleepDebtHrs: sleepResult.latest_whoop_sleep_debt_hrs,
        sleepDurationBalanceHrs: sleepResult.sleep_duration_balance_7d_hrs,
        recoveryTrend: recoveryResult.trend,
        hrvTrend: hrvResult.trend,
      });
      const weeklySummary = buildEventContextSummary({
        assessmentStatus,
        recoveryTrend: recoveryResult.trend,
        recoveryContextStatus,
        observations,
      });

      return {
        computed: {
          days_to_event: getDaysToEvent(),
          event_name: config.event?.name ?? null,
          event_date: config.event?.date ?? null,
          current_phase: getCurrentEventPhase(),
          assessment_status: assessmentStatus,
          assessment_available: assessmentStatus === "context_available",
          is_clearance: false as const,
          recovery_context_status: recoveryContextStatus,
          red_streak_alert: recoveryContextStatus === "red_band_streak_alert",
          key_observations: observations,
          weekly_summary: weeklySummary,
          data_quality: {
            recovery_days_7d: recoveryResult.days_with_data_7d,
            recovery_days_30d: recoveryResult.days_with_data_30d,
            hrv_days_7d: hrvResult.days_with_data_7d,
            hrv_days_30d: hrvResult.days_with_data_30d,
            sleep_nights_7d: sleepResult.nights_with_data_7d,
            recovery_age_days: recoveryAgeDays,
            hrv_age_days: hrvAgeDays,
            sleep_age_days: sleepAgeDays,
          },
        },
      };
    },
  );
}
