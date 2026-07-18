import { google } from "googleapis";
import { config } from "./config.js";
import { addDaysToDateKey, localDateKey, zonedDateTimeToDate } from "./timezone.js";
import { isPlannerGeneratedEvent, planPlannerConflictReschedule } from "./planner-rescheduler.js";

export function googleAuthClient() {
  if (!config.calendar.clientId || !config.calendar.clientSecret || !config.calendar.refreshToken) return null;
  const client = new google.auth.OAuth2(config.calendar.clientId, config.calendar.clientSecret, config.calendar.redirectUri);
  client.setCredentials({ refresh_token: config.calendar.refreshToken });
  return client;
}

function calendarApi() {
  const auth = googleAuthClient();
  if (!auth) throw new Error("Google Calendar OAuth is not configured.");
  return google.calendar({ version: "v3", auth });
}

export function isActiveCalendarEvent(event) {
  return event?.status !== "cancelled" && event?.transparency !== "transparent";
}

function dayBounds() {
  const date = localDateKey(new Date(), config.timezone);
  const startDate = zonedDateTimeToDate(`${date}T00:00`, config.timezone);
  const endDate = zonedDateTimeToDate(`${addDaysToDateKey(date, 1)}T00:00`, config.timezone);
  return { start: startDate.toISOString(), end: endDate.toISOString() };
}

export async function listCalendars() {
  const response = await calendarApi().calendarList.list({ maxResults: 100, showDeleted: false });
  return response.data.items || [];
}

export function normalizeDefaultReminders(reminders) {
  if (!Array.isArray(reminders) || !reminders.length) throw new Error("At least one calendar reminder is required.");
  const unique = new Map();
  for (const reminder of reminders) {
    const method = reminder?.method;
    const minutes = Number(reminder?.minutes);
    if (!['popup', 'email'].includes(method) || !Number.isInteger(minutes) || minutes < 0 || minutes > 40320) {
      throw new Error("Calendar reminders must use popup or email with 0–40320 whole minutes.");
    }
    unique.set(`${method}:${minutes}`, { method, minutes });
  }
  return [...unique.values()].sort((a, b) => b.minutes - a.minutes || a.method.localeCompare(b.method));
}

export async function getPlannerCalendarSettings() {
  const response = await calendarApi().calendarList.get({ calendarId: config.calendar.calendarId });
  return {
    id: response.data.id,
    summary: response.data.summary,
    primary: Boolean(response.data.primary),
    defaultReminders: response.data.defaultReminders || []
  };
}

export async function updatePlannerCalendarDefaultReminders(reminders, { confirm = false } = {}) {
  if (!confirm) throw new Error("Calendar default reminder updates require confirm=true.");
  const defaultReminders = normalizeDefaultReminders(reminders);
  const response = await calendarApi().calendarList.update({
    calendarId: config.calendar.calendarId,
    requestBody: { defaultReminders }
  });
  return {
    id: response.data.id,
    summary: response.data.summary,
    primary: Boolean(response.data.primary),
    defaultReminders: response.data.defaultReminders || []
  };
}

export async function listTodayEvents() {
  const { start, end } = dayBounds();
  const response = await calendarApi().events.list({
    calendarId: config.calendar.calendarId,
    timeMin: start,
    timeMax: end,
    singleEvents: true,
    orderBy: "startTime",
    showDeleted: false,
    maxResults: 100
  });
  return (response.data.items || []).filter(isActiveCalendarEvent).map((event) => ({
    id: event.id,
    summary: event.summary || "Untitled event",
    description: event.description || "",
    location: event.location || "",
    start: event.start?.dateTime || event.start?.date,
    end: event.end?.dateTime || event.end?.date,
    htmlLink: event.htmlLink
  }));
}

export async function getCalendarEvent(eventId) {
  const response = await calendarApi().events.get({ calendarId: config.calendar.calendarId, eventId });
  return response.data;
}

export async function listCalendarEventsBetween(start, end) {
  const response = await calendarApi().events.list({
    calendarId: config.calendar.calendarId,
    timeMin: new Date(start).toISOString(),
    timeMax: new Date(end).toISOString(),
    singleEvents: true,
    showDeleted: false,
    // A conflict move must see all blocks in the look-ahead window; Calendar
    // supports up to 2,500 results in one request.
    maxResults: 2500
  });
  return (response.data.items || []).filter((event) => event.status !== "cancelled");
}

export async function searchCalendarEvents(query, start, end) {
  const response = await calendarApi().events.list({
    calendarId: config.calendar.calendarId,
    q: query,
    timeMin: new Date(start).toISOString(),
    timeMax: new Date(end).toISOString(),
    singleEvents: true,
    showDeleted: false,
    maxResults: 100
  });
  return (response.data.items || []).filter((event) => event.status !== "cancelled");
}

export async function createCalendarEvent(event, { confirm = false } = {}) {
  if (!confirm) throw new Error("Calendar writes require confirm=true.");
  const response = await calendarApi().events.insert({ calendarId: config.calendar.calendarId, requestBody: event, sendUpdates: "none" });
  const created = response.data;
  if (!created.id || created.status === "cancelled") {
    throw new Error("Google Calendar did not confirm creation of the event.");
  }
  return created;
}

