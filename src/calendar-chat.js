import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { parseCalendarRequest } from "./ai.js";
import { createManualCalendarEvent } from "./google-calendar.js";
import { zonedDateTimeToDate } from "./timezone.js";

const pendingPath = path.resolve(".planner-data/pending-calendar-event.json");

async function readPending() {
  try { return JSON.parse(await readFile(pendingPath, "utf8")); }
  catch { return {}; }
}

async function writePending(data) {
  await mkdir(path.dirname(pendingPath), { recursive: true });
  const temporaryPath = `${pendingPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(data, null, 2));
  await rename(temporaryPath, pendingPath);
}

function preview(event) {
  const start = zonedDateTimeToDate(event.start.dateTime, event.start.timeZone || config.timezone);
  const end = zonedDateTimeToDate(event.end.dateTime, event.end.timeZone || config.timezone);
  const format = new Intl.DateTimeFormat("en-GB", { timeZone: config.timezone, dateStyle: "medium", timeStyle: "short" });
  return `Calendar preview\n\n${event.summary}\n${format.format(start)}–${format.format(end)}\n\nReply /confirm to create it or /cancel to discard it.`;
}

export function explicitCalendarDateError(text, start) {
  const statedDays = [...String(text || "").matchAll(/\b(?:the\s+)?([1-9]|[12]\d|3[01])(?:st|nd|rd|th)\b/gi)]
    .map((match) => Number(match[1]));
  if (!statedDays.length) return null;
  const parsed = /^(\d{4})-(\d{2})-(\d{2})T/.exec(String(start || ""));
  if (!parsed) return "I could not validate the date. Please include a clear date and time.";
  const parsedDay = Number(parsed[3]);
  if (statedDays.includes(parsedDay)) return null;
  return "I could not match the date in your message. Please resend it with the full date (for example, July 22 at 8 p.m.).";
}

export function looksLikeCalendarRequest(text) {
  const input = String(text || "").trim();
  const isCommand = /^\/(calendar|add|schedule)\b/i.test(input);
  const startsLikeEvent = /^(add|create|block|put)\b/i.test(input);
  // Natural meeting language should not be mistaken for an update to an
  // existing Trello task. Require a time/date cue so ordinary chat is safe.
  const eventWord = /\b(meeting|appointment|calendar event|call with|catch[- ]?up)\b/i.test(input);
  const timeCue = /\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|at\s+\d|\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i.test(input);
  const scheduledMeeting = /^schedule\b/i.test(input) && (eventWord || /\bwith\b/i.test(input)) && timeCue;
  return isCommand || startsLikeEvent || scheduledMeeting || (eventWord && timeCue);
}

export async function handleCalendarMessage(text, chatId) {
  const pending = await readPending();
  const current = pending[String(chatId)];
  const command = text.trim().toLowerCase();

  if ((command === "/confirm" || command === "yes") && current) {
    const created = await createManualCalendarEvent(current.event, { confirm: true });
    delete pending[String(chatId)];
    await writePending(pending);
    const moved = created.rescheduledPlannerEvents?.length || 0;
    return `Calendar event created and confirmed by Google: ${created.summary || current.event.summary}${moved ? `. Rescheduled ${moved} planner task${moved === 1 ? "" : "s"}.` : ""}`;
  }
  if ((command === "/cancel" || command === "no") && current) {
    delete pending[String(chatId)];
    await writePending(pending);
    return "Calendar event discarded.";
  }

  const request = text.replace(/^\/calendar\s*/i, "").replace(/^\/(add|schedule)\s*/i, "").trim();
  const looksLikeEvent = looksLikeCalendarRequest(text);
  if (!looksLikeEvent || !request) return null;

  const parsed = await parseCalendarRequest(request);
  if (parsed.error || !parsed.event) return parsed.error || parsed.message || "I need more details for that event.";
  const dateError = explicitCalendarDateError(request, parsed.event.start);
  if (dateError) return dateError;
  const event = {
    summary: String(parsed.event.summary).slice(0, 200),
    description: String(parsed.event.description || "Created by Personal Planner").slice(0, 2000),
    start: { dateTime: `${parsed.event.start}:00`, timeZone: config.timezone },
    end: { dateTime: `${parsed.event.end}:00`, timeZone: config.timezone }
  };
  try {
    const start = zonedDateTimeToDate(event.start.dateTime, event.start.timeZone);
    const end = zonedDateTimeToDate(event.end.dateTime, event.end.timeZone);
    if (end <= start) throw new Error("end before start");
  } catch {
    return "I could not validate the date and time. Please include a clear date and time.";
  }
  pending[String(chatId)] = { event, createdAt: new Date().toISOString() };
  if (config.calendar.autoSchedule) {
    const created = await createManualCalendarEvent(event, { confirm: true });
    delete pending[String(chatId)];
    await writePending(pending);
    const moved = created.rescheduledPlannerEvents?.length || 0;
    return `Calendar event created and confirmed by Google: ${created.summary || event.summary}${moved ? `. Rescheduled ${moved} planner task${moved === 1 ? "" : "s"}.` : ""}`;
  }
  await writePending(pending);
  return preview(event);
}
