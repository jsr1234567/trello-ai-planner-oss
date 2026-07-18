import express from "express";
import { config } from "./config.js";
import { trello } from "./trello.js";
import { prioritize } from "./ai.js";
import { buildTaskReview, scanTrelloNotifications, startTaskAgent } from "./task-agent.js";
import { sendWhatsApp } from "./whatsapp.js";
import { getTelegramBot, sendTelegramMessage, startTelegramPolling } from "./telegram.js";
import { startMorningScheduler } from "./scheduler.js";
import { createManualCalendarEvent, deleteCalendarEvent, getPlannerCalendarSettings, listCalendars, listTodayEvents, updateCalendarEvent, updatePlannerCalendarDefaultReminders } from "./google-calendar.js";
import { buildTodayBriefing } from "./planner.js";
import { reopenPlannerTask, startGoogleTasksSync, synchronizeGoogleTasks } from "./google-tasks.js";
import { apiAuthMiddleware, assertSafeServerConfig, securityHeaders } from "./api-security.js";
import { beginGooglePlannerAuthorization, exchangeGooglePlannerAuthorization } from "./google-oauth-rotation.js";

const app = express();
app.disable("x-powered-by");
app.use(securityHeaders);
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ ok: true, service: "trello-ai-planner" }));

app.use("/api", apiAuthMiddleware({ host: config.host, apiToken: config.api.bearerToken }));

app.get("/api/briefing/today", async (_req, res) => {
  try { res.json({ briefing: await buildTodayBriefing() }); }
  catch (error) { res.status(503).json({ error: error.message }); }
});

app.get("/api/trello/me", async (_req, res) => {
  try { res.json(await trello.me()); }
  catch (error) { res.status(503).json({ error: error.message }); }
});

app.get("/api/trello/boards", async (_req, res) => {
  try { res.json(await trello.boards()); }
  catch (error) { res.status(503).json({ error: error.message }); }
});

app.get("/api/trello/boards/:boardId/cards", async (req, res) => {
  try { res.json(await trello.boardCards(req.params.boardId)); }
  catch (error) { res.status(503).json({ error: error.message }); }
});

app.get("/api/trello/boards/:boardId/lists", async (req, res) => {
  try { res.json(await trello.lists(req.params.boardId)); }
  catch (error) { res.status(503).json({ error: error.message }); }
});

app.get("/api/trello/boards/:boardId/labels", async (req, res) => {
  try { res.json(await trello.labels(req.params.boardId)); }
  catch (error) { res.status(503).json({ error: error.message }); }
});

app.patch("/api/trello/labels/:labelId", async (req, res) => {
  try { res.json(await trello.updateLabel(req.params.labelId, req.body)); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

app.patch("/api/trello/cards/:cardId", async (req, res) => {
  try { res.json(await trello.updateCard(req.params.cardId, req.body)); }
  catch (error) { res.status(503).json({ error: error.message }); }
});

app.post("/api/ai/prioritize", async (req, res) => {
  try { res.json(await prioritize(req.body.cards || [])); }
  catch (error) { res.status(502).json({ error: error.message }); }
});

app.post("/api/ai/review-tasks", async (_req, res) => {
  try { res.json({ review: await buildTaskReview() }); }
  catch (error) { res.status(502).json({ error: error.message }); }
});

app.post("/api/trello/notifications/scan", async (_req, res) => {
  try { res.json(await scanTrelloNotifications()); }
  catch (error) { res.status(502).json({ error: error.message }); }
});

app.get("/api/calendar/calendars", async (_req, res) => {
  try { res.json(await listCalendars()); }
  catch (error) { res.status(503).json({ error: error.message }); }
});

app.get("/api/calendar/settings", async (_req, res) => {
  try { res.json(await getPlannerCalendarSettings()); }
  catch (error) { res.status(503).json({ error: error.message }); }
});

app.patch("/api/calendar/default-reminders", async (req, res) => {
  try { res.json(await updatePlannerCalendarDefaultReminders(req.body.reminders, { confirm: req.body.confirm === true })); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

app.post("/api/google-oauth/authorize", async (_req, res) => {
  try { res.json(beginGooglePlannerAuthorization()); }
  catch (error) { res.status(503).json({ error: error.message }); }
});

app.post("/api/google-oauth/exchange", async (req, res) => {
  try { res.json(await exchangeGooglePlannerAuthorization(req.body)); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

app.get("/api/calendar/today", async (_req, res) => {
  try { res.json(await listTodayEvents()); }
  catch (error) { res.status(503).json({ error: error.message }); }
});

app.post("/api/calendar/events", async (req, res) => {
  try {
    res.status(201).json(await createManualCalendarEvent(req.body.event, {
      confirm: req.body.confirm === true,
      reschedulePlannerConflicts: req.body.reschedulePlannerConflicts !== false
    }));
  }
  catch (error) { res.status(400).json({ error: error.message }); }
});

app.patch("/api/calendar/events/:eventId", async (req, res) => {
  try { res.json(await updateCalendarEvent(req.params.eventId, req.body.event, { confirm: req.body.confirm === true })); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

app.delete("/api/calendar/events/:eventId", async (req, res) => {
  try { res.json(await deleteCalendarEvent(req.params.eventId, { confirm: req.body.confirm === true })); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

app.post("/api/google-tasks/sync", async (_req, res) => {
  try { res.json(await synchronizeGoogleTasks()); }
  catch (error) { res.status(503).json({ error: error.message }); }
});

app.post("/api/google-tasks/:trelloCardId/reopen", async (req, res) => {
  try { res.json(await reopenPlannerTask(req.params.trelloCardId)); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

app.post("/api/whatsapp/test", async (req, res) => {
  try { res.json(await sendWhatsApp(req.body.message || "Planner test message")); }
  catch (error) { res.status(502).json({ error: error.message }); }
});

app.get("/api/telegram/me", async (_req, res) => {
  try { res.json(await getTelegramBot()); }
  catch (error) { res.status(502).json({ error: error.message }); }
});

app.post("/api/telegram/test", async (req, res) => {
  try { res.json(await sendTelegramMessage(req.body.message || "Planner test message", req.body.chatId)); }
  catch (error) { res.status(502).json({ error: error.message }); }
});

// This deployment uses outbound polling. Do not expose a webhook endpoint
// until Trello's signature verification is implemented and configured.
app.post("/webhooks/trello", (_req, res) => res.sendStatus(404));

assertSafeServerConfig({ host: config.host, apiToken: config.api.bearerToken });
app.listen(config.port, config.host, () => {
  console.log(`Trello AI Planner listening on http://${config.host}:${config.port}`);
  startTelegramPolling();
  startMorningScheduler();
  startTaskAgent();
  startGoogleTasksSync();
});
