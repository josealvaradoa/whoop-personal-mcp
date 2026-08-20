import dotenv from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

dotenv.config({ quiet: true });

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function isDateOnly(value: string): boolean {
  if (!DATE_ONLY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const DateOnlySchema = z.string().refine(isDateOnly, "must be a real YYYY-MM-DD date");

const EventPhaseSchema = z.object({
  name: z.string().trim().min(1).max(80),
  start: DateOnlySchema,
  end: DateOnlySchema,
}).strict().refine((phase) => phase.start <= phase.end, {
  message: "phase start must be on or before phase end",
});

const TimeZoneSchema = z.string().trim().min(1).max(100).refine((value) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}, "must be a valid IANA time zone");

const AthleteSchema = z.object({
  sleep_target_hrs: z.number().finite().min(4).max(14).nullable().optional(),
  timezone: TimeZoneSchema.default("UTC"),
}).strict();

const RuntimeAthleteSchema = z.object({
  sleep_target_hrs: z.number().finite().min(4).max(14).nullable(),
  timezone: TimeZoneSchema,
}).strict();

const EventSchema = z.object({
  name: z.string().trim().min(1).max(160).default("Target event"),
  date: DateOnlySchema,
  phases: z.array(EventPhaseSchema).max(30).default([]),
}).strict().superRefine((event, ctx) => {
  const sorted = [...event.phases].sort((a, b) => a.start.localeCompare(b.start));
  for (let i = 0; i < sorted.length; i++) {
    const phase = sorted[i];
    if (phase.end > event.date) {
      ctx.addIssue({
        code: "custom",
        path: ["phases"],
        message: `phase \"${phase.name}\" ends after event.date`,
      });
    }
    const previous = sorted[i - 1];
    if (previous && phase.start <= previous.end) {
      ctx.addIssue({
        code: "custom",
        path: ["phases"],
        message: `phases \"${previous.name}\" and \"${phase.name}\" overlap`,
      });
    }
  }
});

const ThresholdsSchema = z.object({
  consecutive_red_alert: z.number().int().min(1).max(30).default(3),
}).strict();

const FileServerSchema = z.object({
  port: z.number().int().min(1).max(65535).optional(),
  public_url: z.string().url().optional(),
}).strict();

const ConfigFileSchema = z.object({
  athlete: AthleteSchema.optional(),
  event: EventSchema.optional(),
  thresholds: ThresholdsSchema.optional(),
  server: FileServerSchema.optional(),
}).strict();

export type EventPhase = z.infer<typeof EventPhaseSchema>;

const RuntimeConfigSchema = z.object({
  whoop: z.object({
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
    redirectUri: z.string().url(),
    requestTimeoutMs: z.number().int().min(1_000).max(120_000),
  }).strict(),
  security: z.object({
    encryptionSecret: z.string().min(32),
    mcpBearerToken: z.string().min(32).optional(),
    accessPassword: z.string().min(12),
    allowedRedirectHosts: z.array(z.string().min(1)).max(100),
    allowedOrigins: z.array(z.string().url()).max(100),
    allowedHosts: z.array(z.string().min(1)).min(1).max(100),
  }).strict(),
  server: z.object({
    port: z.number().int().min(1).max(65535),
    bindHost: z.string().min(1).max(253),
    publicUrl: z.string().url(),
    trustProxy: z.union([z.literal(false), z.number().int().min(1).max(10)]),
    deploymentMode: z.literal("single-user-self-hosted"),
  }).strict(),
  athlete: RuntimeAthleteSchema,
  event: EventSchema.nullable(),
  thresholds: ThresholdsSchema,
}).strict();

export type Config = z.infer<typeof RuntimeConfigSchema>;

type Env = NodeJS.ProcessEnv;

function requiredEnv(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function secretEnv(env: Env, name: string, cwd: string): string | undefined {
  const fileName = `${name}_FILE`;
  const directValue = env[name]?.trim();
  const configuredPath = env[fileName]?.trim();
  if (env[fileName] !== undefined && !configuredPath) {
    throw new Error(`${fileName} must name a readable file`);
  }
  if (directValue && configuredPath) {
    throw new Error(`Set only one of ${name} or ${fileName}`);
  }
  if (configuredPath) {
    const filePath = isAbsolute(configuredPath) ? configuredPath : resolve(cwd, configuredPath);
    let value: string;
    try {
      value = readFileSync(filePath, "utf8").trim();
    } catch {
      throw new Error(`${fileName} must name a readable file`);
    }
    if (!value) throw new Error(`${fileName} must not be empty`);
    return value;
  }
  return directValue || undefined;
}

function requiredSecret(env: Env, name: string, cwd: string): string {
  const value = secretEnv(env, name, cwd);
  if (!value) throw new Error(`Missing required secret: ${name} or ${name}_FILE`);
  return value;
}

function parseJsonObject(value: string, source: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${source} must contain valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${source} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function loadConfigInput(env: Env, cwd: string): Record<string, unknown> {
  const json = env.WHOOP_MCP_CONFIG_JSON ?? env.CONFIG_JSON;
  const configuredPath = env.CONFIG_PATH;
  if (json && configuredPath) {
    throw new Error("Set only one of WHOOP_MCP_CONFIG_JSON/CONFIG_JSON or CONFIG_PATH");
  }
  if (json) return parseJsonObject(json, env.WHOOP_MCP_CONFIG_JSON ? "WHOOP_MCP_CONFIG_JSON" : "CONFIG_JSON");

  if (configuredPath) {
    const filePath = isAbsolute(configuredPath) ? configuredPath : resolve(cwd, configuredPath);
    if (!existsSync(filePath)) throw new Error(`CONFIG_PATH does not exist: ${filePath}`);
    return parseJsonObject(readFileSync(filePath, "utf8"), "CONFIG_PATH");
  }

  const normalPath = join(cwd, "whoop-mcp.config.json");
  if (existsSync(normalPath)) {
    return parseJsonObject(readFileSync(normalPath, "utf8"), "whoop-mcp.config.json");
  }

  // Example/template files are never runtime input. Only an explicitly selected
  // source or the active whoop-mcp.config.json may carry personal settings.
  return {};
}

function parseTrustProxy(value: string | undefined): false | number {
  if (value === undefined || ["0", "false", "no", "off"].includes(value.trim().toLowerCase())) return false;
  const hops = Number(value);
  if (Number.isInteger(hops) && hops >= 1 && hops <= 10) return hops;
  throw new Error("TRUST_PROXY must be false or an exact positive hop count from 1 to 10");
}

function parseNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a finite number`);
  return parsed;
}

function objectSection(raw: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = raw[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function applyEnvironmentOverrides(raw: Record<string, unknown>, env: Env): Record<string, unknown> {
  const next: Record<string, unknown> = { ...raw };
  const athlete = objectSection(next, "athlete");
  const event = objectSection(next, "event");
  const thresholds = objectSection(next, "thresholds");

  if (env.SLEEP_TARGET_HOURS) athlete.sleep_target_hrs = parseNumber(env.SLEEP_TARGET_HOURS, "SLEEP_TARGET_HOURS");
  if (env.ATHLETE_TIMEZONE) athlete.timezone = env.ATHLETE_TIMEZONE;

  if (env.EVENT_NAME) event.name = env.EVENT_NAME;
  if (env.EVENT_DATE) event.date = env.EVENT_DATE;
  if (env.EVENT_PHASES_JSON) {
    try {
      event.phases = JSON.parse(env.EVENT_PHASES_JSON) as unknown;
    } catch {
      throw new Error("EVENT_PHASES_JSON must contain valid JSON");
    }
  }

  if (env.CONSECUTIVE_RED_ALERT) {
    thresholds.consecutive_red_alert = parseNumber(env.CONSECUTIVE_RED_ALERT, "CONSECUTIVE_RED_ALERT");
  }

  if (Object.keys(athlete).length > 0) next.athlete = athlete;
  if (Object.keys(event).length > 0) next.event = event;
  if (Object.keys(thresholds).length > 0) next.thresholds = thresholds;
  return next;
}

function parseCsv(value: string | undefined): string[] {
  return (value ?? "").split(",").map((part) => part.trim()).filter(Boolean);
}

function normalizeOrigin(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} contains an invalid URL: ${value}`);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error(`${label} entries must be bare http(s) origins: ${value}`);
  }
  return url.origin;
}

