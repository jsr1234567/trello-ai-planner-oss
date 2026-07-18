import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const defaultAuditPath = path.resolve(".planner-data/action-audit.jsonl");

// This is intentionally metadata-only: task titles, note text, chat IDs, and
// credentials never enter the audit log.
export async function appendActionAudit({ action, outcome, at = new Date().toISOString() }, { auditPath = defaultAuditPath } = {}) {
  const entry = {
    at,
    integration: "trello",
    actor: "owner",
    action: String(action || "unknown").slice(0, 40),
    outcome: outcome === "success" ? "success" : "failure"
  };
  await mkdir(path.dirname(auditPath), { recursive: true });
  await appendFile(auditPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  return entry;
}

export async function countActionAudits({ start, end, auditPath = defaultAuditPath } = {}) {
  try {
    const entries = (await readFile(auditPath, "utf8")).trim().split("\n")
      .map((line) => {
        try { return JSON.parse(line); }
        catch { return null; }
      })
      .filter(Boolean)
      .filter((entry) => {
        const at = Date.parse(entry.at || "");
        return Number.isFinite(at) && (!start || at >= new Date(start).getTime()) && (!end || at < new Date(end).getTime());
      });
    return {
      total: entries.length,
      success: entries.filter((entry) => entry.outcome === "success").length,
      failure: entries.filter((entry) => entry.outcome === "failure").length
    };
  } catch { return { total: 0, success: 0, failure: 0 }; }
}
