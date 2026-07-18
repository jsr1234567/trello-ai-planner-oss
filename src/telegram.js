import { config } from "./config.js";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildPlannerFollowUp, buildTodayBriefing, getDailyCards } from "./planner.js";
import { buildTaskReview } from "./task-agent.js";
import { handleCalendarMessage, looksLikeCalendarRequest } from "./calendar-chat.js";
import OpenAI from "openai";
import { answerPlannerChat } from "./ai.js";
import { handleKnowledgeMessage, listActiveReminders } from "./life-knowledge.js";
import { handleTrelloMessage } from "./trello-chat.js";
import { listTodayEvents } from "./google-calendar.js";
import { fetchWithRetry } from "./http.js";
import { recordTranscriptionUsage } from "./costs.js";
import { isActiveTrelloCard } from "./trello-workflow.js";

const chatStatePath = path.resolve(".planner-data/telegram-chat.json");
const pollingStatePath = path.resolve(".planner-data/telegram-polling.json");
const conversationStatePath = path.resolve(".planner-data/telegram-conversations.json");
const conversationTurns = 8;
const telegramLongPollSeconds = 25;

// Telegram holds getUpdates requests open for the requested long-poll period.
// Keep the client-side deadline beyond it, otherwise every empty poll aborts
// locally before Telegram can return its normal response.
export function telegramPollRequestTimeoutMs(pollSeconds = telegramLongPollSeconds) {
  const seconds = Number(pollSeconds);
  return Math.max(12_000, (Number.isFinite(seconds) ? seconds : telegramLongPollSeconds) * 1_000 + 5_000);
}

async function loadChatId() {
  if (config.telegram.chatId) return;
  try {
    const state = JSON.parse(await readFile(chatStatePath, "utf8"));
    if (state.chatId) config.telegram.chatId = String(state.chatId);
  } catch {
    // No local chat state yet; /start will establish it.
  }
}

async function readJson(filePath, fallback) {
  try { return JSON.parse(await readFile(filePath, "utf8")); }
  catch { return fallback; }
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(value, null, 2));
  await rename(temporaryPath, filePath);
}

async function loadPollingOffset() {
  const state = await readJson(pollingStatePath, {});
  return Number.isSafeInteger(state.nextOffset) && state.nextOffset >= 0 ? state.nextOffset : 0;
}

async function savePollingOffset(nextOffset) {
  await writeJson(pollingStatePath, { nextOffset, updatedAt: new Date().toISOString() });
}

export function isOwnerMessage(message) {
  return Boolean(config.telegram.chatId)
    && message.chat?.type === "private"
    && String(message.chat.id) === String(config.telegram.chatId);
}

export function detectPlannerShortcut(text) {
  const input = String(text || "").trim().toLowerCase();
  if (!input || input.startsWith("/")) return null;
  if (/^(today|my day|my plan|my agenda)$/.test(input)
    || /\b(what(?:'s| is) (?:my )?(?:plan|agenda|schedule)(?: for)? today|what should i (?:do|work on|focus on)|what(?:'s| is) next|help me focus)\b/.test(input)) {
    return "today";
  }
  if (/\b(review|prioriti[sz]e|triage)\b.*\b(tasks?|trello|board)\b|\b(tasks?|trello|board)\b.*\b(review|prioriti[sz]e|triage)\b/.test(input)) {
    return "review";
  }
  if (/\b(suggestions?|replan|adjust my (?:day|schedule))\b/.test(input)) return "suggestions";
  return null;
}

