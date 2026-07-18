import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { google } from "googleapis";
import { config } from "./config.js";
import { getCalendarEvent, googleAuthClient, listCalendarEventsBetween, searchCalendarEvents, updateCalendarEvent } from "./google-calendar.js";
import { trello } from "./trello.js";
import { isActiveTrelloCard, resolveTrelloWorkflow } from "./trello-workflow.js";

const linksPath = path.resolve(".planner-data/google-task-links.json");

const titleStopWords = new Set(["a", "an", "the", "i", "my", "to"]);

function tasksApi() {
  const auth = googleAuthClient();
  if (!auth) throw new Error("Google Calendar and Tasks OAuth is not configured.");
  return google.tasks({ version: "v1", auth });
}

async function loadLinks(statePath = linksPath) {
  try { return JSON.parse(await readFile(statePath, "utf8")); }
  catch { return { links: [] }; }
}

async function saveLinks(state, statePath = linksPath) {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2));
}

export function taskTitleKey(value) {
  return String(value || "")
    .replace(/^\s*✓\s*/, "")
    .replace(/\[[^\]]+\]/g, " ")
    // Treat the common “Open AI” spelling as the product name “OpenAI” so
    // labels/tasks created by different capture paths still link safely.
    .replace(/\bopen\s+ai\b/gi, "openai")
    .toLowerCase()
    .match(/[a-z0-9]+/g)?.map((word) => {
      if (titleStopWords.has(word)) return "";
      if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
      if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
      if (word.length > 4 && word.endsWith("s")) return word.slice(0, -1);
      return word;
    // Capture paths may put the same task words in a different order.  The
    // caller still requires exactly one matching task and card before linking.
    }).filter(Boolean).sort().join(" ") || "";
}

function dateFromTask(task, now) {
  for (const value of [task.due, task.completed, task.updated]) {
    const date = new Date(value || "");
    if (!Number.isNaN(date.getTime())) return date;
  }
  return now;
}

function calendarSearchWindow(task, now) {
  const anchor = dateFromTask(task, now);
  return {
    start: new Date(anchor.getTime() - 45 * 24 * 60 * 60 * 1000),
    end: new Date(anchor.getTime() + 45 * 24 * 60 * 60 * 1000)
  };
}

async function listGoogleTasks(api) {
  const lists = [];
  let pageToken;
  do {
    const response = await api.tasklists.list({ maxResults: 100, pageToken });
    lists.push(...(response.data.items || []));
    pageToken = response.data.nextPageToken;
  } while (pageToken);

  const tasks = [];
  for (const list of lists) {
    if (!list.id) continue;
    let taskPageToken;
    do {
      const response = await api.tasks.list({
        tasklist: list.id,
        maxResults: 100,
        showCompleted: true,
        showHidden: true,
        pageToken: taskPageToken
      });
      for (const task of response.data.items || []) tasks.push({ ...task, tasklistId: list.id });
      taskPageToken = response.data.nextPageToken;
    } while (taskPageToken);
  }
  return tasks;
}

function uniqueMatch(items, predicate) {
  const matches = items.filter(predicate);
  return matches.length === 1 ? matches[0] : null;
}

async function findCalendarEventForTask(task, card, { now = new Date(), searchEvents = searchCalendarEvents } = {}) {
  const { start, end } = calendarSearchWindow(task, now);
  const linkedEvents = await searchEvents(card.id, start, end);
  const byCardId = linkedEvents.filter((event) => String(event.description || "").includes(card.id));
  if (byCardId.length === 1) return { event: byCardId[0] };
  if (byCardId.length > 1) return { ambiguous: true };

  const titleKey = taskTitleKey(task.title);
  if (!titleKey) return {};
  const titleEvents = await searchEvents(task.title, start, end);
  const byTitle = titleEvents.filter((event) => taskTitleKey(event.summary) === titleKey);
  if (byTitle.length === 1) return { event: byTitle[0] };
  if (byTitle.length > 1) return { ambiguous: true };
  return {};
}

async function plannerTaskList(api = tasksApi()) {
  const existing = await api.tasklists.list({ maxResults: 100 });
  const found = (existing.data.items || []).find((list) => list.title === config.googleTasks.listName);
  if (found?.id) return found.id;
  const created = await api.tasklists.insert({ requestBody: { title: config.googleTasks.listName } });
  return created.data.id;
}

