import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import type { Client } from "@modelcontextprotocol/client";
import type { McpServer } from "@modelcontextprotocol/server";
import type { MockAgent } from "undici";
import { useIsolatedDataDir, initTestDb, seedWhoopTokens } from "../helpers/db.js";

// Isolate DATA_DIR before any getDb() call (getDb reads DATA_DIR lazily).
useIsolatedDataDir("contract");

import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { connectInMemory, EXPECTED_TOOL_NAMES } from "../helpers/mcpHarness.js";
import { installWhoopMock, uninstallWhoopMock, type WhoopData } from "../helpers/whoopMock.js";
import {
  makeCycle,
  makeRecovery,
  makeSleep,
  makeWorkout,
  makeInProgressCycle,
  shiftDay,
} from "../helpers/fixtures.js";
import { daysAgo } from "../../src/whoop/client.js";
import { calendarDate, shiftCalendarDate } from "../../src/compute/stats.js";
import { config } from "../../src/config.js";

const todayUtc = (): string => new Date().toISOString().split("T")[0];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

let client: Client;
let server: McpServer;
let mock: MockAgent | undefined;

beforeAll(async () => {
  initTestDb();
  seedWhoopTokens();
  ({ client, server } = await connectInMemory());
});

afterAll(async () => {
  await client.close();
  await server.close();
});

afterEach(async () => {
  await uninstallWhoopMock(mock);
  mock = undefined;
});

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<Any> {
  return (await client.callTool({ name, arguments: args })) as Any;
}

describe("MCP contract — tools/list", () => {
  it("registers the six base tools and event context only when an event is configured", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(EXPECTED_TOOL_NAMES);
    expect(tools.every((t) => t.name.startsWith("whoop_"))).toBe(true);
  });

  it("each tool has object input+output schemas and read-only/idempotent annotations", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect((tool.inputSchema as Any).type, `${tool.name} inputSchema`).toBe("object");
      expect((tool.outputSchema as Any)?.type, `${tool.name} outputSchema`).toBe("object");
      expect((tool.annotations as Any)?.readOnlyHint, `${tool.name} readOnlyHint`).toBe(true);
      expect((tool.annotations as Any)?.idempotentHint, `${tool.name} idempotentHint`).toBe(true);
    }
  });
});

describe("MCP contract — provider-neutral prompt and usage-policy resource", () => {
  it("publishes a safe wellness-summary prompt", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((prompt) => prompt.name)).toContain("summarize_wellness_context");
    const prompt = await client.getPrompt({ name: "summarize_wellness_context" });
    const textContent = prompt.messages[0]?.content as Any;
    expect(textContent.type).toBe("text");
    expect(textContent.text).toContain("Treat null as unavailable, never zero");
    expect(textContent.text).toContain("not a validated acute-to-chronic workload ratio");
    expect(textContent.text).toContain("Do not diagnose");
    expect(textContent.text).not.toMatch(/full training|mandatory deload|continue current plan/i);
  });

  it("publishes a static single-user wellness-only usage policy", async () => {
    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri)).toContain("whoop://server/usage-policy");
    const resource = await client.readResource({ uri: "whoop://server/usage-policy" });
    const contents = resource.contents[0] as Any;
    expect(contents.mimeType).toBe("text/markdown");
    expect(contents.text).toContain("read-only, single-user, self-hosted connector");
    expect(contents.text).toContain("has no threshold bands");
    expect(contents.text).toContain("Event context");
  });
});

describe("MCP contract — structuredContent mirrors the text JSON", () => {
  it("every tool returns structuredContent that deep-equals its text content", async () => {
    mock = installWhoopMock({}); // empty data is fine; we only compare the two encodings
    for (const name of EXPECTED_TOOL_NAMES) {
      const result = await callTool(name);
      expect(result.isError, `${name} should not error`).toBeFalsy();
      expect(result.structuredContent, `${name} structuredContent`).toBeDefined();
      const textItem = result.content.find((c: Any) => c.type === "text");
      expect(textItem, `${name} text content`).toBeDefined();
      expect(JSON.parse(textItem.text)).toEqual(result.structuredContent);
    }
  });
});

