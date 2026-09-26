/**
 * Timezone helpers. Cloudflare cron runs in UTC; Sid is Eastern (EST/EDT). We
 * never hardcode an offset — Intl resolves DST for the given IANA zone, so a
 * wake-up at 7:00 AM Eastern lands on the right UTC instant in both winter and
 * summer. Tests assert WHICH wall-clock a UTC instant maps to (trap: "test which
 * firing happens").
 */
export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: string;
}

export function wallClockInZone(instant: string | number | Date, zone: string): WallClock {
  const date = instant instanceof Date ? instant : new Date(instant);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  let hour = parseInt(get("hour"), 10);
  if (hour === 24) hour = 0; // some engines emit 24 for midnight
  return {
    year: parseInt(get("year"), 10),
    month: parseInt(get("month"), 10),
    day: parseInt(get("day"), 10),
    hour,
    minute: parseInt(get("minute"), 10),
    weekday: get("weekday"),
  };
}
