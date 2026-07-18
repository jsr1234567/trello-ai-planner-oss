import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canSendProactive, isQuietHours, reserveProactiveDelivery } from "../src/notification-policy.js";

const options = { timeZone: "Europe/Paris", quietStartHour: 22, quietEndHour: 7, dailyCap: 2 };

test("quiet hours span midnight in the configured timezone", () => {
  assert.equal(isQuietHours(new Date("2026-07-16T21:00:00.000Z"), options), true); // 23:00 local
  assert.equal(isQuietHours(new Date("2026-07-16T07:00:00.000Z"), options), false); // 09:00 local
  assert.equal(canSendProactive({ sentCount: 2, now: new Date("2026-07-16T07:00:00.000Z"), options }), false);
});

test("proactive delivery reservations enforce the daily cap", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "planner-notifications-"));
  const statePath = path.join(root, "state.json");
  const now = new Date("2026-07-16T07:00:00.000Z");
  assert.equal((await reserveProactiveDelivery({ now, statePath, options, purpose: "first" })).allowed, true);
  assert.equal((await reserveProactiveDelivery({ now, statePath, options, purpose: "second" })).allowed, true);
  const third = await reserveProactiveDelivery({ now, statePath, options, purpose: "third" });
  assert.deepEqual(third.reason, "daily-cap");
});

test("a requested weekly recap can bypass the cap but never quiet hours", () => {
  const daytime = new Date("2026-07-16T07:00:00.000Z");
  const quiet = new Date("2026-07-16T21:00:00.000Z");
  assert.equal(canSendProactive({ sentCount: 99, now: daytime, options, priority: true }), true);
  assert.equal(canSendProactive({ sentCount: 0, now: quiet, options, priority: true }), false);
});
