import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MockAgent } from "undici";
import { useIsolatedDataDir, initTestDb, seedWhoopTokens, clearCache } from "../helpers/db.js";

// Isolate DATA_DIR before any getDb() call (getDb reads DATA_DIR lazily).
useIsolatedDataDir("contract");

import { connectInMemory, EXPECTED_TOOL_NAMES } from "../helpers/mcpHarness.js";
import { installWhoopMock, uninstallWhoopMock, type WhoopData } from "../helpers/whoopMock.js";
import { makeCycle, makeRecovery, makeSleep } from "../helpers/fixtures.js";

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
