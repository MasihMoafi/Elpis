import type { Entry } from "./api";
import type { Attachment } from "./attachments";
export type MessageReply = { reference: string; speaker: string; text: string; image?: { name: string } };
export const messageDomId = (reference: string) => `message-${encodeURIComponent(reference)}`;
export function replyAttachment(entry: Entry, speaker: string, selected?: string, imageName?: string): Attachment {
  const author = speaker.replace(/[\x00-\x1f]/g, " ").slice(0, 80) || "Elpis";
  const whole = entry.item.type === "agentMessage" ? entry.item.text || "" : (entry.item.content || []).map(part => part.type === "text" ? part.text || "" : `[${part.type} attachment]`).join("\n");
  const text = (selected ?? whole).trim();
  const quote = text.length > 24000 ? `${text.slice(0, 24000)}\n[Excerpt; open the original message for the rest.]` : text;
  return { id: `reply-${crypto.randomUUID()}`, name: `Reply to ${author}`, type: "text", mimeType: "text/plain", text: `Replying to ${author}\nMessage: ${JSON.stringify([entry.turnId, entry.item.id])}\n\n${imageName ? `Image: ${JSON.stringify(imageName)}` : quote}` };
}
/** The reply owns its picture; replacing it must preserve the user's other files. */
export function withoutReplyAttachments(parts: Attachment[]): Attachment[] {
  const replies = new Set(parts.filter(part => readReply(part)).map(part => part.id));
  return parts.filter(part => !replies.has(part.id) && ![...replies].some(id => part.id === `reply-image-${id}`));
}
export function readReply(part: Pick<Attachment, "name" | "type"> & { text?: string }): MessageReply | null {
  if (part.type !== "text" || !part.text) return null;
  const match = /^Replying to ([^\n]+)\nMessage: ([^\n]+)\n\n([\s\S]+)$/.exec(part.text);
  if (!match || part.name !== `Reply to ${match[1]}`) return null;
  try { const ids: unknown = JSON.parse(match[2]); if (!Array.isArray(ids) || ids.length !== 2 || ids.some(id => typeof id !== "string" || !id || id.length > 500)) return null; } catch { return null; }
  if (match[3].startsWith('Image: "')) {
    try {
      const name: unknown = JSON.parse(match[3].slice(7));
      if (typeof name === "string" && name && name.length <= 500) return { speaker: match[1], reference: match[2], text: name, image: { name } };
    } catch { /* A plain text quote may itself start with Image:. */ }
  }
  return { speaker: match[1], reference: match[2], text: match[3] };
}
