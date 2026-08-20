import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { daysAgo, today, getWorkoutCollection } from "../../whoop/client.js";
import { calendarDate, kjToKcal, shiftCalendarDate } from "../../compute/stats.js";
import { config } from "../../config.js";
import { defineTool, READ_ONLY_ANNOTATIONS } from "./helpers.js";

const MILLI_TO_MIN = 1 / (1000 * 60);

export function registerWorkoutsTool(server: McpServer): void {
  defineTool(
    server,
    "whoop_get_workouts",
    {
      title: "Workout History",
      description:
        "Get scored workout history with sport, per-workout Strain, duration, heart rate, and heart-rate-zone time. The requested raw window and sport distribution use the requested number of days; weekly volume/count and zone distribution always use a complete trailing 7-day fetch. WHOOP Strain is nonlinear and is never summed across workouts or presented as an injury/safety threshold. Counts and durations are zero only when no matching scored workouts were logged. This is wellness context, not medical advice or exercise clearance.",
      inputSchema: {
        days: z.number().int().min(1).max(365).optional().default(14).describe("Number of days to look back. Minimum 1, maximum 365, default 14."),
        sport: z.string().optional().describe("Filter by sport name (e.g. 'running', 'cycling', 'swimming'). Optional."),
      },
      outputSchema: {
        raw: z.object({
          workouts: z.array(
            z.object({
              date: z.string(),
              sport: z.string(),
              strain: z.number(),
              duration_min: z.number(),
              avg_hr: z.number().nullable(),
              max_hr: z.number().nullable(),
              calories: z.number(),
              hr_zones_minutes: z.object({
                zone1: z.number(),
                zone2: z.number(),
                zone3: z.number(),
                zone4: z.number(),
                zone5: z.number(),
              }),
            }),
          ),
        }),
        computed: z.object({
          total_workouts: z.number(),
          weekly_workout_count: z.number(),
          weekly_volume_hrs: z.number(),
          sport_distribution: z.record(z.string(), z.number()),
          intensity_distribution: z.object({
            zone1_2_pct: z.number(),
            zone3_pct: z.number(),
            zone4_5_pct: z.number(),
          }),
        }),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      errorLabel: "fetching workouts",
    },
    async ({ days, sport }) => {
      const ownerToday = calendarDate(new Date(), config.athlete.timezone);
      if (ownerToday == null) {
        throw new Error("Unable to establish the requested calendar window");
      }
      const requestedStart = shiftCalendarDate(ownerToday, -(days - 1));
      // Today plus the prior six owner-local dates is a seven-calendar-day window.
      const weeklyStart = shiftCalendarDate(ownerToday, -6);
      const workouts = await getWorkoutCollection(daysAgo(Math.max(days, 7)), today());

      const isFiniteNum = (n: unknown): n is number =>
        typeof n === "number" && Number.isFinite(n);
      const nullIfNotFinite = (n: unknown): number | null => (isFiniteNum(n) ? n : null);
      // A missing zone breakdown is genuinely 0 minutes in that zone, not a fabricated
      // metric — coerce non-finite millis to 0 so one dirty field can't NaN the record.
      const zoneMin = (milli: unknown): number =>
        isFiniteNum(milli) && milli >= 0 ? Math.round(milli * MILLI_TO_MIN) : 0;

      // Map to readable format — filter out unscored workouts. One dirty record must
      // degrade gracefully (dropped or nulled), never fail the whole tool: a NaN in a
      // non-nullable z.number() field would make the SDK reject the entire result.
      const mapped = workouts
        .filter((w) => w.score_state === "SCORED" && w.score)
        .map((w) => {
          const zd = w.score.zone_durations;
          const durationMin = Math.round(
            (new Date(w.end).getTime() - new Date(w.start).getTime()) / (1000 * 60)
          );
          const date = calendarDate(w.start, config.athlete.timezone);
          // Core numerics must be finite to aggregate honestly. A bad timestamp (NaN
          // duration) or dirty strain/kilojoule drops just this workout.
          if (
            date == null ||
            !isFiniteNum(durationMin) ||
            durationMin <= 0 ||
            !isFiniteNum(w.score.strain) ||
            !isFiniteNum(w.score.kilojoule) ||
            w.score.kilojoule < 0
          ) {
            return null;
          }
          return {
            date,
            sport: w.sport_name,
            strain: w.score.strain,
            duration_min: durationMin,
            // avg/max HR are genuinely optional on WHOOP → emit null (NaN would be rejected).
            avg_hr: nullIfNotFinite(w.score.average_heart_rate),
            max_hr: nullIfNotFinite(w.score.max_heart_rate),
            calories: kjToKcal(w.score.kilojoule),
            hr_zones_minutes: {
              zone1: zoneMin(zd?.zone_one_milli),
              zone2: zoneMin(zd?.zone_two_milli),
              zone3: zoneMin(zd?.zone_three_milli),
              zone4: zoneMin(zd?.zone_four_milli),
              zone5: zoneMin(zd?.zone_five_milli),
            },
          };
        })
        .filter((w): w is NonNullable<typeof w> => w !== null);

      const sportFiltered = sport
        ? mapped.filter((w) => w.sport.toLowerCase() === sport.toLowerCase())
        : mapped;
      const filtered = sportFiltered.filter((workout) => workout.date >= requestedStart);

      // Weekly fields use the independently fetched trailing seven-day window even
      // when the caller asks for fewer raw-history days.
      const last7 = sportFiltered.filter((workout) => workout.date >= weeklyStart);

      const weeklyVolumeHrs =
        Math.round((last7.reduce((sum, workout) => sum + workout.duration_min, 0) / 60) * 10) /
        10;

      // Sport distribution (full window)
      const sportDist: Record<string, number> = {};
      for (const w of filtered) {
        sportDist[w.sport] = (sportDist[w.sport] ?? 0) + 1;
      }

      // Intensity distribution (last 7 days)
      let z12 = 0, z3 = 0, z45 = 0;
      for (const w of last7) {
        const hz = w.hr_zones_minutes;
        z12 += hz.zone1 + hz.zone2;
        z3 += hz.zone3;
        z45 += hz.zone4 + hz.zone5;
      }
      const totalZone = z12 + z3 + z45;
      const intensityDist = totalZone > 0
        ? {
            zone1_2_pct: Math.round((z12 / totalZone) * 100),
            zone3_pct: Math.round((z3 / totalZone) * 100),
            zone4_5_pct: Math.round((z45 / totalZone) * 100),
          }
        : { zone1_2_pct: 0, zone3_pct: 0, zone4_5_pct: 0 };

      return {
        raw: { workouts: filtered },
        computed: {
          total_workouts: filtered.length,
          weekly_workout_count: last7.length,
          weekly_volume_hrs: weeklyVolumeHrs,
          sport_distribution: sportDist,
          intensity_distribution: intensityDist,
        },
      };
    },
  );
}
