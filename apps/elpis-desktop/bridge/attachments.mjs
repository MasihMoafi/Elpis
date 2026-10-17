import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';

export const ATTACHMENT_BODY_LIMIT = 6 * 1024 * 1024;
const IMAGE_LIMIT = 4 * 1024 * 1024;
const TEXT_LIMIT = 128 * 1024;
export class AttachmentError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new AttachmentError('Invalid attachment fields');
}
function name(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) throw new AttachmentError('Invalid attachment name');
  return value;
}
function dataBytes(value, mime, limit) {
  const prefix = `data:${mime};base64,`;
  if (typeof value !== 'string' || !value.startsWith(prefix)) throw new AttachmentError('Attachment encoding does not match its type');
  const encoded = value.slice(prefix.length);
  if (!encoded || encoded.length > Math.ceil(limit / 3) * 4 || encoded.length % 4 || /[^A-Za-z0-9+/=]/.test(encoded)) throw new AttachmentError('Attachment is invalid or too large');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > limit || bytes.toString('base64') !== encoded) throw new AttachmentError('Attachment is invalid or too large');
  return bytes;
}
export function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}
/** The @-mentions of a message as native `mention` input items (name and path), validated as a batch. They are
 * references recorded with the message, never content: a message of mentions alone is empty. */
function mentionInput(mentions) {
  if (mentions === undefined) return [];
  if (!Array.isArray(mentions) || mentions.length > 10) throw new AttachmentError('Invalid mentions: at most ten per message');
  return mentions.map(mention => {
    if (!mention || typeof mention !== 'object' || Array.isArray(mention) || Object.keys(mention).some(key => !['name', 'path'].includes(key))) throw new AttachmentError('Invalid mention fields');
    if (typeof mention.name !== 'string' || !mention.name.trim() || mention.name.length > 200 || /[\x00-\x1f\x7f]/.test(mention.name)) throw new AttachmentError('Invalid mention name');
    if (typeof mention.path !== 'string' || !mention.path.trim() || mention.path.length > 4096 || /[\x00-\x1f\x7f]/.test(mention.path)) throw new AttachmentError('Invalid mention path');
    return { type: 'mention', name: mention.name, path: mention.path };
  });
}
/** Construct native input only after validating the entire attachment batch. */
export function attachmentInput(message, attachments = [], mentions) {
  if (message === undefined) message = '';
  if (typeof message !== 'string' || message.length > 32000) throw new AttachmentError('Invalid message');
  if (!Array.isArray(attachments) || attachments.length > 3) throw new AttachmentError('Attach at most three files');
  const input = message.trim() ? [{ type: 'text', text: message, text_elements: [] }] : [];
  const referenced = mentionInput(mentions);
  input.push(...referenced);
  const ids = new Set(); let imageSize = 0, textSize = 0;
  for (const file of attachments) {
    fields(file, ['id', 'name', 'type', 'mimeType', ...(file?.type === 'image' ? ['dataUrl'] : ['text'])]);
    if (typeof file.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(file.id) || ids.has(file.id)) throw new AttachmentError('Invalid or duplicate attachment ID');
    ids.add(file.id); name(file.name);
    if (file.type === 'image') {
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.mimeType)) throw new AttachmentError('Use a PNG, JPEG, WebP or GIF image');
      const bytes = dataBytes(file.dataUrl, file.mimeType, IMAGE_LIMIT);
      imageSize += bytes.length;
      if (imageSize > IMAGE_LIMIT) throw new AttachmentError('Images must total at most 4 MiB');
      if (imageMime(bytes) !== file.mimeType) throw new AttachmentError('Image contents do not match its file type');
      input.push({ type: 'image', url: file.dataUrl });
    } else if (file.type === 'text') {
      if (file.mimeType !== 'text/plain' || typeof file.text !== 'string' || !file.text.trim() || file.text.includes('\0')) throw new AttachmentError('Text attachment is empty or invalid');
      textSize += Buffer.byteLength(file.text);
      if (textSize > TEXT_LIMIT) throw new AttachmentError('Attached text must total at most 128 KiB');
      const contents = `File: ${file.name}\n${file.text}`;
      input.push({ type: 'text', text: contents, text_elements: [{ byteRange: { start: 0, end: Buffer.byteLength(contents) }, placeholder: `Attachment: ${file.name}` }] });
    } else throw new AttachmentError('Unsupported attachment type');
  }
  if (input.length === referenced.length) throw new AttachmentError('Write a message or attach a file');
  return input;
}