export async function assertGoogleTasksAccess() {
  await tasksApi().tasklists.list({ maxResults: 1 });
}

export async function createGoogleTask({ title, notes, due }) {
  const api = tasksApi();
  const tasklist = await plannerTaskList(api);
  const created = await api.tasks.insert({
    tasklist,
    requestBody: {
      title: title.slice(0, 1024),
      notes: String(notes || "").slice(0, 8192),
      due: due ? new Date(due).toISOString() : undefined,
      status: "needsAction"
    }
  });
  return { tasklist, task: created.data };
}

export async function deleteGoogleTask({ tasklist, taskId }) {
  if (!tasklist || !taskId) return;
  await tasksApi().tasks.delete({ tasklist, task: taskId });
}

export async function linkGoogleTask(link) {
  const state = await loadLinks();
  state.links = state.links.filter((item) => item.trelloCardId !== link.trelloCardId);
  state.links.push({ ...link, status: "open", createdAt: new Date().toISOString() });
  await saveLinks(state);
}

export async function updatePlannerEventSchedule(calendarEventId, start, end, {
  statePath = linksPath,
  client = trello,
  api
} = {}) {
  const state = await loadLinks(statePath);
  const link = (state.links || []).find((item) => item.calendarEventId === calendarEventId);
  if (!link) return false;
  const scheduleStart = new Date(start).toISOString();
  const scheduleEnd = new Date(end).toISOString();

  // Calendar owns the time reservation. Mirror it to the two task systems
  // before recording the local link, so a successful reschedule is coherent
  // across Calendar, Google Tasks, and Trello.
  if (link.googleTaskListId && link.googleTaskId) {
    await (api || tasksApi()).tasks.patch({
      tasklist: link.googleTaskListId,
      task: link.googleTaskId,
      requestBody: { due: scheduleStart, status: "needsAction" }
    });
  }
  if (link.trelloCardId) {
    await client.updateCard(link.trelloCardId, { due: scheduleEnd, dueComplete: false });
  }
  link.scheduleStart = scheduleStart;
  link.scheduleEnd = scheduleEnd;
  link.rescheduledAt = new Date().toISOString();
  await saveLinks(state, statePath);
  return true;
}

export async function backfillGoogleTaskLinks({
  client = trello,
  api = tasksApi(),
  now = new Date(),
  searchEvents = searchCalendarEvents,
  statePath = linksPath
} = {}) {
  const state = await loadLinks(statePath);
  const existingLinks = Array.isArray(state.links) ? state.links : [];
  const [tasks, boards] = await Promise.all([listGoogleTasks(api), client.boards()]);
  const board = boards.find((item) => !item.closed && item.name.toLowerCase() === config.trello.boardName.toLowerCase());
  if (!board) throw new Error(`Active Trello board not found: ${config.trello.boardName}`);
  const cards = await (client.allBoardCards ? client.allBoardCards(board.id) : client.boardCards(board.id));
  const linkedTaskIds = new Set(existingLinks.map((link) => `${link.googleTaskListId}:${link.googleTaskId}`));
  const linkedCardIds = new Set(existingLinks.map((link) => link.trelloCardId));
  const candidates = tasks.filter((task) => task.id && task.tasklistId && task.title && !linkedTaskIds.has(`${task.tasklistId}:${task.id}`));
  const taskTitleCounts = new Map();
  for (const task of candidates) {
    const key = taskTitleKey(task.title);
    if (key) taskTitleCounts.set(key, (taskTitleCounts.get(key) || 0) + 1);
  }
  const result = { scanned: tasks.length, linked: 0, calendarLinked: 0, ambiguousTasks: 0, ambiguousCards: 0, ambiguousCalendar: 0, unmatched: 0 };

  for (const task of candidates) {
    const key = taskTitleKey(task.title);
    if (!key) continue;
    if (taskTitleCounts.get(key) > 1) {
      result.ambiguousTasks += 1;
      continue;
    }
    const card = uniqueMatch(cards, (item) => !linkedCardIds.has(item.id) && taskTitleKey(item.name) === key);
    if (!card) {
      const count = cards.filter((item) => !linkedCardIds.has(item.id) && taskTitleKey(item.name) === key).length;
      if (count > 1) result.ambiguousCards += 1;
      else result.unmatched += 1;
      continue;
    }

    let calendarMatch = {};
    try {
      calendarMatch = await findCalendarEventForTask(task, card, { now, searchEvents });
    } catch (error) {
      console.warn(`Calendar discovery failed for a Google Task: ${error.message}`);
    }
    if (calendarMatch.ambiguous) result.ambiguousCalendar += 1;
    if (calendarMatch.event?.id) result.calendarLinked += 1;
    existingLinks.push({
      trelloCardId: card.id,
      calendarEventId: calendarMatch.event?.id,
      googleTaskListId: task.tasklistId,
      googleTaskId: task.id,
      title: task.title,
      status: "open",
      source: "backfill",
      createdAt: now.toISOString()
    });
    linkedTaskIds.add(`${task.tasklistId}:${task.id}`);
    linkedCardIds.add(card.id);
    result.linked += 1;
  }
  if (result.linked) {
    state.links = existingLinks;
    await saveLinks(state, statePath);
  }
  return result;
}

