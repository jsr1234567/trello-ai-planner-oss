import { countActionAudits } from "./action-audit.js";
import { config } from "./config.js";
import { estimatedWeeklyHostingCost, formatUsd, getWeeklyUsageSummary } from "./costs.js";
import { listCalendarEventsBetween } from "./google-calendar.js";
import { getDailyCards } from "./planner.js";
import { addDaysToDateKey, zonedDateTimeToDate } from "./timezone.js";
import { isActiveTrelloCard } from "./trello-workflow.js";

function weeklyBounds(usage) {
  return {
    start: zonedDateTimeToDate(`${usage.start}T00:00`, config.timezone),
    end: zonedDateTimeToDate(`${usage.end}T00:00`, config.timezone)
  };
}

function countDueThisWeek(cards, start, end) {
  return cards.filter((card) => {
    const due = Date.parse(card.due || "");
    return !card.closed && Number.isFinite(due) && due >= start.getTime() && due < end.getTime();
  }).length;
}

export async function buildWeeklyReport({
  now = new Date(),
  getUsage = getWeeklyUsageSummary,
  loadDailyCards = getDailyCards,
  loadCalendarEvents = listCalendarEventsBetween,
  countActions = countActionAudits
} = {}) {
  const usage = await getUsage({ now });
  const { start, end } = weeklyBounds(usage);
  const through = addDaysToDateKey(usage.end, -1);
  const [cardsResult, eventsResult, actions] = await Promise.all([
    loadDailyCards(),
    loadCalendarEvents(start, end),
    countActions({ start, end })
  ].map((promise) => Promise.resolve(promise).catch(() => null)));

  const openCards = cardsResult ? cardsResult.cards.filter((card) => isActiveTrelloCard(card, cardsResult.workflow)) : [];
  const eventCount = Array.isArray(eventsResult) ? eventsResult.length : null;
  const hostingWeekly = estimatedWeeklyHostingCost();
  const tracking = usage.trackingStartedAt
    ? `${usage.textRequests} text calls · ${usage.inputTokens.toLocaleString()} in / ${usage.outputTokens.toLocaleString()} out`
    : "tracking starts with this release; earlier API usage was not recorded";
  const lines = [
    "Weekly planner report",
    `Week: ${usage.start}–${through}`,
    cardsResult ? `Open Trello tasks: ${openCards.length} · due this week: ${countDueThisWeek(openCards, start, end)}` : "Trello: unavailable for this report",
    eventCount === null ? "Calendar: unavailable for this report" : `Calendar events: ${eventCount}`,
    `Confirmed Trello actions: ${actions?.success || 0}${actions?.failure ? ` · ${actions.failure} failed` : ""}`,
    "",
    `LLM usage: ${tracking}`,
    `Text-model estimate: ${formatUsd(usage.textCostUsd)}${usage.unpricedTextRequests ? ` · ${usage.unpricedTextRequests} unpriced model call(s)` : ""}`,
    `Voice transcription: ${(usage.transcriptionSeconds / 60).toFixed(1)} min · ${formatUsd(usage.transcriptionCostUsd)}`,
    `Hosting estimate: ${formatUsd(config.costs.hostingMonthlyUsd)}/month · ${formatUsd(hostingWeekly)} this week`,
    `Tracked weekly total: ${formatUsd(usage.llmCostUsd + hostingWeekly)} (excludes taxes, credits, and earlier untracked LLM usage)`,
    "",
    "Next step: reply with the one change you want to make this week."
  ];
  return lines.join("\n");
}
