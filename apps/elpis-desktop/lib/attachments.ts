export type Attachment = { id: string; name: string; type: "image"; mimeType: string; dataUrl: string } | { id: string; name: string; type: "text"; mimeType: "text/plain"; text: string };
type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
/** What the one "Add files or photos" chooser shows: pictures, PDFs and text. */
export const ATTACHMENT_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,application/pdf,text/*,.txt,.md,.csv,.json,.yaml,.yml,.toml,.log,.xml,.html,.css,.js,.jsx,.ts,.tsx,.py,.rs,.sh,.sql";
const PREFIX = "elpis-attachments-v1:";
const MiB = 1024 * 1024;
/** What one message carries, the same numbers as bridge/attachments.mjs (a test compares them).
 * count: Claude's own cap of files in a message (its chat takes 20 and its local sessions 20 pictures).
 * fileBytes: Claude's file limit, 30 MB: the largest file read, a picture before it is shrunk or a PDF before its text is taken.
 * imageBytes: all the pictures of a message; the chat's history carries them back inline through an 8 MiB socket.
 * textChars: the engine's MAX_USER_INPUT_TEXT_CHARS, which the message's own words share. */
export const ATTACHMENT_LIMITS = { count: 20, fileBytes: 30 * MiB, imageBytes: 4 * MiB, textChars: 1 << 20 };
const IMAGE_LIMIT = ATTACHMENT_LIMITS.imageBytes;
/** As Claude shrinks a picture before it goes: past this many bytes, or past the engine's own 2048 px, it becomes a JPEG. */
const SHRINK_ABOVE = 3.5 * MiB, MAX_SIDE = 2048, JPEG_QUALITY = 0.85;
const imageTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const audioTypes = new Set(["audio/wav", "audio/x-wav", "audio/ogg", "audio/mpeg", "audio/mp3", "audio/mp4", "audio/webm"]);
function decodedSize(value: string, mimeType: string, limit = IMAGE_LIMIT): number {
  if (value.length > Math.ceil(limit / 3) * 4 + mimeType.length + 14) throw Error("The attachment is too large.");
  const prefix = `data:${mimeType};base64,`, encoded = value.startsWith(prefix) ? value.slice(prefix.length) : "";
  if (!encoded || encoded.length % 4 || /[^A-Za-z0-9+/=]/.test(encoded) || encoded.indexOf("=") !== -1 && !/={1,2}$/.test(encoded.slice(encoded.indexOf("=")))) throw Error("The attachment data is invalid.");
  return encoded.length / 4 * 3 - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
}
const megabytes = (bytes: number) => Number((bytes / MiB).toFixed(1));
const quoted = (name: string) => `\u201c${name}\u201d`;
/** Characters as the engine counts them (Unicode scalar values), not UTF-16 units or bytes. */
function characters(value: string): number { let count = 0; for (const _ of value) count++; return count; }
const tooMany = () => `Up to ${ATTACHMENT_LIMITS.count} files fit in one message.`;
const imagesPast = () => `${megabytes(IMAGE_LIMIT)} MB for one message`;
const textPast = () => `${ATTACHMENT_LIMITS.textChars.toLocaleString("en-US")} characters for one message`;
export function validateAttachments(value: unknown): Attachment[] {
  if (!Array.isArray(value) || value.length > ATTACHMENT_LIMITS.count) throw Error(tooMany());
  let images = 0, text = 0; const ids = new Set<string>();
  for (const part of value) {
    if (!part || typeof part !== "object" || typeof part.id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(part.id) || ids.has(part.id)) throw Error("The attachment identity is invalid.");
    ids.add(part.id);
    if (typeof part.name !== "string" || !part.name.trim() || part.name.length > 200 || /[\u0000-\u001f]/.test(part.name)) throw Error("The attachment needs a valid file name.");
    if (part.type === "image" && imageTypes.has(part.mimeType) && typeof part.dataUrl === "string") images += decodedSize(part.dataUrl, part.mimeType);
    else if (part.type === "text" && part.mimeType === "text/plain" && typeof part.text === "string" && part.text.trim() && !part.text.includes("\0")) text += characters(part.text);
    else throw Error("This file is not a supported image or readable text attachment.");
  }
  if (images > IMAGE_LIMIT) throw Error(`Pictures can total ${imagesPast()} at most.`);
  if (text > ATTACHMENT_LIMITS.textChars) throw Error(`Text can total ${textPast()} at most.`);
  return value as Attachment[];
}
/** Adds files to a message's list as far as they fit, and says for each that did not why, by name:
 * the one place the count and the totals are applied, whichever way the files came (chooser, paste, drop, the browser pane). */
