function partsFor(date, timeZone, options) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    ...options
  });
  return Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
}

function offsetMinutesAt(date, timeZone) {
  const offset = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset"
  }).formatToParts(date).find((part) => part.type === "timeZoneName")?.value;
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(offset || "");
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "+" ? minutes : -minutes;
}

export function localDateParts(date = new Date(), timeZone) {
  if (!timeZone) throw new Error("A timezone is required.");
  return partsFor(date, timeZone, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

export function localDateKey(date = new Date(), timeZone) {
  const parts = localDateParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function addDaysToDateKey(dateKey, days) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey));
  if (!match) throw new Error("Date must use YYYY-MM-DD.");
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + Number(days)));
  return date.toISOString().slice(0, 10);
}

// Converts a wall-clock time in an IANA timezone to an instant without relying
// on the machine's timezone or a hard-coded UTC offset. Explicit ISO offsets
// remain valid and are passed through unchanged.
export function zonedDateTimeToDate(value, timeZone) {
  const input = String(value || "").trim().replace(" ", "T");
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(input)) {
    const date = new Date(input);
    if (!Number.isNaN(date.getTime())) return date;
    throw new Error("Invalid ISO date and time.");
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(input);
  if (!match) throw new Error("Date and time must use YYYY-MM-DDTHH:mm.");
  const [year, month, day, hour, minute, second] = match.slice(1).map((item) => Number(item || 0));
  const intended = { year, month, day, hour, minute, second };
  const intendedUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let timestamp = intendedUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const next = intendedUtc - offsetMinutesAt(new Date(timestamp), timeZone) * 60_000;
    if (next === timestamp) break;
    timestamp = next;
  }
  const date = new Date(timestamp);
  const actual = localDateParts(date, timeZone);
  const matches = Number(actual.year) === intended.year
    && Number(actual.month) === intended.month
    && Number(actual.day) === intended.day
    && Number(actual.hour) === intended.hour
    && Number(actual.minute) === intended.minute
    && Number(actual.second) === intended.second;
  if (!matches) throw new Error(`That local time does not exist in ${timeZone}.`);
  return date;
}
