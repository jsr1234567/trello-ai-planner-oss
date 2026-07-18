import { config } from "./config.js";
import { listCalendarEventsBetween } from "./google-calendar.js";
import { createPlannerArtifacts } from "./planner-artifacts.js";
import { getDailyCards } from "./planner.js";
import { addDaysToDateKey, localDateKey, zonedDateTimeToDate } from "./timezone.js";
import { isActiveTrelloCard } from "./trello-workflow.js";
import { estimateTaskDuration, formatPlannerTask } from "./ai.js";
import { trello } from "./trello.js";

const slotMinutes = 30;

function localWeekDates(now, timeZone) {
  const today = localDateKey(now, timeZone);
  // The date key is a calendar date, so UTC weekday calculation is deliberate
  // and independent of the server's host timezone.
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  const daysUntilWeekEnd = (config.weekStartsOn + 6 - weekday + 7) % 7;
  return Array.from({ length: daysUntilWeekEnd + 1 }, (_item, index) => addDaysToDateKey(today, index));
}

function eventInterval(event, timeZone) {
  const startValue = event?.start?.dateTime || event?.start?.date || event?.start;
  const endValue = event?.end?.dateTime || event?.end?.date || event?.end;
  if (!startValue || !endValue) return null;
  try {
    const start = /T/.test(startValue) ? new Date(startValue) : zonedDateTimeToDate(`${startValue}T00:00`, timeZone);
    const end = /T/.test(endValue) ? new Date(endValue) : zonedDateTimeToDate(`${endValue}T00:00`, timeZone);
    return Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start ? null : { start, end };
  } catch {
    return null;
  }
}

function overlaps(start, end, interval) {
  return start < interval.end && end > interval.start;
}

export function findFreeSlot({ events = [], dates, now = new Date(), timeZone = config.timezone, durationMinutes = slotMinutes } = {}) {
  const durationMs = durationMinutes * 60_000;
  const intervals = events
    .filter((event) => event?.status !== "cancelled" && event?.transparency !== "transparent")
    .map((event) => eventInterval(event, timeZone))
    .filter(Boolean);
  for (const date of dates || []) {
    const dayStart = zonedDateTimeToDate(`${date}T${String(config.dayStartHour).padStart(2, "0")}:00`, timeZone);
    const dayEnd = zonedDateTimeToDate(`${date}T${String(config.dayEndHour).padStart(2, "0")}:00`, timeZone);
    let candidate = new Date(dayStart);
    if (localDateKey(now, timeZone) === date && now > candidate) {
      candidate = new Date(Math.ceil(now.getTime() / (15 * 60_000)) * 15 * 60_000);
    }
    while (candidate.getTime() + durationMs <= dayEnd.getTime()) {
      const end = new Date(candidate.getTime() + durationMs);
      if (!intervals.some((interval) => overlaps(candidate, end, interval))) return { start: candidate, end, date };
      candidate = new Date(candidate.getTime() + 15 * 60_000);
    }
  }
  return null;
}

function plannedCountByDate(events, timeZone) {
  const counts = new Map();
  for (const event of events) {
    if (!String(event?.description || "").includes("Planner task linked to Trello card")) continue;
    const interval = eventInterval(event, timeZone);
    if (!interval) continue;
    const date = localDateKey(interval.start, timeZone);
    counts.set(date, (counts.get(date) || 0) + 1);
  }
  return counts;
}

function plannedMinutesByDate(events, timeZone) {
  const minutes = new Map();
  for (const event of events) {
    if (!String(event?.description || "").includes("Planner task linked to Trello card")) continue;
    const interval = eventInterval(event, timeZone);
    if (!interval) continue;
    const date = localDateKey(interval.start, timeZone);
    const duration = Math.round((interval.end.getTime() - interval.start.getTime()) / 60_000);
    minutes.set(date, (minutes.get(date) || 0) + duration);
  }
  return minutes;
}

function protectedLunchEvents(dates, timeZone) {
  const durationMs = Math.max(15, Number(config.lunchDurationMinutes) || 60) * 60_000;
  return dates.map((date) => {
    const start = zonedDateTimeToDate(`${date}T${String(config.lunchStartHour).padStart(2, "0")}:00`, timeZone);
    const end = new Date(start.getTime() + durationMs);
    return {
      summary: "Lunch",
      // These virtual events are deliberately not written to Calendar; they
      // are a protected planning boundary rather than a new appointment.
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
      transparency: "opaque"
    };
  });
}

function dueTime(card) {
  const time = new Date(card?.due || "").getTime();
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
}

