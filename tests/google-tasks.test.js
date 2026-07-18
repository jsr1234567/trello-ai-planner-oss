import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { backfillGoogleTaskLinks, reconcileDailyTrelloWorkflow, syncCompletedGoogleTasks, taskTitleKey, updatePlannerEventSchedule } from "../src/google-tasks.js";

async function temporaryState(initial = { links: [] }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "planner-google-tasks-"));
  const statePath = path.join(root, "google-task-links.json");
  await writeFile(statePath, JSON.stringify(initial));
  return statePath;
}

test("normalizes planner labels and simple wording differences before matching", () => {
  assert.equal(taskTitleKey("[People & Relationships] I contacted Phong"), "contact phong");
  assert.equal(taskTitleKey("✓ Contact Phong"), "contact phong");
  assert.equal(taskTitleKey("Reroll my key Open AI Codex"), taskTitleKey("Reroll OpenAI Codex key"));
});

test("moving a planner Calendar block updates its Google Task, Trello deadline, and local link", async () => {
  const statePath = await temporaryState({
    links: [{
      trelloCardId: "card-1",
      calendarEventId: "event-1",
      googleTaskListId: "tasks",
      googleTaskId: "task-1",
      status: "open"
    }]
  });
  const googleUpdates = [];
  const trelloUpdates = [];

  const updated = await updatePlannerEventSchedule(
    "event-1",
    new Date("2026-07-20T06:00:00.000Z"),
    new Date("2026-07-20T07:00:00.000Z"),
    {
      statePath,
      api: { tasks: { patch: async (request) => googleUpdates.push(request) } },
      client: { updateCard: async (id, fields) => trelloUpdates.push({ id, fields }) }
    }
  );

  assert.equal(updated, true);
  assert.deepEqual(googleUpdates, [{
    tasklist: "tasks",
    task: "task-1",
    requestBody: { due: "2026-07-20T06:00:00.000Z", status: "needsAction" }
  }]);
  assert.deepEqual(trelloUpdates, [{
    id: "card-1",
    fields: { due: "2026-07-20T07:00:00.000Z", dueComplete: false }
  }]);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.links[0].scheduleStart, "2026-07-20T06:00:00.000Z");
  assert.equal(state.links[0].scheduleEnd, "2026-07-20T07:00:00.000Z");
});

test("backfills an existing completed Google Task only when its Trello and Calendar matches are unique", async () => {
  const statePath = await temporaryState();
  const searches = [];
  const api = {
    tasklists: { list: async () => ({ data: { items: [{ id: "tasks", title: "My Tasks" }] } }) },
    tasks: {
      list: async () => ({ data: { items: [{
        id: "task-phong",
        title: "[People & Relationships] I contacted Phong",
        status: "completed",
        due: "2026-07-16T03:00:00.000Z"
      }] } })
    }
  };
  const client = {
    boards: async () => [{ id: "daily", name: "Daily", closed: false }],
    allBoardCards: async () => [{ id: "card-phong", name: "Contact Phong", closed: false }]
  };
  const searchEvents = async (query) => {
    searches.push(query);
    if (query === "[People & Relationships] I contacted Phong") return [{ id: "event-phong", summary: "Contact Phong" }];
    return [];
  };

  const result = await backfillGoogleTaskLinks({
    api,
    client,
    searchEvents,
    statePath,
    now: new Date("2026-07-16T04:00:00.000Z")
  });

  assert.deepEqual(result, { scanned: 1, linked: 1, calendarLinked: 1, ambiguousTasks: 0, ambiguousCards: 0, ambiguousCalendar: 0, unmatched: 0 });
  assert.deepEqual(searches, ["card-phong", "[People & Relationships] I contacted Phong"]);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.deepEqual(state.links[0], {
    trelloCardId: "card-phong",
    calendarEventId: "event-phong",
    googleTaskListId: "tasks",
    googleTaskId: "task-phong",
    title: "[People & Relationships] I contacted Phong",
    status: "open",
    source: "backfill",
    createdAt: "2026-07-16T04:00:00.000Z"
  });
});

