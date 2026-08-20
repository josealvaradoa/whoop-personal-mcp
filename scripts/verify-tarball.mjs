import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const npmCache = await mkdtemp(join(tmpdir(), "whoop-personal-mcp-npm-cache-"));
let stdout;
try {
  ({ stdout } = await execFileAsync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    {
      cwd: new URL("../", import.meta.url),
      env: { ...process.env, npm_config_cache: npmCache },
      maxBuffer: 10 * 1024 * 1024,
    },
  ));
} finally {
  await rm(npmCache, { recursive: true, force: true });
}

const result = JSON.parse(stdout)[0];
const files = new Set(result.files.map((entry) => entry.path));
const requiredTarEntries = [
  "dist/index.js",
  "bin/whoop-personal-mcp.js",
  "docs/cli.md",
  "docs/index.md",
  "templates/grok-config.toml",
  "templates/event-config.example.json",
  "README.md",
  "CODE_OF_CONDUCT.md",
  "DISCLAIMER.md",
  "GOVERNANCE.md",
  "MAINTAINERS.md",
  "PRIVACY.md",
  "server.json",
  "scripts/smoke-cli.mjs",
  "test-curls.sh",
];

for (const path of requiredTarEntries) {
  if (!files.has(path)) {
    throw new Error(`npm tarball is missing ${path}`);
  }
}

// A removed source file must never survive in dist/ and leak into a release.
// TypeScript does not clean outDir, so this catches stale compiled artifacts
// even when a caller bypasses the normal clean build.
for (const path of files) {
  if (!path.startsWith("dist/")) continue;
  let sourcePath;
  if (path.endsWith(".d.ts")) sourcePath = `src/${path.slice(5, -5)}.ts`;
  else if (path.endsWith(".js.map")) sourcePath = `src/${path.slice(5, -7)}.ts`;
  else if (path.endsWith(".js")) sourcePath = `src/${path.slice(5, -3)}.ts`;
  else continue;
  try {
    await access(new URL(sourcePath, new URL("../", import.meta.url)));
  } catch {
    throw new Error(`npm tarball contains orphaned compiled file ${path}`);
  }
}

console.log(
  `npm tarball check passed (${result.entryCount} files, ${result.size} bytes packed).`
);