export function fitAttachments(current: Attachment[], added: Attachment[]): { kept: Attachment[]; problems: string[] } {
  const kept = [...current], problems: string[] = [], left: string[] = [];
  let images = 0, text = 0;
  for (const part of current) { if (part.type === "image") images += decodedSize(part.dataUrl, part.mimeType); else text += characters(part.text); }
  for (const part of added) {
    if (kept.length >= ATTACHMENT_LIMITS.count) { left.push(part.name); continue; }
    if (part.type === "image") {
      const size = decodedSize(part.dataUrl, part.mimeType);
      if (images + size > IMAGE_LIMIT) { problems.push(`${quoted(part.name)} would take the pictures past ${imagesPast()}. Remove a picture or send this one in another message.`); continue; }
      images += size;
    } else {
      const size = characters(part.text);
      if (text + size > ATTACHMENT_LIMITS.textChars) { problems.push(`${quoted(part.name)} would take the text past ${textPast()}. Remove a file or send this one in another message.`); continue; }
      text += size;
    }
    kept.push(part);
  }
  if (left.length) problems.unshift(`${tooMany()} Not added: ${left.join(", ")}.`);
  return { kept: validateAttachments(kept), problems };
}
/** The files of a paste or a drop: its files, or, when it lists none, those among its items. */
export function transferFiles(transfer: { files?: ArrayLike<File>; items?: ArrayLike<{ kind: string; getAsFile(): File | null }> } | null | undefined): File[] {
  if (!transfer) return [];
  const files = Array.from(transfer.files ?? []);
  if (files.length) return files;
  return Array.from(transfer.items ?? []).flatMap(item => item.kind === "file" ? [item.getAsFile()].filter((file): file is File => !!file) : []);
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
async function fileDataUrl(file: Blob, mimeType = file.type): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer()); let encoded = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) encoded += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return `data:${mimeType};base64,${btoa(encoded)}`;
}
/** A picture past 3.5 MB or 2048 px becomes a JPEG of at most 2048 px (as Claude shrinks pictures; the engine would cut the size to 2048 anyway). */
async function shrunk(file: File, mimeType: string): Promise<{ blob: Blob; mimeType: string }> {
  const as = { blob: file, mimeType };
  if (typeof document === "undefined" || typeof createImageBitmap === "undefined") return as;
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); } catch { return as; }
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= SHRINK_ABOVE) return as;
    const canvas = document.createElement("canvas"), context = canvas.getContext("2d");
    if (!context) return as;
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height); context.imageSmoothingQuality = "high"; context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
    return blob && (scale < 1 || blob.size < file.size) ? { blob, mimeType: "image/jpeg" } : as;
  } finally { bitmap.close(); }
}
export async function attachmentFromFile(file: File, extract?: (body: { name: string; mimeType: "application/pdf"; dataUrl: string }) => Promise<{ attachment: Attachment }>): Promise<Attachment> {
  if (file.size > ATTACHMENT_LIMITS.fileBytes) throw Error(`${quoted(file.name)} is too large: it is ${megabytes(file.size)} MB and a file can be up to ${megabytes(ATTACHMENT_LIMITS.fileBytes)} MB.`);
  const base = { id: crypto.randomUUID(), name: file.name };
  const inferred: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", pdf: "application/pdf" };
  const mimeType = file.type || inferred[file.name.split(".").at(-1)?.toLowerCase() ?? ""] || "";
  if (imageTypes.has(mimeType)) {
    const picture = await shrunk(file, mimeType);
    if (picture.blob.size > IMAGE_LIMIT) throw Error(`${quoted(file.name)} is too large to send: ${megabytes(picture.blob.size)} MB, and the pictures of a message can total ${imagesPast()}.`);
    return validateAttachments([{ ...base, type: "image", mimeType: picture.mimeType, dataUrl: await fileDataUrl(picture.blob, picture.mimeType) }])[0];
  }
  if (mimeType === "application/pdf") {
    if (!extract) throw Error("PDF text extraction is unavailable.");
    const result = await extract({ name: file.name, mimeType: "application/pdf", dataUrl: await fileDataUrl(file, mimeType) });
    return validateAttachments([result.attachment])[0];
  }
  if (!file.type.startsWith("text/") && !/\.(txt|md|markdown|csv|json|ya?ml|toml|log|xml|html?|css|[cm]?jsx?|tsx?|py|rs|sh|sql)$/i.test(file.name)) throw Error(`${quoted(file.name)} can\u2019t be attached. Choose a PNG, JPEG, WebP, GIF, PDF, or text file.`);
  const wordy = () => Error(`${quoted(file.name)} has more text than a message takes: up to ${ATTACHMENT_LIMITS.textChars.toLocaleString("en-US")} characters, with its own words.`);
  if (file.size > ATTACHMENT_LIMITS.textChars * 4) throw wordy();
  let contents: string;
  try { contents = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()); }
  catch { throw Error(`${quoted(file.name)}: this file is not readable UTF-8 text.`); }
  if (characters(contents) > ATTACHMENT_LIMITS.textChars) throw wordy();
  return validateAttachments([{ ...base, type: "text", mimeType: "text/plain", text: contents }])[0];
}
/** Files from a chooser, a paste or a drop, read one by one for adding to a message's list: those that fit come back in
 * `added`; each that does not fit or cannot be read is left out and named in `problems`. */
export async function attachFiles(current: Attachment[], files: File[], extract?: Parameters<typeof attachmentFromFile>[1]): Promise<{ added: Attachment[]; problems: string[] }> {
  let kept = current; const added: Attachment[] = [], problems: string[] = [], left: string[] = [];
  for (const file of files) {
    if (kept.length >= ATTACHMENT_LIMITS.count) { left.push(file.name); continue; }
    try { const fit = fitAttachments(kept, [await attachmentFromFile(file, extract)]); added.push(...fit.kept.slice(kept.length)); kept = fit.kept; problems.push(...fit.problems); }
    catch (cause) { problems.push(cause instanceof Error ? cause.message : String(cause)); }
  }
  if (left.length) problems.unshift(`${tooMany()} Not added: ${left.join(", ")}.`);
  return { added, problems };
}
/** Said under the box while a picture waits for a model that reads text only. */
export const TEXT_ONLY_NOTICE = "This model accepts text only. Choose an image-capable model or remove the images.";
export function inlineMediaUrl(value: unknown, kind: "image" | "audio"): string | null {
  if (typeof value !== "string") return null;
  const mimeType = /^data:([^;,]+);base64,/.exec(value)?.[1];
  if (!mimeType || !(kind === "image" ? imageTypes : audioTypes).has(mimeType)) return null;
  try { const limit = kind === "image" ? IMAGE_LIMIT : 16 * 1024 * 1024; return decodedSize(value, mimeType, limit) <= limit ? value : null; }
  catch { return null; }
}
