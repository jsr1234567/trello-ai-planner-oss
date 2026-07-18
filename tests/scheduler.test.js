import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runScheduledDelivery } from "../src/scheduler.js";

test("a scheduled slot is claimed atomically and only delivers once each day", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "planner-scheduler-"));
  const statePath = path.join(root, "state.json");
  const sent = [];
  const dependencies = {
    statePath,
    now: new Date("2026-07-16T01:00:00.000Z"),
    buildToday: async () => "Today report",
    buildFollowUp: async () => "One next step",
    send: async (message) => { sent.push(message); return { sent: true }; },
    reserve: async () => ({ allowed: true })
  };
  const first = await runScheduledDelivery("morning", dependencies);
  const second = await runScheduledDelivery("morning", dependencies);
  assert.equal(first.sent, true);
  assert.equal(second.reason, "already-sent");
  assert.deepEqual(sent, ["Today report", "One next step\n\nNext step: reply with the one task you will start first."]);
});

test("weekly delivery uses the requested recap and reserves a priority notification slot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "planner-weekly-scheduler-"));
  const statePath = path.join(root, "state.json");
  let reservation;
  const messages = [];
  const result = await runScheduledDelivery("weekly", {
    statePath,
    now: new Date("2026-07-19T11:00:00.000Z"),
    buildWeekly: async () => "Weekly report",
    reserve: async (input) => { reservation = input; return { allowed: true }; },
    send: async (message) => { messages.push(message); return { sent: true }; }
  });
  assert.equal(result.sent, true);
  assert.deepEqual(messages, ["Weekly report"]);
  assert.equal(reservation.priority, true);
});
