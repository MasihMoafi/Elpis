type ReplacementEntry = { turnId: string; item: unknown };
type InputPart = Record<string, unknown>;
/** `prompt` is the typed text of the turn's first message; `kept` is everything else it carried (files, images,
 * quoted replies, mentions), resent unchanged after the edited text. `messageId` is the message that offers Edit. */
type ReplacementEligibility = { allowed: true; prompt: string; kept: InputPart[]; messageId: string } | { allowed: false; reason: string };

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const elementsOf = (part: InputPart) => [part.textElements, part.text_elements].filter(elements => elements !== undefined);

/** As in ChatGPT, any earlier turn can be replaced: its first message's text is edited and its attachments are kept.
 * Follow-ups delivered into the turn go with it; the edit keeps the earlier version, so nothing is lost. */
export function replacementEligibility(entries: readonly ReplacementEntry[], turnId: string, { historyComplete }: { historyComplete: boolean }): ReplacementEligibility {
  if (!historyComplete) return { allowed: false, reason: "Load all earlier messages before editing or regenerating this turn." };
  const items = entries.filter(entry => entry.turnId === turnId).map(entry => entry.item);
  if (!items.length || items.some(item => !record(item) || typeof item.type !== "string")) return { allowed: false, reason: "The complete input for this turn is unavailable, so it cannot be replaced here." };
  const first = items.find((item): item is Record<string, unknown> => record(item) && item.type === "userMessage");
  if (!first) return { allowed: false, reason: "The original user message is unavailable, so this turn cannot be replaced here." };
  const content = first.content;
  if (!Array.isArray(content) || !content.length || !content.every(part => record(part) && typeof part.type === "string")) return { allowed: false, reason: "The original user input is unavailable, so this turn cannot be replaced here." };
  const parts = content as InputPart[];
  if (parts.some(part => part.type === "text" && (typeof part.text !== "string" || elementsOf(part).some(elements => !Array.isArray(elements))))) return { allowed: false, reason: "The original user input is unreadable, so this turn cannot be replaced here." };
  const typed = (part: InputPart) => part.type === "text" && elementsOf(part).every(elements => (elements as unknown[]).length === 0);
  const prompt = parts.filter(typed).map(part => part.text as string).join("\n"), kept = parts.filter(part => !typed(part));
  if (!prompt.trim() && !kept.length) return { allowed: false, reason: "This message has no text to replace." };
  return { allowed: true, prompt, kept, messageId: typeof first.id === "string" ? first.id : "" };
}

/** Edit sits on the turn's first message; a follow-up delivered into the turn says where to edit instead. */
export function editableMessage(option: ReplacementEligibility | undefined, messageId: unknown): boolean {
  return !!option?.allowed && option.messageId === messageId;
}
export function editBlocked(option: ReplacementEligibility | undefined, messageId: unknown): string | undefined {
  if (!option) return undefined;
  if (!option.allowed) return option.reason;
  return option.messageId === messageId ? undefined : "This follow-up went into the turn above it. Edit that turn's first message to replace both.";
}

/** One edited message's place among its versions (bridge/message-versions.mjs); `previous`/`next` are their chats. */
export type MessageVersion = { turnId: string; index: number; count: number; previous?: string; next?: string };
export type VersionControl = { index: number; count: number; onPrevious?: () => void; onNext?: () => void };
export function versionControl(versions: readonly MessageVersion[] | undefined, turnId: string, option: ReplacementEligibility | undefined, messageId: unknown, enabled: boolean, show: (threadId: string) => void): VersionControl | undefined {
  const version = versions?.find(candidate => candidate.turnId === turnId);
  if (!version || version.count < 2 || (option?.allowed && option.messageId !== messageId)) return undefined;
  const { previous, next } = version;
  return { index: version.index, count: version.count, ...(enabled && previous ? { onPrevious: () => show(previous) } : {}), ...(enabled && next ? { onNext: () => show(next) } : {}) };
}
