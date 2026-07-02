import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

type Shape = z.ZodRawShape;
type Infer<S extends Shape> = z.infer<z.ZodObject<S>>;

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
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: `Error ${def.errorLabel}: ${message}` }],
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
