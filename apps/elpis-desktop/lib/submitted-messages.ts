import type { Entry, Item } from "./api";
import type { Attachment } from "./attachments";

/** Renderer-only identity, kept across the bridge's acknowledgement and recorded user item. */
export type SubmittedMessage = {
  key: string; scope: string; content: NonNullable<Item["content"]>; previousKeys: string[];
  turnId?: string; newTurn: boolean; failed?: boolean; recorded?: string;
};
export const entryKey = (entry: Entry) => JSON.stringify([entry.turnId, entry.item.id]);
export function submittedContent(text: string, files: Attachment[]): NonNullable<Item["content"]> {
  return [...(text.trim() ? [{ type: "text", text }] : []), ...files.map(file => {
    if (file.type === "image") return { type: "image", url: file.dataUrl };
    const contents = `File: ${file.name}\n${file.text}`;
    return { type: "text", text: contents, text_elements: [{ byteRange: { start: 0, end: new TextEncoder().encode(contents).length }, placeholder: `Attachment: ${file.name}` }] };
  })];
}
const textParts = (content: Item["content"]) => JSON.stringify(content?.filter(part => part.type === "text").map(part => part.text) ?? []);
const imageCount = (content: Item["content"]) => content?.filter(part => part.type === "image" || part.type === "localImage").length ?? 0;
function matchingEntry(entries: Entry[], sent: SubmittedMessage, used: Set<string>) {
  return entries.find(entry => entry.item.type === "userMessage" && !used.has(entryKey(entry)) && (!sent.turnId || sent.turnId === entry.turnId)
    && (sent.recorded ? entryKey(entry) === sent.recorded : !sent.previousKeys.includes(entryKey(entry)) && textParts(entry.item.content) === textParts(sent.content) && imageCount(entry.item.content) === imageCount(sent.content)));
}

/** Once observed, a recorded item can later disappear through rewind or compaction without reviving its optimistic copy. */
export function rememberSubmittedMessages(entries: Entry[], submissions: SubmittedMessage[], scope: string): SubmittedMessage[] {
  let changed = false;
  const used = new Set<string>();
  const next = submissions.map(sent => {
    if (sent.scope !== scope) return sent;
    const found = matchingEntry(entries, sent, used);
    if (!found) return sent;
    const recorded = entryKey(found); used.add(recorded);
    if (sent.recorded === recorded) return sent;
    changed = true; return { ...sent, recorded, turnId: found.turnId, previousKeys: [] };
  });
  return changed ? next : submissions;
}

/** Overlay only this chat's submissions. Old identical prompts cannot consume a fresh submission. */
export function withSubmittedMessages(entries: Entry[], submissions: SubmittedMessage[], scope: string): Entry[] {
  let result = entries;
  const used = new Set<string>(), earlier = new Set<string>();
  for (const sent of submissions) {
    if (sent.scope !== scope) continue;
    const found = matchingEntry(entries, sent, used);
    earlier.add(sent.key);
    if (found) {
      used.add(entryKey(found));
      result = result.map(entry => entry === found ? { ...entry, clientKey: sent.key, ...(sent.newTurn ? { clientTurnKey: sent.key } : {}) }
        : sent.newTurn && entry.turnId === found.turnId ? { ...entry, clientTurnKey: sent.key } : entry);
    } else if (!sent.failed && !sent.recorded) {
      const pending: Entry = { turnId: sent.turnId ?? sent.key, clientKey: sent.key, ...(sent.newTurn ? { clientTurnKey: sent.key } : {}), clientPending: true, item: { id: sent.key, type: "userMessage", content: sent.content } };
      // A new turn opens with its message; a message sent into a running turn sits right below what was shown when it
      // was sent, including the messages sent before it (R2, R4), so what the agent writes afterwards follows it.
      const seen = new Set(sent.previousKeys);
      const firstWork = sent.turnId && sent.newTurn ? result.findIndex(entry => entry.turnId === sent.turnId) : -1;
      const afterShown = result.reduce((last, entry, index) => seen.has(entryKey(entry)) || (entry.clientKey !== undefined && entry.clientKey !== sent.key && earlier.has(entry.clientKey)) ? index + 1 : last, 0);
      const at = firstWork >= 0 ? firstWork : sent.newTurn ? result.length : afterShown;
      result = [...result.slice(0, at), pending, ...result.slice(at)];
      if (sent.newTurn && sent.turnId) result = result.map(entry => entry.turnId === sent.turnId ? { ...entry, clientTurnKey: sent.key } : entry);
    }
  }
  return result;
}