function localDate(value) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(value));
}

function normalizeListName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function weeklyList(lists) {
  return lists.find((list) => normalizeListName(list.name) === "to do this week")
    || lists.find((list) => normalizeListName(list.name) === "this week")
    || null;
}

function cardIsDone(card, doneList) {
  return Boolean(card && (card.closed || card.dueComplete || (doneList && card.idList === doneList.id)));
}

async function visuallyCompleteCalendar(link, { updateEvent = updateCalendarEvent } = {}) {
  if (!link.calendarEventId) return;
  try {
    await updateEvent(link.calendarEventId, {
      summary: `✓ ${link.title}`.slice(0, 200),
      colorId: "10",
      transparency: "transparent"
    }, { confirm: true });
  } catch (error) {
    console.warn(`Calendar completion update failed: ${error.message}`);
  }
}

function calendarColorForTitle(title) {
  if (title.includes("Urgent")) return "11";
  if (title.includes("Build & Tech")) return "3";
  if (title.includes("Content & Creative")) return "5";
  if (title.includes("Career & Learning")) return "9";
  if (title.includes("Finance & Admin")) return "6";
  if (title.includes("People & Relationships")) return "4";
  if (title.includes("Personal & Lifestyle")) return "3";
  if (title.includes("Errands & Purchases")) return "7";
  return "1";
}

async function visuallyReopenCalendar(link, { getEvent = getCalendarEvent, updateEvent = updateCalendarEvent } = {}) {
  if (!link.calendarEventId) return null;
  try {
    const event = await getEvent(link.calendarEventId);
    await updateEvent(link.calendarEventId, {
      summary: link.title,
      colorId: calendarColorForTitle(link.title),
      transparency: "opaque"
    }, { confirm: true });
    return event;
  } catch (error) {
    console.warn(`Calendar reopen update failed: ${error.message}`);
    return null;
  }
}

export async function reopenPlannerTask(trelloCardId, { client = trello } = {}) {
  const state = await loadLinks();
  const link = state.links.find((item) => item.trelloCardId === trelloCardId);
  if (!link) throw new Error("No linked Google Task was found for this Trello card.");
  const api = tasksApi();
  await api.tasks.patch({
    tasklist: link.googleTaskListId,
    task: link.googleTaskId,
    requestBody: { status: "needsAction" }
  });
  const boards = await client.boards();
  const board = boards.find((item) => !item.closed && item.name.toLowerCase() === config.trello.boardName.toLowerCase());
  const lists = board ? await client.lists(board.id) : [];
  const workflow = board ? await resolveTrelloWorkflow({ board, lists }) : {};
  let due = link.scheduleEnd || null;
  if (link.calendarEventId) {
    const event = await getCalendarEvent(link.calendarEventId);
    due = event.end?.dateTime || due;
    await updateCalendarEvent(link.calendarEventId, {
      summary: link.title,
      colorId: calendarColorForTitle(link.title),
      transparency: "opaque"
    }, { confirm: true });
  }
  await client.updateCard(trelloCardId, {
    ...(workflow.captureList ? { idList: workflow.captureList.id } : {}),
    closed: false,
    dueComplete: false,
    ...(due ? { due } : {})
  });
  link.status = "open";
  delete link.completedAt;
  await saveLinks(state);
  return { reopened: true, title: link.title };
}

