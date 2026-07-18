function pathList(value = "") {
  return value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
}

export function resolveCalendarId(environment = process.env) {
  return environment.GOOGLE_CALENDAR_ID || "primary";
}

export const config = {
  port: Number(process.env.PORT || 8787),
  host: process.env.PLANNER_HOST || "localhost",
  api: {
    bearerToken: process.env.PLANNER_API_TOKEN
  },
  timezone: process.env.PLANNER_TIMEZONE || "UTC",
  morningHour: Number(process.env.PLANNER_MORNING_HOUR || 8),
  morningMinute: Number(process.env.PLANNER_MORNING_MINUTE || 0),
  afternoonHour: Number(process.env.PLANNER_AFTERNOON_HOUR || 14),
  afternoonMinute: Number(process.env.PLANNER_AFTERNOON_MINUTE || 0),
  dayStartHour: Number(process.env.PLANNER_DAY_START_HOUR || 9),
  dayEndHour: Number(process.env.PLANNER_DAY_END_HOUR || 21),
  lunchStartHour: Number(process.env.PLANNER_LUNCH_START_HOUR || 12),
  lunchDurationMinutes: Number(process.env.PLANNER_LUNCH_DURATION_MINUTES || 60),
  // Limit planned focused work by time, leaving room for messages, transitions,
  // and unexpected work. Set to 0 only for deliberate unlimited planning.
  dailyFocusCapMinutes: Number(process.env.PLANNER_DAILY_FOCUS_CAP_MINUTES || 300),
  // JavaScript weekday: 0 = Sunday, 1 = Monday. Monday is the user's planning-week start.
  weekStartsOn: Number(process.env.PLANNER_WEEK_STARTS_ON || 1),
  morningEnabled: process.env.PLANNER_MORNING_ENABLED !== "false",
  scheduler: {
    // Enable only for a deliberate standalone process.
    inProcessEnabled: process.env.PLANNER_IN_PROCESS_SCHEDULER === "true"
  },
  notifications: {
    quietStartHour: Number(process.env.PLANNER_QUIET_HOURS_START || 22),
    quietEndHour: Number(process.env.PLANNER_QUIET_HOURS_END || 7),
    proactiveDailyCap: Number(process.env.PLANNER_PROACTIVE_DAILY_CAP || 4)
  },
  costs: {
    hostingMonthlyUsd: Number(process.env.PLANNER_HOSTING_MONTHLY_USD || 0)
  },
  trello: {
    apiKey: process.env.TRELLO_PUBLIC_API_KEY || process.env.TRELLO_API_KEY,
    token: process.env.TRELLO_TOKEN,
    boardName: process.env.TRELLO_BOARD_NAME || "Daily",
    captureListName: process.env.TRELLO_CAPTURE_LIST || "Inbox",
    naturalLanguageUpdates: process.env.TRELLO_NATURAL_LANGUAGE_UPDATES !== "false",
    // Clear creation/scheduling requests are applied from one Telegram
    // message. Set false to restore previews; destructive updates still
    // require confirmation.
    autoApply: process.env.TRELLO_AUTO_APPLY !== "false",
    pushEnabled: process.env.TRELLO_PUSH_ENABLED === "true",
    pushPollMinutes: Number(process.env.TRELLO_PUSH_POLL_MINUTES || 15)
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || "gpt-4.1-mini"
  },
  calendar: {
    clientId: process.env.GOOGLE_CALENDAR_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CALENDAR_CLIENT_SECRET,
    refreshToken: process.env.GOOGLE_CALENDAR_REFRESH_TOKEN,
    redirectUri: process.env.GOOGLE_CALENDAR_REDIRECT_URI || "http://localhost:8005/auth/google/callback",
    calendarId: resolveCalendarId(),
    // A complete calendar request is created immediately. Set false to
    // restore the explicit preview-and-confirm flow.
    autoSchedule: process.env.PLANNER_AUTO_SCHEDULE !== "false",
    // Put active Today and To Do This Week cards into real free calendar time.
    autoPlan: process.env.PLANNER_AUTO_PLAN === "true",
    // 0 means unlimited; set a positive number only when a daily cap is wanted.
    autoPlanDailyLimit: Number(process.env.PLANNER_AUTO_PLAN_DAILY_LIMIT || 0)
  },
  googleTasks: {
    listName: process.env.GOOGLE_TASKS_LIST_NAME || "Planner",
    syncEnabled: process.env.GOOGLE_TASKS_SYNC_ENABLED !== "false",
    syncPollMinutes: Number(process.env.GOOGLE_TASKS_SYNC_POLL_MINUTES || 5)
  },
  voice: {
    transcriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe"
  },
  lifeKnowledge: {
    dir: process.env.LIFE_KNOWLEDGE_DIR || ".planner-data/life-knowledge",
    sourceDirectories: pathList(process.env.LIFE_KNOWLEDGE_SOURCES)
  },
  whatsapp: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    from: process.env.TWILIO_WHATSAPP_FROM,
    to: process.env.WHATSAPP_TO
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID
  },
  email: {
    enabled: process.env.EMAIL_NOTIFICATIONS_ENABLED === "true",
    from: process.env.EMAIL_FROM,
    to: process.env.EMAIL_TO
  }
};

export function requireTrelloCredentials() {
  if (!config.trello.apiKey || !config.trello.token) {
    const missing = [
      !config.trello.apiKey && "TRELLO_API_KEY",
      !config.trello.token && "TRELLO_TOKEN"
    ].filter(Boolean);
    throw new Error(`Missing Trello credential(s): ${missing.join(", ")}`);
  }
}
