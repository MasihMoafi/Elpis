// @-mentions in the message box: finding the "@query" under the caret, ranking what it can name (the project's
// files and the person's other chats), inserting the choice, and which choices the message still carries when sent.

/** What a message carries for a mention: the engine's native `mention` input (name and path). */
export type Mention = { name: string; path: string };
/** One line of the picker: a file or a chat, `detail` being the words shown beside its name. */
export type MentionItem = { kind: "file" | "chat"; name: string; detail: string; path: string };

const SHOWN = 8, CHATS = 3;
const space = /\s/;

/** The mention being typed: an "@" at the start of the text or after whitespace, up to the caret. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  let start = caret;
  while (start > 0 && !space.test(text[start - 1])) start--;
  if (text[start] !== "@") return null;
  return { start, query: text.slice(start + 1, caret) };
}

/** 0 the path starts with the query, 1 the file name does, 2 the file name contains it, 3 the path does; null no match. */
function score(item: MentionItem, query: string): number | null {
  const name = item.name.toLowerCase(), base = item.kind === "file" ? name.slice(name.lastIndexOf("/") + 1) : name;
  if (name.startsWith(query)) return 0;
  if (base.startsWith(query)) return 1;
  if (base.includes(query)) return 2;
  return name.includes(query) ? 3 : null;
}

/** The picker's lines: with nothing typed the first files then up to three chats; otherwise the best matches. */
export function rankMentions(items: MentionItem[], typed: string): MentionItem[] {
  const query = typed.toLowerCase();
  if (!query) {
    const files = items.filter(item => item.kind === "file"), chats = items.filter(item => item.kind === "chat");
    const chatCount = Math.min(chats.length, Math.max(CHATS, SHOWN - files.length));
    return [...files.slice(0, SHOWN - chatCount), ...chats.slice(0, chatCount)];
  }
  return items.map((item, order) => ({ item, order, rank: score(item, query) }))
    .filter((entry): entry is { item: MentionItem; order: number; rank: number } => entry.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.item.name.length - b.item.name.length || a.order - b.order)
    .slice(0, SHOWN).map(entry => entry.item);
}

/** Replaces the "@query" (from `start` to the caret) with "@name " and reports where the caret goes. */
export function insertMention(text: string, start: number, caret: number, name: string): { text: string; caret: number } {
  const token = `@${name} `;
  return { text: text.slice(0, start) + token + text.slice(caret), caret: start + token.length };
}

/** The picked mentions whose "@name" is still in the text, each once. */
export function usedMentions(text: string, picked: Mention[]): Mention[] {
  const seen = new Set<string>();
  return picked.filter(mention => text.includes(`@${mention.name}`) && !seen.has(mention.path) && !!seen.add(mention.path));
}
