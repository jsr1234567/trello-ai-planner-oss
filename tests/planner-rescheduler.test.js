import assert from "node:assert/strict";
import test from "node:test";
import { reconcileManualCalendarConflicts } from "../src/google-calendar.js";
import { planPlannerConflictReschedule } from "../src/planner-rescheduler.js";

const plannerEvent = (id, start, end) => ({
  id,
  summary: `Planner task ${id}`,
  description: `Planner task linked to Trello card ${id}.`,
  start: { dateTime: start },
  end: { dateTime: end }
});

test("moves only overlapping planner blocks after a manual calendar reservation", () => {
  const manualEvent = {
    id: "coffee",
    summary: "Have coffee with Alex",
    start: { dateTime: "2026-07-20T10:30:00Z" },
    end: { dateTime: "2026-07-20T11:30:00Z" }
  };
  const moves = planPlannerConflictReschedule({
    manualEvent,
    events: [
      manualEvent,
      plannerEvent("conflict", "2026-07-20T10:00:00Z", "2026-07-20T11:00:00Z"),
      {
        id: "ordinary-event",
        summary: "Existing personal event",
        start: { dateTime: "2026-07-20T11:30:00Z" },
        end: { dateTime: "2026-07-20T12:00:00Z" }
      },
      plannerEvent("unaffected", "2026-07-20T13:00:00Z", "2026-07-20T13:30:00Z")
    ]
  });

  assert.equal(moves.length, 1);
  assert.equal(moves[0].event.id, "conflict");
  // Noon is protected for lunch and 13:00 is already occupied.
  assert.equal(moves[0].start.toISOString(), "2026-07-20T13:30:00.000Z");
  assert.equal(moves[0].end.toISOString(), "2026-07-20T14:30:00.000Z");
});

test("packs multiple displaced planner blocks without overlapping one another", () => {
  const manualEvent = {
    id: "manual",
    start: { dateTime: "2026-07-20T10:00:00Z" },
    end: { dateTime: "2026-07-20T11:00:00Z" }
  };
  const moves = planPlannerConflictReschedule({
    manualEvent,
    events: [
      manualEvent,
      plannerEvent("first", "2026-07-20T09:30:00Z", "2026-07-20T10:30:00Z"),
      plannerEvent("second", "2026-07-20T10:30:00Z", "2026-07-20T11:00:00Z")
    ]
  });

  assert.deepEqual(moves.map((move) => move.start.toISOString()), [
    "2026-07-20T11:00:00.000Z",
    "2026-07-20T13:00:00.000Z"
  ]);
  assert.deepEqual(moves.map((move) => move.end.toISOString()), [
    "2026-07-20T12:00:00.000Z",
    "2026-07-20T13:30:00.000Z"
  ]);
});

test("does not move completed transparent planner blocks", () => {
  const manualEvent = {
    id: "manual",
    start: { dateTime: "2026-07-20T10:00:00Z" },
    end: { dateTime: "2026-07-20T11:00:00Z" }
  };
  assert.deepEqual(planPlannerConflictReschedule({
    manualEvent,
    events: [{ ...plannerEvent("done", "2026-07-20T10:00:00Z", "2026-07-20T11:00:00Z"), transparency: "transparent" }]
  }), []);
});

test("a reservation entered directly in Calendar displaces a planner block and syncs its new time", async () => {
  const manualEvent = {
    id: "coffee",
    summary: "Coffee with Alex",
    start: { dateTime: "2026-07-20T10:30:00Z" },
    end: { dateTime: "2026-07-20T11:30:00Z" }
  };
  const displaced = plannerEvent("work", "2026-07-20T10:00:00Z", "2026-07-20T11:00:00Z");
  const updated = [];
  const synced = [];

  const result = await reconcileManualCalendarConflicts({
    now: new Date("2026-07-20T00:00:00.000Z"),
    listEvents: async () => [manualEvent, displaced],
    updateEvent: async (id, event, options) => updated.push({ id, event, options }),
    syncSchedule: async (id, start, end) => synced.push({ id, start: start.toISOString(), end: end.toISOString() })
  });

  assert.equal(result.rescheduled, 1);
  assert.deepEqual(updated, [{
    id: "work",
    event: {
      start: { dateTime: "2026-07-20T13:00:00.000Z", timeZone: "UTC" },
      end: { dateTime: "2026-07-20T14:00:00.000Z", timeZone: "UTC" }
    },
    options: { confirm: true }
  }]);
  assert.deepEqual(synced, [{
    id: "work",
    start: "2026-07-20T13:00:00.000Z",
    end: "2026-07-20T14:00:00.000Z"
  }]);
});

test("moves every overlapping planner block when a linked-task sync fails", async () => {
  const manualEvent = {
    id: "meeting",
    summary: "Manual meeting",
    start: { dateTime: "2026-07-20T10:00:00Z" },
    end: { dateTime: "2026-07-20T11:00:00Z" }
  };
  const updated = [];

  const result = await reconcileManualCalendarConflicts({
    now: new Date("2026-07-20T00:00:00.000Z"),
    listEvents: async () => [
      manualEvent,
      plannerEvent("first", "2026-07-20T09:30:00Z", "2026-07-20T10:30:00Z"),
      plannerEvent("second", "2026-07-20T10:00:00Z", "2026-07-20T10:30:00Z"),
      plannerEvent("third", "2026-07-20T10:30:00Z", "2026-07-20T11:30:00Z")
    ],
    updateEvent: async (id, event) => updated.push({ id, event }),
    syncSchedule: async (id) => {
      if (id === "first") throw new Error("Google Tasks is temporarily unavailable");
    }
  });

  assert.equal(result.rescheduled, 3);
  assert.deepEqual(updated.map(({ id }) => id), ["first", "second", "third"]);
  assert.deepEqual(result.moves.map(({ id, start, end }) => ({ id, start, end })), [
    { id: "first", start: "2026-07-20T11:00:00.000Z", end: "2026-07-20T12:00:00.000Z" },
    { id: "second", start: "2026-07-20T13:00:00.000Z", end: "2026-07-20T13:30:00.000Z" },
    { id: "third", start: "2026-07-20T13:30:00.000Z", end: "2026-07-20T14:30:00.000Z" }
  ]);
  assert.deepEqual(result.warnings.map(({ id, stage }) => ({ id, stage })), [
    { id: "first", stage: "linked-schedule" }
  ]);
});
