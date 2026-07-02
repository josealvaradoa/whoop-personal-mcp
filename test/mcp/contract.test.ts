import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MockAgent } from "undici";
import { useIsolatedDataDir, initTestDb, seedWhoopTokens, clearCache } from "../helpers/db.js";

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

beforeEach(() => {
  clearCache(); // date-keyed cache entries must not leak between tests
});

afterEach(async () => {
  await uninstallWhoopMock(mock);
  mock = undefined;
});

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<Any> {
  return (await client.callTool({ name, arguments: args })) as Any;
}

describe("MCP contract — tools/list", () => {
  it("registers exactly the 7 whoop_* tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOL_NAMES].sort());
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

  it("today_overview reports missing (null metrics, false flags, null readiness — never 0)", async () => {
    const { structuredContent: sc } = await callTool("whoop_get_today_overview");
    expect(sc.raw.recovery_score).toBeNull();
    expect(sc.raw.hrv_rmssd).toBeNull();
    expect(sc.raw.day_strain).toBeNull();
    expect(sc.raw.day_calories).toBeNull();
    expect(sc.computed.recovery_available).toBe(false);
    expect(sc.computed.sleep_available).toBe(false);
    expect(sc.computed.strain_available).toBe(false);
    expect(sc.computed.readiness).toBeNull();
    expect(sc.computed.recommendation).toBeNull();
  });

  it("recovery_trend reports null averages/trend and zero streaks", async () => {
    const { structuredContent: sc } = await callTool("whoop_get_recovery_trend");
    expect(sc.raw.daily_recovery).toEqual([]);
    expect(sc.computed.avg_7d).toBeNull();
    expect(sc.computed.avg_30d).toBeNull();
    expect(sc.computed.trend).toBeNull();
    expect(sc.computed.consecutive_red_days).toBe(0);
  });

  it("hrv_trend reports null everywhere including above_baseline", async () => {
    const { structuredContent: sc } = await callTool("whoop_get_hrv_trend");
    expect(sc.computed.baseline_30d).toBeNull();
    expect(sc.computed.current_7d_avg).toBeNull();
    expect(sc.computed.cv_pct).toBeNull();
    expect(sc.computed.trend).toBeNull();
    expect(sc.computed.above_baseline).toBeNull();
  });

  it("sleep_trend reports null metrics", async () => {
    const { structuredContent: sc } = await callTool("whoop_get_sleep_trend");
    expect(sc.computed.avg_duration_7d_hrs).toBeNull();
    expect(sc.computed.sleep_debt_cumulative_hrs).toBeNull();
    expect(sc.computed.consistency_score).toBeNull();
    expect(sc.computed.trend).toBeNull();
  });

  it("training_load reports null ACWR/zone and zero completeness counts", async () => {
    const { structuredContent: sc } = await callTool("whoop_get_training_load");
    expect(sc.computed.acute_load_7d).toBeNull();
    expect(sc.computed.acwr).toBeNull();
    expect(sc.computed.acwr_zone).toBeNull();
    expect(sc.computed.days_with_data_7d).toBe(0);
  });

  it("race_readiness leaves fitness_trend/fatigue_status null but keeps config-driven fields", async () => {
    const { structuredContent: sc } = await callTool("whoop_get_race_readiness");
    expect(sc.computed.fitness_trend).toBeNull();
    expect(sc.computed.fatigue_status).toBeNull();
    expect(typeof sc.computed.days_to_race).toBe("number");
    expect(typeof sc.computed.current_phase).toBe("string");
  });
});

describe("MCP contract — populated data flows through", () => {
  it("today_overview surfaces recovery/sleep/strain and a readiness recommendation", async () => {
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
    expect(sc.computed.readiness).toBe("green"); // 75 >= yellow threshold 66
    expect(sc.computed.recommendation).toBe("full_training");
    expect(sc.raw.recovery_score).toBe(75);
    expect(sc.raw.day_strain).toBe(12);
    expect(sc.raw.day_calories).toBe(2000); // round(8368 * 0.239006)
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
    const cyc = sc.raw.workouts.find((w: Any) => w.sport === "cycling");
    expect(cyc.avg_hr).toBeNull();
    expect(cyc.max_hr).toBeNull();
    // volume sums the two good durations without NaN (60 + 60 = 2.0h).
    expect(sc.computed.weekly_volume_hrs).toBe(2);
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