export async function createManualCalendarEvent(event, { confirm = false, reschedulePlannerConflicts = true } = {}) {
  const created = await createCalendarEvent(event, { confirm });
  if (!reschedulePlannerConflicts) return { ...created, rescheduledPlannerEvents: [] };

  try {
    const manualStart = created.start?.dateTime || created.start?.date;
    const manualEnd = created.end?.dateTime || created.end?.date;
    const rangeEnd = new Date(new Date(manualEnd).getTime() + 90 * 24 * 60 * 60_000);
    const events = await listCalendarEventsBetween(manualStart, rangeEnd);
    const moves = planPlannerConflictReschedule({ events, manualEvent: created });
    const { updatePlannerEventSchedule } = await import("./google-tasks.js");
    const result = await applyPlannerConflictMoves({
      moves,
      manualEvent: created,
      updateEvent: updateCalendarEvent,
      syncSchedule: updatePlannerEventSchedule
    });
    return {
      ...created,
      // Preserve the existing create-event response shape; `displacedBy` is
      // useful for the background reconciler, but self-evident here.
      rescheduledPlannerEvents: result.rescheduled.map(({ displacedBy, ...move }) => move),
      rescheduleWarnings: result.warnings
    };
  } catch (error) {
    // The manual reservation has already been made. Do not silently delete it
    // if conflict discovery or planning fails; return an actionable error instead.
    throw new Error(`Calendar event ${created.id} was created, but planner conflict resolution failed: ${error.message}`);
  }
}

function plannerMoveSummary(move, manualEvent) {
  return {
    id: move.event.id,
    summary: move.event.summary || "Untitled task",
    start: move.start.toISOString(),
    end: move.end.toISOString(),
    ...(manualEvent ? { displacedBy: manualEvent.id || manualEvent.summary || "manual-calendar-event" } : {})
  };
}

// Calendar is the source of truth for a reservation. Once a planner event has
// been moved there, a problem updating a linked Trello or Google Task must not
// stop the remaining calendar conflicts from being cleared.
async function applyPlannerConflictMoves({ moves, manualEvent, updateEvent, syncSchedule }) {
  const rescheduled = [];
  const warnings = [];

  for (const move of moves) {
    const summary = plannerMoveSummary(move, manualEvent);
    try {
      await updateEvent(move.event.id, {
        start: { dateTime: move.start.toISOString(), timeZone: config.timezone },
        end: { dateTime: move.end.toISOString(), timeZone: config.timezone }
      }, { confirm: true });
    } catch (error) {
      warnings.push({ ...summary, stage: "calendar", error: error.message });
      continue;
    }

    // Keep the in-memory view current. A task displaced by one manual event
    // must not be considered at its old time while later reservations in the
    // same polling pass are evaluated.
    Object.assign(move.event, {
      start: { dateTime: move.start.toISOString(), timeZone: config.timezone },
      end: { dateTime: move.end.toISOString(), timeZone: config.timezone }
    });
    rescheduled.push(summary);

    try {
      await syncSchedule(move.event.id, move.start, move.end);
    } catch (error) {
      warnings.push({ ...summary, stage: "linked-schedule", error: error.message });
    }
  }
  return { rescheduled, warnings };
}

// Calendar is also a first-class input surface: a reservation entered in the
// Google Calendar UI must displace Planner-owned work in exactly the same way
// as one created through Telegram or the HTTP API. This is intentionally
// limited to Planner-managed events, so personal and shared Calendar entries
// are never changed by the service.
export async function reconcileManualCalendarConflicts({
  now = new Date(),
  lookAheadDays = 90,
  listEvents = listCalendarEventsBetween,
  updateEvent = updateCalendarEvent,
  syncSchedule
} = {}) {
  const start = new Date(now);
  const end = new Date(start.getTime() + Math.max(1, lookAheadDays) * 24 * 60 * 60_000);
  const events = await listEvents(start, end);
  const manualEvents = events
    .filter(isActiveCalendarEvent)
    .filter((event) => !isPlannerGeneratedEvent(event))
    .sort((first, second) => new Date(first.start?.dateTime || first.start?.date || 0) - new Date(second.start?.dateTime || second.start?.date || 0));
  const updateLinkedSchedule = syncSchedule || (async (calendarEventId, moveStart, moveEnd) => {
    const { updatePlannerEventSchedule } = await import("./google-tasks.js");
    return updatePlannerEventSchedule(calendarEventId, moveStart, moveEnd);
  });
  const moves = [];
  const warnings = [];

  for (const manualEvent of manualEvents) {
    const reschedules = planPlannerConflictReschedule({ events, manualEvent });
    const result = await applyPlannerConflictMoves({
      moves: reschedules,
      manualEvent,
      updateEvent,
      syncSchedule: updateLinkedSchedule
    });
    moves.push(...result.rescheduled);
    warnings.push(...result.warnings);
  }
  return { checked: events.length, manualEvents: manualEvents.length, rescheduled: moves.length, moves, warnings };
}

export async function updateCalendarEvent(eventId, event, { confirm = false } = {}) {
  if (!confirm) throw new Error("Calendar writes require confirm=true.");
  const response = await calendarApi().events.patch({ calendarId: config.calendar.calendarId, eventId, requestBody: event, sendUpdates: "none" });
  return response.data;
}

export async function deleteCalendarEvent(eventId, { confirm = false } = {}) {
  if (!confirm) throw new Error("Calendar deletions require confirm=true.");
  await calendarApi().events.delete({ calendarId: config.calendar.calendarId, eventId, sendUpdates: "none" });
  return { deleted: true, id: eventId };
}
