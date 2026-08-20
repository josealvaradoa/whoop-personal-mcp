#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`WHOOP Personal MCP ${packageJson.version}

Starts the Streamable HTTP server configured by environment variables and
whoop-mcp.config.json. The MCP endpoint is /mcp and the health endpoint is
/health.

Usage:
  whoop-personal-mcp
  whoop-personal-mcp init
  whoop-personal-mcp doctor
  whoop-personal-mcp doctor --url https://YOUR-HOST.example
  whoop-personal-mcp --help
  whoop-personal-mcp --version

Commands:
  init      Create .env and a privacy-first config without overwriting files.
  doctor    Validate local configuration, or probe a remote deployment.

Setup: https://github.com/josealvaradoa/whoop-personal-mcp#quick-start`);
  process.exit(0);
}

if (args.includes("--version") || args.includes("-v")) {
  console.log(packageJson.version);
  process.exit(0);
}

function isLoopback(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

async function initFiles() {
  const envPath = resolve(process.cwd(), ".env");
  const configPath = resolve(process.cwd(), "whoop-mcp.config.json");
  const existing = [envPath, configPath].filter(existsSync);
  if (existing.length > 0) {
    throw new Error(`Refusing to overwrite existing file${existing.length === 1 ? "" : "s"}: ${existing.join(", ")}`);
  }

  let timezone = "UTC";
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    // UTC is a deterministic, valid fallback. The owner can edit it later.
  }

  const encryptionSecret = randomBytes(48).toString("base64url");
  const accessPassword = randomBytes(24).toString("base64url");
  const env = `# Fill these two values from your personal app at https://developer.whoop.com/\nWHOOP_CLIENT_ID=\nWHOOP_CLIENT_SECRET=\nWHOOP_REDIRECT_URI=http://localhost:3000/auth/whoop/callback\n\n# Generated for this deployment. Keep this file private.\nENCRYPTION_SECRET=${encryptionSecret}\nACCESS_PASSWORD=${accessPassword}\n\n# Leave blank unless a client cannot use MCP OAuth.\nMCP_BEARER_TOKEN=\n\nPORT=3000\nBIND_HOST=127.0.0.1\nNODE_ENV=development\nPUBLIC_URL=http://localhost:3000\nTRUST_PROXY=false\nDATA_DIR=./data\n`;
  const config = {
    athlete: {
      timezone,
      sleep_target_hrs: null,
    },
    thresholds: {
      consecutive_red_alert: 3,
    },
  };

  // Exclusive creation is repeated at the write boundary to avoid a TOCTOU
  // overwrite if another process creates either file after the checks above.
  await writeFile(envPath, env, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    console.error(`Created ${envPath}, but could not create ${configPath}. The existing .env was not removed.`);
    throw error;
  }

  console.log(`Created:\n  ${envPath}\n  ${configPath}\n\nNext: add your WHOOP client ID/secret to .env, then run:\n  whoop-personal-mcp doctor`);
}

async function probeRemote(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("doctor --url requires a valid http(s) URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("doctor --url requires an http(s) URL without embedded credentials");
  }
  if (url.protocol !== "https:" && !isLoopback(url.hostname)) {
    throw new Error("Remote deployments must use HTTPS; plain HTTP is allowed only on loopback");
  }
  const origin = url.origin;
  const request = async (path) => {
    const response = await fetch(`${origin}${path}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    return response;
  };

  const health = await request("/health");
  if (!health.ok) throw new Error(`Health probe failed with HTTP ${health.status}`);
  const healthBody = await health.json().catch(() => null);
  if (healthBody?.status !== "ok") throw new Error("Health probe returned an unexpected response");

  const metadata = await request("/.well-known/oauth-protected-resource/mcp");
  if (!metadata.ok) throw new Error(`MCP OAuth metadata probe failed with HTTP ${metadata.status}`);
  const metadataBody = await metadata.json().catch(() => null);
  if (!metadataBody?.authorization_servers?.length) {
    throw new Error("MCP OAuth metadata does not advertise an authorization server");
  }

  const unauthenticatedMcp = await request("/mcp");
  if (unauthenticatedMcp.status !== 401) {
    throw new Error(`Unauthenticated /mcp probe should return 401; received ${unauthenticatedMcp.status}`);
  }

  console.log(`Remote doctor passed:\n  origin: ${origin}\n  health: ok\n  OAuth metadata: ok\n  unauthenticated MCP rejection: ok`);
}

async function doctorLocal() {
  let imported;
  try {
    imported = await import("../dist/config.js");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Local configuration is invalid: ${message}`);
  }
  const config = imported.config;
  const envPath = resolve(process.cwd(), ".env");
  let permissions = "not present";
  if (existsSync(envPath)) {
    const info = await stat(envPath);
    const exposedBits = info.mode & 0o077;
    permissions = exposedBits === 0 ? "private" : `warning: mode ${(info.mode & 0o777).toString(8)} permits group/other access`;
  }

  console.log(`Local doctor passed:\n  mode: ${config.server.deploymentMode}\n  public URL: ${config.server.publicUrl}\n  timezone: ${config.athlete.timezone}\n  sleep target: ${config.athlete.sleep_target_hrs == null ? "not configured" : `${config.athlete.sleep_target_hrs} h`}\n  event context: ${config.event == null ? "disabled" : "configured"}\n  static bearer: ${config.security.mcpBearerToken == null ? "disabled" : "enabled"}\n  .env permissions: ${permissions}`);
}

if (args[0] === "init" && args.length === 1) {
  await initFiles().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
} else if (args[0] === "doctor") {
  const doctorArgs = args.slice(1);
  if (doctorArgs.length === 0) {
    await doctorLocal().catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  } else if (doctorArgs.length === 2 && doctorArgs[0] === "--url") {
    await probeRemote(doctorArgs[1]).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  } else {
    console.error("Usage: whoop-personal-mcp doctor [--url https://YOUR-HOST.example]");
    process.exitCode = 2;
  }
} else if (args.length > 0) {
  console.error(`Unknown option or command: ${args[0]}. Run with --help for usage.`);
  process.exitCode = 2;
} else {
  await import("../dist/index.js");
}
