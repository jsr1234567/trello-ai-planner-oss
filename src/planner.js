import { config } from "./config.js";
import { trello } from "./trello.js";
import { suggestScheduleChanges } from "./ai.js";
import { listTodayEvents } from "./google-calendar.js";
import { formatActiveReminders } from "./life-knowledge.js";
import { isActiveTrelloCard, resolveTrelloWorkflow } from "./trello-workflow.js";

function localTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: config.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  const fields = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${fields.hour}:${fields.minute}`;
}

function localDay(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(value));
  const fields = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function uniqueCards(cards) {
  const byName = new Map();
  for (const card of cards) {
    const key = card.name.trim().toLowerCase();
    const existing = byName.get(key);
    if (!existing || (card.due && !existing.due)) byName.set(key, card);
  }
  return [...byName.values()];
}

export function formatFallbackTimeline(cards, events, { startHour = config.dayStartHour } = {}) {
  const commitments = events.map((event) => {
    const time = localTime(event.start);
    return time ? `${time} — ${event.summary}` : `All day — ${event.summary}`;
  });
  const tasks = cards.slice(0, 3).map((card, index) => {
    const hour = String(Math.min(23, startHour + index)).padStart(2, "0");
    return `${hour}:00 — ${card.task}`;
  });
  return [...commitments, ...tasks]
    .sort((a, b) => {
      const aTime = a.match(/^(\d{2}):(\d{2})/);
      const bTime = b.match(/^(\d{2}):(\d{2})/);
      if (!aTime) return 1;
      if (!bTime) return -1;
      return Number(aTime[1]) * 60 + Number(aTime[2]) - Number(bTime[1]) * 60 - Number(bTime[2]);
    })
    .join("\n") || "09:00 — Choose one task from the Daily board.";
}

// The primary Telegram report is an agenda, not an AI proposal. Keeping it
// deterministic means every time-stamped line has a corresponding Calendar
// event and cannot be invented at an impossible time.
export function formatAgendaTimeline(events) {
  return events.map((event) => {
    const time = localTime(event.start);
    return time ? `${time} — ${event.summary}` : `All day — ${event.summary}`;
  }).join("\n") || "No agenda blocks yet today.";
}

export async function getDailyCards() {
  const boards = await trello.boards();
  const board = boards.find((item) => !item.closed && item.name.toLowerCase() === config.trello.boardName.toLowerCase());
  if (!board) throw new Error(`Active Trello board not found: ${config.trello.boardName}`);
  const [cards, lists] = await Promise.all([trello.boardCards(board.id), trello.lists(board.id)]);
  const workflow = await resolveTrelloWorkflow({ board, lists });
  return { board, cards, lists, workflow };
}

export async function buildTodayBriefing({
  loadDailyCards = getDailyCards,
  loadTodayEvents = listTodayEvents
} = {}) {
  const { board } = await loadDailyCards();

  let events = [];
  try { events = await loadTodayEvents(); }
  catch (error) { console.warn(`Calendar unavailable: ${error.message}`); }
  return `Today — ${board.name}\n\n${formatAgendaTimeline(events)}`;
}

export async function buildPlannerFollowUp(period = "morning") {
  const sections = [];
  const reminders = await formatActiveReminders().catch((error) => {
    console.warn(`Life knowledge unavailable: ${error.message}`);
    return "";
  });
  if (reminders) sections.push(reminders);

  try {
    const { cards, workflow } = await getDailyCards();
    const events = await listTodayEvents().catch(() => []);
    const result = await suggestScheduleChanges({
      period,
      cards: cards.filter((card) => isActiveTrelloCard(card, workflow)).slice(0, 40).map((card) => ({ task: card.name, due: card.due, url: card.url })),
      events
    });
    if (result.configured && result.text?.trim()) sections.push(`Suggestions\n${result.text.trim()}`);
  } catch (error) {
    console.warn(`Planner follow-up unavailable: ${error.message}`);
  }
  return sections.join("\n\n");
}

export async function buildScheduleSuggestion(period = "morning") {
  const { cards, workflow } = await getDailyCards();
  let events = [];
  try { events = await listTodayEvents(); }
  catch (error) { console.warn(`Calendar unavailable for schedule suggestion: ${error.message}`); }
  const result = await suggestScheduleChanges({
    period,
    cards: cards.filter((card) => isActiveTrelloCard(card, workflow)).slice(0, 40).map((card) => ({ task: card.name, due: card.due, url: card.url })),
    events
  });
  return result.configured && result.text?.trim() ? result.text : result.message;
}
