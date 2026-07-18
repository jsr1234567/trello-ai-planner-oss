import assert from "node:assert/strict";
import test from "node:test";
import { reconcilePlanningPipeline } from "../src/planning-pipeline.js";

test("promotes dated cards through the Inbox, Month, and Week planning funnel", async () => {
  const changes = [];
  const result = await reconcilePlanningPipeline({
    now: new Date("2026-07-20T01:00:00.000Z"),
    loadCards: async () => ({
      workflow: {
        captureList: { id: "inbox" },
        monthList: { id: "month" },
        weekList: { id: "week" },
        doneList: { id: "done" }
      },
      cards: [
        { id: "inbox-week", idList: "inbox", due: "2026-07-22T10:00:00.000Z", closed: false },
        { id: "inbox-month", idList: "inbox", due: "2026-07-30T10:00:00.000Z", closed: false },
        { id: "inbox-later", idList: "inbox", due: "2026-08-01T10:00:00.000Z", closed: false },
        { id: "month-week", idList: "month", due: "2026-07-24T10:00:00.000Z", closed: false },
        { id: "inbox-undated", idList: "inbox", due: null, closed: false }
      ]
    }),
    client: { updateCard: async (id, fields) => changes.push({ id, fields }) }
  });
  assert.deepEqual(result, { inboxToMonth: 1, inboxToWeek: 1, monthToWeek: 1 });
  assert.deepEqual(changes, [
    { id: "inbox-week", fields: { idList: "week" } },
    { id: "inbox-month", fields: { idList: "month" } },
    { id: "month-week", fields: { idList: "week" } }
  ]);
});
