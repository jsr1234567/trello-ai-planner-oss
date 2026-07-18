import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureKnowledge, formatActiveReminders, indexKnowledgeSources, recallKnowledge } from "../src/life-knowledge.js";
import { formatFallbackTimeline } from "../src/planner.js";
import { executeTrelloIntent } from "../src/trello-chat.js";

async function temporaryVault() {
  return mkdtemp(path.join(os.tmpdir(), "planner-knowledge-"));
}

test("captures promises and dated reminders as readable local records", async () => {
  const root = await temporaryVault();
  const reminder = await captureKnowledge("/remind 2026-07-20 book a dentist visit", { root });
  const promise = await captureKnowledge("/promise call Mum this week", { root });
  assert.equal(reminder.kind, "reminder");
  assert.equal(reminder.due, "2026-07-20");
  assert.equal(promise.kind, "promise");
  const briefing = await formatActiveReminders({ root });
  assert.match(briefing, /book a dentist visit/);
  assert.match(briefing, /call Mum this week/);
});

test("indexes explicitly selected Markdown and text sources for recall", async () => {
  const root = await temporaryVault();
  const source = path.join(root, "source");
  await mkdir(source);
  await writeFile(path.join(source, "idea.md"), "# Project Atlas\n\nRemember the renewable-energy customer interview.");
  const indexed = await indexKnowledgeSources({ root, sourceDirectories: [source] });
  assert.equal(indexed.indexed, 1);
  const matches = await recallKnowledge("renewable customer", { root });
  assert.equal(matches[0].kind, "source");
  assert.match(matches[0].text, /renewable-energy/);
});

test("formats a compact daily fallback as time followed by action", () => {
  const plan = formatFallbackTimeline(
    [{ task: "Write the launch brief" }, { task: "Call the accountant" }],
    [{ start: "2026-07-15T03:30:00.000Z", summary: "Team call" }],
    { startHour: 9 }
  );
  assert.match(plan, /^03:30 — Team call/m);
  assert.match(plan, /^09:00 — Write the launch brief/m);
  assert.match(plan, /^10:00 — Call the accountant/m);
});

test("executes a natural-language create intent in the configured Inbox list", async () => {
  const calls = [];
  const reply = await executeTrelloIntent(
    { action: "create", task: "Book a dentist visit", list: "tasks", due: null },
    {
      board: { id: "board-1", name: "Daily" },
      cards: [],
      workflowResolver: async () => ({ captureList: { id: "list-1" } }),
      client: {
        lists: async () => [{ id: "list-1", name: "Inbox", closed: false }],
        createCard: async (fields) => calls.push(fields)
      }
    }
  );
  assert.deepEqual(calls, [{ idList: "list-1", name: "Book a dentist visit", due: undefined }]);
  assert.equal(reply, "Added to Inbox: Book a dentist visit");
});

test("uses the approved taxonomy labels when creating a Trello task", async () => {
  const calls = [];
  const reply = await executeTrelloIntent(
    { action: "create", task: "Pay rent", list: "", due: null, labels: ["Finance & Admin"] },
    {
      board: { id: "board-1", name: "Daily" },
      cards: [],
      workflowResolver: async () => ({ captureList: { id: "list-1" } }),
      client: {
        lists: async () => [{ id: "list-1", name: "Inbox", closed: false }],
        labels: async () => [{ id: "label-1", name: "Finance & Admin" }],
        createCard: async (fields) => { calls.push(["create", fields]); return { id: "card-1", name: fields.name }; },
        setCardLabels: async (...args) => calls.push(["labels", ...args])
      }
    }
  );
  assert.deepEqual(calls, [
    ["create", { idList: "list-1", name: "Pay rent", due: undefined }],
    ["labels", "card-1", ["label-1"]]
  ]);
  assert.equal(reply, "Added to Inbox: Pay rent");
});

test("executes a natural-language completion intent against a matching open card", async () => {
  const calls = [];
  const reply = await executeTrelloIntent(
    { action: "complete", task: "launch brief" },
    {
      board: { id: "board-1", name: "Daily" },
      cards: [{ id: "card-1", name: "Write launch brief", closed: false }],
      workflowResolver: async () => ({}),
      client: { lists: async () => [], updateCard: async (...args) => calls.push(args) }
    }
  );
  assert.deepEqual(calls, [["card-1", { closed: true, dueComplete: true }]]);
  assert.equal(reply, "Completed: Write launch brief");
});
