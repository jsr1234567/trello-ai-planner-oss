import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getWeeklyUsageSummary, recordModelUsage, recordTranscriptionUsage } from "../src/costs.js";
import { buildWeeklyReport } from "../src/weekly-report.js";

test("records token and voice usage with the configured public rates", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "planner-costs-"));
  const usagePath = path.join(root, "usage.json");
  const now = new Date("2026-07-13T02:00:00.000Z");
  await recordModelUsage({
    model: "gpt-4.1-mini",
    usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 100 }, output_tokens: 500 },
    operation: "planner_chat",
    now
  }, { usagePath });
  await recordTranscriptionUsage({ model: "gpt-4o-mini-transcribe", seconds: 120, now }, { usagePath });
  const summary = await getWeeklyUsageSummary({ now, usagePath });
  assert.equal(summary.textRequests, 1);
  assert.equal(summary.inputTokens, 1000);
  assert.equal(summary.cachedInputTokens, 100);
  assert.equal(summary.outputTokens, 500);
  assert.equal(summary.transcriptionSeconds, 120);
  assert.ok(Math.abs(summary.textCostUsd - 0.00117) < 1e-10);
  assert.ok(Math.abs(summary.transcriptionCostUsd - 0.006) < 1e-10);
});

test("weekly report separates tracked LLM usage from hosting costs", async () => {
  const report = await buildWeeklyReport({
    now: new Date("2026-07-16T02:00:00.000Z"),
    getUsage: async () => ({
      start: "2026-07-13", end: "2026-07-20", trackingStartedAt: "2026-07-16T00:00:00.000Z",
      textRequests: 3, inputTokens: 1200, outputTokens: 300, textCostUsd: 0.00096,
      unpricedTextRequests: 0, transcriptionSeconds: 60, transcriptionCostUsd: 0.003, llmCostUsd: 0.00396
    }),
    loadDailyCards: async () => ({
      workflow: { doneList: { id: "done" } },
      cards: [
        { idList: "active", closed: false, due: "2026-07-17T10:00:00.000Z" },
        { idList: "done", closed: false, due: "2026-07-17T10:00:00.000Z" }
      ]
    }),
    loadCalendarEvents: async () => [{}, {}],
    countActions: async () => ({ success: 2, failure: 0 })
  });
  assert.match(report, /Weekly planner report/);
  assert.match(report, /3 text calls · 1,200 in \/ 300 out/);
  assert.match(report, /Hosting estimate: \$0\.0000\/month/);
  assert.match(report, /Confirmed Trello actions: 2/);
  assert.match(report, /Open Trello tasks: 1/);
});
