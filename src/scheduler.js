import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { buildPlannerFollowUp, buildScheduleSuggestion, buildTodayBriefing } from "./planner.js";
import { sendTelegramMessage } from "./telegram.js";
import { localDateKey, localDateParts } from "./timezone.js";
import { reserveProactiveDelivery } from "./notification-policy.js";
import { buildWeeklyReport } from "./weekly-report.js";

const defaultStatePath = path.resolve(".planner-data/morning-state.json");
const lockMaximumAgeMs = 5 * 60 * 1000;

async function loadState(statePath) {
  try { return JSON.parse(await readFile(statePath, "utf8")); }
  catch { return {}; }
}

async function writeState(statePath, state) {
  await mkdir(path.dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(temporaryPath, statePath);
}

async function acquireRunLock(statePath) {
  const lockPath = `${statePath}.lock`;
  await mkdir(path.dirname(statePath), { recursive: true });
  try {
    return { lockPath, handle: await open(lockPath, "wx", 0o600) };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    try {
      const existing = await stat(lockPath);
      if (Date.now() - existing.mtimeMs > lockMaximumAgeMs) {
        await rm(lockPath, { force: true });
        return acquireRunLock(statePath);
      }
    } catch (statError) {
      if (statError.code === "ENOENT") return acquireRunLock(statePath);
      throw statError;
    }
    return null;
  }
}

export function scheduledSlotAt(now = new Date()) {
  const local = localDateParts(now, config.timezone);
  if (Number(local.hour) === config.morningHour && Number(local.minute) === config.morningMinute) return "morning";
  if (Number(local.hour) === config.afternoonHour && Number(local.minute) === config.afternoonMinute) return "afternoon";
  return null;
}

export async function runScheduledDelivery(slot, {
  now = new Date(),
  statePath = defaultStatePath,
  buildToday = buildTodayBriefing,
  buildFollowUp = buildPlannerFollowUp,
  buildSuggestion = buildScheduleSuggestion,
  buildWeekly = buildWeeklyReport,
  send = sendTelegramMessage,
  reserve = reserveProactiveDelivery
} = {}) {
  if (!["morning", "afternoon", "weekly"].includes(slot)) throw new Error("Schedule slot must be morning, afternoon, or weekly.");
  if (!config.morningEnabled) return { sent: false, reason: "disabled" };

  const lock = await acquireRunLock(statePath);
  if (!lock) return { sent: false, reason: "already-running" };
  try {
    const date = localDateKey(now, config.timezone);
    const state = await loadState(statePath);
    if (state[slot] === date) return { sent: false, reason: "already-sent" };

    // Claim before contacting Telegram. This intentionally prefers no duplicate
    // report over a duplicate report if the process stops after Telegram accepts it.
    state[slot] = date;
    await writeState(statePath, state);

    let messages;
    if (slot === "morning") {
      const [briefing, followUp] = await Promise.all([buildToday(), buildFollowUp("morning")]);
      messages = [
        briefing,
        [followUp, "Next step: reply with the one task you will start first."].filter(Boolean).join("\n\n")
      ].filter(Boolean);
    } else if (slot === "afternoon") {
      messages = [`Afternoon check-in\n\n${await buildSuggestion("afternoon")}\n\nNext step: tell me what needs to change before your next block.`];
    } else {
      messages = [await buildWeekly()];
    }
    // The requested weekly recap should not disappear merely because ordinary
    // alerts consumed that day's low-noise cap. It still respects quiet hours.
    const reservation = await reserve({ now, purpose: `scheduled-${slot}`, priority: slot === "weekly" });
    if (!reservation.allowed) return { sent: false, reason: reservation.reason };
    for (const message of messages) {
      const result = await send(message);
      if (result?.sent === false) return { sent: false, reason: "not-configured" };
    }
    return { sent: true, slot, date };
  } finally {
    await lock.handle.close();
    await rm(lock.lockPath, { force: true });
  }
}

export function startMorningScheduler() {
  if (!config.morningEnabled) return;
  if (!config.scheduler.inProcessEnabled) {
    console.log("Report timing is owned by systemd timers; set PLANNER_IN_PROCESS_SCHEDULER=true only for local development.");
    return;
  }
  console.log(`Local development scheduler enabled (${config.timezone}).`);
  setInterval(() => {
    const slot = scheduledSlotAt();
    if (slot) runScheduledDelivery(slot).catch((error) => console.error(`${slot} schedule error: ${error.message}`));
  }, 30_000);
}
