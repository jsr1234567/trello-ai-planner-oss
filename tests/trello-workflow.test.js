import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveTrelloWorkflow } from "../src/trello-workflow.js";

async function statePath() {
  const root = await mkdtemp(path.join(os.tmpdir(), "planner-workflow-"));
  return path.join(root, "trello-workflow.json");
}

test("workflow roles stay attached to Trello list IDs after a list is renamed", async () => {
  const state = await statePath();
  const board = { id: "daily" };
  const initial = await resolveTrelloWorkflow({
    board,
    statePath: state,
    lists: [
      { id: "capture", name: "Inbox", closed: false },
      { id: "month", name: "To Do This Month", closed: false },
      { id: "week", name: "To Do This Week", closed: false },
      { id: "today", name: "Today", closed: false },
      { id: "done", name: "Done", closed: false }
    ]
  });
  assert.equal(initial.captureList.id, "capture");
  assert.equal(initial.monthList.id, "month");
  assert.equal(initial.weekList.id, "week");
  assert.equal(initial.todayList.id, "today");
  assert.equal(initial.doneList.id, "done");

  const renamed = await resolveTrelloWorkflow({
    board,
    statePath: state,
    lists: [
      { id: "capture", name: "Ideas to triage", closed: false },
      { id: "month", name: "This month", closed: false },
      { id: "week", name: "Weekly commitments", closed: false },
      { id: "today", name: "Right now", closed: false },
      { id: "done", name: "Shipped", closed: false }
    ]
  });
  assert.equal(renamed.captureList.name, "Ideas to triage");
  assert.equal(renamed.monthList.name, "This month");
  assert.equal(renamed.weekList.name, "Weekly commitments");
  assert.equal(renamed.todayList.name, "Right now");
  assert.equal(renamed.doneList.name, "Shipped");
});

test("workflow infers a sensible capture list and leaves Done optional", async () => {
  const workflow = await resolveTrelloWorkflow({
    board: { id: "custom" },
    statePath: await statePath(),
    lists: [{ id: "ideas", name: "Ideas", closed: false }, { id: "doing", name: "Doing", closed: false }]
  });
  assert.equal(workflow.captureList.id, "ideas");
  assert.equal(workflow.monthList, null);
  assert.equal(workflow.weekList, null);
  assert.equal(workflow.todayList, null);
  assert.equal(workflow.doneList, null);
});
