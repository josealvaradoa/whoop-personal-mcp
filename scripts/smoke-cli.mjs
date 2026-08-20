import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bin = join(root, "bin", "whoop-personal-mcp.js");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const scratch = await mkdtemp(join(tmpdir(), "whoop-personal-mcp-cli-"));

try {
  const help = await execFileAsync(process.execPath, [bin, "--help"], { cwd: scratch });
  if (!help.stdout.includes("whoop-personal-mcp init") || !help.stdout.includes("doctor --url")) {
    throw new Error("CLI help is missing init/doctor usage");
  }

  const version = await execFileAsync(process.execPath, [bin, "--version"], { cwd: scratch });
  if (version.stdout.trim() !== packageJson.version) {
    throw new Error("CLI version does not match package.json");
  }

  await execFileAsync(process.execPath, [bin, "init"], { cwd: scratch });
  const envPath = join(scratch, ".env");
  const configPath = join(scratch, "whoop-mcp.config.json");
  const env = await readFile(envPath, "utf8");
  const config = JSON.parse(await readFile(configPath, "utf8"));

  for (const pattern of [
    /^WHOOP_CLIENT_ID=$/m,
    /^WHOOP_CLIENT_SECRET=$/m,
    /^ENCRYPTION_SECRET=\S{32,}$/m,
    /^ACCESS_PASSWORD=\S{12,}$/m,
  ]) {
    if (!pattern.test(env)) throw new Error(`Generated .env failed ${pattern}`);
  }
  if (config.athlete?.sleep_target_hrs !== null || !config.athlete?.timezone || "event" in config) {
    throw new Error("Generated config is not privacy-first");
  }

  if (process.platform !== "win32") {
    for (const path of [envPath, configPath]) {
      const mode = (await stat(path)).mode & 0o777;
      if (mode !== 0o600) throw new Error(`${path} has mode ${mode.toString(8)}, expected 600`);
    }
  }

  const localDoctor = await execFileAsync(process.execPath, [bin, "doctor"], {
    cwd: scratch,
    env: {
      ...process.env,
      WHOOP_CLIENT_ID: "cli-smoke-client",
      WHOOP_CLIENT_SECRET: "cli-smoke-secret",
    },
  });
  for (const expected of ["Local doctor passed", "event context: disabled", ".env permissions: private"]) {
    if (!localDoctor.stdout.includes(expected)) {
      throw new Error(`Local doctor output is missing: ${expected}`);
    }
  }

  const probeServer = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/health") {
      response.end('{"status":"ok"}');
    } else if (request.url === "/.well-known/oauth-protected-resource/mcp") {
      response.end('{"authorization_servers":["http://127.0.0.1"]}');
    } else if (request.url === "/mcp") {
      response.statusCode = 401;
      response.end('{"error":"unauthorized"}');
    } else {
      response.statusCode = 404;
      response.end('{"error":"not found"}');
    }
  });
  let remoteDoctorChecked = false;
  try {
    await new Promise((resolvePromise, rejectPromise) => {
      probeServer.once("error", rejectPromise);
      probeServer.listen(0, "127.0.0.1", resolvePromise);
    });
    try {
      const address = probeServer.address();
      if (!address || typeof address === "string") throw new Error("Probe server did not expose a TCP address");
      const remoteDoctor = await execFileAsync(
        process.execPath,
        [bin, "doctor", "--url", `http://127.0.0.1:${address.port}`],
        { cwd: scratch },
      );
      if (!remoteDoctor.stdout.includes("Remote doctor passed")) {
        throw new Error("Remote doctor did not report success");
      }
      remoteDoctorChecked = true;
    } finally {
      await new Promise((resolvePromise, rejectPromise) => {
        probeServer.close((error) => error ? rejectPromise(error) : resolvePromise());
      });
    }
  } catch (error) {
    if (!error || typeof error !== "object" || !["EPERM", "EACCES"].includes(error.code)) throw error;
    console.warn("Remote doctor smoke skipped because this environment forbids loopback listeners.");
  }

  let refusedOverwrite = false;
  try {
    await execFileAsync(process.execPath, [bin, "init"], { cwd: scratch });
  } catch (error) {
    refusedOverwrite = error && typeof error === "object" && error.code !== 0;
  }
  if (!refusedOverwrite) throw new Error("CLI init did not refuse to overwrite existing files");

  console.log(`CLI smoke passed (help, version, private init, local doctor, no-overwrite guard${remoteDoctorChecked ? ", remote doctor" : ""}).`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
