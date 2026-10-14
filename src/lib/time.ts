/**
 * India business-day / business-hour helpers. All scheduling decisions use the
 * configured reporting timezone (default Asia/Kolkata) so behaviour is stable
 * regardless of where the server runs.
 */

export function zonedParts(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).map((p) => [p.type, p.value]),
  );
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour === "24" ? "0" : parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: weekdayMap[parts.weekday as string] ?? 0,
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

export function isBusinessDay(date: Date, timeZone: string): boolean {
  const wd = zonedParts(date, timeZone).weekday;
  return wd >= 1 && wd <= 5;
}

export function isWithinSendWindow(
  date: Date,
  timeZone: string,
  startHour: number,
  endHour: number,
): boolean {
  if (!isBusinessDay(date, timeZone)) return false;
  const h = zonedParts(date, timeZone).hour;
  return h >= startHour && h < endHour;
}

/** Adds N business days (Mon–Fri) in the given timezone. */
export function addBusinessDays(
  date: Date,
  days: number,
  timeZone: string,
): Date {
  let cursor = new Date(date.getTime());
  let added = 0;
  while (added < days) {
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    if (isBusinessDay(cursor, timeZone)) added += 1;
  }
  return cursor;
}

/** Start of the current local day, expressed as a UTC instant. */
export function startOfZonedDay(date: Date, timeZone: string): Date {
  const p = zonedParts(date, timeZone);
  const guess = Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0);
  const offset = date.getTime() - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return new Date(guess + offset);
}

export function formatZoned(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

/** Deterministic, bounded pacing jitter (never used to evade abuse controls). */
export function pacingJitterMs(seed: string, maxMinutes = 11): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return (h % (maxMinutes * 60)) * 1000;
}
