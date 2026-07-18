import { config } from "./config.js";
import { addDaysToDateKey, localDateKey, zonedDateTimeToDate } from "./timezone.js";

export const plannerEventMarker = "Planner task linked to Trello card";

export function isPlannerGeneratedEvent(event) {
  return String(event?.description || "").includes(plannerEventMarker)
    || event?.extendedProperties?.private?.personalPlannerManaged === "true";
}

export function calendarEventInterval(event, timeZone = config.timezone) {
  const startValue = event?.start?.dateTime || event?.start?.date || event?.start;
  const endValue = event?.end?.dateTime || event?.end?.date || event?.end;
  if (!startValue || !endValue) return null;
  try {
    const parse = (value) => {
      if (value instanceof Date) return value;
      if (!String(value).includes("T")) return zonedDateTimeToDate(`${value}T00:00`, timeZone);
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? zonedDateTimeToDate(value, timeZone) : date;
    };
    const start = parse(startValue);
    const end = parse(endValue);
    return end > start ? { start, end } : null;
  } catch {
    return null;
  }
}

function overlaps(first, second) {
  return first.start < second.end && first.end > second.start;
}

function isActive(event) {
  return event?.status !== "cancelled" && event?.transparency !== "transparent";
}

function roundUpToQuarterHour(date) {
  const quarterHour = 15 * 60_000;
  return new Date(Math.ceil(date.getTime() / quarterHour) * quarterHour);
}

function protectedLunchIntervals(firstDate, days, timeZone) {
  const duration = Math.max(15, Number(config.lunchDurationMinutes) || 60) * 60_000;
  return Array.from({ length: days }, (_item, index) => {
    const date = addDaysToDateKey(firstDate, index);
    const start = zonedDateTimeToDate(`${date}T${String(config.lunchStartHour).padStart(2, "0")}:00`, timeZone);
    return { start, end: new Date(start.getTime() + duration) };
  });
}

export function findLaterAvailableSlot({
  occupiedEvents = [],
  notBefore,
  durationMinutes,
  timeZone = config.timezone,
  maxDays = 90
} = {}) {
  const after = new Date(notBefore);
  const duration = Number(durationMinutes) * 60_000;
  if (Number.isNaN(after.getTime()) || !Number.isFinite(duration) || duration <= 0) return null;
  const firstDate = localDateKey(after, timeZone);
  const intervals = [
    ...occupiedEvents.map((event) => calendarEventInterval(event, timeZone)).filter(Boolean),
    ...protectedLunchIntervals(firstDate, maxDays, timeZone)
  ];

  for (let index = 0; index < maxDays; index += 1) {
    const date = addDaysToDateKey(firstDate, index);
    const dayStart = zonedDateTimeToDate(`${date}T${String(config.dayStartHour).padStart(2, "0")}:00`, timeZone);
    const dayEnd = zonedDateTimeToDate(`${date}T${String(config.dayEndHour).padStart(2, "0")}:00`, timeZone);
    let start = new Date(Math.max(dayStart.getTime(), index === 0 ? after.getTime() : dayStart.getTime()));
    start = roundUpToQuarterHour(start);
    while (start.getTime() + duration <= dayEnd.getTime()) {
      const candidate = { start, end: new Date(start.getTime() + duration) };
      if (!intervals.some((interval) => overlaps(candidate, interval))) return candidate;
      start = new Date(start.getTime() + 15 * 60_000);
    }
  }
  return null;
}

// Only planner-owned blocks are movable. A manually created event reserves its
// requested time; affected planner tasks are then placed in the next working
// slot after it, retaining their original duration and avoiding every active
// Calendar event.
export function planPlannerConflictReschedule({ events = [], manualEvent, timeZone = config.timezone, maxDays = 90 } = {}) {
  const manualInterval = calendarEventInterval(manualEvent, timeZone);
  if (!manualInterval) throw new Error("Manual calendar events need a valid start and end time.");

  const conflicts = events
    .filter(isActive)
    .filter(isPlannerGeneratedEvent)
    .map((event) => ({ event, interval: calendarEventInterval(event, timeZone) }))
    .filter(({ interval }) => interval && overlaps(interval, manualInterval))
    .sort((first, second) => first.interval.start - second.interval.start);
  if (!conflicts.length) return [];

  const conflictIds = new Set(conflicts.map(({ event }) => event.id).filter(Boolean));
  const occupiedEvents = events.filter((event) => isActive(event) && !conflictIds.has(event.id));
  if (!occupiedEvents.some((event) => event.id && event.id === manualEvent.id)) occupiedEvents.push(manualEvent);
  const moves = [];

  for (const { event, interval } of conflicts) {
    const durationMinutes = (interval.end.getTime() - interval.start.getTime()) / 60_000;
    const slot = findLaterAvailableSlot({
      occupiedEvents,
      notBefore: manualInterval.end,
      durationMinutes,
      timeZone,
      maxDays
    });
    if (!slot) throw new Error(`Could not find a free planner slot for “${event.summary || "Untitled task"}” in the next ${maxDays} days.`);
    const movedEvent = {
      ...event,
      start: { dateTime: slot.start.toISOString(), timeZone },
      end: { dateTime: slot.end.toISOString(), timeZone }
    };
    occupiedEvents.push(movedEvent);
    moves.push({ event, start: slot.start, end: slot.end });
  }
  return moves;
}
