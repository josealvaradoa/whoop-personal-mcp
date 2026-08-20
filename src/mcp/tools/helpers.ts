import type {
  CallToolResult,
  McpServer,
  ToolAnnotations,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { calendarDaysSince } from "../../compute/stats.js";
import { config } from "../../config.js";

type Shape = z.ZodRawShape;
type Infer<S extends Shape> = z.infer<z.ZodObject<S>>;

// When dating recovery records via their cycle, fetch cycles this many days EARLIER
// than the recovery window so a recovery whose cycle sits just outside the window
// still finds a date (WHOOP's real API filters cycles by start-date, so a too-tight
// window silently drops boundary recoveries — e.g. "this morning's" recovery).
export const CYCLE_DATING_BUFFER_DAYS = 5;

// Integer owner-local calendar days since the newest day with data.
export function daysSinceOwnerDate(asOfDate: string | null): number | null {
  return calendarDaysSince(asOfDate, config.athlete.timezone);
}

// Every WHOOP tool is a read-only, idempotent lookup against the external API.
export const READ_ONLY_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export const WELLNESS_NOTICE =
  "Wellness information only. This server does not diagnose, treat, prevent, or clear anyone for exercise. Use symptoms, personal context, and qualified medical or coaching advice for decisions.";

type SafeToolError = {
  code:
    | "AUTH_REQUIRED"
    | "RATE_LIMITED"
    | "UPSTREAM_TIMEOUT"
    | "UPSTREAM_UNAVAILABLE"
    | "TEMPORARY_FAILURE";
  message: string;
  retryable: boolean;
  retry_after_seconds?: number;
};

type CodedWhoopError = {
  code: string;
  retryable: boolean;
  retryAfterSeconds?: number;
};

function isCodedWhoopError(err: unknown): err is CodedWhoopError {
  return typeof err === "object" && err !== null &&
    "code" in err && typeof err.code === "string" &&
    "retryable" in err && typeof err.retryable === "boolean";
}

function classifyToolError(err: unknown): SafeToolError {
  // The WHOOP client/auth layers expose stable, privacy-safe error codes. Prefer
  // those over parsing human-readable messages, which are deliberately generic.
  if (isCodedWhoopError(err)) {
    if (err.code === "AUTH_REQUIRED" || err.code === "UPSTREAM_AUTH_REJECTED") {
      return {
        code: "AUTH_REQUIRED",
        message: "The instance owner must link or re-link the WHOOP account.",
        retryable: false,
      };
    }
    if (err.code === "RATE_LIMITED" || err.code === "UPSTREAM_RATE_LIMITED") {
      return {
        code: "RATE_LIMITED",
        message: "WHOOP is rate limiting requests. Try again later.",
        retryable: true,
        ...(err.retryAfterSeconds == null
          ? {}
          : { retry_after_seconds: err.retryAfterSeconds }),
      };
    }
    if (err.code === "UPSTREAM_TIMEOUT") {
      return {
        code: "UPSTREAM_TIMEOUT",
        message: "WHOOP did not respond before the request timeout.",
        retryable: true,
      };
    }
    if (err.code === "UPSTREAM_UNAVAILABLE" || err.code === "UPSTREAM_INVALID_RESPONSE") {
      return {
        code: "UPSTREAM_UNAVAILABLE",
        message: "WHOOP is temporarily unavailable.",
        retryable: err.retryable,
      };
    }
  }

  const detail = err instanceof Error ? err.message.toLowerCase() : "";

  if (
    detail.includes("no tokens stored") ||
    detail.includes("re-authorize") ||
    detail.includes("reauthorize") ||
    detail.includes("invalid or expired token")
  ) {
    return {
      code: "AUTH_REQUIRED",
      message: "The instance owner must link or re-link the WHOOP account.",
      retryable: false,
    };
  }

  if (detail.includes("429") || detail.includes("rate limit")) {
    return {
      code: "RATE_LIMITED",
      message: "WHOOP is rate limiting requests. Try again later.",
      retryable: true,
    };
  }

  if (
    detail.includes("abort") ||
    detail.includes("timed out") ||
    detail.includes("timeout")
  ) {
    return {
      code: "UPSTREAM_TIMEOUT",
      message: "WHOOP did not respond before the request timeout.",
      retryable: true,
    };
  }

  if (
    detail.includes("network") ||
    detail.includes("fetch failed") ||
    /\b5\d{2}\b/.test(detail)
  ) {
    return {
      code: "UPSTREAM_UNAVAILABLE",
      message: "WHOOP is temporarily unavailable.",
      retryable: true,
    };
  }

  return {
    code: "TEMPORARY_FAILURE",
    message: "The request could not be completed.",
    retryable: true,
  };
}

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
        content: [
          { type: "text", text: JSON.stringify(output) },
          { type: "text", text: WELLNESS_NOTICE },
        ],
      };
    } catch (err) {
      // Do not log an upstream response body: it may contain health information.
      // Clients receive a stable, privacy-safe category and can decide whether to retry.
      const safeError = classifyToolError(err);
      console.error(`[tool:${name}] ${safeError.code} while ${def.errorLabel}`);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: safeError,
              wellness_notice: WELLNESS_NOTICE,
            }),
          },
        ],
      };
    }
  };

  server.registerTool(
    name,
    {
      title: def.title,
      description: `${def.description} ${WELLNESS_NOTICE}`,
      inputSchema: z.object(def.inputSchema),
      outputSchema: z.object(def.outputSchema),
      annotations: def.annotations,
    },
    cb,
  );
}
