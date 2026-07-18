import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const ignoredDirectories = new Set([".git", "node_modules", ".planner-data"]);
const ignoredFiles = new Set(["package-lock.json"]);
const legacyMarkers = ["jsr" + "1234567", "jor" + "an", "sail" + "lier", "plan" + "hcmc", "ho" + "_chi" + "_minh"];
const infrastructureMarkers = ["digital" + "ocean", "drop" + "let"];
const rules = [
  { name: "infrastructure branding", pattern: new RegExp(infrastructureMarkers.join("|"), "i") },
  { name: "literal IPv4 address", pattern: /(?<![A-Za-z0-9_])(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?![A-Za-z0-9_])/ },
  { name: "credential-like assignment", pattern: /(?:api[_-]?key|token|secret|password)\s*[:=]\s*["'](?!your-|example-|replace-|changeme)[^"']{12,}["']/i },
  { name: "legacy identity marker", pattern: new RegExp(legacyMarkers.join("|"), "i") }
];

async function filesAt(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const children = await Promise.all(entries.map(async (entry) => {
    if (ignoredDirectories.has(entry.name)) return [];
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesAt(child);
    return ignoredFiles.has(entry.name) ? [] : [child];
  }));
  return children.flat();
}

const failures = [];
for (const file of await filesAt(process.cwd())) {
  let content;
  try {
    content = await readFile(file, "utf8");
  } catch {
    continue;
  }
  for (const rule of rules) {
    if (rule.pattern.test(content)) failures.push(`${path.relative(process.cwd(), file)}: ${rule.name}`);
  }
}

if (failures.length) {
  console.error("Public-release check failed:\n" + failures.join("\n"));
  process.exit(1);
}

console.log("Public-release check passed.");