test("does not adopt ambiguous Google Task matches", async () => {
  const statePath = await temporaryState();
  const api = {
    tasklists: { list: async () => ({ data: { items: [{ id: "tasks" }] } }) },
    tasks: { list: async () => ({ data: { items: [{ id: "task", title: "Call Phong" }] } }) }
  };
  const client = {
    boards: async () => [{ id: "daily", name: "Daily", closed: false }],
    allBoardCards: async () => [{ id: "one", name: "Call Phong" }, { id: "two", name: "Call Phong" }]
  };

  const result = await backfillGoogleTaskLinks({ api, client, searchEvents: async () => { throw new Error("must not search"); }, statePath });

  assert.deepEqual(result, { scanned: 1, linked: 0, calendarLinked: 0, ambiguousTasks: 0, ambiguousCards: 1, ambiguousCalendar: 0, unmatched: 0 });
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), { links: [] });
});

test("does not adopt duplicate Google Tasks against one Trello card", async () => {
  const statePath = await temporaryState();
  const api = {
    tasklists: { list: async () => ({ data: { items: [{ id: "tasks" }] } }) },
    tasks: { list: async () => ({ data: { items: [{ id: "one", title: "Call Phong" }, { id: "two", title: "Call Phong" }] } }) }
  };
  const client = {
    boards: async () => [{ id: "daily", name: "Daily", closed: false }],
    allBoardCards: async () => [{ id: "card", name: "Call Phong" }]
  };

  const result = await backfillGoogleTaskLinks({ api, client, searchEvents: async () => { throw new Error("must not search"); }, statePath });

  assert.deepEqual(result, { scanned: 2, linked: 0, calendarLinked: 0, ambiguousTasks: 2, ambiguousCards: 0, ambiguousCalendar: 0, unmatched: 0 });
});

test("a completed backfilled task closes its Trello card and visually completes its Calendar event", async () => {
  const statePath = await temporaryState({
    links: [{
      trelloCardId: "card-phong",
      calendarEventId: "event-phong",
      googleTaskListId: "tasks",
      googleTaskId: "task-phong",
      title: "Contact Phong",
      status: "open"
    }]
  });
  const cardUpdates = [];
  const calendarUpdates = [];
  const result = await syncCompletedGoogleTasks({
    statePath,
    api: { tasks: { get: async () => ({ data: { status: "completed" } }) } },
    client: {
      boards: async () => [{ id: "daily", name: "Daily", closed: false }],
      lists: async () => [{ id: "done", name: "Done", closed: false }],
      boardCards: async () => [{ id: "card-phong", closed: false, dueComplete: false, idList: "inbox" }],
      updateCard: async (id, fields) => cardUpdates.push({ id, fields })
    },
    workflowResolver: async () => ({ doneList: { id: "done" }, captureList: { id: "inbox" } }),
    updateEvent: async (id, event, options) => calendarUpdates.push({ id, event, options })
  });

  assert.deepEqual(result, { checked: 1, completed: 1, reopened: 0, rescheduled: 0 });
  assert.deepEqual(cardUpdates, [{ id: "card-phong", fields: { closed: true, dueComplete: true } }]);
  assert.deepEqual(calendarUpdates, [{
    id: "event-phong",
    event: { summary: "✓ Contact Phong", colorId: "10", transparency: "transparent" },
    options: { confirm: true }
  }]);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).links[0].status, "completed");
});

