import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerOverviewTool } from "../../src/mcp/tools/overview.js";
import { registerRecoveryTool } from "../../src/mcp/tools/recovery.js";
import { registerHrvTool } from "../../src/mcp/tools/hrv.js";
import { registerSleepTool } from "../../src/mcp/tools/sleep.js";
import { registerTrainingLoadTool } from "../../src/mcp/tools/training-load.js";
import { registerWorkoutsTool } from "../../src/mcp/tools/workouts.js";
import { registerRaceReadinessTool } from "../../src/mcp/tools/race-readiness.js";

// The seven tools the production server registers (src/mcp/setup.ts).
export const EXPECTED_TOOL_NAMES = [
  "whoop_get_today_overview",
  "whoop_get_recovery_trend",
  "whoop_get_hrv_trend",
  "whoop_get_sleep_trend",
  "whoop_get_training_load",
  "whoop_get_workouts",
  "whoop_get_race_readiness",
] as const;

/** Build an McpServer wired with the same 7 register* calls as createMcpServer(). */
export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "whoop-mcp-server", version: "1.0.0" });
  registerOverviewTool(server);
  registerRecoveryTool(server);
  registerHrvTool(server);
  registerSleepTool(server);
  registerTrainingLoadTool(server);
  registerWorkoutsTool(server);
  registerRaceReadinessTool(server);
  return server;
}

/** Connect an SDK Client to the server over a linked in-memory transport pair. */
export async function connectInMemory(): Promise<{ server: McpServer; client: Client }> {
  const server = buildMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}
