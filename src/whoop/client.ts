import {
  forceRefreshAccessToken,
  getValidAccessToken,
  WhoopAuthError,
} from "./auth.js";
import { config } from "../config.js";
import type {
  PaginatedResponse,
  Cycle,
  Recovery,
  Sleep,
  Workout,
} from "./types.js";

const BASE_URL = "https://api.prod.whoop.com/developer";

// --- Private helpers ---

export type WhoopApiErrorCode =
  | "AUTH_REQUIRED"
  | "RATE_LIMITED"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_UNAVAILABLE"
  | "UPSTREAM_INVALID_RESPONSE";

export class WhoopApiError extends Error {
  constructor(
    readonly code: WhoopApiErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "WhoopApiError";
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

async function fetchWhoop<T>(
  endpoint: string,
  params?: Record<string, string>,
  isRetry = false,
): Promise<T> {
  const accessToken = await getValidAccessToken();
  const url = new URL(`${BASE_URL}${endpoint}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }

  // The abort/timeout covers BOTH the header fetch and the body read: clearTimeout
  // only fires in the finally (after the body is consumed or throws), so a stalled
  // response body cannot hang a tool call indefinitely.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.whoop.requestTimeoutMs);
  timeoutId.unref();
  try {
    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });

    if (!response.ok) {
      // On 401, FORCE a token refresh and retry once. Invalidating only the
      // in-memory token is
      // not enough: getValidAccessToken() reloads the same still-"valid" DB token
      // whenever it is outside the 300s expiry buffer, so a WHOOP-side early
      // revocation would never heal. forceRefreshAccessToken() bypasses that
      // shortcut (and coalesces concurrent 401s via the single-flight mutex).
      if (response.status === 401 && !isRetry) {
        console.warn(`[whoop-api] ${endpoint} → 401, forcing token refresh and retrying…`);
        clearTimeout(timeoutId); // this request is done; refresh + retry own their timeouts
        await forceRefreshAccessToken(); // surfaces a clear re-authorize error on definitive failure
        return await fetchWhoop<T>(endpoint, params, true);
      }
      // Never record or surface upstream error bodies: they can contain identifiers.
      if (response.status === 401 || response.status === 403) {
        throw new WhoopApiError("AUTH_REQUIRED", "WHOOP authorization is invalid; re-link the account", false, response.status);
      }
      if (response.status === 429) {
        const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
        throw new WhoopApiError(
          "RATE_LIMITED",
          "WHOOP rate limited the request",
          true,
          response.status,
          Number.isFinite(retryAfter) ? retryAfter : undefined,
        );
      }
      throw new WhoopApiError(
        "UPSTREAM_UNAVAILABLE",
        "WHOOP is temporarily unavailable",
        response.status >= 500,
        response.status,
      );
    }

    try {
      return (await response.json()) as T;
    } catch (parseError) {
      // 200 with an empty / non-JSON body (or a body read aborted by the timeout).
      // Log the detail server-side; surface a generic internal error to the caller.
      if (isAbortError(parseError)) {
        throw new WhoopApiError("UPSTREAM_TIMEOUT", "WHOOP response timed out", true);
      }
      throw new WhoopApiError("UPSTREAM_INVALID_RESPONSE", "WHOOP returned an unreadable response", true);
    }
  } catch (error) {
    if (error instanceof WhoopApiError || error instanceof WhoopAuthError) throw error;
    if (isAbortError(error)) {
      throw new WhoopApiError("UPSTREAM_TIMEOUT", "WHOOP request timed out", true);
    }
    throw new WhoopApiError("UPSTREAM_UNAVAILABLE", "WHOOP request failed", true);
  } finally {
    clearTimeout(timeoutId);
  }
}

const MAX_PAGES = 50;

async function fetchAllPages<T>(
  endpoint: string,
  params?: Record<string, string>
): Promise<T[]> {
  const allRecords: T[] = [];
  // WHOOP v2 caps page size at 25; requesting it explicitly cuts round-trips ~2.5x.
  const queryParams: Record<string, string> = { ...params, limit: "25" };
  let truncated = false;

  for (let page_num = 0; page_num < MAX_PAGES; page_num++) {
    const page = await fetchWhoop<PaginatedResponse<T>>(endpoint, queryParams);

    // Guard a malformed 200 body: the WHOOP contract guarantees `records` is an
    // array. If it is not, log the shape server-side and surface a generic upstream
    // error rather than crashing with "records is not iterable" (never leak the body).
    if (!page || !Array.isArray(page.records)) {
      console.error(`[whoop-api] ${endpoint} returned an invalid collection envelope`);
      throw new WhoopApiError("UPSTREAM_INVALID_RESPONSE", "WHOOP returned an unexpected response shape", true);
    }

    allRecords.push(...page.records);

    if (!page.next_token || page.records.length === 0) break;
    queryParams.nextToken = page.next_token;
    if (page_num === MAX_PAGES - 1) truncated = true;
  }

  if (truncated) {
    console.warn(`[whoop-api] ${endpoint} hit the ${MAX_PAGES}-page cap — results were truncated.`);
  }

  return allRecords;
}

// --- Date helpers ---

/** ISO timestamp for N days before now. Note: calendar-day boundaries are UTC (documented limitation). */
export function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

/** ISO timestamp for now. Note: calendar-day boundaries are UTC (documented limitation). */
export function today(): string {
  return new Date().toISOString();
}

// --- Public methods ---

export async function getCycles(start: string, end: string): Promise<Cycle[]> {
  return fetchAllPages<Cycle>("/v2/cycle", { start, end });
}

export async function getRecoveryCollection(
  start: string,
  end: string
): Promise<Recovery[]> {
  return fetchAllPages<Recovery>("/v2/recovery", { start, end });
}

export async function getSleepCollection(
  start: string,
  end: string
): Promise<Sleep[]> {
  return fetchAllPages<Sleep>("/v2/activity/sleep", { start, end });
}

export async function getWorkoutCollection(
  start: string,
  end: string
): Promise<Workout[]> {
  return fetchAllPages<Workout>("/v2/activity/workout", { start, end });
}