test("moving a completed card back out of Done reopens its linked Google Task and Calendar block", async () => {
  const statePath = await temporaryState({
    links: [{
      trelloCardId: "card-phong",
      calendarEventId: "event-phong",
      googleTaskListId: "tasks",
      googleTaskId: "task-phong",
      title: "Contact Phong",
      status: "completed",
      completedAt: "2026-07-16T02:00:00.000Z"
    }]
  });
  const taskUpdates = [];
  const cardUpdates = [];
  const calendarUpdates = [];
  const result = await syncCompletedGoogleTasks({
    statePath,
    api: {
      tasks: {
        get: async () => ({ data: { status: "completed" } }),
        patch: async (value) => taskUpdates.push(value)
      }
    },
    client: {
      boards: async () => [{ id: "daily", name: "Daily", closed: false }],
      lists: async () => [{ id: "done", name: "Done", closed: false }, { id: "inbox", name: "Inbox", closed: false }],
      allBoardCards: async () => [{ id: "card-phong", closed: false, dueComplete: true, idList: "inbox" }],
      updateCard: async (id, fields) => cardUpdates.push({ id, fields })
    },
    workflowResolver: async () => ({ doneList: { id: "done" }, captureList: { id: "inbox" } }),
    getEvent: async () => ({ end: { dateTime: "2026-07-17T03:00:00.000Z" } }),
    updateEvent: async (id, event, options) => calendarUpdates.push({ id, event, options })
  });

  assert.deepEqual(result, { checked: 1, completed: 0, reopened: 1, rescheduled: 0 });
  assert.equal(taskUpdates[0].requestBody.status, "needsAction");
  assert.deepEqual(cardUpdates, [{ id: "card-phong", fields: { closed: false, dueComplete: false, due: "2026-07-17T03:00:00.000Z" } }]);
  assert.deepEqual(calendarUpdates[0].event, { summary: "Contact Phong", colorId: "1", transparency: "opaque" });
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).links[0].status, "open");
});

test("reopening a Career & Learning task uses blue rather than the completed green", async () => {
  const statePath = await temporaryState({
    links: [{
      trelloCardId: "card-1",
      calendarEventId: "event-1",
      googleTaskListId: "list-1",
      googleTaskId: "task-1",
      title: "[Career & Learning] Study product design",
      status: "completed"
    }]
  });
  const calendarUpdates = [];
  await syncCompletedGoogleTasks({
    statePath,
    client: {
      boards: async () => [{ id: "board", name: "Daily", closed: false }],
      lists: async () => [{ id: "inbox", name: "Inbox", closed: false }, { id: "done", name: "Done", closed: false }],
      allBoardCards: async () => [{ id: "card-1", idList: "inbox", closed: false, dueComplete: false }],
      updateCard: async () => {}
    },
    api: { tasks: { get: async () => ({ data: { status: "needsAction" } }), patch: async () => {} } },
    getEvent: async () => ({ end: { dateTime: "2026-07-19T10:00:00Z" } }),
    updateEvent: async (_id, event) => { calendarUpdates.push(event); },
    workflowResolver: async () => ({ captureList: { id: "inbox" }, doneList: { id: "done" } })
  });
  assert.equal(calendarUpdates[0].colorId, "9");
});

test("moves only today's scheduled weekly cards into Today and returns stale Today cards", async () => {
  const statePath = await temporaryState({
    links: [
      { trelloCardId: "today-plan", scheduleStart: "2026-07-20T03:00:00.000Z", status: "open" },
      { trelloCardId: "future-plan", scheduleStart: "2026-07-21T03:00:00.000Z", status: "open" },
      { trelloCardId: "stale-today", scheduleStart: "2026-07-19T03:00:00.000Z", status: "open" }
    ]
  });
  const changes = [];
  const result = await reconcileDailyTrelloWorkflow({
    statePath,
    now: new Date("2026-07-20T01:00:00.000Z"),
    client: {
      boards: async () => [{ id: "board", name: "Daily", closed: false }],
      lists: async () => [{ id: "week", name: "To Do This Week", closed: false }, { id: "today", name: "Today", closed: false }, { id: "done", name: "Done", closed: false }],
      allBoardCards: async () => [
        { id: "today-plan", idList: "week", closed: false },
        { id: "future-plan", idList: "week", closed: false },
        { id: "stale-today", idList: "today", closed: false }
      ],
      updateCard: async (id, fields) => changes.push({ id, fields })
    },
    workflowResolver: async () => ({ todayList: { id: "today" }, doneList: { id: "done" } })
  });
  assert.deepEqual(result, { promoted: 1, returnedToWeek: 1 });
  assert.deepEqual(changes, [
    { id: "today-plan", fields: { idList: "today" } },
    { id: "stale-today", fields: { idList: "week" } }
  ]);
});
