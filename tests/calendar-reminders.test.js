import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDefaultReminders } from "../src/google-calendar.js";

test("normalizes and deduplicates calendar default reminders", () => {
  assert.deepEqual(normalizeDefaultReminders([
    { method: "popup", minutes: 15 },
    { method: "popup", minutes: 60 },
    { method: "popup", minutes: 15 }
  ]), [{ method: "popup", minutes: 60 }, { method: "popup", minutes: 15 }]);
});

test("rejects invalid calendar default reminders", () => {
  assert.throws(() => normalizeDefaultReminders([]), /At least one/);
  assert.throws(() => normalizeDefaultReminders([{ method: "sms", minutes: 15 }]), /popup or email/);
});