export async function autoPlanTrelloTasks({
  now = new Date(),
  loadCards = getDailyCards,
  listEvents = listCalendarEventsBetween,
  createArtifacts = createPlannerArtifacts,
  estimateDuration = estimateTaskDuration,
  formatTask = formatPlannerTask,
  updateCard = trello.updateCard
} = {}) {
  if (!config.calendar.autoPlan) return { planned: 0, skipped: "disabled" };
  const { cards, lists, workflow } = await loadCards();
  const dates = localWeekDates(now, config.timezone);
  const rangeStart = zonedDateTimeToDate(`${dates[0]}T00:00`, config.timezone);
  const rangeEnd = zonedDateTimeToDate(`${addDaysToDateKey(dates.at(-1), 1)}T00:00`, config.timezone);
  const calendarEvents = await listEvents(rangeStart, rangeEnd);
  const events = [...calendarEvents, ...protectedLunchEvents(dates, config.timezone)];
  const candidates = cards
    .filter((card) => isActiveTrelloCard(card, workflow))
    // Month and Inbox are intentional review states. Only an explicit weekly
    // commitment or a Today item may consume agenda capacity.
    .filter((card) => card.idList === workflow?.todayList?.id || card.idList === workflow?.weekList?.id)
    .filter((card) => !events.some((event) => String(event?.description || "").includes(card.id)))
    // Keep today first. Within a list, commit explicit earlier deadlines
    // before flexible undated work, which fills only the remaining capacity.
    .sort((a, b) => Number(b.idList === workflow?.todayList?.id) - Number(a.idList === workflow?.todayList?.id)
      || dueTime(a) - dueTime(b)
      || String(a.name || "").localeCompare(String(b.name || "")));
  const dailyLimit = Math.max(0, Math.floor(config.calendar.autoPlanDailyLimit || 0));
  const dailyFocusCapMinutes = Math.max(0, Math.floor(config.dailyFocusCapMinutes || 0));
  const perDay = plannedCountByDate(events, config.timezone);
  const plannedMinutes = plannedMinutesByDate(events, config.timezone);
  let planned = 0;
  const scheduled = [];

  for (const card of candidates) {
    const labels = (card.labels || []).map((label) => label.name).filter(Boolean);
    const needsFormatting = !String(card.desc || "").trim() || String(card.name || "").trim().length > 90;
    const formatted = needsFormatting
      ? await formatTask({
        title: card.name,
        description: card.desc || "",
        labels,
        due: card.due || null
      })
      : { title: card.name, description: card.desc || "" };
    const formattedCard = {
      ...card,
      name: formatted?.title || card.name,
      desc: formatted?.description ?? card.desc ?? ""
    };
    const updates = {};
    if (formattedCard.name !== card.name) updates.name = formattedCard.name;
    if (formattedCard.desc !== (card.desc || "")) updates.desc = formattedCard.desc;
    if (Object.keys(updates).length) await updateCard(card.id, updates);
    const candidateDates = card.idList === workflow?.todayList?.id ? dates.slice(0, 1) : dates;
    const estimate = await estimateDuration({
      title: formattedCard.name,
      description: formattedCard.desc,
      labels,
      due: formattedCard.due || null
    });
    const durationMinutes = Number.isInteger(estimate?.minutes) ? estimate.minutes : slotMinutes;
    const usableDates = candidateDates.filter((date) => {
      if (dailyLimit && (perDay.get(date) || 0) >= dailyLimit) return false;
      return !dailyFocusCapMinutes || (plannedMinutes.get(date) || 0) + durationMinutes <= dailyFocusCapMinutes;
    });
    const slot = findFreeSlot({ events, dates: usableDates, now, timeZone: config.timezone, durationMinutes });
    if (!slot || (dailyLimit && (perDay.get(slot.date) || 0) >= dailyLimit)) continue;
    await createArtifacts({ card: formattedCard, labels, scheduleStart: slot.start.toISOString(), durationMinutes });
    const event = {
      description: `Planner task linked to Trello card ${card.id}.`,
      start: { dateTime: slot.start.toISOString() },
      end: { dateTime: slot.end.toISOString() }
    };
    events.push(event);
    perDay.set(slot.date, (perDay.get(slot.date) || 0) + 1);
    plannedMinutes.set(slot.date, (plannedMinutes.get(slot.date) || 0) + durationMinutes);
    planned += 1;
    scheduled.push({ cardId: card.id, date: slot.date, start: slot.start.toISOString(), durationMinutes });
  }
  return { planned, scheduled };
}
