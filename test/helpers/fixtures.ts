// Fixture builders for WHOOP domain objects, matching src/whoop/types.ts exactly.
// Overrides let each test express only what it cares about.
import type { Cycle, Recovery, Sleep, Workout } from "../../src/whoop/types.js";
import type { DailyRecovery } from "../../src/compute/recovery.js";
import type { SleepDayData } from "../../src/compute/sleep.js";

const HOUR_MS = 60 * 60 * 1000;

// Use for nullable passthrough fields so an explicit `null` is preserved (a bare
// `opts.x ?? default` would turn an intentional null back into the default).
function withDefault<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}

/** Shift a YYYY-MM-DD day string by `delta` calendar days, in UTC. */
export function shiftDay(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().split("T")[0];
}

let cycleSeq = 1000;

/**
 * A completed, scored cycle whose `start` is at noon UTC on `date` and `end` one
 * hour later (non-null → counts as completed). Pass score: null / end: null to
 * model unscored / in-progress cycles.
 */
export function makeCycle(opts: {
  date: string;
  strain?: number;
  kilojoule?: number;
  id?: number;
  end?: string | null;
  score?: Cycle["score"] | null;
}): Cycle {
  const id = opts.id ?? cycleSeq++;
  const start = `${opts.date}T12:00:00.000Z`;
  const end = opts.end === undefined ? `${opts.date}T13:00:00.000Z` : opts.end;
  const score =
    opts.score === null
      ? null
      : (opts.score ?? {
          strain: opts.strain ?? 10,
          kilojoule: opts.kilojoule ?? 8000,
          average_heart_rate: 130,
          max_heart_rate: 170,
        });
  return { id, user_id: 1, start, end, score };
}

/** An in-progress cycle (end === null) with a partial strain. */
export function makeInProgressCycle(opts: { date: string; strain?: number; id?: number }): Cycle {
  return makeCycle({ ...opts, end: null });
}

/** An unscored cycle (score === null). */
export function makeUnscoredCycle(opts: { date: string; id?: number }): Cycle {
  return makeCycle({ date: opts.date, id: opts.id, score: null });
}

/**
 * Build `strains.length` consecutive daily completed cycles, newest first:
 * strains[0] lands on `newestDate`, strains[i] on newestDate - i days.
 */
export function consecutiveCycles(newestDate: string, strains: number[]): Cycle[] {
  return strains.map((strain, i) => makeCycle({ date: shiftDay(newestDate, -i), strain }));
}

let recoverySeq = 5000;

export function makeRecovery(opts: {
  cycleId: number;
  recoveryScore?: number;
  hrv?: number;
  rhr?: number;
  spo2?: number | null;
  skinTemp?: number | null;
  scoreState?: Recovery["score_state"];
  scored?: boolean;
}): Recovery {
  const scored = opts.scored ?? true;
  const scoreState = opts.scoreState ?? (scored ? "SCORED" : "PENDING_SCORE");
  return {
    cycle_id: opts.cycleId,
    sleep_id: `sleep-${recoverySeq++}`,
    user_id: 1,
    score_state: scoreState,
    score:
      scoreState === "SCORED"
        ? {
            recovery_score: opts.recoveryScore ?? 60,
            resting_heart_rate: opts.rhr ?? 50,
            hrv_rmssd_milli: opts.hrv ?? 80,
            spo2_percentage: withDefault(opts.spo2, 97),
            skin_temp_celsius: withDefault(opts.skinTemp, 33.5),
          }
        : null,
  };
}

let sleepSeq = 9000;