describe("MCP contract — NULL semantics when WHOOP has no data", () => {
  beforeEach(() => {
    mock = installWhoopMock({}); // all collections empty
  });

  it("today_overview reports missing metrics and no product band — never 0", async () => {
    const { structuredContent: sc } = await callTool("whoop_get_today_overview");
    expect(sc.raw.recovery_score).toBeNull();
    expect(sc.raw.hrv_rmssd).toBeNull();
    expect(sc.raw.day_strain).toBeNull();
    expect(sc.raw.day_calories).toBeNull();
    expect(sc.computed.recovery_available).toBe(false);
    expect(sc.computed.sleep_available).toBe(false);
    expect(sc.computed.strain_available).toBe(false);
    expect(sc.computed.recovery_band).toBeNull();
    expect(sc.computed.wellness_context_only).toBe(true);
    expect(sc.computed).not.toHaveProperty("recommendation");
  });

  it("recovery_trend reports null averages/trend and zero streaks", async () => {
    const { structuredContent: sc } = await callTool("whoop_get_recovery_trend");
    expect(sc.raw.daily_recovery).toEqual([]);
    expect(sc.computed.avg_7d).toBeNull();
    expect(sc.computed.avg_30d).toBeNull();
    expect(sc.computed.trend).toBeNull();
    expect(sc.computed.consecutive_red_days).toBe(0);
    expect(sc.computed.days_with_data_7d).toBe(0);
    expect(sc.computed.days_with_data_30d).toBe(0);
  });

  it("hrv_trend reports null everywhere including above_baseline", async () => {
    const { structuredContent: sc } = await callTool("whoop_get_hrv_trend");
    expect(sc.computed.baseline_30d).toBeNull();
    expect(sc.computed.current_7d_avg).toBeNull();
    expect(sc.computed.cv_pct).toBeNull();
    expect(sc.computed.trend).toBeNull();
    expect(sc.computed.above_baseline).toBeNull();
    expect(sc.computed.days_with_data_7d).toBe(0);
    expect(sc.computed.days_with_data_30d).toBe(0);
  });

  it("sleep_trend reports null metrics", async () => {
    const { structuredContent: sc } = await callTool("whoop_get_sleep_trend");
    expect(sc.computed.avg_duration_7d_hrs).toBeNull();
    expect(sc.computed.latest_whoop_sleep_debt_hrs).toBeNull();
    expect(sc.computed.sleep_duration_balance_7d_hrs).toBeNull();
    expect(sc.computed.avg_consistency_7d_pct).toBeNull();
    expect(sc.computed.nights_with_data_7d).toBe(0);
    expect(sc.computed.duration_direction).toBeNull();
  });

  it("training_load reports a null experimental ratio and zero completeness counts", async () => {
    const { structuredContent: sc } = await callTool("whoop_get_training_load");
    expect(sc.computed.mean_day_strain_7d).toBeNull();
    expect(sc.computed.experimental_mean_day_strain_ratio_7d_28d).toBeNull();
    expect(sc.computed.is_experimental).toBe(true);
    expect(sc.computed.limitations).toContain(
      "not a validated acute-to-chronic workload ratio",
    );
    expect(sc.computed).not.toHaveProperty("acwr_reference_band_experimental");
    expect(sc.computed.days_with_data_7d).toBe(0);
  });

  const eventIt = EXPECTED_TOOL_NAMES.includes("whoop_get_event_context") ? it : it.skip;
  eventIt("event context abstains on missing data and never returns clearance", async () => {
    const { structuredContent: sc } = await callTool("whoop_get_event_context");
    expect(sc.computed.recovery_context_status).toBeNull();
    expect(sc.computed.assessment_status).toBe("insufficient_data");
    expect(sc.computed.assessment_available).toBe(false);
    expect(sc.computed.is_clearance).toBe(false);
    expect(sc.computed.weekly_summary).toContain("withheld");
    expect(typeof sc.computed.days_to_event).toBe("number");
    expect(typeof sc.computed.current_phase).toBe("string");
  });
});

