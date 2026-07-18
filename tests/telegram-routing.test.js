import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "../src/config.js";
import { detectPlannerShortcut, isOwnerMessage, saveConversationTurn, telegramPollRequestTimeoutMs } from "../src/telegram.js";
import { explicitCalendarDateError, looksLikeCalendarRequest } from "../src/calendar-chat.js";

test("keeps Telegram's HTTP deadline beyond the long-poll window", () => {
  assert.equal(telegramPollRequestTimeoutMs(25), 30_000);
  assert.equal(telegramPollRequestTimeoutMs(0), 12_000);
});

test("clear task and calendar requests execute immediately by default", () => {
  assert.equal(config.trello.autoApply, true);
  assert.equal(config.calendar.autoSchedule, true);
});

test("plain planning questions map to the right shortcut", () => {
  assert.equal(detectPlannerShortcut("What should I focus on today?"), "today");
  assert.equal(detectPlannerShortcut("Could you review my Trello tasks?"), "review");
  assert.equal(detectPlannerShortcut("Please replan my day"), "suggestions");
  assert.equal(detectPlannerShortcut("Add buy coffee"), null);
  assert.equal(detectPlannerShortcut("/today"), null);
});

test("recognizes ordinary meeting language as a calendar request", () => {
  assert.equal(looksLikeCalendarRequest("I want to schedule a 6pm meeting with Mr X today"), true);
  assert.equal(looksLikeCalendarRequest("schedule the existing tax task for 18:00"), false);
});

test("rejects an inferred calendar date that conflicts with the stated day", () => {
  assert.equal(explicitCalendarDateError("schedule the call on the 22nd at 8pm", "2026-07-27T20:00"), "I could not match the date in your message. Please resend it with the full date (for example, July 22 at 8 p.m.).");
  assert.equal(explicitCalendarDateError("schedule the call on the 22nd at 8pm", "2026-07-22T20:00"), null);
});

test("only the configured private Telegram chat is authorized", () => {
  const originalChatId = config.telegram.chatId;
  config.telegram.chatId = "12345";
  try {
    assert.equal(isOwnerMessage({ chat: { id: 12345, type: "private" } }), true);
    assert.equal(isOwnerMessage({ chat: { id: 12345, type: "group" } }), false);
    assert.equal(isOwnerMessage({ chat: { id: 98765, type: "private" } }), false);
  } finally {
    config.telegram.chatId = originalChatId;
  }
});

test("retains command and calendar interactions in the conversation state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "planner-telegram-history-"));
  const statePath = path.join(root, "telegram-conversations.json");
  await saveConversationTurn("owner", "schedule a call with Jennyi", "Calendar event created and confirmed by Google: Call with Jennyi", { statePath });
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.deepEqual(state.owner, [
    { role: "user", content: "schedule a call with Jennyi" },
    { role: "assistant", content: "Calendar event created and confirmed by Google: Call with Jennyi" }
  ]);
});