/** PDF conversion is an explicit upload, never a renderer-supplied filesystem path. */
export async function extractPdf(request, { command = '/usr/bin/pdftotext', timeoutMs = 5000 } = {}) {
  fields(request, ['name', 'mimeType', 'dataUrl']); name(request.name);
  if (request.mimeType !== 'application/pdf') throw new AttachmentError('Only PDF extraction is supported');
  const bytes = dataBytes(request.dataUrl, 'application/pdf', IMAGE_LIMIT);
  if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new AttachmentError('File contents are not a PDF');
  const text = await new Promise((resolve, reject) => {
    const child = spawn(command, ['-layout', '-', '-'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = []; let size = 0, settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => { child.kill(); finish(new AttachmentError('PDF extraction timed out', 422)); }, timeoutMs);
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > TEXT_LIMIT) { child.kill(); finish(new AttachmentError('Extracted PDF exceeds 128 KiB; attach a smaller document', 413)); }
      else chunks.push(chunk);
    });
    child.on('error', () => finish(new AttachmentError('PDF text extraction is unavailable', 503)));
    child.on('close', code => {
      if (code !== 0) return finish(new AttachmentError('Could not extract PDF text; encrypted or scanned PDFs may need conversion first', 422));
      const result = Buffer.concat(chunks).toString('utf8');
      if (!result.trim()) return finish(new AttachmentError('This PDF contains no extractable text', 422));
      finish(null, result);
    });
    child.stdin.on('error', () => {}); child.stdin.end(bytes);
  });
  return { attachment: { id: randomUUID(), name: request.name, type: 'text', mimeType: 'text/plain', text } };
}

/** Only call with a path taken from an actual native user-input item. */
export async function recordedMedia(input) {
  if (!['localImage', 'localAudio'].includes(input?.type) || typeof input.path !== 'string') throw new AttachmentError('No local media recorded here', 404);
  let file;
  try {
    file = await fs.open(input.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new AttachmentError('Recorded media is unavailable or too large to preview', 413);
    const chunks = []; let size = 0;
    while (size <= 16 * 1024 * 1024) {
      const chunk = Buffer.alloc(64 * 1024), { bytesRead } = await file.read(chunk);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > 16 * 1024 * 1024) throw new AttachmentError('Recorded media is too large to preview', 413);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const bytes = Buffer.concat(chunks);
    let mimeType = imageMime(bytes);
    if (input.type === 'localAudio') {
      mimeType = bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WAVE' ? 'audio/wav'
        : bytes.subarray(0, 4).toString('ascii') === 'OggS' ? 'audio/ogg'
        : bytes.subarray(0, 3).toString('ascii') === 'ID3' || (bytes[0] === 255 && (bytes[1] & 224) === 224) ? 'audio/mpeg'
        : bytes.subarray(4, 8).toString('ascii') === 'ftyp' ? 'audio/mp4'
        : bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])) ? 'audio/webm' : null;
    }
    if (!mimeType || !mimeType.startsWith(input.type === 'localImage' ? 'image/' : 'audio/')) throw new AttachmentError('Recorded media format cannot be previewed', 415);
    return { bytes, mimeType };
  } catch (error) {
    if (error instanceof AttachmentError) throw error;
    throw new AttachmentError('Recorded media is no longer available', 404);
  } finally { await file?.close(); }
}
