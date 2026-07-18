import { config } from "./config.js";
import { getDailyCards } from "./planner.js";
import { trello } from "./trello.js";
import { isActiveTrelloCard } from "./trello-workflow.js";
import { addDaysToDateKey, localDateKey } from "./timezone.js";

function compareDateKeys(left, right) {
  return String(left).localeCompare(String(right));
}

export function endOfPlanningWeek(now = new Date(), timeZone = config.timezone) {
  const today = localDateKey(now, timeZone);
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  const daysUntilWeekEnd = (config.weekStartsOn + 6 - weekday + 7) % 7;
  return addDaysToDateKey(today, daysUntilWeekEnd);
}

export function endOfPlanningMonth(now = new Date(), timeZone = config.timezone) {
  const today = localDateKey(now, timeZone);
  const [year, month] = today.split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function dueDateKey(card, timeZone) {
  if (!card?.due) return null;
  const date = new Date(card.due);
  return Number.isNaN(date.getTime()) ? null : localDateKey(date, timeZone);
}

// Columns are a planning funnel. A real due date controls promotion, while
// cards without one stay where the user placed them rather than receiving an
// invented commitment date.
export async function reconcilePlanningPipeline({
  now = new Date(),
  loadCards = getDailyCards,
  client = trello
} = {}) {
  const { cards, workflow } = await loadCards();
  const captureId = workflow.captureList?.id;
  const monthId = workflow.monthList?.id;
  const weekId = workflow.weekList?.id;
  if (!captureId || !monthId || !weekId) {
    return { inboxToMonth: 0, inboxToWeek: 0, monthToWeek: 0, skipped: "lists-not-found" };
  }

  const weekEnd = endOfPlanningWeek(now);
  const monthEnd = endOfPlanningMonth(now);
  const result = { inboxToMonth: 0, inboxToWeek: 0, monthToWeek: 0 };

  for (const card of cards.filter((item) => isActiveTrelloCard(item, workflow))) {
    const due = dueDateKey(card, config.timezone);
    if (!due) continue;
    if (card.idList === captureId && compareDateKeys(due, weekEnd) <= 0) {
      await client.updateCard(card.id, { idList: weekId });
      result.inboxToWeek += 1;
    } else if (card.idList === captureId && compareDateKeys(due, monthEnd) <= 0) {
      await client.updateCard(card.id, { idList: monthId });
      result.inboxToMonth += 1;
    } else if (card.idList === monthId && compareDateKeys(due, weekEnd) <= 0) {
      await client.updateCard(card.id, { idList: weekId });
      result.monthToWeek += 1;
    }
  }
  return result;
}