async function nextFreeSlot(event, { listEvents = listCalendarEventsBetween } = {}) {
  const startValue = event.start?.dateTime;
  const endValue = event.end?.dateTime;
  if (!startValue || !endValue) return null;
  const originalStart = new Date(startValue);
  const duration = new Date(endValue).getTime() - originalStart.getTime();
  if (!Number.isFinite(duration) || duration <= 0) return null;

  const today = localDate(new Date());
  const candidate = new Date(originalStart);
  while (localDate(candidate) <= today) candidate.setDate(candidate.getDate() + 1);

  for (let day = 0; day < 14; day += 1) {
    const end = new Date(candidate.getTime() + duration);
    const events = await listEvents(candidate, end);
    const busy = events.some((item) => item.id !== event.id && item.transparency !== "transparent");
    if (!busy) return { start: new Date(candidate), end };
    candidate.setDate(candidate.getDate() + 1);
  }
  return null;
}

export async function syncCompletedGoogleTasks({
  client = trello,
  api = tasksApi(),
  updateEvent = updateCalendarEvent,
  getEvent = getCalendarEvent,
  listEvents = listCalendarEventsBetween,
  workflowResolver = resolveTrelloWorkflow,
  now = new Date(),
  statePath = linksPath
} = {}) {
  const state = await loadLinks(statePath);
  const links = state.links || [];
  if (!links.length) return { checked: 0, completed: 0, reopened: 0, rescheduled: 0 };

  let completed = 0;
  let reopened = 0;
  let rescheduled = 0;
  const boards = await client.boards();
  const board = boards.find((item) => !item.closed && item.name.toLowerCase() === config.trello.boardName.toLowerCase());
  const lists = board ? await client.lists(board.id) : [];
  const workflow = board ? await workflowResolver({ board, lists }) : {};
  const cards = board ? await (client.allBoardCards ? client.allBoardCards(board.id) : client.boardCards(board.id)) : [];
  const cardById = new Map(cards.map((card) => [card.id, card]));
  for (const link of links) {
    const result = await api.tasks.get({ tasklist: link.googleTaskListId, task: link.googleTaskId });
    const card = cardById.get(link.trelloCardId);
    const taskComplete = result.data.status === "completed";
    const activeOutsideDone = card && !card.closed && card.idList !== workflow.doneList?.id;

    if (link.status === "completed" && (!taskComplete || activeOutsideDone)) {
      if (taskComplete) {
        await api.tasks.patch({
          tasklist: link.googleTaskListId,
          task: link.googleTaskId,
          requestBody: { status: "needsAction" }
        });
      }
      const event = await visuallyReopenCalendar(link, { getEvent, updateEvent });
      if (card) {
        await client.updateCard(link.trelloCardId, {
          ...(card.idList === workflow.doneList?.id && workflow.captureList ? { idList: workflow.captureList.id } : {}),
          closed: false,
          dueComplete: false,
          ...(event?.end?.dateTime ? { due: event.end.dateTime } : {})
        });
      }
      link.status = "open";
      delete link.completedAt;
      reopened += 1;
      continue;
    }

    if (taskComplete) {
      if (!cardIsDone(card, workflow.doneList)) await client.updateCard(link.trelloCardId, { closed: true, dueComplete: true });
      await visuallyCompleteCalendar(link, { updateEvent });
      link.status = "completed";
      link.completedAt = now.toISOString();
      completed += 1;
      continue;
    }

    if (!card) continue;
    if (cardIsDone(card, workflow.doneList)) {
      await api.tasks.patch({
        tasklist: link.googleTaskListId,
        task: link.googleTaskId,
        requestBody: { status: "completed" }
      });
      if (card && !card.closed) await client.updateCard(link.trelloCardId, { closed: true, dueComplete: true });
      await visuallyCompleteCalendar(link, { updateEvent });
      link.status = "completed";
      link.completedAt = now.toISOString();
      completed += 1;
      continue;
    }

    if (!link.calendarEventId) continue;
    const event = await getEvent(link.calendarEventId).catch((error) => {
      console.warn(`Calendar read failed: ${error.message}`);
      return null;
    });
    if (!event?.end?.dateTime || localDate(event.end.dateTime) >= localDate(now)) continue;
    const slot = await nextFreeSlot(event, { listEvents });
    if (!slot) continue;
    await updateEvent(link.calendarEventId, {
      start: { dateTime: slot.start.toISOString(), timeZone: config.timezone },
      end: { dateTime: slot.end.toISOString(), timeZone: config.timezone },
      transparency: "opaque"
    }, { confirm: true });
    await api.tasks.patch({
      tasklist: link.googleTaskListId,
      task: link.googleTaskId,
      requestBody: { due: slot.start.toISOString() }
    });
    await client.updateCard(link.trelloCardId, { due: slot.end.toISOString(), dueComplete: false });
    link.scheduleStart = slot.start.toISOString();
    link.scheduleEnd = slot.end.toISOString();
    link.rescheduledAt = new Date().toISOString();
    rescheduled += 1;
  }
  await saveLinks(state, statePath);
  return { checked: links.length, completed, reopened, rescheduled };
}

