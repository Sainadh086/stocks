import { readFileSync } from "node:fs";
import { join } from "node:path";
import { projectRoot } from "./storage.js";
export type Exchange = "NYSE" | "NSE";
const data = JSON.parse(
  readFileSync(join(projectRoot, "server/data/sessions.json"), "utf8"),
) as {
  coverage: string[];
  sessions: Record<Exchange, Record<string, [number, number]>>;
};
export function localDay(now: number | Date, exchange: Exchange): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: exchange === "NYSE" ? "America/New_York" : "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  return ["year", "month", "day"]
    .map((t) => parts.find((p) => p.type === t)!.value)
    .join("-");
}
export function session(
  day: string,
  exchange: Exchange = "NYSE",
): [number, number] | null {
  if (day < data.coverage[0] || day > data.coverage[1])
    throw new Error(
      "Exchange calendar coverage expired. Update sessions before trading.",
    );
  return data.sessions[exchange][day] ?? null;
}
export function phase(now = Date.now(), exchange: Exchange = "NYSE"): string {
  const s = session(localDay(now, exchange), exchange);
  return !s
    ? "Market closed"
    : now < s[0]
      ? "Before market open"
      : now >= s[1]
        ? "After market close"
        : "Market open";
}
export function completedDay(now: number, exchange: Exchange): string {
  const days = Object.entries(data.sessions[exchange])
    .filter(([, hours]) => hours[1] <= now)
    .map(([day]) => day)
    .sort();
  if (!days.length) throw new Error("No completed session available.");
  return days.at(-1)!;
}
export function nextReview(now: number): string | null {
  return (
    Object.entries(data.sessions.NSE).find(
      ([day, h]) => h[1] > now && new Date(day).getUTCDay() === 5,
    )?.[0] ?? null
  );
}