function normalizeHost(value: string, label: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed.includes("/") || trimmed.includes("@") || trimmed.includes(",")) {
    throw new Error(`${label} contains an invalid host: ${value}`);
  }
  try {
    return new URL(`http://${trimmed}`).host.toLowerCase();
  } catch {
    throw new Error(`${label} contains an invalid host: ${value}`);
  }
}

function validatePublicUrls(publicUrlValue: string, redirectUriValue: string): {
  publicUrl: string;
  redirectUri: string;
} {
  const publicUrl = new URL(publicUrlValue);
  const redirectUri = new URL(redirectUriValue);
  // The MCP SDK's authorization router permits insecure issuers only for these
  // two hostnames. Reject HTTP IPv6 loopback here rather than accepting a config
  // that will fail later during createApp().
  const insecureIssuerAllowed = (url: URL) => ["localhost", "127.0.0.1"].includes(url.hostname);

  for (const [label, url] of [["PUBLIC_URL", publicUrl], ["WHOOP_REDIRECT_URI", redirectUri]] as const) {
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error(`${label} must be an http(s) URL without credentials, query, or fragment`);
    }
    if (url.protocol !== "https:" && !insecureIssuerAllowed(url)) {
      throw new Error(`${label} must use https unless it uses the supported loopback host localhost or 127.0.0.1`);
    }
  }
  if (publicUrl.pathname !== "/") throw new Error("PUBLIC_URL must be an origin without a path");
  if (redirectUri.pathname !== "/auth/whoop/callback") {
    throw new Error("WHOOP_REDIRECT_URI must end at /auth/whoop/callback");
  }
  if (publicUrl.origin !== redirectUri.origin) {
    throw new Error("WHOOP_REDIRECT_URI must share PUBLIC_URL's origin");
  }
  return { publicUrl: publicUrl.origin, redirectUri: redirectUri.toString() };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** Build and validate a complete runtime configuration. Exported for focused tests. */
