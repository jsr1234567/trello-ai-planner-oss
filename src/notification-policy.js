import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { localDateKey, localDateParts } from "./timezone.js";

const defaultStatePath = path.resolve(".planner-data/notification-policy.json");

function policy() {
  return {
    timeZone: config.timezone,
    quietStartHour: config.notifications.quietStartHour,
    quietEndHour: config.notifications.quietEndHour,
    dailyCap: config.notifications.proactiveDailyCap
  };
}

export function isQuietHours(now = new Date(), options = policy()) {
  const start = Number(options.quietStartHour);
  const end = Number(options.quietEndHour);
  if (start === end) return false;
  const hour = Number(localDateParts(now, options.timeZone).hour);
  return start > end ? hour >= start || hour < end : hour >= start && hour < end;
}

export function canSendProactive({ sentCount = 0, now = new Date(), options = policy(), priority = false } = {}) {
  return !isQuietHours(now, options) && (priority || Number(sentCount) < Math.max(0, Number(options.dailyCap)));
}

async function readState(statePath) {
  try { return JSON.parse(await readFile(statePath, "utf8")); }
  catch { return { days: {} }; }
}

async function writeState(statePath, state) {
  await mkdir(path.dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(temporaryPath, statePath);
}

export async function reserveProactiveDelivery({ now = new Date(), purpose, priority = false, statePath = defaultStatePath, options = policy() } = {}) {
  const state = await readState(statePath);
  const date = localDateKey(now, options.timeZone);
  const sentCount = Number(state.days?.[date] || 0);
  if (!canSendProactive({ sentCount, now, options, priority })) {
    return { allowed: false, reason: isQuietHours(now, options) ? "quiet-hours" : "daily-cap", date };
  }
  state.days = { [date]: sentCount + 1 };
  await writeState(statePath, state);
  return { allowed: true, date, purpose: String(purpose || "planner").slice(0, 80) };
}
