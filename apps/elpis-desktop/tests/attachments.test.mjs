import test from 'node:test';
import assert from 'node:assert/strict';
import * as lib from '../lib/attachments.ts';
import * as bridge from '../bridge/attachments.mjs';
const { validateAttachments, readAttachmentDraft, writeAttachmentDraft, attachmentFromFile, inlineMediaUrl } = lib;

const png = 'data:image/png;base64,iVBORw0KGgo=';
const image = { id: 'image-a', name: 'book.png', type: 'image', mimeType: 'image/png', dataUrl: png };
const text = { id: 'text-a', name: 'notes.md', type: 'text', mimeType: 'text/plain', text: 'متن\nNotes' };

test('attachment batch retains image and exact text, rejects excess, duplicates, binary and oversized text', () => {
  assert.deepEqual(validateAttachments([image, text]), [image, text]);
  for (const input of [[image, image], [1], [{ ...text, text: '\0binary' }], [{ ...text, text: 'a'.repeat((1 << 20) + 1) }], [{ ...image, dataUrl: 'https://example.invalid/book.png' }], Array.from({ length: 21 }, (_, i) => ({ ...text, id: `text-${i}` }))]) assert.throws(() => validateAttachments(input));
});
test('attachment drafts round-trip independently and failed persistence is explicit', () => {
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  assert.equal(writeAttachmentDraft('a', [image, text], storage), true);
  assert.deepEqual(readAttachmentDraft('a', storage), [image, text]); assert.deepEqual(readAttachmentDraft('b', storage), []);
  assert(values.has('elpis-attachments-v1:a'));
  assert.equal(writeAttachmentDraft('a', [], storage), true); assert.deepEqual(readAttachmentDraft('a', storage), []);
  assert.equal(writeAttachmentDraft('a', [image], { setItem() { throw Error('quota'); } }), false);
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

const note = (id, body, name = `${id}.txt`) => ({ id, name, type: 'text', mimeType: 'text/plain', text: body });
const picture = (id, bytes, name = `${id}.png`) => ({ id, name, type: 'image', mimeType: 'image/png', dataUrl: `data:image/png;base64,${Buffer.alloc(bytes, 1).toString('base64')}` });
const MiB = 1024 * 1024;

test('five files with two images validate as one list; twenty do; twenty-one do not and the error says twenty', () => {
  const five = [image, note('a', 'one'), { ...image, id: 'image-b', name: 'two.png' }, note('c', 'three'), note('d', 'four')];
  assert.deepEqual(validateAttachments(five), five);
  const many = n => Array.from({ length: n }, (_, i) => i % 3 ? note(`n${i}`, `file ${i}`) : { ...image, id: `i${i}`, name: `p${i}.png` });
  assert.equal(validateAttachments(many(20)).length, 20);
  assert.throws(() => validateAttachments(many(21)), /20 files/);
});
test('text is limited by characters as the engine counts them, so Persian and emoji files are not cut early', () => {
  const persian = 'ب'.repeat(700_000);
  assert.equal(new TextEncoder().encode(persian).length, 1_400_000);
  assert.equal(validateAttachments([note('fa', persian)])[0].text.length, 700_000);
  assert.equal(validateAttachments([note('faces', '\u{1F600}'.repeat(600_000))]).length, 1);
  assert.throws(() => validateAttachments([note('a', 'a'.repeat(600_000)), note('b', 'b'.repeat(600_000))]), /1,048,576|characters/);
});
test('fitAttachments keeps what fits and names each file it leaves out, and why', () => {
  const current = Array.from({ length: 19 }, (_, i) => note(`c${i}`, `c${i}`));
  const { kept, problems } = lib.fitAttachments(current, [note('x', 'x', 'x.txt'), note('y', 'y', 'y.txt'), note('z', 'z', 'z.txt')]);
  assert.deepEqual(kept.map(part => part.id).slice(19), ['x']);
  assert.equal(problems.length, 1); assert.match(problems[0], /20 files/); assert.match(problems[0], /y\.txt/); assert.match(problems[0], /z\.txt/); assert.doesNotMatch(problems[0], /x\.txt/);
  const images = lib.fitAttachments([picture('one', 3 * MiB, 'one.png')], [picture('two', 2 * MiB, 'two.png'), note('t', 'fits', 't.txt')]);
  assert.deepEqual(images.kept.map(part => part.id), ['one', 't']);
  assert.equal(images.problems.length, 1); assert.match(images.problems[0], /two\.png/); assert.match(images.problems[0], /4 MB/); assert.doesNotMatch(images.problems[0], /one\.png/);
  const tooMuchText = lib.fitAttachments([note('a', 'a'.repeat(1_000_000), 'a.txt')], [note('b', 'b'.repeat(100_000), 'b.txt')]);
  assert.deepEqual(tooMuchText.kept.map(part => part.id), ['a']); assert.match(tooMuchText.problems[0], /b\.txt/);
});
test('a file over 30 MB is refused by name before it is read; a text file is measured in characters once decoded', async () => {
  const huge = new File([new Uint8Array(30 * MiB + 1)], 'huge.png', { type: 'image/png' });
  await assert.rejects(attachmentFromFile(huge), error => /huge\.png/.test(error.message) && /30 MB/.test(error.message));
  const persian = new File(['ب'.repeat(700_000)], 'persian.txt', { type: 'text/plain' });
  assert.equal((await attachmentFromFile(persian)).text.length, 700_000);
  const wordy = new File(['w'.repeat((1 << 20) + 1)], 'wordy.txt', { type: 'text/plain' });
  await assert.rejects(attachmentFromFile(wordy), error => /wordy\.txt/.test(error.message) && /1,048,576/.test(error.message));
});
test('the renderer and the bridge hold the same limits', () => {
  assert.deepEqual(lib.ATTACHMENT_LIMITS, bridge.ATTACHMENT_LIMITS);
  assert.deepEqual(lib.ATTACHMENT_LIMITS, { count: 20, fileBytes: 30 * MiB, imageBytes: 4 * MiB, textChars: 1 << 20 });
});
test('one list of files for every way in: a pasted or dropped transfer yields its files, from items when files is empty', () => {
  const file = new File(['x'], 'a.txt');
  assert.deepEqual(lib.transferFiles({ files: [file], items: [] }), [file]);
  assert.deepEqual(lib.transferFiles({ files: [], items: [{ kind: 'file', getAsFile: () => file }, { kind: 'string', getAsFile: () => null }] }), [file]);
  assert.deepEqual(lib.transferFiles(null), []);
});

test('attachFiles adds each file that fits, names each that does not, and reads no file past the twentieth', async () => {
  const files = Array.from({ length: 22 }, (_, i) => new File([`body ${i}`], `file-${i}.txt`, { type: 'text/plain' }));
  const { added, problems } = await lib.attachFiles([], files);
  assert.equal(added.length, 20); assert.deepEqual(added.map(part => part.name), files.slice(0, 20).map(file => file.name));
  assert.equal(problems.length, 1); assert.match(problems[0], /20 files/); assert.match(problems[0], /file-20\.txt, file-21\.txt/);
  const huge = new File([new Uint8Array(30 * MiB + 1)], 'huge.bin', { type: 'application/octet-stream' });
  const mixed = await lib.attachFiles([], [new File(['a'], 'a.txt', { type: 'text/plain' }), huge, new File(['zip'], 'x.zip', { type: 'application/zip' }), new File(['b'], 'b.md', { type: 'text/markdown' })]);
  assert.deepEqual(mixed.added.map(part => part.name), ['a.txt', 'b.md']);
  assert.equal(mixed.problems.length, 2); assert.match(mixed.problems[0], /huge\.bin/); assert.match(mixed.problems[0], /30 MB/); assert.match(mixed.problems[1], /x\.zip/);
});
