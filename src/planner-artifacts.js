import { createCalendarEvent, deleteCalendarEvent } from "./google-calendar.js";
import { assertGoogleTasksAccess, createGoogleTask, deleteGoogleTask, linkGoogleTask } from "./google-tasks.js";
import { config } from "./config.js";
import { trello } from "./trello.js";

const calendarColors = {
  "Work & Business": "1",
  "Build & Tech": "3",
  "Content & Creative": "5",
  // Blue matches the Trello Career & Learning label. Green (10) is reserved
  // for completed planner blocks.
  "Career & Learning": "9",
  "Finance & Admin": "6",
  "People & Relationships": "4",
  // Purple matches the Trello Personal & Lifestyle label. Green is reserved
  // for completed planner blocks.
  "Personal & Lifestyle": "3",
  "Errands & Purchases": "7",
  "Urgent / Time-sensitive": "11"
};

function eventTitle(task, labels) {
  const visible = labels.filter((label) => label !== "Urgent / Time-sensitive");
  const prefix = visible.length ? `[${visible.join(" • ")}] ` : "";
  return `${prefix}${task}`.slice(0, 200);
}

function eventDescription(card) {
  const details = String(card.desc || "").trim();
  return [
    `Planner task linked to Trello card ${card.id}.`,
    details && `Trello details:\n${details}`
  ].filter(Boolean).join("\n\n");
}

export async function createPlannerArtifacts({
  card,
  labels = [],
  scheduleStart,
  durationMinutes = 30,
  client = trello,
  assertTasksAccess = assertGoogleTasksAccess,
  createEvent = createCalendarEvent,
  createTask = createGoogleTask,
  linkTask = linkGoogleTask,
  deleteTask = deleteGoogleTask,
  deleteEvent = deleteCalendarEvent
} = {}) {
  if (!scheduleStart) return { scheduled: false };
  await assertTasksAccess();
  const start = new Date(scheduleStart);
  if (Number.isNaN(start.getTime())) throw new Error("The scheduled time is invalid.");
  const minutes = Math.max(15, Math.min(240, Number(durationMinutes) || 30));
  const end = new Date(start.getTime() + minutes * 60_000);
  const title = eventTitle(card.name, labels);
  let event;
  let googleTask;
  try {
    event = await createEvent({
      summary: title,
      description: eventDescription(card),
      colorId: calendarColors[labels.includes("Urgent / Time-sensitive") ? "Urgent / Time-sensitive" : labels[0]] || "3",
      start: { dateTime: start.toISOString(), timeZone: config.timezone },
      end: { dateTime: end.toISOString(), timeZone: config.timezone },
      extendedProperties: { private: { personalPlannerManaged: "true" } },
      visibility: "private"
    }, { confirm: true });
    googleTask = await createTask({
      title,
      notes: `Linked Trello card: ${card.id}`,
      // Google Tasks tracks the start of the reserved work block. Trello
      // tracks its end, matching the reschedule synchronization convention.
      due: start.toISOString()
    });
    await client.updateCard(card.id, { due: end.toISOString(), dueComplete: false });
    await linkTask({
      trelloCardId: card.id,
      calendarEventId: event.id,
      googleTaskListId: googleTask.tasklist,
      googleTaskId: googleTask.task.id,
      title,
      scheduleStart: start.toISOString(),
      scheduleEnd: end.toISOString()
    });
    return { scheduled: true, eventId: event.id, googleTaskId: googleTask.task.id };
  } catch (error) {
    // Do not leave an orphaned agenda entry or checkbox after a partial write.
    if (googleTask?.task?.id) {
      try { await deleteTask({ tasklist: googleTask.tasklist, taskId: googleTask.task.id }); }
      catch (cleanupError) { console.error(`Google Task cleanup failed: ${cleanupError.message}`); }
    }
    if (event?.id) {
      try { await deleteEvent(event.id, { confirm: true }); }
      catch (cleanupError) { console.error(`Calendar cleanup failed: ${cleanupError.message}`); }
    }
    throw error;
  }
}
