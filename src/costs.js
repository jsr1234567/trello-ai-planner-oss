import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { addDaysToDateKey, localDateKey, localDateParts } from "./timezone.js";

const defaultUsagePath = path.resolve(".planner-data/ai-usage.json");
const modelRatesPerMillion = {
  "gpt-4.1": { input: 2, cachedInput: 0.5, output: 8 },
  "gpt-4.1-mini": { input: 0.4, cachedInput: 0.1, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, cachedInput: 0.025, output: 0.4 },
  "gpt-4o": { input: 2.5, cachedInput: 1.25, output: 10 },
  "gpt-4o-mini": { input: 0.15, cachedInput: 0.075, output: 0.6 }
};
const transcriptionRatesPerMinute = {
  "gpt-4o-transcribe": 0.006,
  "gpt-4o-mini-transcribe": 0.003
};

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function emptyDay() {
  return {
    textRequests: 0,
    unpricedTextRequests: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    textCostUsd: 0,
    transcriptionRequests: 0,
    transcriptionSeconds: 0,
    transcriptionCostUsd: 0,
    operations: {}
  };
}

async function readUsage(usagePath) {
  try {
    const state = JSON.parse(await readFile(usagePath, "utf8"));
    return state && typeof state === "object" ? state : { days: {} };
  } catch { return { days: {} }; }
}

async function writeUsage(usagePath, state) {
  await mkdir(path.dirname(usagePath), { recursive: true });
  const temporaryPath = `${usagePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(temporaryPath, usagePath);
}

function recordOperation(day, operation) {
  const key = String(operation || "unknown").replace(/[^a-z0-9_-]/gi, "_").slice(0, 60);
  day.operations[key] = Number(day.operations[key] || 0) + 1;
}

function weekStartDateKey(now) {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: config.timezone, weekday: "short" }).format(now);
  const offset = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[weekday];
  return addDaysToDateKey(localDateKey(now, config.timezone), -offset);
}

function usageForDate(state, date) {
  return { ...emptyDay(), ...(state.days?.[date] || {}) };
}

export async function recordModelUsage({ model, usage, operation, now = new Date() }, { usagePath = defaultUsagePath } = {}) {
  const state = await readUsage(usagePath);
  const date = localDateKey(now, config.timezone);
  const day = usageForDate(state, date);
  const inputTokens = nonNegativeNumber(usage?.input_tokens);
  const cachedInputTokens = Math.min(inputTokens, nonNegativeNumber(usage?.input_tokens_details?.cached_tokens));
  const outputTokens = nonNegativeNumber(usage?.output_tokens);
  const rates = modelRatesPerMillion[model];
  day.textRequests += 1;
  day.inputTokens += inputTokens;
  day.cachedInputTokens += cachedInputTokens;
  day.outputTokens += outputTokens;
  if (rates) {
    day.textCostUsd += ((inputTokens - cachedInputTokens) * rates.input + cachedInputTokens * rates.cachedInput + outputTokens * rates.output) / 1_000_000;
  } else {
    day.unpricedTextRequests += 1;
  }
  recordOperation(day, operation);
  state.days = { ...(state.days || {}), [date]: day };
  state.trackingStartedAt ||= now.toISOString();
  await writeUsage(usagePath, state);
  return { date, inputTokens, cachedInputTokens, outputTokens, costUsd: rates ? day.textCostUsd : null };
}

export async function recordTranscriptionUsage({ model, seconds, operation = "telegram_voice", now = new Date() }, { usagePath = defaultUsagePath } = {}) {
  const state = await readUsage(usagePath);
  const date = localDateKey(now, config.timezone);
  const day = usageForDate(state, date);
  const duration = nonNegativeNumber(seconds);
  const rate = transcriptionRatesPerMinute[model];
  day.transcriptionRequests += 1;
  day.transcriptionSeconds += duration;
  if (rate) day.transcriptionCostUsd += (duration / 60) * rate;
  recordOperation(day, operation);
  state.days = { ...(state.days || {}), [date]: day };
  state.trackingStartedAt ||= now.toISOString();
  await writeUsage(usagePath, state);
  return { date, seconds: duration, costUsd: rate ? (duration / 60) * rate : null };
}

export async function getWeeklyUsageSummary({ now = new Date(), usagePath = defaultUsagePath } = {}) {
  const state = await readUsage(usagePath);
  const start = weekStartDateKey(now);
  const end = addDaysToDateKey(start, 7);
  const summary = { ...emptyDay(), start, end, trackingStartedAt: state.trackingStartedAt || null };
  for (let date = start; date < end; date = addDaysToDateKey(date, 1)) {
    const day = usageForDate(state, date);
    for (const field of ["textRequests", "unpricedTextRequests", "inputTokens", "cachedInputTokens", "outputTokens", "textCostUsd", "transcriptionRequests", "transcriptionSeconds", "transcriptionCostUsd"]) {
      summary[field] += Number(day[field] || 0);
    }
    for (const [operation, count] of Object.entries(day.operations || {})) {
      summary.operations[operation] = Number(summary.operations[operation] || 0) + Number(count || 0);
    }
  }
  summary.llmCostUsd = summary.textCostUsd + summary.transcriptionCostUsd;
  return summary;
}

export function estimatedWeeklyHostingCost() {
  const monthly = nonNegativeNumber(config.costs.hostingMonthlyUsd);
  return monthly * 7 / 30.4375;
}

export function formatUsd(value) {
  const amount = Number(value || 0);
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}
