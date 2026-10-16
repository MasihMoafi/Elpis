type ReplacementEntry = { turnId: string; item: unknown };
type ReplacementEligibility = { allowed: true; prompt: string } | { allowed: false; reason: string };

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Text-only replacement is safe only when it accounts for every user input in the turn. */
export function replacementEligibility(entries: readonly ReplacementEntry[], turnId: string, { historyComplete }: { historyComplete: boolean }): ReplacementEligibility {
  if (!historyComplete) return { allowed: false, reason: "Load all earlier messages before editing or regenerating this turn." };
  const items = entries.filter(entry => entry.turnId === turnId).map(entry => entry.item);
  if (!items.length || items.some(item => !record(item) || typeof item.type !== "string")) return { allowed: false, reason: "The complete input for this turn is unavailable, so it cannot be replaced here." };
  const users = items.filter((item): item is Record<string, unknown> => record(item) && item.type === "userMessage");
  if (users.length !== 1) return { allowed: false, reason: users.length > 1 ? "This turn includes delivered follow-ups. Replacing one message here would remove the other instructions." : "The original user message is unavailable, so this turn cannot be replaced here." };
  const content = users[0].content;
  if (!Array.isArray(content) || !content.length) return { allowed: false, reason: "The original user input is unavailable, so this turn cannot be replaced here." };
  const plainText = content.every(part => record(part) && part.type === "text" && typeof part.text === "string"
    && Object.keys(part).every(key => ["type", "text", "textElements", "text_elements"].includes(key))
    && [part.textElements, part.text_elements].every(elements => elements === undefined || (Array.isArray(elements) && elements.length === 0)));
  if (!plainText) return { allowed: false, reason: "This message contains attachments or special input that this app cannot safely resend." };
  const prompt = content.map(part => part.text as string).join("\n");
  return prompt.trim() ? { allowed: true, prompt } : { allowed: false, reason: "This message has no text to replace." };
}
