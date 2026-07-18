import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../src/config.js";
import { autoPlanTrelloTasks, findFreeSlot } from "../src/auto-plan.js";

test("finds the next open 30-minute slot around calendar commitments", () => {
  const slot = findFreeSlot({
    now: new Date("2026-07-20T01:00:00.000Z"),
    dates: ["2026-07-20"],
    events: [{ start: { dateTime: "2026-07-20T09:00:00Z" }, end: { dateTime: "2026-07-20T10:00:00Z" } }]
  });
  assert.equal(slot.start.toISOString(), "2026-07-20T10:00:00.000Z");
  assert.equal(slot.end.toISOString(), "2026-07-20T10:30:00.000Z");
});

test("time-blocks Today and This Week cards, but not Inbox or This Month cards", async () => {
  const previous = { autoPlan: config.calendar.autoPlan, dailyLimit: config.calendar.autoPlanDailyLimit };
  config.calendar.autoPlan = true;
  config.calendar.autoPlanDailyLimit = 0;
  const created = [];
  try {
    const result = await autoPlanTrelloTasks({
      now: new Date("2026-07-20T01:00:00.000Z"),
      loadCards: async () => ({
        workflow: { todayList: { id: "today" }, weekList: { id: "week" }, doneList: { id: "done" } },
        lists: [{ id: "today", name: "Today" }, { id: "week", name: "To Do This Week" }, { id: "month", name: "To Do This Month" }, { id: "inbox", name: "Inbox" }, { id: "done", name: "Done" }],
        cards: [
          { id: "today-card", idList: "today", name: "Today task", labels: [], closed: false },
          { id: "week-card", idList: "week", name: "Week task", labels: [], closed: false },
          { id: "month-card", idList: "month", name: "Month task", labels: [], closed: false },
          { id: "inbox-card", idList: "inbox", name: "Inbox task", labels: [], closed: false }
        ]
      }),
      listEvents: async () => [],
      createArtifacts: async (input) => { created.push(input); },
      estimateDuration: async () => ({ minutes: 90 })
    });
    assert.equal(result.planned, 2);
    assert.deepEqual(created.map((item) => item.card.id), ["today-card", "week-card"]);
    assert.deepEqual(created.map((item) => item.durationMinutes), [90, 90]);
  } finally {
    config.calendar.autoPlan = previous.autoPlan;
    config.calendar.autoPlanDailyLimit = previous.dailyLimit;
  }
});

test("reserves the protected noon lunch break before placing a task", async () => {
  const previous = { autoPlan: config.calendar.autoPlan, dailyLimit: config.calendar.autoPlanDailyLimit };
  config.calendar.autoPlan = true;
  config.calendar.autoPlanDailyLimit = 0;
  const created = [];
  try {
    await autoPlanTrelloTasks({
      // 11:45 rounds up to noon, which must be skipped for lunch.
      now: new Date("2026-07-20T11:45:00.000Z"),
      loadCards: async () => ({
        workflow: { todayList: { id: "today" } },
        lists: [{ id: "today", name: "Today" }],
        cards: [{ id: "today-card", idList: "today", name: "Write proposal", labels: [], closed: false }]
      }),
      listEvents: async () => [],
      estimateDuration: async () => ({ minutes: 30 }),
      createArtifacts: async (input) => { created.push(input); }
    });
    assert.equal(created[0].scheduleStart, "2026-07-20T13:00:00.000Z");
  } finally {
    config.calendar.autoPlan = previous.autoPlan;
    config.calendar.autoPlanDailyLimit = previous.dailyLimit;
  }
});

test("plans dated weekly commitments before flexible undated work", async () => {
  const previous = { autoPlan: config.calendar.autoPlan, dailyLimit: config.calendar.autoPlanDailyLimit };
  config.calendar.autoPlan = true;
  config.calendar.autoPlanDailyLimit = 0;
  const created = [];
  try {
    await autoPlanTrelloTasks({
      now: new Date("2026-07-20T01:00:00.000Z"),
      loadCards: async () => ({
        workflow: { weekList: { id: "week" } },
        cards: [
          { id: "flexible", idList: "week", name: "Flexible task", labels: [], closed: false, due: null },
          { id: "deadline", idList: "week", name: "Deadline task", labels: [], closed: false, due: "2026-07-21T03:00:00.000Z" }
        ]
      }),
      listEvents: async () => [],
      estimateDuration: async () => ({ minutes: 30 }),
      createArtifacts: async ({ card }) => created.push(card.id)
    });
    assert.deepEqual(created, ["deadline", "flexible"]);
  } finally {
    config.calendar.autoPlan = previous.autoPlan;
    config.calendar.autoPlanDailyLimit = previous.dailyLimit;
  }
});

test("formats an unlinked weekly card before creating its planner artifacts", async () => {
  const previous = { autoPlan: config.calendar.autoPlan, dailyLimit: config.calendar.autoPlanDailyLimit };
  config.calendar.autoPlan = true;
  config.calendar.autoPlanDailyLimit = 0;
  const updates = [];
  const created = [];
  try {
    await autoPlanTrelloTasks({
      now: new Date("2026-07-20T01:00:00.000Z"),
      loadCards: async () => ({
        workflow: { weekList: { id: "week" } },
        cards: [{ id: "week-card", idList: "week", name: "rambling thought", desc: "", labels: [], closed: false }]
      }),
      listEvents: async () => [],
      formatTask: async () => ({ title: "Write a concise project brief", description: "Include scope and next steps." }),
      updateCard: async (id, fields) => updates.push({ id, fields }),
      estimateDuration: async () => ({ minutes: 30 }),
      createArtifacts: async ({ card }) => created.push(card)
    });
    assert.deepEqual(updates, [{ id: "week-card", fields: { name: "Write a concise project brief", desc: "Include scope and next steps." } }]);
    assert.deepEqual(created, [{ id: "week-card", idList: "week", name: "Write a concise project brief", desc: "Include scope and next steps.", labels: [], closed: false }]);
  } finally {
    config.calendar.autoPlan = previous.autoPlan;
    config.calendar.autoPlanDailyLimit = previous.dailyLimit;
  }
});
