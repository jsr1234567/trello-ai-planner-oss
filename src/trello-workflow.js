import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

const defaultStatePath = path.resolve(".planner-data/trello-workflow.json");

const roleNames = {
  capture: ["inbox", "capture", "todo", "to do", "tasks"],
  month: ["to do this month", "this month", "month"],
  week: ["to do this week", "this week"],
  today: ["today", "now"],
  done: ["done", "complete", "completed", "finished", "archive", "archived"]
};

function normalize(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

async function loadState(statePath) {
  try { return JSON.parse(await readFile(statePath, "utf8")); }
  catch { return { boards: {} }; }
}

async function saveState(state, statePath) {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2));
}

function namedList(lists, names) {
  const normalized = names.map(normalize);
  return lists.find((list) => normalized.includes(normalize(list.name)))
    || lists.find((list) => normalized.some((name) => normalize(list.name).includes(name)));
}

function inferList(role, lists) {
  if (role === "capture") {
    const configured = lists.find((list) => normalize(list.name) === normalize(config.trello.captureListName));
    if (configured) return configured;
  }
  return namedList(lists, roleNames[role]) || (role === "capture" ? lists[0] : null);
}

export async function resolveTrelloWorkflow({ board, lists, statePath = defaultStatePath } = {}) {
  if (!board?.id) throw new Error("A Trello board is required to resolve its workflow.");
  const openLists = (lists || []).filter((list) => !list.closed);
  const state = await loadState(statePath);
  const saved = state.boards?.[board.id] || {};
  const byId = new Map(openLists.map((list) => [list.id, list]));
  const workflow = {
    captureList: byId.get(saved.captureListId) || inferList("capture", openLists),
    monthList: byId.get(saved.monthListId) || inferList("month", openLists),
    weekList: byId.get(saved.weekListId) || inferList("week", openLists),
    todayList: byId.get(saved.todayListId) || inferList("today", openLists),
    doneList: byId.get(saved.doneListId) || inferList("done", openLists)
  };
  const next = {
    captureListId: workflow.captureList?.id || null,
    monthListId: workflow.monthList?.id || null,
    weekListId: workflow.weekList?.id || null,
    todayListId: workflow.todayList?.id || null,
    doneListId: workflow.doneList?.id || null
  };
  if (JSON.stringify(saved) !== JSON.stringify(next)) {
    state.boards = state.boards || {};
    state.boards[board.id] = next;
    await saveState(state, statePath);
  }
  return workflow;
}

export function listIsDone(list, workflow) {
  return Boolean(list && workflow?.doneList && list.id === workflow.doneList.id);
}

export function isActiveTrelloCard(card, workflow) {
  return Boolean(card && !card.closed && (!workflow?.doneList || card.idList !== workflow.doneList.id));
}
