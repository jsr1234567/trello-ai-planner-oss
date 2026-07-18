import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";

const captureFolders = {
  note: "inbox",
  reminder: "reminders",
  promise: "promises"
};
const sourceExtensions = new Set([".md", ".markdown", ".txt"]);

function vaultRoot(root) {
  return path.resolve(root || config.lifeKnowledge.dir);
}

function dateOnly(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function asRecord(content, filePath) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;
  const metadata = Object.fromEntries(match[1].split("\n").map((line) => {
    const separator = line.indexOf(":");
    return separator === -1 ? [line, ""] : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
  }));
  return { ...metadata, body: match[2].trim(), path: filePath };
}

function recordMarkdown({ id, kind, text, source, due }) {
  return [
    "---",
    `id: ${id}`,
    `kind: ${kind}`,
    `created: ${new Date().toISOString()}`,
    `source: ${source}`,
    `status: open`,
    `due: ${due || ""}`,
    "---",
    "",
    `# ${kind[0].toUpperCase()}${kind.slice(1)}`,
    "",
    text.trim(),
    ""
  ].join("\n");
}

export async function ensureKnowledgeVault({ root } = {}) {
  const base = vaultRoot(root);
  await Promise.all(["inbox", "reminders", "promises", "sources"].map((folder) => mkdir(path.join(base, folder), { recursive: true })));
  const readmePath = path.join(base, "README.md");
  try {
    await stat(readmePath);
  } catch {
    await writeFile(readmePath, [
      "# Life knowledge base",
      "",
      "This local Markdown vault is managed by the personal planner.",
      "Use Telegram `/remember`, `/note`, `/promise`, `/remind YYYY-MM-DD ...`, and `/recall <words>`.",
      "Run `npm run knowledge:index` after setting `LIFE_KNOWLEDGE_SOURCES` to index selected Markdown or text folders.",
      ""
    ].join("\n"));
  }
  return base;
}

export function parseKnowledgeCapture(text, { captureAll = false } = {}) {
  const input = String(text || "").trim();
  const command = input.match(/^\/?(remember|note|promise|remind)\b\s*([\s\S]*)$/i);
  const naturalPromise = input.match(/^(?:i\s+)?promise(?:\s+myself)?\b\s*([\s\S]*)$/i);
  if (!command && !naturalPromise && !captureAll) return null;

  const requestedKind = command?.[1]?.toLowerCase() || (naturalPromise ? "promise" : "note");
  let body = (command?.[2] || naturalPromise?.[1] || input).trim();
  if (!body) return { error: "Please include what you want me to remember." };

  let kind = requestedKind === "remember" ? "note" : requestedKind;
  let due = null;
  if (kind === "remind") {
    kind = "reminder";
    const dated = body.match(/^(\d{4}-\d{2}-\d{2})\s+([\s\S]+)$/);
    if (dated) {
      due = dateOnly(dated[1]);
      body = dated[2].trim();
    }
  }
  return { kind, text: body, due };
}

