export type Attachment = { id: string; name: string; type: "image"; mimeType: string; dataUrl: string } | { id: string; name: string; type: "text"; mimeType: "text/plain"; text: string };
type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
/** What the "+" menu's Images item lets the file chooser show. */
export const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";
export const ATTACHMENT_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,application/pdf,text/*,.txt,.md,.csv,.json,.yaml,.yml,.toml,.log,.xml,.html,.css,.js,.jsx,.ts,.tsx,.py,.rs,.sh,.sql";
const PREFIX = "elpis-attachments-v1:";
const IMAGE_LIMIT = 4 * 1024 * 1024, TEXT_LIMIT = 128 * 1024;
const imageTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const audioTypes = new Set(["audio/wav", "audio/x-wav", "audio/ogg", "audio/mpeg", "audio/mp3", "audio/mp4", "audio/webm"]);
function decodedSize(value: string, mimeType: string, limit = IMAGE_LIMIT): number {
  if (value.length > Math.ceil(limit / 3) * 4 + mimeType.length + 14) throw Error("The attachment is too large.");
  const prefix = `data:${mimeType};base64,`, encoded = value.startsWith(prefix) ? value.slice(prefix.length) : "";
  if (!encoded || encoded.length % 4 || /[^A-Za-z0-9+/=]/.test(encoded) || encoded.indexOf("=") !== -1 && !/={1,2}$/.test(encoded.slice(encoded.indexOf("=")))) throw Error("The attachment data is invalid.");
  return encoded.length / 4 * 3 - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
}
export function validateAttachments(value: unknown): Attachment[] {
  if (!Array.isArray(value) || value.length > 3) throw Error("Attach up to three files per message.");
  let images = 0, text = 0; const ids = new Set<string>();
  for (const part of value) {
    if (!part || typeof part !== "object" || typeof part.id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(part.id) || ids.has(part.id)) throw Error("The attachment identity is invalid.");
    ids.add(part.id);
    if (typeof part.name !== "string" || !part.name.trim() || part.name.length > 200 || /[\u0000-\u001f]/.test(part.name)) throw Error("The attachment needs a valid file name.");
    if (part.type === "image" && imageTypes.has(part.mimeType) && typeof part.dataUrl === "string") images += decodedSize(part.dataUrl, part.mimeType);
    else if (part.type === "text" && part.mimeType === "text/plain" && typeof part.text === "string" && part.text.trim() && !part.text.includes("\0")) text += new TextEncoder().encode(part.text).length;
    else throw Error("This file is not a supported image or readable text attachment.");
  }
  if (images > IMAGE_LIMIT) throw Error("Images must total 4 MB or less per message.");
  if (text > TEXT_LIMIT) throw Error("Text attachments must total 128 KB or less per message.");
  return value as Attachment[];
}
function storage(): DraftStorage { return window.elpisDesktop?.storage ?? window.sessionStorage; }
export function readAttachmentDraft(id: string, target?: DraftStorage): Attachment[] {
  const raw = (target ?? storage()).getItem(PREFIX + id);
  return raw ? validateAttachments(JSON.parse(raw)) : [];
}
export function writeAttachmentDraft(id: string, attachments: Attachment[], target?: DraftStorage): boolean {
  try {
    const store = target ?? storage();
    if (attachments.length) store.setItem(PREFIX + id, JSON.stringify(validateAttachments(attachments)));
    else store.removeItem(PREFIX + id);
    return true;
  } catch { return false; }
}
export function withoutSubmittedAttachments(current: Attachment[], submitted: Attachment[]): Attachment[] {
  const ids = new Set(submitted.map(part => part.id)); return current.filter(part => !ids.has(part.id));
}
async function fileDataUrl(file: File, mimeType = file.type): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer()); let encoded = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) encoded += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return `data:${mimeType};base64,${btoa(encoded)}`;
}
export async function attachmentFromFile(file: File, extract?: (body: { name: string; mimeType: "application/pdf"; dataUrl: string }) => Promise<{ attachment: Attachment }>): Promise<Attachment> {
  if (file.size > IMAGE_LIMIT) throw Error(`${file.name}: files must be 4 MB or less.`);
  const base = { id: crypto.randomUUID(), name: file.name };
  const inferred: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", pdf: "application/pdf" };
  const mimeType = file.type || inferred[file.name.split(".").at(-1)?.toLowerCase() ?? ""] || "";
  if (imageTypes.has(mimeType)) return validateAttachments([{ ...base, type: "image", mimeType, dataUrl: await fileDataUrl(file, mimeType) }])[0];
  if (mimeType === "application/pdf") {
    if (!extract) throw Error("PDF text extraction is unavailable.");
    const result = await extract({ name: file.name, mimeType: "application/pdf", dataUrl: await fileDataUrl(file, mimeType) });
    return validateAttachments([result.attachment])[0];
  }
  if (!file.type.startsWith("text/") && !/\.(txt|md|markdown|csv|json|ya?ml|toml|log|xml|html?|css|[cm]?jsx?|tsx?|py|rs|sh|sql)$/i.test(file.name)) throw Error(`${file.name}: choose a PNG, JPEG, WebP, GIF, PDF, or text file.`);
  if (file.size > TEXT_LIMIT) throw Error(`${file.name}: text files must be 128 KB or less.`);
  let contents: string;
  try { contents = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()); }
  catch { throw Error(`${file.name}: this file is not readable UTF-8 text.`); }
  return validateAttachments([{ ...base, type: "text", mimeType: "text/plain", text: contents }])[0];
}
export function inlineMediaUrl(value: unknown, kind: "image" | "audio"): string | null {
  if (typeof value !== "string") return null;
  const mimeType = /^data:([^;,]+);base64,/.exec(value)?.[1];
  if (!mimeType || !(kind === "image" ? imageTypes : audioTypes).has(mimeType)) return null;
  try { const limit = kind === "image" ? IMAGE_LIMIT : 16 * 1024 * 1024; return decodedSize(value, mimeType, limit) <= limit ? value : null; }
  catch { return null; }
}