export function buildConfig(env: Env = process.env, cwd = process.cwd()): Config {
  const raw = applyEnvironmentOverrides(loadConfigInput(env, cwd), env);
  const parsed = ConfigFileSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Config validation failed: ${z.prettifyError(parsed.error)}`);

  const encryptionSecret = requiredSecret(env, "ENCRYPTION_SECRET", cwd);
  if (encryptionSecret.length < 32) throw new Error("ENCRYPTION_SECRET must be at least 32 characters");
  const accessPassword = requiredSecret(env, "ACCESS_PASSWORD", cwd);
  if (accessPassword.length < 12) throw new Error("ACCESS_PASSWORD must be at least 12 characters");
  const mcpBearerToken = secretEnv(env, "MCP_BEARER_TOKEN", cwd);
  if (mcpBearerToken && mcpBearerToken.length < 32) {
    throw new Error("MCP_BEARER_TOKEN must be at least 32 characters");
  }

  const filePort = parsed.data.server?.port;
  const port = env.PORT ? parseNumber(env.PORT, "PORT") : (filePort ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer from 1 to 65535");

  const publicUrlInput = env.PUBLIC_URL ?? parsed.data.server?.public_url ?? `http://localhost:${port}`;
  const urls = validatePublicUrls(publicUrlInput, requiredEnv(env, "WHOOP_REDIRECT_URI"));
  const bindHost = env.BIND_HOST?.trim() || "127.0.0.1";
  if (
    !/^[a-zA-Z0-9.:[\]-]+$/.test(bindHost) ||
    bindHost.includes("..") ||
    bindHost.startsWith("-") ||
    bindHost.endsWith("-")
  ) {
    throw new Error("BIND_HOST must be an IP address or simple hostname");
  }
  const requestTimeoutMs = env.WHOOP_REQUEST_TIMEOUT_MS
    ? parseNumber(env.WHOOP_REQUEST_TIMEOUT_MS, "WHOOP_REQUEST_TIMEOUT_MS")
    : 30_000;
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1_000 || requestTimeoutMs > 120_000) {
    throw new Error("WHOOP_REQUEST_TIMEOUT_MS must be an integer from 1000 to 120000");
  }

  const redirectHosts = parseCsv(env.ALLOWED_REDIRECT_HOSTS);
  const allowedRedirectHosts = redirectHosts.map((host) => normalizeHost(host, "ALLOWED_REDIRECT_HOSTS"));
  const allowedOrigins = [...new Set([
    urls.publicUrl,
    ...parseCsv(env.CORS_ORIGINS),
  ].map((origin) => normalizeOrigin(origin, "CORS_ORIGINS")))];
  const allowedHosts = [...new Set([
    new URL(urls.publicUrl).host.toLowerCase(),
    ...parseCsv(env.ALLOWED_HOSTS).map((host) => normalizeHost(host, "ALLOWED_HOSTS")),
  ])];

  const athlete = parsed.data.athlete ?? AthleteSchema.parse({});
  const event = parsed.data.event ?? null;

  const runtime = RuntimeConfigSchema.safeParse({
    whoop: {
      clientId: requiredEnv(env, "WHOOP_CLIENT_ID"),
      clientSecret: requiredSecret(env, "WHOOP_CLIENT_SECRET", cwd),
      redirectUri: urls.redirectUri,
      requestTimeoutMs,
    },
    security: {
      encryptionSecret,
      mcpBearerToken,
      accessPassword,
      allowedRedirectHosts,
      allowedOrigins,
      allowedHosts,
    },
    server: {
      port,
      bindHost,
      publicUrl: urls.publicUrl,
      trustProxy: parseTrustProxy(env.TRUST_PROXY),
      deploymentMode: "single-user-self-hosted",
    },
    athlete: {
      sleep_target_hrs: athlete.sleep_target_hrs ?? null,
      timezone: athlete.timezone,
    },
    event,
    thresholds: parsed.data.thresholds ?? ThresholdsSchema.parse({}),
  });
  if (!runtime.success) {
    throw new Error(`Runtime config validation failed: ${z.prettifyError(runtime.error)}`);
  }
  return deepFreeze(runtime.data);
}

export const config = buildConfig();