export async function captureKnowledge(text, { root, source = "telegram", captureAll = false } = {}) {
  const parsed = parseKnowledgeCapture(text, { captureAll });
  if (!parsed || parsed.error) return parsed;
  const base = await ensureKnowledgeVault({ root });
  const id = randomUUID();
  const fileName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${id.slice(0, 8)}.md`;
  const filePath = path.join(base, captureFolders[parsed.kind], fileName);
  await writeFile(filePath, recordMarkdown({ id, ...parsed, source }));
  return { ...parsed, id, path: filePath };
}

async function vaultRecords({ root } = {}) {
  const base = await ensureKnowledgeVault({ root });
  const records = [];
  for (const folder of Object.values(captureFolders)) {
    const directory = path.join(base, folder);
    const files = await readdir(directory, { withFileTypes: true });
    for (const file of files.filter((item) => item.isFile() && item.name.endsWith(".md"))) {
      const filePath = path.join(directory, file.name);
      const record = asRecord(await readFile(filePath, "utf8"), filePath);
      if (record) records.push(record);
    }
  }
  return records;
}

export async function listActiveReminders({ root, now = new Date() } = {}) {
  const today = now.toISOString().slice(0, 10);
  const records = await vaultRecords({ root });
  return records.filter((record) => record.status === "open" && ["reminder", "promise"].includes(record.kind))
    .sort((a, b) => {
      const aRank = a.due ? (a.due < today ? "0" : a.due) : "z";
      const bRank = b.due ? (b.due < today ? "0" : b.due) : "z";
      return aRank.localeCompare(bRank) || String(a.created).localeCompare(String(b.created));
    });
}

export async function formatActiveReminders({ root, limit = 4 } = {}) {
  const reminders = await listActiveReminders({ root });
  if (!reminders.length) return "";
  const lines = reminders.slice(0, limit).map((item) => `- ${item.body.replace(/^#.*\n+/m, "").replace(/\s+/g, " ").trim()}${item.due ? ` (due ${item.due})` : ""}`);
  return `Life reminders:\n${lines.join("\n")}`;
}

async function walkTextFiles(directory, files = []) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if ([".git", "node_modules", ".planner-data"].includes(entry.name)) continue;
    const itemPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await walkTextFiles(itemPath, files);
    else if (entry.isFile() && sourceExtensions.has(path.extname(entry.name).toLowerCase())) files.push(itemPath);
  }
  return files;
}

export async function indexKnowledgeSources({ root, sourceDirectories = config.lifeKnowledge.sourceDirectories } = {}) {
  const base = await ensureKnowledgeVault({ root });
  const entries = [];
  for (const sourceDirectory of sourceDirectories) {
    try {
      const files = await walkTextFiles(path.resolve(sourceDirectory));
      for (const filePath of files) {
        const content = await readFile(filePath, "utf8");
        entries.push({ path: filePath, content: content.slice(0, 8000), indexedAt: new Date().toISOString() });
      }
    } catch (error) {
      entries.push({ path: sourceDirectory, error: error.message, indexedAt: new Date().toISOString() });
    }
  }
  await writeFile(path.join(base, "sources", "index.json"), JSON.stringify({ sourceDirectories, entries }, null, 2));
  return { sourceDirectories, indexed: entries.filter((entry) => !entry.error).length, errors: entries.filter((entry) => entry.error) };
}

export async function recallKnowledge(query, { root, limit = 5 } = {}) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return [];
  const terms = needle.split(/\s+/).filter(Boolean);
  const records = await vaultRecords({ root });
  const matches = records.filter((record) => terms.every((term) => `${record.body} ${record.kind}`.toLowerCase().includes(term)))
    .map((record) => ({ kind: record.kind, due: record.due || null, text: record.body.replace(/^#.*\n+/m, "").trim(), path: record.path }));
  try {
    const sourceIndex = JSON.parse(await readFile(path.join(vaultRoot(root), "sources", "index.json"), "utf8"));
    for (const entry of sourceIndex.entries || []) {
      if (entry.content && terms.every((term) => entry.content.toLowerCase().includes(term))) {
        matches.push({ kind: "source", due: null, text: entry.content.replace(/\s+/g, " ").slice(0, 280), path: entry.path });
      }
    }
  } catch { /* Source indexing is optional. */ }
  return matches.slice(0, limit);
}

export async function handleKnowledgeMessage(text, { root, source = "telegram", captureAll = false } = {}) {
  const recall = String(text || "").trim().match(/^\/?recall\s+(.+)$/i);
  if (recall) {
    const matches = await recallKnowledge(recall[1], { root });
    return matches.length
      ? `I found:\n${matches.map((item) => `- ${item.text}${item.due ? ` (due ${item.due})` : ""}`).join("\n")}`
      : "I could not find a matching note yet.";
  }
  const captured = await captureKnowledge(text, { root, source, captureAll });
  if (!captured) return null;
  if (captured.error) return captured.error;
  return `${captured.kind[0].toUpperCase()}${captured.kind.slice(1)} captured${captured.due ? ` for ${captured.due}` : ""}.`;
}
