import assert from "node:assert/strict";
import test from "node:test";
import { resolveCalendarId } from "../src/config.js";
import { isActiveCalendarEvent } from "../src/google-calendar.js";
import { buildTodayBriefing, formatAgendaTimeline } from "../src/planner.js";
import { zonedDateTimeToDate } from "../src/timezone.js";

test("uses the configured Google Calendar ID", () => {
  assert.equal(resolveCalendarId({ GOOGLE_CALENDAR_ID: "legacy-calendar" }), "legacy-calendar");
  assert.equal(resolveCalendarId({ GOOGLE_CALENDAR_ID: "configured-calendar" }), "configured-calendar");
});

test("parses local calendar times with the configured IANA timezone", () => {
  const date = zonedDateTimeToDate("2026-07-16T09:30", "Europe/Paris");
  assert.equal(date.toISOString(), "2026-07-16T07:30:00.000Z");
  assert.throws(() => zonedDateTimeToDate("2026-03-08T02:30", "America/New_York"), /does not exist/);
});

test("excludes completed transparent Calendar blocks from the active agenda", () => {
  assert.equal(isActiveCalendarEvent({ status: "confirmed", transparency: "opaque" }), true);
  assert.equal(isActiveCalendarEvent({ status: "confirmed", transparency: "transparent" }), false);
  assert.equal(isActiveCalendarEvent({ status: "cancelled" }), false);
});

test("daily briefing contains only real calendar agenda entries", async () => {
  const briefing = await buildTodayBriefing({
    loadDailyCards: async () => ({
      board: { name: "Daily" },
      lists: [{ id: "today", name: "Today", closed: false }],
      cards: [{ id: "card-1", idList: "today", name: "Write launch brief", closed: false, due: null, url: "" }]
    }),
    loadTodayEvents: async () => [{ start: "2026-07-16T03:00:00.000Z", summary: "Team call" }]
  });
  assert.match(briefing, /Team call/);
  assert.doesNotMatch(briefing, /Write launch brief/);
});

test("agenda formatting never creates task lines from the Trello backlog", () => {
  assert.equal(formatAgendaTimeline([]), "No agenda blocks yet today.");
  assert.equal(formatAgendaTimeline([{ start: "2026-07-16T03:00:00.000Z", summary: "Team call" }]), "03:00 — Team call");
});
