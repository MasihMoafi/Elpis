import type { Entry } from "@/lib/api";

/** What the router sends a worker is written for the model: the ticket as JSON with its IDs
 * (bridge/router/executor/dsh.mts launch) and fixed notices (bridge/router/executor/messages.mts). A person reads the
 * ticket's title, its assignment and the request; the notices are quiet notes, not messages from him
 * (specs/router-chats.md R3, R4). Anything else is returned unchanged. */
export function ticketText(body: string): string | null {
  if (!body.startsWith("{") || !body.includes('"ticket_id"')) return null;
  try {
    const value = JSON.parse(body) as Record<string, unknown>;
    // Only the ticket a worker receives (its title, or a retry's assignment number); a report about a ticket is not one.
    if (typeof value.ticket_id !== "string" || typeof value.kind === "string") return null;
    if (typeof value.title !== "string" && typeof value.assignment !== "number") return null;
    const title = typeof value.title === "string" ? value.title.trim() : "";
    const brief = typeof value.assignment === "string" ? value.assignment.trim() : "";
    const trigger = value.trigger && typeof value.trigger === "object" ? (value.trigger as Record<string, unknown>) : {};
    const asked = typeof trigger.text === "string" ? trigger.text.trim() : "";
    const parts = [title, brief.replace(/^Routing note \(not the source request\):\s*/i, ""), asked && `Request: ${asked}`];
    const shown = parts.filter(Boolean).join("\n\n");
    return shown || (typeof value.assignment === "number" ? `Assignment ${value.assignment} started again.` : "Ticket");
  } catch {
    return null;
  }
}

const NOTICES = [
  [/^This ticket ended earlier and the message that follows/, "Elpis resumed this ticket for the message below."],
  [/^A person retried this ticket\./, "This ticket was retried."],
  [/^Policy change:/, "Elpis's rules changed; the worker checks its remaining work against them."],
] as const;
export function routerNotice(body: string): string | null {
  return NOTICES.find(([pattern]) => pattern.test(body))?.[1] ?? null;
}

/** Router notices in a worker chat become notes; other entries pass unchanged. */
export function noteRouterNotices(entries: Entry[]): Entry[] {
  let changed = false;
  const out = entries.map(entry => {
    if (entry.item.type !== "userMessage") return entry;
    const body = (entry.item.content ?? [])
      .map(part => (typeof part.text === "string" ? part.text : ""))
      .join("\n")
      .replace(/^<elpis-router-message [^>]*>\n?/, "")
      .trim();
    const note = routerNotice(body);
    if (!note) return entry;
    changed = true;
    return { ...entry, item: { id: entry.item.id, type: "routerNote", text: note } };
  });
  return changed ? out : entries;
}
