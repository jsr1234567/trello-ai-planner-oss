import { parseTrelloRequest } from "./ai.js";
import { config } from "./config.js";
import { getDailyCards } from "./planner.js";
import { trello } from "./trello.js";
import { createPlannerArtifacts } from "./planner-artifacts.js";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { appendActionAudit } from "./action-audit.js";
import { isActiveTrelloCard, resolveTrelloWorkflow } from "./trello-workflow.js";

const defaultPendingPath = path.resolve(".planner-data/pending-trello-action.json");
const pendingTtlMs = 15 * 60 * 1000;

function normalize(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function findCard(cards, task) {
  const query = normalize(task);
  if (!query) return { error: "I need the task name to update it." };
  const exact = cards.find((card) => normalize(card.name) === query);
  if (exact) return { card: exact };
  const matches = cards.filter((card) => {
    const name = normalize(card.name);
    return name.includes(query) || query.includes(name);
  });
  if (matches.length === 1) return { card: matches[0] };
  if (!matches.length) return { error: `I could not find an open Trello card matching “${task}”.` };
  return { error: `I found several cards matching “${task}”. Please use a more specific name.` };
}

function findList(lists, name) {
  const query = normalize(name);
  const exact = lists.find((list) => normalize(list.name) === query);
  if (exact) return exact;
  const matches = lists.filter((list) => normalize(list.name).includes(query));
  return matches.length === 1 ? matches[0] : null;
}

async function applyLabelsToCard(client, boardId, cardId, labels) {
  if (!cardId || !labels.length) return;
  const boardLabels = await client.labels(boardId);
  const ids = labels.map((name) => boardLabels.find((label) => label.name === name)?.id).filter(Boolean);
  if (ids.length) await client.setCardLabels(cardId, ids);
}

async function createMissingScheduledCard({ intent, board, workflow, client }) {
  const target = workflow.captureList;
  if (!target) return `I could not find a capture list on ${board.name}.`;
  const labels = (intent.labels || []).slice(0, 2);
  const due = intent.due || intent.scheduleStart;
  const created = await client.createCard({
    idList: target.id,
    name: intent.task.slice(0, 500),
    due
  });
  await applyLabelsToCard(client, board.id, created?.id, labels);
  if (client === trello && created?.id && intent.scheduleStart) {
    try {
      await createPlannerArtifacts({ card: created, labels, scheduleStart: intent.scheduleStart, durationMinutes: intent.durationMinutes });
    } catch {
      return `Created ${intent.task} in ${target.name}. Calendar and Google Tasks need authorization before I can time-block it.`;
    }
    return `Created and time-blocked: ${intent.task}`;
  }
  return `Created and scheduled: ${intent.task}`;
}

async function readPending(statePath) {
  try { return JSON.parse(await readFile(statePath, "utf8")); }
  catch { return {}; }
}

async function writePending(statePath, state) {
  await mkdir(path.dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(temporaryPath, statePath);
}

function isConfirmation(text) {
  return /^(yes|no|\/confirm|\/cancel)$/i.test(String(text || "").trim());
}

function hasExpired(pending, now) {
  const created = Date.parse(pending?.createdAt || "");
  return !Number.isFinite(created) || now.getTime() - created > pendingTtlMs;
}

export function describeTrelloIntent(intent) {
  const task = intent.task ? ` “${intent.task.slice(0, 160)}”` : "";
  if (intent.action === "create") return `Create Trello task${task}${intent.list ? ` in ${intent.list}` : ""}.`;
  if (intent.action === "complete") return `Complete Trello task${task}.`;
  if (intent.action === "rename") return `Rename Trello task${task} to “${String(intent.newTitle || "").slice(0, 160)}”.`;
  if (intent.action === "move") return `Move Trello task${task} to ${intent.list || "the requested list"}.`;
  if (intent.action === "schedule") return `Set the Trello deadline for${task} to ${intent.due || intent.scheduleStart || "the requested time"}.`;
  return "Apply this Trello change.";
}

export async function savePendingTrelloAction(chatId, intent, {
  statePath = defaultPendingPath,
  now = new Date()
} = {}) {
  const state = await readPending(statePath);
  state[String(chatId)] = { intent, createdAt: now.toISOString() };
  await writePending(statePath, state);
}

export async function executeTrelloIntent(intent, { board, cards, client = trello, workflowResolver = resolveTrelloWorkflow } = {}) {
  if (!intent?.action || intent.action === "none") return null;
  if (!board || !cards) throw new Error("A Daily Trello board is required.");
  const lists = (await client.lists(board.id)).filter((list) => !list.closed);
  const workflow = await workflowResolver({ board, lists });
  const openCards = cards.filter((card) => isActiveTrelloCard(card, workflow));

  if (intent.action === "create") {
    if (!intent.task) return "I need a task name before I can add it.";
    const genericListNames = new Set(["task", "tasks", "trello", "board", "daily"]);
    const requestedList = genericListNames.has(normalize(intent.list)) ? "" : intent.list;
    const target = findList(lists, requestedList) || (!requestedList ? workflow.captureList : null);
    if (!target) return `I could not find the requested list on ${board.name}.`;
    const labels = (intent.labels || []).slice(0, 2);
    const created = await client.createCard({
      idList: target.id,
      name: intent.task.slice(0, 500),
      due: intent.due || intent.scheduleStart || undefined
    });
    await applyLabelsToCard(client, board.id, created?.id, labels);
    if (client === trello && created?.id && intent.scheduleStart) {
      try {
        await createPlannerArtifacts({ card: created, labels, scheduleStart: intent.scheduleStart, durationMinutes: intent.durationMinutes });
      } catch (error) {
        return `Added to ${target.name}: ${intent.task}. Calendar and Google Tasks need authorization before I can time-block it.`;
      }
      return `Added to ${target.name}, labelled, and time-blocked: ${intent.task}`;
    }
    return `Added to ${target.name}: ${intent.task}`;
  }

  const found = findCard(openCards, intent.task);
  if (found.error) {
    // A natural appointment such as “tomorrow I have dinner with John at
    // 5pm” is new work, not a failed attempt to update a pre-existing card.
    // Capture it as a card, then create the linked time block when available.
    if (intent.action === "schedule" && intent.task && (intent.due || intent.scheduleStart)) {
      return createMissingScheduledCard({ intent, board, workflow, client });
    }
    return found.error;
  }
  if (intent.action === "complete") {
    await client.updateCard(found.card.id, { closed: true, dueComplete: true });
    return `Completed: ${found.card.name}`;
  }
  if (intent.action === "rename") {
    if (!intent.newTitle) return "I need the new task name to rename it.";
    await client.updateCard(found.card.id, { name: intent.newTitle.slice(0, 500) });
    return `Renamed to: ${intent.newTitle}`;
  }
  if (intent.action === "schedule") {
    const due = intent.due || intent.scheduleStart;
    if (!due) return "I need a clear date and time to schedule that task.";
    await client.updateCard(found.card.id, { due });
    if (client === trello && intent.scheduleStart) {
      try {
        await createPlannerArtifacts({
          card: { ...found.card, due },
          labels: intent.labels?.length ? intent.labels : found.card.labels.map((label) => label.name),
          scheduleStart: intent.scheduleStart,
          durationMinutes: intent.durationMinutes
        });
      } catch {
        return `Deadline saved for ${found.card.name}. Calendar and Google Tasks need authorization before I can time-block it.`;
      }
      return `Scheduled and time-blocked: ${found.card.name}`;
    }
    return `Scheduled ${found.card.name}.`;
  }
  if (intent.action === "move") {
    if (!intent.list) return "I need the list name to move that task.";
    const target = findList(lists, intent.list);
    if (!target) return `I could not find a list named “${intent.list}”.`;
    if (target.id === workflow.doneList?.id) {
      await client.updateCard(found.card.id, { closed: true, dueComplete: true });
      return `Completed and archived: ${found.card.name}`;
    }
    await client.updateCard(found.card.id, { idList: target.id });
    return `Moved ${found.card.name} to ${target.name}.`;
  }
  return null;
}

export async function handleTrelloMessage(text, chatId, {
  statePath = defaultPendingPath,
  auditPath,
  now = new Date(),
  parseRequest = parseTrelloRequest,
  loadDailyCards = getDailyCards,
  execute = executeTrelloIntent,
  audit = appendActionAudit
} = {}) {
  if (!chatId || !config.trello.naturalLanguageUpdates) return null;
  const command = String(text || "").trim().toLowerCase();
  if (isConfirmation(command)) {
    const state = await readPending(statePath);
    const pending = state[String(chatId)];
    if (!pending) return null;
    delete state[String(chatId)];
    await writePending(statePath, state);
    if (hasExpired(pending, now)) return "That pending Trello action expired. Please tell me the task change again.";
    if (command === "no" || command === "/cancel") return "Trello action discarded.";

    try {
      const { board, cards } = await loadDailyCards();
      const reply = await execute(pending.intent, { board, cards });
      await audit({ action: pending.intent.action, outcome: "success" }, { auditPath });
      return reply || "Trello action completed.";
    } catch (error) {
      try { await audit({ action: pending.intent.action, outcome: "failure" }, { auditPath }); }
      catch (auditError) { console.error(`Trello audit error: ${auditError.message}`); }
      return `I could not apply that Trello action: ${error.message}`;
    }
  }

  if (String(text).trim().startsWith("/")) return null;
  const intent = await parseRequest(text);
  if (!intent.configured || intent.action === "none") return null;
  // Creation and scheduling are the common capture path and execute from one
  // clear message. Completing, moving, and renaming retain their safety preview.
  if (config.trello.autoApply && ["create", "schedule"].includes(intent.action)) {
    try {
      const { board, cards } = await loadDailyCards();
      const reply = await execute(intent, { board, cards });
      await audit({ action: intent.action, outcome: "success" }, { auditPath });
      return reply || "Trello action completed.";
    } catch (error) {
      try { await audit({ action: intent.action, outcome: "failure" }, { auditPath }); }
      catch (auditError) { console.error(`Trello audit error: ${auditError.message}`); }
      return `I could not apply that Trello action: ${error.message}`;
    }
  }
  await savePendingTrelloAction(chatId, intent, { statePath, now });
  return `Trello preview\n\n${describeTrelloIntent(intent)}\n\nReply yes to apply it or no to discard it.`;
}