describe("MCP contract — populated data flows through", () => {
  it("today_overview surfaces metrics and a WHOOP product band without a prescription", async () => {
    const data: WhoopData = {
      cycles: [makeCycle({ date: "2026-06-15", strain: 12, kilojoule: 8368, id: 1 })],
      recoveries: [makeRecovery({ cycleId: 1, recoveryScore: 75, hrv: 90, rhr: 48 })],
      sleeps: [makeSleep({ date: "2026-06-15" })],
    };
    mock = installWhoopMock(data);
    const { structuredContent: sc } = await callTool("whoop_get_today_overview");
    expect(sc.computed.recovery_available).toBe(true);
    expect(sc.computed.sleep_available).toBe(true);
    expect(sc.computed.strain_available).toBe(true);
    expect(sc.computed.recovery_band).toBe("green");
    expect(sc.computed).not.toHaveProperty("recommendation");
    expect(sc.raw.recovery_score).toBe(75);
    expect(sc.raw.day_strain).toBe(12);
    expect(sc.raw.day_calories).toBe(2000); // round(8368 * 0.239006)
  });

  it("today_overview fetches enough sleep history to retain last night late the next day", async () => {
    const lastNight = shiftDay(todayUtc(), -1);
    mock = installWhoopMock({ sleeps: [makeSleep({ date: lastNight })] });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const { structuredContent: sc } = await callTool("whoop_get_today_overview");
      expect(sc.computed.sleep_available).toBe(true);
      expect(sc.raw.sleep_date).toBe(lastNight);

      const sleepCall = fetchSpy.mock.calls.find(([url]) =>
        String(url).includes("/developer/v2/activity/sleep"),
      );
      expect(sleepCall, "overview should fetch the sleep collection").toBeDefined();
      const query = new URL(String(sleepCall![0]));
      const start = new Date(query.searchParams.get("start") as string).getTime();
      const end = new Date(query.searchParams.get("end") as string).getTime();
      expect(end - start).toBeGreaterThanOrEqual(72 * 60 * 60 * 1000 - 1000);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  const eventIt = EXPECTED_TOOL_NAMES.includes("whoop_get_event_context") ? it : it.skip;
  eventIt("event context surfaces repeated red-band observations while abstaining", async () => {
    const day = todayUtc();
    const dates = [day, shiftDay(day, -1), shiftDay(day, -2)];
    mock = installWhoopMock({
      cycles: dates.map((date, index) => makeCycle({ date, id: index + 1 })),
      recoveries: dates.map((_, index) =>
        makeRecovery({ cycleId: index + 1, recoveryScore: 20 + index, hrv: 70, rhr: 52 }),
      ),
    });
    const { structuredContent: sc } = await callTool("whoop_get_event_context");
    expect(sc.computed.assessment_status).toBe("insufficient_data");
    expect(sc.computed.assessment_available).toBe(false);
    expect(sc.computed.recovery_context_status).toBe("red_band_streak_alert");
    expect(sc.computed.red_streak_alert).toBe(true);
    expect(sc.computed.key_observations).toContain("red_band_streak_observed");
    expect(sc.computed.weekly_summary.startsWith("Recent repeated red-band Recovery observation")).toBe(
      true,
    );
    expect(sc.computed.weekly_summary).not.toMatch(/critical|physiological fatigue/i);
    expect(sc.computed.weekly_summary).not.toMatch(/mandatory deload|continue current plan/i);
  });
});

describe("MCP contract — input validation", () => {
  // The SDK surfaces zod input-validation failures as an isError result (code
  // -32602 in the text), not a thrown/rejected promise.
  it("rejects days = 0 (below the minimum)", async () => {
    const res = await callTool("whoop_get_workouts", { days: 0 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("validation");
  });
  it("rejects days = 100000 (above the maximum)", async () => {
    const res = await callTool("whoop_get_workouts", { days: 100000 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("validation");
  });
});

describe("MCP contract — staleness fields (as_of_date / days_since_last_data, fix 4)", () => {
  const TREND_TOOLS = [
    "whoop_get_recovery_trend",
    "whoop_get_hrv_trend",
    "whoop_get_sleep_trend",
    "whoop_get_training_load",
  ];

  it("all four trend tools report null staleness fields when there is no data", async () => {
    mock = installWhoopMock({});
    for (const name of TREND_TOOLS) {
      const { structuredContent: sc } = await callTool(name);
      expect(sc.computed.as_of_date, `${name} as_of_date`).toBeNull();
      expect(sc.computed.days_since_last_data, `${name} days_since_last_data`).toBeNull();
    }
  });

  it("recovery/hrv date via cycle → as_of_date = today, days_since_last_data = 0", async () => {
    const day = todayUtc();
    mock = installWhoopMock({
      cycles: [makeCycle({ date: day, id: 1 })],
      recoveries: [makeRecovery({ cycleId: 1, recoveryScore: 70, hrv: 80, rhr: 50 })],
    });
    for (const name of ["whoop_get_recovery_trend", "whoop_get_hrv_trend"]) {
      const { structuredContent: sc } = await callTool(name);
      expect(sc.computed.as_of_date, name).toBe(day);
      expect(sc.computed.days_since_last_data, name).toBe(0);
    }
  });

  it("sleep_trend (wake-day) and training_load (newest completed cycle) → days_since 0 for today", async () => {
    const day = todayUtc();
    mock = installWhoopMock({
      sleeps: [makeSleep({ date: day })],
      cycles: [makeCycle({ date: day, id: 1 })],
    });
    const s = (await callTool("whoop_get_sleep_trend")).structuredContent;
    expect(s.computed.as_of_date).toBe(day);
    expect(s.computed.days_since_last_data).toBe(0);
    const t = (await callTool("whoop_get_training_load")).structuredContent;
    expect(t.computed.as_of_date).toBe(day);
    expect(t.computed.days_since_last_data).toBe(0);
  });

  it("surfaces a stale sync: data three days old → days_since_last_data = 3", async () => {
    const day = shiftDay(todayUtc(), -3);
    mock = installWhoopMock({ sleeps: [makeSleep({ date: day })] });
    const s = (await callTool("whoop_get_sleep_trend")).structuredContent;
    expect(s.computed.as_of_date).toBe(day);
    expect(s.computed.days_since_last_data).toBe(3);
  });
});

describe("MCP contract — training_load raw.daily_strain matches computed buckets (fix 5)", () => {
  it("excludes in-progress / partial cycles from raw.daily_strain", async () => {
    const day = todayUtc();
    mock = installWhoopMock({
      cycles: [
        makeInProgressCycle({ date: day, strain: 99, id: 3 }), // partial "today"
        makeCycle({ date: shiftDay(day, -1), strain: 10, id: 1 }),
        makeCycle({ date: shiftDay(day, -2), strain: 11, id: 2 }),
      ],
    });
    const { structuredContent: sc } = await callTool("whoop_get_training_load", { days: 28 });
    // No partial "today" row leaks; only the two completed days appear, none null.
    expect(sc.raw.daily_strain).toHaveLength(2);
    expect(sc.raw.daily_strain.every((d: Any) => d.strain !== 99)).toBe(true);
    expect(sc.raw.daily_strain.every((d: Any) => d.strain !== null)).toBe(true);
    // as_of_date is the newest COMPLETED day, not the in-progress one.
    expect(sc.computed.as_of_date).toBe(shiftDay(day, -1));
  });
});

describe("MCP contract — a dirty workout degrades gracefully (fix 9)", () => {
  it("keeps a null-HR workout (HR → null) and drops a bad-timestamp one; tool still succeeds", async () => {
    const day = todayUtc();
    const good = makeWorkout({ date: day, sport: "running", strain: 8, durationMin: 60 });
    const nullHr = makeWorkout({ date: shiftDay(day, -1), sport: "cycling", durationMin: 60 });
    (nullHr.score as Any).average_heart_rate = null;
    (nullHr.score as Any).max_heart_rate = null;
    const badTs = makeWorkout({ date: shiftDay(day, -2), sport: "swimming", durationMin: 60 });
    (badTs as Any).end = "not-a-timestamp"; // NaN duration → must be dropped, not fail the tool
    mock = installWhoopMock({ workouts: [good, nullHr, badTs] });

    const res = await callTool("whoop_get_workouts", { days: 30 });
    expect(res.isError, "one dirty record must not fail the whole tool").toBeFalsy();
    const sc = res.structuredContent;
    // bad-timestamp workout dropped; the other two survive and validate.
    expect(sc.raw.workouts).toHaveLength(2);
    expect(sc.computed.total_workouts).toBe(2);
    expect(sc.computed.weekly_workout_count).toBe(2);
    const cyc = sc.raw.workouts.find((w: Any) => w.sport === "cycling");
    expect(cyc.avg_hr).toBeNull();
    expect(cyc.max_hr).toBeNull();
    // volume sums the two good durations without NaN (60 + 60 = 2.0h).
    expect(sc.computed.weekly_volume_hrs).toBe(2);
  });

  it("includes the exact requested calendar-window boundary", async () => {
    const ownerToday = calendarDate(new Date(), config.athlete.timezone);
    if (ownerToday == null) throw new Error("test clock should produce a calendar date");
    const boundary = shiftCalendarDate(ownerToday, -13); // 14 dates including today
    mock = installWhoopMock({ workouts: [makeWorkout({ date: boundary, durationMin: 60 })] });
    const { structuredContent: sc } = await callTool("whoop_get_workouts", { days: 14 });
    expect(sc.raw.workouts.map((workout: Any) => workout.date)).toContain(boundary);
  });

  it("uses exactly today plus the prior six dates for weekly aggregates", async () => {
    const ownerToday = calendarDate(new Date(), config.athlete.timezone);
    if (ownerToday == null) throw new Error("test clock should produce a calendar date");
    const included = shiftCalendarDate(ownerToday, -6);
    const excluded = shiftCalendarDate(ownerToday, -7);
    mock = installWhoopMock({
      workouts: [
        makeWorkout({ date: included, durationMin: 60 }),
        makeWorkout({ date: excluded, durationMin: 60 }),
      ],
    });
    const { structuredContent: sc } = await callTool("whoop_get_workouts", { days: 1 });
    expect(sc.computed.weekly_workout_count).toBe(1);
    expect(sc.computed.weekly_volume_hrs).toBe(1);
  });

  it("today_overview nulls a non-finite latest-recovery metric instead of failing (fix 9)", async () => {
    const day = todayUtc();
    const dirty = makeRecovery({ cycleId: 1, recoveryScore: 60, hrv: 70, rhr: 50 });
    (dirty.score as Any).hrv_rmssd_milli = NaN; // NaN would be rejected by z.number().nullable()
    mock = installWhoopMock({
      cycles: [makeCycle({ date: day, id: 1 })],
      recoveries: [dirty],
    });
    const res = await callTool("whoop_get_today_overview");
    expect(res.isError, "a dirty latest recovery must not fail overview").toBeFalsy();
    const sc = res.structuredContent;
    expect(sc.raw.hrv_rmssd).toBeNull(); // NaN → null, not a rejected result
    expect(sc.raw.recovery_score).toBe(60); // finite fields still flow through
    expect(sc.computed.recovery_available).toBe(true);
  });
});

describe("MCP contract — widened cycle window keeps a boundary recovery (fix 10)", () => {
  it("dates a recovery whose cycle sits just outside the recovery window", async () => {
    // The recovery's cycle started 32 days ago — OUTSIDE the default 30-day recovery
    // window but INSIDE the widened cycle window (30 + buffer). WHOOP filters cycles by
    // the `start` query param, so mimic that: return the cycle only when the query start
    // reaches back far enough to include it. A too-tight window would drop the recovery.
    const boundaryDate = daysAgo(32).split("T")[0];
    const boundaryCycle = makeCycle({ date: boundaryDate, id: 777 });
    const recovery = makeRecovery({ cycleId: 777, recoveryScore: 64, hrv: 70, rhr: 52 });

    const prev = getGlobalDispatcher();
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    const pool = agent.get("https://api.prod.whoop.com");
    const page = (records: unknown[]) => ({ records, next_token: null });
    const startDate = (p: string): string =>
      new URLSearchParams(p.split("?")[1] ?? "").get("start")?.split("T")[0] ?? "";
    const json = { headers: { "content-type": "application/json" } };

    pool
      .intercept({
        path: (p: string) => p.split("?")[0] === "/developer/v2/cycle" && startDate(p) <= boundaryDate,
        method: "GET",
      })
      .reply(200, page([boundaryCycle]), json)
      .persist();
    pool
      .intercept({
        path: (p: string) => p.split("?")[0] === "/developer/v2/cycle" && startDate(p) > boundaryDate,
        method: "GET",
      })
      .reply(200, page([]), json)
      .persist();
    pool
      .intercept({ path: (p: string) => p.split("?")[0] === "/developer/v2/recovery", method: "GET" })
      .reply(200, page([recovery]), json)
      .persist();

    try {
      const { structuredContent: sc } = await callTool("whoop_get_recovery_trend", { days: 30 });
      // With the widened cycle fetch the recovery finds its cycle and is dated (not dropped).
      expect(sc.raw.daily_recovery).toHaveLength(1);
      expect(sc.raw.daily_recovery[0].date).toBe(boundaryDate);
      expect(sc.raw.daily_recovery[0].score).toBe(64);
    } finally {
      await agent.close();
      setGlobalDispatcher(prev);
      mock = undefined; // dispatcher managed locally; keep afterEach from double-restoring
    }
  });
});
