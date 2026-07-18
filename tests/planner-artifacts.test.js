import assert from "node:assert/strict";
import test from "node:test";
import { createPlannerArtifacts } from "../src/planner-artifacts.js";

test("initially scheduling a planner task synchronizes Calendar, Google Tasks, and Trello", async () => {
  const calendarEvents = [];
  const googleTasks = [];
  const trelloUpdates = [];
  const links = [];

  const result = await createPlannerArtifacts({
    card: { id: "card-1", name: "Write proposal", desc: "Include the timeline and decision needed.", due: null },
    labels: ["Work & Business"],
    scheduleStart: "2026-07-20T06:00:00.000Z",
    durationMinutes: 90,
    assertTasksAccess: async () => {},
    createEvent: async (event, options) => {
      calendarEvents.push({ event, options });
      return { id: "event-1" };
    },
    createTask: async (task) => {
      googleTasks.push(task);
      return { tasklist: "planner", task: { id: "task-1" } };
    },
    client: { updateCard: async (id, fields) => trelloUpdates.push({ id, fields }) },
    linkTask: async (link) => links.push(link)
  });

  assert.deepEqual(result, { scheduled: true, eventId: "event-1", googleTaskId: "task-1" });
  assert.equal(calendarEvents[0].event.start.dateTime, "2026-07-20T06:00:00.000Z");
  assert.equal(calendarEvents[0].event.end.dateTime, "2026-07-20T07:30:00.000Z");
  assert.match(calendarEvents[0].event.description, /Trello details:\nInclude the timeline and decision needed\./);
  assert.equal(googleTasks[0].due, "2026-07-20T06:00:00.000Z");
  assert.deepEqual(trelloUpdates, [{
    id: "card-1",
    fields: { due: "2026-07-20T07:30:00.000Z", dueComplete: false }
  }]);
  assert.deepEqual(links, [{
    trelloCardId: "card-1",
    calendarEventId: "event-1",
    googleTaskListId: "planner",
    googleTaskId: "task-1",
    title: "[Work & Business] Write proposal",
    scheduleStart: "2026-07-20T06:00:00.000Z",
    scheduleEnd: "2026-07-20T07:30:00.000Z"
  }]);
});
