const HOUR = 3_600_000;
/** A turn gets a time line when it starts an hour or more after the turn before ends, or on another day. */
export function pauseBefore(start: unknown, end: unknown): start is number {
  return typeof start === "number" && typeof end === "number" && (start - end >= HOUR || new Date(start).toDateString() !== new Date(end).toDateString());
}
/** ChatGPT's time line ("Yesterday 8:41 PM") above a turn that starts an hour or more after the one before, or on another day. */
export function turnTime(at: number, now = new Date()): string {
  const date = new Date(at), time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const midnight = (day: Date) => new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const days = Math.round((midnight(now) - midnight(date)) / 86_400_000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  if (days > 1 && days < 7) return `${date.toLocaleDateString(undefined, { weekday: "long" })} ${time}`;
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) })}, ${time}`;
}
