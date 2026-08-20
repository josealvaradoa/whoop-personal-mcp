import { McpServer } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { registerOverviewTool } from "../../src/mcp/tools/overview.js";
import { registerRecoveryTool } from "../../src/mcp/tools/recovery.js";
import { registerHrvTool } from "../../src/mcp/tools/hrv.js";
import { registerSleepTool } from "../../src/mcp/tools/sleep.js";
import { registerTrainingLoadTool } from "../../src/mcp/tools/training-load.js";
import { registerWorkoutsTool } from "../../src/mcp/tools/workouts.js";
import { registerEventContextTool } from "../../src/mcp/tools/race-readiness.js";
import { registerWellnessContextPrompt } from "../../src/mcp/prompts/wellness-context.js";
import { registerUsagePolicyResource } from "../../src/mcp/resources/usage-policy.js";
import { config } from "../../src/config.js";

const BASE_TOOL_NAMES = [
  "whoop_get_today_overview",
  "whoop_get_recovery_trend",
  "whoop_get_hrv_trend",
  "whoop_get_sleep_trend",
  "whoop_get_training_load",
  "whoop_get_workouts",
] as const;

// Event context is registered only for an explicitly configured event, matching
// production setup. A generic installation exposes the six base tools.
export const EXPECTED_TOOL_NAMES: readonly string[] = config.event
  ? [...BASE_TOOL_NAMES, "whoop_get_event_context"]
  : BASE_TOOL_NAMES;

/** Build an McpServer with the same conditional registration as createMcpServer(). */
export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "whoop-personal-mcp", version: "1.0.0" });
  registerOverviewTool(server);
  registerRecoveryTool(server);
  registerHrvTool(server);
  registerSleepTool(server);
  registerTrainingLoadTool(server);
  registerWorkoutsTool(server);
  if (config.event) registerEventContextTool(server);
  registerWellnessContextPrompt(server);
  registerUsagePolicyResource(server);
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
