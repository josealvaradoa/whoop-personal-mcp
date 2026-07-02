import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { dayDiff } from "../../compute/stats.js";

type Shape = z.ZodRawShape;
type Infer<S extends Shape> = z.infer<z.ZodObject<S>>;

// When dating recovery records via their cycle, fetch cycles this many days EARLIER
// than the recovery window so a recovery whose cycle sits just outside the window
// still finds a date (WHOOP's real API filters cycles by start-date, so a too-tight
// window silently drops boundary recoveries — e.g. "this morning's" recovery).
export const CYCLE_DATING_BUFFER_DAYS = 5;

// Integer calendar days between server-UTC "today" and `asOfDate` (the newest day
// with data). null when there is no data. A large value signals a stale sync.
export function daysSinceUTC(asOfDate: string | null): number | null {
  if (asOfDate == null) return null;
  const todayUtc = new Date().toISOString().split("T")[0];
  return dayDiff(todayUtc, asOfDate);
}

// Every WHOOP tool is a read-only, idempotent lookup against the external API.
export const READ_ONLY_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export interface ToolDefinition<I extends Shape, O extends Shape> {
  title: string;
  description: string;
  inputSchema: I;
  outputSchema: O;
  annotations: ToolAnnotations;
  /** Slots into "Error <label>: <message>" on failure, e.g. "fetching today's overview". */
  errorLabel: string;
}

// Wraps the boilerplate every tool shares: run the handler, emit both
// structuredContent (validated against outputSchema) and the JSON text content,
// and turn thrown errors into an isError result.
export function defineTool<I extends Shape, O extends Shape>(
  server: McpServer,
  name: string,
  def: ToolDefinition<I, O>,
  handler: (args: Infer<I>) => Promise<Infer<O>>,
): void {
  const cb = async (args: Infer<I>): Promise<CallToolResult> => {
    try {
      const output = await handler(args);
      return {
        structuredContent: output as Record<string, unknown>,
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    } catch (err) {
      // Log the full detail server-side only. The upstream message can embed the raw
      // WHOOP response body ("Whoop API error <status> on <endpoint>: <body>"); return
      // a generic message to the client so no upstream detail leaks to the LLM.
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[tool:${name}] error ${def.errorLabel}:`, detail);
      return {
        isError: true,
        content: [{ type: "text", text: `Failed while ${def.errorLabel}. See server logs.` }],
      };
    }
  };

  server.registerTool(
    name,
    {
      title: def.title,
      description: def.description,
      inputSchema: def.inputSchema,
      outputSchema: def.outputSchema,
      annotations: def.annotations,
    },
    cb as unknown as ToolCallback<I>,
  );
}
