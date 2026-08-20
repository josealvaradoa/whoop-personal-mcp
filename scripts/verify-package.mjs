import { access, readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));

const requiredPaths = [
  "dist/index.js",
  "dist/index.d.ts",
  "bin/whoop-personal-mcp.js",
  "docs/cli.md",
  "docs/index.md",
  "templates/grok-config.toml",
  "templates/event-config.example.json",
  "examples/README.md",
  "examples/claude/README.md",
  "examples/codex/README.md",
  "examples/grok/README.md",
  "README.md",
  "CODE_OF_CONDUCT.md",
  "DISCLAIMER.md",
  "GOVERNANCE.md",
  "MAINTAINERS.md",
  "PRIVACY.md",
  "server.json",
  "whoop-mcp.config.example.json",
];

for (const path of requiredPaths) {
  await access(new URL(path, root));
}

if (packageJson.name !== "whoop-personal-mcp") {
  throw new Error("Unexpected package name");
}
if (packageJson.bin?.["whoop-personal-mcp"] !== "bin/whoop-personal-mcp.js") {
  throw new Error("Package bin does not point to bin/whoop-personal-mcp.js");
}
if (packageJson.types !== "dist/index.d.ts") {
  throw new Error("Package types does not point to dist/index.d.ts");
}
for (const entry of ["dist/", "bin/", "docs/", "templates/", "examples/"]) {
  if (!packageJson.files?.includes(entry)) {
    throw new Error(`Package files is missing ${entry}`);
  }
}
for (const entry of ["scripts/", "test-curls.sh"]) {
  if (!packageJson.files?.includes(entry)) {
    throw new Error(`Package files is missing ${entry}`);
  }
}

const bin = await readFile(new URL("bin/whoop-personal-mcp.js", root), "utf8");
if (!bin.startsWith("#!/usr/bin/env node")) {
  throw new Error("CLI wrapper is missing its Node shebang");
}

console.log(`Package source check passed (${requiredPaths.length} required paths).`);
