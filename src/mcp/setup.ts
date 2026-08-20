import {
  createMcpHandler,
  isJSONRPCRequest,
  McpServer,
  type McpHttpHandler,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import {
  getOAuthProtectedResourceMetadataUrl,
  requireBearerAuth,
} from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { Express, Request, Response } from "express";
import { registerOverviewTool } from "./tools/overview.js";
import { registerRecoveryTool } from "./tools/recovery.js";
import { registerHrvTool } from "./tools/hrv.js";
import { registerSleepTool } from "./tools/sleep.js";
import { registerTrainingLoadTool } from "./tools/training-load.js";
import { registerWorkoutsTool } from "./tools/workouts.js";
import { registerEventContextTool } from "./tools/race-readiness.js";
import { registerWellnessContextPrompt } from "./prompts/wellness-context.js";
import { registerUsagePolicyResource } from "./resources/usage-policy.js";
import { config } from "../config.js";

const MODERN_PROTOCOL_VERSION = "2026-07-28";

export interface McpRuntime {
  /**
   * Abort exchanges that started before this call and rotate to a fresh
   * stateless handler. Used by the protected disconnect/privacy-wipe route.
   */
  closeAllSessions(): Promise<void>;
  /** Permanently stop the MCP handler and abort its in-flight exchanges. */
  close(): Promise<void>;
}

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "whoop-personal-mcp",
    version: "1.0.0",
  });

  // Registration order is deliberately stable. MCP 2026-07-28 requires tool
  // lists to be deterministic, and the same factory serves both protocol eras.
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

function createHandler(): McpHttpHandler {
  return createMcpHandler(createMcpServer, {
    // The modern leg speaks MCP 2026-07-28 (server/discover plus a per-request
    // _meta envelope). The official SDK's stateless fallback keeps conforming
    // 2024/2025 clients working without carrying protocol sessions forward.
    legacy: "stateless",
    responseMode: "auto",
    onerror(error) {
      // Do not log request bodies or tool results: either may contain personal
      // wellness data. The error class is enough for operational diagnosis.
      console.error(`[mcp] request failed (${error.name})`);
    },
  });
}

function modernRequestIdMissingProtocolHeader(
  req: Request,
): string | number | undefined {
  const body = req.body;
  // Let the SDK classify malformed JSON-RPC itself so invalid ids, protocol
  // versions, or method shapes retain the standard -32600 response rather
  // than being misreported as an HTTP routing-header mismatch.
  if (!isJSONRPCRequest(body)) return undefined;
  const params = "params" in body ? body.params : undefined;
  if (params === null || typeof params !== "object" || Array.isArray(params)) return undefined;
  const meta = "_meta" in params ? params._meta : undefined;
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return undefined;
  const claimedVersion = "io.modelcontextprotocol/protocolVersion" in meta
    ? meta["io.modelcontextprotocol/protocolVersion"]
    : undefined;
  if (claimedVersion !== MODERN_PROTOCOL_VERSION) return undefined;
  const header = req.headers["mcp-protocol-version"];
  if (typeof header === "string" && header.trim() !== "") return undefined;

  return body.id;
}

/**
 * Mount a single Streamable HTTP endpoint that serves both MCP protocol eras:
 * modern 2026-07-28 traffic and the SDK's stateless 2025-era compatibility
 * path. The handler factory creates a fresh McpServer for every HTTP exchange.
 */
export function mountMcp(app: Express, provider: OAuthTokenVerifier): McpRuntime {
  const resourceServerUrl = new URL("/mcp", config.server.publicUrl);
  const auth = requireBearerAuth({
    verifier: provider,
    requiredScopes: ["mcp:read"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });

  let closed = false;
  let handler = createHandler();
  let nodeHandler = toNodeHandler(handler, {
    onerror(error) {
      console.error(`[mcp] HTTP adapter failed (${error.name})`);
    },
  });
  const activeResponses = new Set<Response>();

  app.all("/mcp", auth, (req: Request, res: Response) => {
    if (closed) {
      res.status(503).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "MCP server is shutting down" },
        id: null,
      });
      return;
    }

    // SDK 2.0.0 validates protocol-header/body disagreement but its initial
    // release does not reject an absent MCP-Protocol-Version header. The final
    // 2026-07-28 transport rules require it on every modern request POST, so
    // close that narrow conformance gap before dispatch. Notifications remain
    // exempt because their header requirements are intentionally unspecified.
    const missingProtocolHeaderId = modernRequestIdMissingProtocolHeader(req);
    if (missingProtocolHeaderId !== undefined) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32020,
          message:
            "Bad Request: the required MCP-Protocol-Version header is absent",
          data: {
            mismatch: {
              header: "(missing)",
              body: `the request envelope names ${MODERN_PROTOCOL_VERSION}`,
            },
          },
        },
        id: missingProtocolHeaderId,
      });
      return;
    }

    activeResponses.add(res);
    const currentNodeHandler = nodeHandler;
    void currentNodeHandler(req, res, req.body)
      .catch((error: unknown) => {
        console.error(
          `[mcp] request adapter rejected (${error instanceof Error ? error.name : "unknown"})`,
        );
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          });
        }
      })
      .finally(() => {
        activeResponses.delete(res);
      });
  });

  const closeAllSessions = async (): Promise<void> => {
    if (closed) return;

    // Swap synchronously so requests arriving while the previous generation is
    // closing use a clean handler. Then terminate any old HTTP response streams
    // and let the SDK close every modern per-request server instance.
    const previous = handler;
    const previousResponses = [...activeResponses];
    handler = createHandler();
    nodeHandler = toNodeHandler(handler, {
      onerror(error) {
        console.error(`[mcp] HTTP adapter failed (${error.name})`);
      },
    });

    for (const response of previousResponses) {
      if (!response.writableEnded && !response.destroyed) response.destroy();
    }
    await previous.close();
  };

  const runtime: McpRuntime = {
    closeAllSessions,
    async close() {
      if (closed) return;
      closed = true;
      for (const response of activeResponses) {
        if (!response.writableEnded && !response.destroyed) response.destroy();
      }
      activeResponses.clear();
      await handler.close();
    },
  };

  // The protected disconnect route uses this hook to terminate open exchanges
  // immediately after revoking persisted credentials.
  app.locals.closeMcpSessions = closeAllSessions;
  return runtime;
}
