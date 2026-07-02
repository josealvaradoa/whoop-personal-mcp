import dotenv from "dotenv";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

dotenv.config();

export interface RacePhase {
  name: string;
  start: string;
  end: string;
}

export interface Config {
  whoop: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  };
  security: {
    encryptionSecret: string;
    // Optional static bearer token for direct MCP access (curl/scripts). When
    // unset there is no static auth path — only dynamic OAuth tokens are accepted.
    mcpBearerToken: string | undefined;
    // Browser password gating client authorization and WHOOP account linking.
    accessPassword: string;
    // Hostnames whose https redirect_uris may be registered by MCP clients
    // (consent-gate phishing mitigation). Remote defaults are the Claude hosts;
    // ALLOWED_REDIRECT_HOSTS replaces them when set. localhost/127.0.0.1 are
    // always allowed separately (http included) and are not listed here.
    allowedRedirectHosts: string[];
  };
  server: {
    port: number;
    nodeEnv: string;
    publicUrl: string;
  };
  athlete: {
    name: string;
    sleep_target_hrs: number;
    max_hr: number | null;
    resting_hr_baseline: number | null;
  };
  race: {
    name: string;
    date: string;
    type: string;
    phases: RacePhase[];
  };
  thresholds: {
    acwr_danger: number;
    acwr_optimal_low: number;
    acwr_optimal_high: number;
    recovery_red: number;
    recovery_yellow: number;
    consecutive_red_alert: number;
    hrv_cv_concern_pct: number;
  };
  cache: {
    ttl_minutes: number;
    history_window_days: number;
  };
}

// Remote redirect hosts allowed for dynamic client registration when
// ALLOWED_REDIRECT_HOSTS is unset. localhost/127.0.0.1 are always allowed
// separately (see isAllowedRedirectUri in server.ts) and are not listed here.
const DEFAULT_REDIRECT_HOSTS = ["claude.ai", "claude.com", "www.claude.ai", "www.claude.com"];

// ALLOWED_REDIRECT_HOSTS (comma-separated hostnames), when set, REPLACES the
// remote defaults entirely (localhost stays allowed regardless).
function resolveAllowedRedirectHosts(): string[] {
  const raw = process.env.ALLOWED_REDIRECT_HOSTS;
  if (!raw) return [...DEFAULT_REDIRECT_HOSTS];
  return raw
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function loadConfigFile(): Record<string, unknown> {
  const configPath = join(process.cwd(), "whoop-mcp.config.json");
  const examplePath = join(process.cwd(), "whoop-mcp.config.example.json");

  const filePath = existsSync(configPath) ? configPath : examplePath;
  if (!existsSync(filePath)) {
    throw new Error(
      "No config file found. Create whoop-mcp.config.json or whoop-mcp.config.example.json"
    );
  }

  return JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
}

function validateConfig(raw: Record<string, unknown>): void {
  const race = raw.race as Record<string, unknown> | undefined;
  if (!race?.date || typeof race.date !== "string") {
    throw new Error("Config validation failed: race.date is required");
  }
  if (isNaN(Date.parse(race.date))) {
    throw new Error(`Config validation failed: race.date "${race.date}" is not a valid date`);
  }

  const phases = race.phases as RacePhase[] | undefined;
  if (!Array.isArray(phases) || phases.length === 0) {
    throw new Error("Config validation failed: race.phases must be a non-empty array");
  }

  const thresholds = raw.thresholds as Record<string, unknown> | undefined;
  const requiredThresholds = [
    "acwr_danger",
    "acwr_optimal_low",
    "acwr_optimal_high",
    "recovery_red",
    "recovery_yellow",
    "consecutive_red_alert",
    "hrv_cv_concern_pct",
  ];
  for (const key of requiredThresholds) {
    if (thresholds?.[key] == null) {
      throw new Error(`Config validation failed: thresholds.${key} is required`);
    }
  }
}

function buildConfig(): Config {
  const encryptionSecret = requireEnv("ENCRYPTION_SECRET");
  if (encryptionSecret.length < 32) {
    throw new Error("ENCRYPTION_SECRET must be at least 32 characters");
  }

  const accessPassword = requireEnv("ACCESS_PASSWORD");
  if (accessPassword.length < 12) {
    throw new Error("ACCESS_PASSWORD must be at least 12 characters");
  }

  const raw = loadConfigFile();
  validateConfig(raw);

  const athlete = raw.athlete as Config["athlete"];
  const race = raw.race as Config["race"];
  const thresholds = raw.thresholds as Config["thresholds"];
  const cache = (raw.cache ?? { ttl_minutes: 5, history_window_days: 90 }) as Config["cache"];

  return Object.freeze({
    whoop: {
      clientId: requireEnv("WHOOP_CLIENT_ID"),
      clientSecret: requireEnv("WHOOP_CLIENT_SECRET"),
      redirectUri: requireEnv("WHOOP_REDIRECT_URI"),
    },
    security: {
      encryptionSecret,
      mcpBearerToken: process.env.MCP_BEARER_TOKEN || undefined,
      accessPassword,
      allowedRedirectHosts: resolveAllowedRedirectHosts(),
    },
    server: {
      port: parseInt(process.env.PORT ?? "3000", 10),
      nodeEnv: process.env.NODE_ENV ?? "development",
      publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? "3000"}`,
    },
    athlete,
    race,
    thresholds,
    cache,
  });
}

export const config = buildConfig();