// Trello expresses the current workflow state; Calendar expresses when work
// happens. Reconcile them after planning so Today contains only cards with a
// linked block on today's local date.
export async function reconcileDailyTrelloWorkflow({
  client = trello,
  workflowResolver = resolveTrelloWorkflow,
  now = new Date(),
  statePath = linksPath
} = {}) {
  const state = await loadLinks(statePath);
  const linksByCardId = new Map((state.links || []).filter((link) => link.status !== "completed").map((link) => [link.trelloCardId, link]));
  const boards = await client.boards();
  const board = boards.find((item) => !item.closed && item.name.toLowerCase() === config.trello.boardName.toLowerCase());
  if (!board) return { promoted: 0, returnedToWeek: 0, skipped: "board-not-found" };
  const lists = await client.lists(board.id);
  const workflow = await workflowResolver({ board, lists });
  const thisWeek = workflow.weekList || weeklyList(lists);
  if (!workflow.todayList || !thisWeek) return { promoted: 0, returnedToWeek: 0, skipped: "lists-not-found" };
  const cards = await (client.allBoardCards ? client.allBoardCards(board.id) : client.boardCards(board.id));
  const today = localDate(now);
  let promoted = 0;
  let returnedToWeek = 0;

  for (const card of cards.filter((item) => isActiveTrelloCard(item, workflow))) {
    const scheduledDate = linksByCardId.get(card.id)?.scheduleStart ? localDate(linksByCardId.get(card.id).scheduleStart) : null;
    if (card.idList === thisWeek.id && scheduledDate === today) {
      await client.updateCard(card.id, { idList: workflow.todayList.id });
      promoted += 1;
    } else if (card.idList === workflow.todayList.id && scheduledDate !== today) {
      // Includes unfinished yesterday cards and Today cards that could not fit
      // inside today's focus-time capacity.
      await client.updateCard(card.id, { idList: thisWeek.id });
      returnedToWeek += 1;
    }
  }
  return { promoted, returnedToWeek };
}

export async function synchronizeGoogleTasks(options = {}) {
  const backfill = await backfillGoogleTaskLinks(options);
  const sync = await syncCompletedGoogleTasks(options);
  const calendarConflicts = await import("./google-calendar.js")
    .then(({ reconcileManualCalendarConflicts }) => reconcileManualCalendarConflicts())
    .catch((error) => {
      console.error(`Manual calendar conflict reconciliation error: ${error.message}`);
      return { checked: 0, manualEvents: 0, rescheduled: 0, error: error.message };
    });
  const workflow = await reconcileDailyTrelloWorkflow(options).catch((error) => {
    console.error(`Daily Trello workflow reconciliation error: ${error.message}`);
    return { promoted: 0, returnedToWeek: 0, error: error.message };
  });
  return { ...sync, backfill, calendarConflicts, workflow };
}

export function startGoogleTasksSync() {
  if (!config.googleTasks.syncEnabled) return;
  const interval = Math.max(1, config.googleTasks.syncPollMinutes) * 60_000;
  const run = () => synchronizeGoogleTasks().catch((error) => {
    if (!String(error.message).includes("OAuth is not configured")) console.error(`Google Tasks sync error: ${error.message}`);
  });
  run();
  setInterval(run, interval);
  console.log(`Google Tasks completion and reschedule sync enabled; polling every ${interval / 60_000} minutes`);
}
