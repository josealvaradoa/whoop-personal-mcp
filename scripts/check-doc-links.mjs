import { access, readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const skipped = new Set([".git", ".pnpm-store", "coverage", "data", "dist", "node_modules"]);

async function markdownFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (skipped.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
  }
  return files;
}

const failures = [];
const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
for (const file of await markdownFiles(root)) {
  const source = await readFile(file, "utf8");
  for (const match of source.matchAll(linkPattern)) {
    let target = match[1].trim();
    if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
    if (!target || target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    target = target.split("#", 1)[0].split("?", 1)[0];
    try {
      await access(resolve(dirname(file), decodeURIComponent(target)));
    } catch {
      failures.push(`${file.slice(root.length + 1)} -> ${target}`);
    }
  }
}

if (failures.length > 0) {
  throw new Error(`Broken local Markdown links:\n${failures.map((item) => `  ${item}`).join("\n")}`);
}
console.log("Local Markdown link check passed.");