/** Build a Sleep record. Durations are given in hours and converted to millis. */
export function makeSleep(opts: {
  date: string;
  lightHrs?: number;
  slowWaveHrs?: number;
  remHrs?: number;
  awakeHrs?: number;
  efficiencyPct?: number | null;
  performancePct?: number | null;
  respiratoryRate?: number | null;
  nap?: boolean;
  scoreState?: Sleep["score_state"];
  scored?: boolean;
  id?: string;
}): Sleep {
  const scored = opts.scored ?? true;
  const scoreState = opts.scoreState ?? (scored ? "SCORED" : "PENDING_SCORE");
  const light = (opts.lightHrs ?? 3) * HOUR_MS;
  const sws = (opts.slowWaveHrs ?? 1.5) * HOUR_MS;
  const rem = (opts.remHrs ?? 1.5) * HOUR_MS;
  const awake = (opts.awakeHrs ?? 0.5) * HOUR_MS;
  return {
    id: opts.id ?? `sleep-rec-${sleepSeq++}`,
    user_id: 1,
    start: `${opts.date}T04:00:00.000Z`,
    end: `${opts.date}T12:00:00.000Z`,
    nap: opts.nap ?? false,
    score_state: scoreState,
    score:
      scoreState === "SCORED"
        ? {
            stage_summary: {
              total_in_bed_time_milli: light + sws + rem + awake,
              total_awake_time_milli: awake,
              total_light_sleep_time_milli: light,
              total_slow_wave_sleep_time_milli: sws,
              total_rem_sleep_time_milli: rem,
              sleep_cycle_count: 5,
              disturbance_count: 3,
            },
            sleep_needed: {
              baseline_milli: 8 * HOUR_MS,
              need_from_sleep_debt_milli: 0,
              need_from_recent_strain_milli: 0,
              need_from_recent_nap_milli: 0,
            },
            respiratory_rate: withDefault(opts.respiratoryRate, 15),
            sleep_performance_percentage: withDefault(opts.performancePct, 90),
            sleep_consistency_percentage: 80,
            sleep_efficiency_percentage: withDefault(opts.efficiencyPct, 92),
          }
        : null,
  };
}

let workoutSeq = 20000;

export function makeWorkout(opts: {
  date: string;
  sport?: string;
  strain?: number;
  durationMin?: number;
  avgHr?: number;
  maxHr?: number;
  kilojoule?: number;
  scoreState?: string;
  zoneMinutes?: Partial<{ z1: number; z2: number; z3: number; z4: number; z5: number }>;
}): Workout {
  const durationMin = opts.durationMin ?? 60;
  const start = `${opts.date}T06:00:00.000Z`;
  const end = new Date(new Date(start).getTime() + durationMin * 60 * 1000).toISOString();
  const z = opts.zoneMinutes ?? {};
  const min = (m: number | undefined): number => (m ?? 0) * 60 * 1000;
  return {
    id: `workout-${workoutSeq++}`,
    user_id: 1,
    start,
    end,
    sport_name: opts.sport ?? "running",
    score_state: opts.scoreState ?? "SCORED",
    score: {
      strain: opts.strain ?? 8,
      average_heart_rate: opts.avgHr ?? 140,
      max_heart_rate: opts.maxHr ?? 175,
      kilojoule: opts.kilojoule ?? 3000,
      percent_recorded: 100,
      zone_durations: {
        zone_zero_milli: 0,
        zone_one_milli: min(z.z1),
        zone_two_milli: min(z.z2),
        zone_three_milli: min(z.z3),
        zone_four_milli: min(z.z4),
        zone_five_milli: min(z.z5),
      },
    },
  };
}

export function makeDailyRecovery(opts: {
  date: string;
  recoveryScore?: number;
  hrv?: number;
  rhr?: number;
}): DailyRecovery {
  return {
    date: opts.date,
    recovery_score: opts.recoveryScore ?? 60,
    hrv_rmssd: opts.hrv ?? 80,
    resting_heart_rate: opts.rhr ?? 50,
  };
}

/** Consecutive daily recovery records, newest first (scores[0] on newestDate). */
export function consecutiveRecovery(
  newestDate: string,
  scores: number[],
  hrvs?: number[],
): DailyRecovery[] {
  return scores.map((recoveryScore, i) =>
    makeDailyRecovery({
      date: shiftDay(newestDate, -i),
      recoveryScore,
      hrv: hrvs ? hrvs[i] : undefined,
    }),
  );
}

export function makeSleepDay(opts: {
  date: string;
  durationHrs?: number;
  efficiencyPct?: number | null;
}): SleepDayData {
  const dur = opts.durationHrs ?? 8;
  return {
    date: opts.date,
    duration_hrs: dur,
    efficiency_pct: withDefault(opts.efficiencyPct, 90),
    performance_pct: 85,
    respiratory_rate: 15,
    stages: {
      awake_hrs: 0.5,
      light_hrs: dur * 0.5,
      slow_wave_hrs: dur * 0.25,
      rem_hrs: dur * 0.25,
    },
  };
}

/** Consecutive nightly sleep-day records, newest first (durations[0] on newestDate). */
export function consecutiveSleepDays(newestDate: string, durationsHrs: number[]): SleepDayData[] {
  return durationsHrs.map((durationHrs, i) =>
    makeSleepDay({ date: shiftDay(newestDate, -i), durationHrs }),
  );
}
