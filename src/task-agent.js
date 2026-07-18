import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { getDailyCards } from "./planner.js";
import { reviewTasks } from "./ai.js";
import { sendTelegramMessage } from "./telegram.js";
import { reserveProactiveDelivery } from "./notification-policy.js";
import { isActiveTrelloCard } from "./trello-workflow.js";

const statePath = path.resolve(".planner-data/trello-notification-state.json");

function taskShape(card) {
  return {
    id: card.id,
    task: card.name,
    description: card.desc,
    due: card.due,
    dueComplete: card.dueComplete,
    lastActivity: card.dateLastActivity,
    labels: card.labels?.map((label) => label.name).filter(Boolean),
    url: card.url
  };
}

async function loadState() {
  try { return JSON.parse(await readFile(statePath, "utf8")); }
  catch { return { cards: {}, dueNotified: {} }; }
}

async function saveState(state) {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2));
}

export async function buildTaskReview() {
  const { cards, workflow } = await getDailyCards();
  const result = await reviewTasks(cards.filter((card) => isActiveTrelloCard(card, workflow)).map(taskShape));
  if (result.configured && result.text?.trim()) return result.text;
  return result.message || "Task review is not configured.";
}

export async function scanTrelloNotifications({ notify = true, now = new Date(), send = sendTelegramMessage, reserve = reserveProactiveDelivery } = {}) {
  const { cards, workflow } = await getDailyCards();
  const state = await loadState();
  const nowMs = now.getTime();
  const current = {};
  const changed = [];
  const dueSoon = [];

  for (const card of cards.filter((item) => isActiveTrelloCard(item, workflow))) {
    const task = taskShape(card);
    current[task.id] = task;
    if (state.cards[task.id] && state.cards[task.id].lastActivity !== task.lastActivity) changed.push(task);
    if (task.due && !task.dueComplete) {
      const dueAt = Date.parse(task.due);
      if (dueAt >= nowMs && dueAt <= nowMs + 24 * 60 * 60 * 1000 && state.dueNotified[task.id] !== task.due) dueSoon.push(task);
    }
  }

  const messages = [
    ...changed.slice(0, 5).map((task) => `Updated: ${task.task}`),
    ...dueSoon.slice(0, 5).map((task) => `Due within 24 hours: ${task.task}`)
  ];

  state.cards = current;
  let notified = false;
  let suppressed;
  if (notify && config.trello.pushEnabled && messages.length) {
    const reservation = await reserve({ now, purpose: "trello-update" });
    if (!reservation.allowed) suppressed = reservation.reason;
    else {
      const result = await send(`Trello update\n\n${messages.join("\n\n")}`);
      notified = result?.sent !== false;
      if (notified) for (const task of dueSoon) state.dueNotified[task.id] = task.due;
    }
  }
  await saveState(state);
  return { changed: changed.length, dueSoon: dueSoon.length, notified, suppressed };
}

export function startTaskAgent() {
  if (!config.trello.pushEnabled) return;
  const interval = Math.max(5, config.trello.pushPollMinutes) * 60_000;
  console.log(`Trello notification agent enabled; polling every ${interval / 60_000} minutes`);
  scanTrelloNotifications({ notify: false }).catch((error) => console.error(`Trello agent seed error: ${error.message}`));
  setInterval(() => scanTrelloNotifications().catch((error) => console.error(`Trello agent error: ${error.message}`)), interval);
}
