import assert from "node:assert/strict";
import test from "node:test";
import { runDailyPlanning } from "../src/daily-planning.js";

test("runs the Trello funnel before committing the daily calendar plan", async () => {
  const calls = [];
  const now = new Date("2026-07-20T00:15:00.000Z");
  const result = await runDailyPlanning({
    now,
    reconcilePipeline: async (input) => {
      calls.push({ step: "pipeline", input });
      return { inboxToWeek: 1 };
    },
    autoPlan: async (input) => {
      calls.push({ step: "plan", input });
      return { planned: 2 };
    },
    reconcileWorkflow: async (input) => {
      calls.push({ step: "workflow", input });
      return { promoted: 1 };
    }
  });

  assert.deepEqual(calls.map(({ step }) => step), ["pipeline", "plan", "workflow"]);
  assert.ok(calls.every(({ input }) => input.now === now));
  assert.deepEqual(result, {
    pipeline: { inboxToWeek: 1 },
    plan: { planned: 2 },
    workflow: { promoted: 1 }
  });
});
