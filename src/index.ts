import { config } from "./config.js";
import { closeDb, getDb } from "./db/connection.js";
import { initSchema } from "./db/schema.js";
import { createApp, oauthProvider, startAuthMaintenance } from "./server.js";
import { mountMcp } from "./mcp/setup.js";

// Initialize database
const db = getDb();
initSchema(db);
const stopAuthMaintenance = startAuthMaintenance();

// Start Express server with MCP routes
const app = createApp();
const mcpRuntime = mountMcp(app, oauthProvider);

const httpServer = app.listen(config.server.port, config.server.bindHost, () => {
  console.log(`whoop-personal-mcp listening on ${config.server.bindHost}:${config.server.port} (${config.server.deploymentMode})`);
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received`);
  stopAuthMaintenance();

  const forceClose = setTimeout(() => {
    console.error("[shutdown] grace period expired; closing remaining HTTP connections");
    httpServer.closeAllConnections();
  }, 10_000);

  try {
    const httpClosed = new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
      httpServer.closeIdleConnections();
    });
    await mcpRuntime.close();
    await httpClosed;
    closeDb();
    console.log("[shutdown] complete");
  } catch (error) {
    process.exitCode = 1;
    console.error(`[shutdown] failed: ${error instanceof Error ? error.message : "unknown error"}`);
  } finally {
    clearTimeout(forceClose);
  }
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
