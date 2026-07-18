import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executeTrelloIntent, handleTrelloMessage, savePendingTrelloAction } from "../src/trello-chat.js";
import { config } from "../src/config.js";

async function temporaryState() {
  const root = await mkdtemp(path.join(os.tmpdir(), "planner-trello-actions-"));
  return { statePath: path.join(root, "pending.json"), auditPath: path.join(root, "audit.jsonl") };
}

test("Trello changes can use the preview flow when immediate application is disabled", async () => {
  const files = await temporaryState();
  const intent = { configured: true, action: "create", task: "Book dentist", list: "Inbox" };
  const original = config.trello.autoApply;
  let executions = 0;
  const dependencies = {
    ...files,
    parseRequest: async () => intent,
    loadDailyCards: async () => ({ board: { id: "board" }, cards: [] }),
    execute: async () => { executions += 1; return "Added to Inbox: Book dentist"; }
  };

  try {
    config.trello.autoApply = false;
    const preview = await handleTrelloMessage("add book dentist", "owner", dependencies);
    assert.match(preview, /Trello preview/);
    assert.equal(executions, 0);
    assert.equal(await handleTrelloMessage("yes", "owner", dependencies), "Added to Inbox: Book dentist");
    assert.equal(executions, 1);
    assert.equal(await handleTrelloMessage("yes", "owner", dependencies), null);
    const audit = await readFile(files.auditPath, "utf8");
    assert.match(audit, /"action":"create"/);
    assert.match(audit, /"outcome":"success"/);
    assert.doesNotMatch(audit, /Book dentist/);
  } finally {
    config.trello.autoApply = original;
  }
});

test("Trello confirmation can be cancelled or expires without an action", async () => {
  const files = await temporaryState();
  const intent = { configured: true, action: "complete", task: "Private task" };
  const dependencies = { ...files, parseRequest: async () => intent };
  await handleTrelloMessage("complete private task", "owner", dependencies);
  assert.equal(await handleTrelloMessage("no", "owner", dependencies), "Trello action discarded.");

  const old = new Date(Date.now() - 16 * 60 * 1000);
  await savePendingTrelloAction("owner", intent, { statePath: files.statePath, now: old });
  const reply = await handleTrelloMessage("yes", "owner", dependencies);
  assert.match(reply, /expired/);
});

test("auto-apply creates a clear new task from one Telegram message", async () => {
  const files = await temporaryState();
  const original = config.trello.autoApply;
  config.trello.autoApply = true;
  let executions = 0;
  try {
    const result = await handleTrelloMessage("add book dentist", "owner", {
      ...files,
      parseRequest: async () => ({ configured: true, action: "create", task: "Book dentist" }),
      loadDailyCards: async () => ({ board: { id: "board" }, cards: [] }),
      execute: async () => { executions += 1; return "Added to Inbox: Book dentist"; }
    });
    assert.equal(result, "Added to Inbox: Book dentist");
    assert.equal(executions, 1);
  } finally {
    config.trello.autoApply = original;
  }
});

test("a scheduled appointment without a matching card creates a new Trello ticket", async () => {
  const created = [];
  const reply = await executeTrelloIntent({
    configured: true,
    action: "schedule",
    task: "Dinner with John",
    scheduleStart: "2026-07-21T17:00:00Z",
    due: "2026-07-21T17:00:00Z",
    labels: []
  }, {
    board: { id: "board", name: "Daily" },
    cards: [],
    client: {
      lists: async () => [{ id: "inbox", name: "Inbox", closed: false }],
      createCard: async (fields) => {
        created.push(fields);
        return { id: "dinner-card", ...fields };
      },
      labels: async () => [],
      setCardLabels: async () => {}
    },
    workflowResolver: async () => ({ captureList: { id: "inbox", name: "Inbox" } })
  });

  assert.equal(reply, "Created and scheduled: Dinner with John");
  assert.deepEqual(created, [{
    idList: "inbox",
    name: "Dinner with John",
    due: "2026-07-21T17:00:00Z"
  }]);
});
