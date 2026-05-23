// Human-readable time helpers.
//
// Pure functions: server components format at render time (deterministic per
// request, so no hydration mismatch) and the live-refresh poll re-renders them
// every few seconds, so "2 minutes ago" stays honest without a client clock.

export function formatAbsoluteUTC(d: Date): string {
  // Stable, locale-free — used as the tooltip behind every relative label.
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/**
 * Compact relative phrase for a past or future instant:
 * "just now", "5 minutes ago", "in 3 hours", "in 5 days".
 */
export function formatRelative(target: Date, now: Date = new Date()): string {
  const diff = target.getTime() - now.getTime();
  const abs = Math.abs(diff);
  if (abs < 45 * 1000) return "just now";

  let value: string;
  if (abs < HOUR) value = plural(Math.round(abs / MIN), "minute");
  else if (abs < DAY) value = plural(Math.round(abs / HOUR), "hour");
  else if (abs < WEEK) value = plural(Math.round(abs / DAY), "day");
  else value = plural(Math.round(abs / WEEK), "week");

  return diff < 0 ? `${value} ago` : `in ${value}`;
}

export type CloseUrgency = "closed" | "soon" | "open";

/**
 * Describe a question's close time for display: the phrase plus an urgency
 * bucket the UI can colour. "soon" means it closes within 24h.
 */
export function describeClose(
  closesAt: Date,
  now: Date = new Date(),
  status?: string,
): { label: string; urgency: CloseUrgency } {
  const diff = closesAt.getTime() - now.getTime();
  if (diff <= 0 || (status && status !== "open")) {
    const when = diff <= 0 ? ` ${formatRelative(closesAt, now)}` : "";
    return { label: `closed${when}`, urgency: "closed" };
  }
  return {
    label: `closes ${formatRelative(closesAt, now)}`,
    urgency: diff <= DAY ? "soon" : "open",
  };
}
