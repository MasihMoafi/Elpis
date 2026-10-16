import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAttachments, readAttachmentDraft, writeAttachmentDraft, withoutSubmittedAttachments, attachmentFromFile, inlineMediaUrl } from '../lib/attachments.ts';

const png = 'data:image/png;base64,iVBORw0KGgo=';
const image = { id: 'image-a', name: 'book.png', type: 'image', mimeType: 'image/png', dataUrl: png };
const text = { id: 'text-a', name: 'notes.md', type: 'text', mimeType: 'text/plain', text: 'متن\nNotes' };

test('attachment batch retains image and exact text, rejects excess, duplicates, binary and oversized text', () => {
  assert.deepEqual(validateAttachments([image, text]), [image, text]);
  for (const input of [[image, image], [1], [{ ...text, text: '\0binary' }], [{ ...text, text: 'a'.repeat(128 * 1024 + 1) }], [{ ...image, dataUrl: 'https://example.invalid/book.png' }], Array.from({ length: 4 }, (_, i) => ({ ...text, id: `text-${i}` }))]) assert.throws(() => validateAttachments(input));
});
test('attachment drafts round-trip independently and failed persistence is explicit', () => {
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  assert.equal(writeAttachmentDraft('a', [image, text], storage), true);
  assert.deepEqual(readAttachmentDraft('a', storage), [image, text]); assert.deepEqual(readAttachmentDraft('b', storage), []);
  assert(values.has('elpis-attachments-v1:a'));
  assert.equal(writeAttachmentDraft('a', [], storage), true); assert.deepEqual(readAttachmentDraft('a', storage), []);
  assert.equal(writeAttachmentDraft('a', [image], { setItem() { throw Error('quota'); } }), false);
});
test('acknowledgement removes only submitted attachment IDs and keeps newer additions', () => {
  assert.deepEqual(withoutSubmittedAttachments([image, text], [image]), [text]);
  assert.deepEqual(withoutSubmittedAttachments([text], [image]), [text]);
});
test('file snapshots preserve text, extract PDFs explicitly, and reject unknown binaries', async () => {
  const contents = 'first\nمتن';
  const result = await attachmentFromFile(new File([contents], 'notes.md', { type: 'text/markdown' }));
  assert.equal(result.type, 'text'); assert.equal(result.text, contents); assert.equal(result.mimeType, 'text/plain');
  const pdf = new File(['%PDF-synthetic'], 'book.pdf', { type: 'application/pdf' });
  let calls = 0;
  assert.deepEqual(await attachmentFromFile(pdf, async body => { calls++; assert.equal(body.name, 'book.pdf'); assert.match(body.dataUrl, /^data:application\/pdf;base64,/); return { attachment: text }; }), text);
  assert.equal(calls, 1);
  await assert.rejects(attachmentFromFile(new File(['binary'], 'archive.zip', { type: 'application/zip' })), /supported|text/i);
});
test('inline previews accept bounded matching data media and never remote URLs', () => {
  assert.equal(inlineMediaUrl(png, 'image'), png);
  assert.equal(inlineMediaUrl('https://example.invalid/image.png', 'image'), null);
  assert.equal(inlineMediaUrl('data:text/html;base64,PHNjcmlwdD4=', 'image'), null);
});
test('one and four MB images validate without regex recursion; over-limit input is rejected', () => {
  for (const size of [1024 * 1024, 4 * 1024 * 1024]) {
    const dataUrl = `data:image/png;base64,${Buffer.alloc(size, 1).toString('base64')}`;
    assert.equal(validateAttachments([{ ...image, dataUrl }])[0].dataUrl, dataUrl);
    assert.equal(inlineMediaUrl(dataUrl, 'image'), dataUrl);
  }
  const dataUrl = `data:image/png;base64,${Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64')}`;
  assert.throws(() => validateAttachments([{ ...image, dataUrl }]), /large|4 MB/);
});
test('known image and PDF extensions with empty browser MIME use a bounded inferred MIME', async () => {
  const result = await attachmentFromFile(new File([new Uint8Array([137,80,78,71,13,10,26,10])], 'cover.PNG'));
  assert.equal(result.type, 'image'); assert.equal(result.mimeType, 'image/png'); assert.match(result.dataUrl, /^data:image\/png;base64,/);
  let mime;
  await attachmentFromFile(new File(['%PDF-fixture'], 'book.pdf'), async body => { mime = body.mimeType; return { attachment: text }; });
  assert.equal(mime, 'application/pdf');
});
