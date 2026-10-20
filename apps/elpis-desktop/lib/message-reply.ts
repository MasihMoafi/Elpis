import type { Entry } from "./api";
import type { Attachment } from "./attachments";
export type MessageReply = { reference: string; speaker: string; text: string };
export const messageDomId = (reference: string) => `message-${encodeURIComponent(reference)}`;
export function replyAttachment(entry: Entry, speaker: string, selected?: string): Attachment {
  const author = speaker.replace(/[\x00-\x1f]/g, " ").slice(0, 80) || "Elpis";
  const whole = entry.item.type === "agentMessage" ? entry.item.text || "" : (entry.item.content || []).map(part => part.type === "text" ? part.text || "" : `[${part.type} attachment]`).join("\n");
  const text = (selected ?? whole).trim();
  const quote = text.length > 24000 ? `${text.slice(0, 24000)}\n[Excerpt; open the original message for the rest.]` : text;
  return { id: `reply-${crypto.randomUUID()}`, name: `Reply to ${author}`, type: "text", mimeType: "text/plain", text: `Replying to ${author}\nMessage: ${JSON.stringify([entry.turnId, entry.item.id])}\n\n${quote}` };
}
export function readReply(part: Pick<Attachment, "name" | "type"> & { text?: string }): MessageReply | null {
  if (part.type !== "text" || !part.text) return null;
  const match = /^Replying to ([^\n]+)\nMessage: ([^\n]+)\n\n([\s\S]+)$/.exec(part.text);
  if (!match || part.name !== `Reply to ${match[1]}`) return null;
  try { const ids: unknown = JSON.parse(match[2]); if (!Array.isArray(ids) || ids.length !== 2 || ids.some(id => typeof id !== "string" || !id || id.length > 500)) return null; } catch { return null; }
  return { speaker: match[1], reference: match[2], text: match[3] };
}
