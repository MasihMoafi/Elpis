/** How a failed turn reads (components/failed-turn-card.tsx): an overloaded model (the server's own kind, or HTTP 529
 * anywhere in its details) offers another model; a usage or rate limit says so and when it resets. */
export function failureKind(info: string | Record<string, unknown> | undefined) {
  const kind = (typeof info === "string" ? info : Object.keys(info ?? {})[0] ?? "").toLowerCase();
  const overloaded = kind === "serveroverloaded" || (typeof info === "object" && info !== null &&
    (info.httpStatusCode === 529 || Object.values(info).some(value => typeof value === "object" && value !== null && "httpStatusCode" in value && value.httpStatusCode === 529)));
  const usage = kind === "usagelimitexceeded", limited = usage || kind === "ratelimitexceeded";
  return { overloaded, usage, limited };
}

/** "Resets in 2h 5m" becomes "Resets in 2 hours and 5 minutes". */
export function plainResetTime(message: string) {
  return message.replace(/\bResets in\s*((?:\d+\s*[dhms]\s*)+)(?=[.!?]|$)/gi, (match, duration: string) => {
    const labels: Record<string, string> = { d: "day", h: "hour", m: "minute", s: "second" };
    const parts = [...duration.matchAll(/(\d+)\s*([dhms])/gi)].map(([, count, unit]) => `${count} ${labels[unit.toLowerCase()]}${count === "1" ? "" : "s"}`);
    if (!parts.length) return match;
    const list = parts.length === 1 ? parts[0] : parts.length === 2 ? `${parts[0]} and ${parts[1]}` : `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
    return `Resets in ${list}`;
  });
}