async function plannerContext() {
  const [trelloResult, calendarResult, remindersResult] = await Promise.allSettled([
    getDailyCards(),
    listTodayEvents(),
    listActiveReminders()
  ]);
  const context = { openTasks: [], calendar: [], reminders: [] };
  if (trelloResult.status === "fulfilled") {
    const listNames = new Map(trelloResult.value.lists.map((list) => [list.id, list.name]));
    context.openTasks = trelloResult.value.cards
      .filter((card) => isActiveTrelloCard(card, trelloResult.value.workflow))
      .slice(0, 20)
      .map((card) => ({ title: card.name, list: listNames.get(card.idList) || "", due: card.due || null, complete: Boolean(card.dueComplete) }));
  }
  if (calendarResult.status === "fulfilled") {
    context.calendar = calendarResult.value.slice(0, 20).map((event) => ({
      title: event.summary,
      start: event.start,
      end: event.end
    }));
  }
  if (remindersResult.status === "fulfilled") {
    context.reminders = remindersResult.value.slice(0, 10).map((item) => ({
      kind: item.kind,
      text: item.body.replace(/^#.*\n+/m, "").trim(),
      due: item.due || null
    }));
  }
  return context;
}

async function conversationHistory(chatId) {
  const state = await readJson(conversationStatePath, {});
  return Array.isArray(state[String(chatId)]) ? state[String(chatId)].slice(-conversationTurns) : [];
}

export async function saveConversationTurn(chatId, userText, assistantText, { statePath = conversationStatePath } = {}) {
  const state = await readJson(statePath, {});
  const history = Array.isArray(state[String(chatId)]) ? state[String(chatId)] : [];
  state[String(chatId)] = [
    ...history,
    { role: "user", content: userText.slice(0, 1200) },
    { role: "assistant", content: assistantText.slice(0, 1200) }
  ].slice(-conversationTurns);
  await writeJson(statePath, state);
}

async function handleConversation(text, chatId) {
  const [history, context] = await Promise.all([conversationHistory(chatId), plannerContext()]);
  const result = await answerPlannerChat({ message: text, history, context });
  return result.configured ? result.text : result.message;
}

async function telegramRequest(method, body = {}, {
  retries = ["getUpdates", "getFile"].includes(method) ? 2 : 0,
  timeoutMs
} = {}) {
  if (!config.telegram.botToken) {
    return { ok: false, message: "Telegram is not configured yet." };
  }

  const response = await fetchWithRetry(`https://api.telegram.org/bot${config.telegram.botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }, { retries, ...(timeoutMs ? { timeoutMs } : {}) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    throw new Error(`Telegram ${response.status}: ${result.description || "request failed"}`);
  }
  return result.result;
}

async function transcribeTelegramVoice(voice) {
  if (!config.openai.apiKey) throw new Error("Voice capture needs OPENAI_API_KEY.");
  const file = await telegramRequest("getFile", { file_id: voice.file_id });
  const response = await fetchWithRetry(`https://api.telegram.org/file/bot${config.telegram.botToken}/${file.file_path}`, {}, { retries: 2 });
  if (!response.ok) throw new Error(`Telegram voice download failed: ${response.status}`);
  const audio = new File([await response.arrayBuffer()], `${voice.file_unique_id || "voice"}.ogg`, { type: "audio/ogg" });
  const client = new OpenAI({ apiKey: config.openai.apiKey });
  const transcript = await client.audio.transcriptions.create({
    file: audio,
    model: config.voice.transcriptionModel,
    prompt: "Personal planning notes, tasks, promises, reminders, and calendar events."
  });
  try {
    await recordTranscriptionUsage({ model: config.voice.transcriptionModel, seconds: voice.duration, operation: "telegram_voice" });
  } catch (error) {
    console.error(`Voice usage recording error: ${error.message}`);
  }
  return transcript.text?.trim() || "";
}

export function splitTelegramMessage(text, limit = 4000) {
  const source = String(text || "");
  if (!source) return [""];
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Telegram message limit must be a positive integer.");
  const chunks = [];
  let start = 0;
  while (start < source.length) {
    let end = Math.min(start + limit, source.length);
    if (end < source.length) {
      const newline = source.lastIndexOf("\n", end - 1);
      const space = source.lastIndexOf(" ", end - 1);
      const boundary = Math.max(newline, space);
      if (boundary >= start + Math.floor(limit / 2)) end = boundary + 1;
    }
    chunks.push(source.slice(start, end));
    start = end;
  }
  return chunks;
}

export async function sendTelegramMessage(text, chatId) {
  // Timer jobs are short-lived processes, so they must recover the owner chat
  // ID persisted by the long-polling service before trying to send a report.
  await loadChatId();
  const targetChatId = chatId || config.telegram.chatId;
  if (!targetChatId) return { sent: false, message: "Set TELEGRAM_CHAT_ID or send /start to establish the owner chat." };
  let result;
  const chunks = splitTelegramMessage(text);
  for (const chunk of chunks) result = await telegramRequest("sendMessage", { chat_id: targetChatId, text: chunk });
  return { sent: true, messages: chunks.length, result };
}

export function getTelegramBot() {
  return telegramRequest("getMe");
}

async function handleTextMessage(text, chatId, { source = "telegram-text" } = {}) {
  const input = String(text || "").trim();
  if (!input) return "I didn’t catch that. Try telling me what you need to do or asking about today.";
  const command = input.split(/\s+/)[0].toLowerCase();
  const replies = {
    "/start": "Connected. Talk to me naturally—ask what is on today, what to focus on, or tell me about a task.",
    "/help": "Just talk naturally. For example: “What should I focus on today?”, “Add finish the deck by Friday”, “Schedule coffee with Maya tomorrow at 10”, or “Remember that Sam prefers email.”"
  };
  const shortcut = detectPlannerShortcut(input);
  if (command === "/today" || shortcut === "today") return buildTodayBriefing();
  if (command === "/suggestions" || shortcut === "suggestions") return (await buildPlannerFollowUp()) || "No additional reminders or suggestions today.";
  if (command === "/review" || shortcut === "review") return buildTaskReview();
  if (replies[command]) return replies[command];

  // Calendar language comes first so “schedule a 6pm meeting with Mr X”
  // creates the meeting rather than searching for a pre-existing Trello card.
  if (looksLikeCalendarRequest(input)) {
    const calendarReply = await handleCalendarMessage(input, chatId);
    if (calendarReply) return calendarReply;
  }

  // Calendar confirmations are intentionally handled before the task parser so a plain “yes” stays safe.
  if (/^(yes|no|\/confirm|\/cancel)$/i.test(input)) {
    const calendarReply = await handleCalendarMessage(input, chatId);
    if (calendarReply) return calendarReply;
  }

  const trelloReply = await handleTrelloMessage(input, chatId);
  if (trelloReply) return trelloReply;
  const calendarReply = await handleCalendarMessage(input, chatId);
  if (calendarReply) return calendarReply;
  const knowledgeReply = await handleKnowledgeMessage(input, { source });
  if (knowledgeReply) return knowledgeReply;
  if (command.startsWith("/")) return "You can just speak naturally. Ask what is on today, what to focus on, or tell me what you want to do.";
  return handleConversation(input, chatId);
}

export async function startTelegramPolling() {
  if (!config.telegram.botToken) return;

  await loadChatId();
  let offset = await loadPollingOffset();
  if (!config.telegram.chatId) console.warn("Telegram owner chat is not configured; incoming messages will be ignored.");
  console.log("Telegram polling enabled");

  while (true) {
    try {
      const updates = await telegramRequest("getUpdates", {
        offset,
        timeout: telegramLongPollSeconds,
        allowed_updates: ["message"]
      }, { timeoutMs: telegramPollRequestTimeoutMs() });

      for (const update of updates) {
        const message = update.message;
        if (message?.text || message?.voice) {
          if (isOwnerMessage(message)) {
            const chatId = message.chat.id;
            const text = message.voice ? await transcribeTelegramVoice(message.voice) : message.text;
            const reply = await handleTextMessage(text, chatId, { source: message.voice ? "telegram-voice" : "telegram-text" });
            // Retain every owner interaction, not just free-form AI chat. This
            // includes commands, confirmations, and auto-scheduled calendar
            // requests, which are the interactions most useful to audit later.
            await saveConversationTurn(chatId, text, reply);
            await sendTelegramMessage(reply, chatId);
          } else {
            console.warn(`Ignored Telegram update from unauthorized chat ${message?.chat?.id || "unknown"}`);
          }
        }
        offset = update.update_id + 1;
        await savePollingOffset(offset);
      }
    } catch (error) {
      console.error(`Telegram polling error: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}
