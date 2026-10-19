// Files in the composer as Claude's desktop app has them (read from its source): no cap of three; one "Add files or
// photos" for everything, a picture being a file; one chip, with a thumbnail when the file is a picture; one notice
// that names the file that did not fit; paste and drop going the way the chooser goes. Real clicks, a real file
// chooser, synthetic paste and drop events (never the system clipboard). Local bridge fixture; no engine or model.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./parity-fixture.cjs');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4o6SEFTEMLQkAvM5EAT6yk8sAAAAASUVORK5CYII=', 'base64');
const MiB = 1024 * 1024;
const routes = { '/api/attachments/extract': body => ({ attachment: { id: `pdf-${body.name.replace(/\W/g, '')}`, name: body.name, type: 'text', mimeType: 'text/plain', text: `Text of ${body.name}` } }) };
const shots = process.env.ELPIS_COMPOSER_SHOTS;

async function using(options, run) {
  const f = await fixture({ routes, ...options });
  try { await f.open('chat-a'); await run(f); assert.deepEqual(f.errors, []); } finally { await f.close(); }
}
const list = page => page.getByRole('list', { name: 'Message attachments', exact: true });
const chips = page => list(page).locator('[data-slot="attachment-chip"]');
const alerts = page => page.locator('.composer [role="alert"]');
const turns = f => f.posts.filter(post => /\/threads\/chat-a\/(turns|steer)$/.test(post.path));
const plus = page => page.getByRole('button', { name: 'Add files and more', exact: true });
/** Through the + menu and its one item, the way a person does. */
async function chooseFiles(page, files) {
  await plus(page).click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('menuitem', { name: /^Add files or photos/ }).click()]);
  await chooser.setFiles(files); return chooser;
}
const text = (name, body = `contents of ${name}`) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(body) });
const picture = (name, buffer = PNG) => ({ name, mimeType: 'image/png', buffer });
const mixed = () => [text('notes.md'), picture('first.png'), text('todo.txt'), picture('second.png'), { name: 'brief.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 synthetic') }];
/** A paste or a drop of these files, built inside the page. */
async function transfer(page, kind, specs) {
  return page.evaluate(async ({ kind, specs }) => {
    const box = document.querySelector('textarea[aria-label="Message Elpis"]'), data = new DataTransfer();
    for (const spec of specs) {
      if (spec.image) {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32;
        const context = canvas.getContext('2d'); context.fillStyle = '#7450d7'; context.fillRect(0, 0, 32, 32);
        data.items.add(new File([await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))], spec.name, { type: 'image/png' }));
      } else data.items.add(new File([spec.text ?? `contents of ${spec.name}`], spec.name, { type: spec.type ?? 'text/plain' }));
    }
    let overPrevented = false;
    if (kind === 'drop') { const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }); box.closest('.composer').dispatchEvent(over); overPrevented = over.defaultPrevented; }
    const event = kind === 'paste' ? new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }) : new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data });
    (kind === 'paste' ? box : box.closest('.composer')).dispatchEvent(event);
    return { prevented: event.defaultPrevented, overPrevented };
  }, { kind, specs });
}
const fiveSpecs = [{ name: 'notes.md' }, { image: true, name: 'first.png' }, { name: 'todo.txt' }, { image: true, name: 'second.png' }, { name: 'brief.pdf', type: 'application/pdf', text: '%PDF-1.4 synthetic' }];

test('the + menu has one item for files and photos, no separate Images, and its one chooser takes pictures and documents', () => using({}, async f => {
  const { page } = f;
  await plus(page).click(); await page.getByRole('menuitem').first().waitFor();
  const names = (await page.getByRole('menuitem').allInnerTexts()).map(item => item.split('\n')[0].trim());
  assert.deepEqual(names, ['Add files or photos', 'Mention', 'Slash commands', 'Plan mode', 'Run as a shell command']);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('menuitem', { name: /^Add files or photos/ }).click()]);
  const accept = await chooser.element().getAttribute('accept');
  for (const kind of ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf', '.md']) assert.match(accept, new RegExp(kind.replace('.', '\\.')));
  assert.equal(await chooser.isMultiple(), true);
  assert.doesNotMatch(await page.locator('.hud-menu').innerText().catch(() => ''), /up to (3|three)/i);
}));

test('five files, two of them pictures, attach as five chips of one kind and send as five', () => using({}, async f => {
  const { page } = f;
  await chooseFiles(page, mixed());
  await chips(page).nth(4).waitFor();
  assert.equal(await chips(page).count(), 5); assert.equal(await alerts(page).count(), 0);
  const looks = await chips(page).evaluateAll(nodes => nodes.map(node => {
    const box = node.getBoundingClientRect(), thumb = node.querySelectorAll('[data-slot="attachment-thumb"]'), art = thumb[0]?.getBoundingClientRect();
    return { height: Math.round(box.height), thumbs: thumb.length, thumb: art && [Math.round(art.width), Math.round(art.height)], picture: !!thumb[0]?.querySelector('img'), caption: node.querySelector('[data-slot="attachment-kind"]')?.textContent, name: node.querySelector('[data-slot="attachment-name"]')?.textContent, label: node.textContent };
  }));
  assert.deepEqual(looks.map(look => look.name), ['notes.md', 'first.png', 'todo.txt', 'second.png', 'brief.pdf']);
  assert.deepEqual(looks.map(look => look.picture), [false, true, false, true, false], 'a thumbnail for the pictures only');
  assert.ok(looks.every(look => look.thumbs === 1), 'every chip has its one leading picture or icon');
  assert.equal(new Set(looks.map(look => look.height)).size, 1, 'one chip height');
  assert.equal(new Set(looks.map(look => look.thumb.join('x'))).size, 1, 'one thumbnail size, picture or icon');
  assert.deepEqual(looks.map(look => look.caption), ['Document · MD', 'Image · PNG', 'Document · TXT', 'Image · PNG', 'Document · PDF']);
  assert.ok(looks.every(look => !/Text snapshot/.test(look.label)), 'no separate wording for text files');
  const thumb = await list(page).getByRole('img', { name: 'first.png', exact: true }).getAttribute('src');
  assert.equal(thumb, `data:image/png;base64,${PNG.toString('base64')}`, 'a small picture goes as it was');
  await f.composer.fill('read these'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.composer [aria-label="Message attachments"]') === null);
  const submitted = page.locator('.chat-content .message.user').last();
  await submitted.getByRole('list', { name: 'Message attachments', exact: true }).waitFor();
  assert.deepEqual(await submitted.locator('summary').allTextContents(), ['notes.md', 'todo.txt', 'brief.pdf'], 'submitted documents keep their names and folded previews');
  assert.equal(await submitted.evaluate(node => [...node.childNodes].filter(child => child.nodeType === Node.TEXT_NODE).map(child => child.textContent).join('')), 'read these', 'file bodies do not spill into the message text');
  const [sent] = turns(f); assert.equal(sent.body.attachments.length, 5);
  assert.deepEqual(sent.body.attachments.map(part => [part.name, part.type]), [['notes.md', 'text'], ['first.png', 'image'], ['todo.txt', 'text'], ['second.png', 'image'], ['brief.pdf', 'text']]);
}));

test('dropping five files, two of them pictures, on the composer attaches all five and cancels the browser\'s own drop', () => using({}, async f => {
  const { page } = f;
  const result = await transfer(page, 'drop', fiveSpecs);
  assert.equal(result.overPrevented, true); assert.equal(result.prevented, true);
  await chips(page).nth(4).waitFor();
  assert.deepEqual(await chips(page).locator('[data-slot="attachment-name"]').allInnerTexts(), ['notes.md', 'first.png', 'todo.txt', 'second.png', 'brief.pdf']);
  assert.equal(await alerts(page).count(), 0);
}));

test('pasting five files attaches all five, the same five a drop or the chooser gives', () => using({}, async f => {
  const { page } = f;
  await transfer(page, 'paste', fiveSpecs);
  await chips(page).nth(4).waitFor();
  assert.deepEqual(await chips(page).locator('[data-slot="attachment-name"]').allInnerTexts(), ['notes.md', 'first.png', 'todo.txt', 'second.png', 'brief.pdf']);
  assert.equal(await list(page).getByRole('img').count(), 2, 'a thumbnail for each picture');
  assert.equal(await alerts(page).count(), 0);
}));

test('twenty files fit; of twenty-two the last two are named in one notice and the + menu waits', () => using({}, async f => {
  const { page } = f;
  await chooseFiles(page, Array.from({ length: 22 }, (_, i) => i % 4 === 1 ? picture(`pic-${i}.png`) : text(`file-${i}.txt`)));
  await chips(page).nth(19).waitFor();
  await alerts(page).first().waitFor();
  assert.equal(await chips(page).count(), 20);
  const notice = await alerts(page).innerText();
  assert.match(notice, /20 files/); assert.match(notice, /file-20\.txt/); assert.match(notice, /pic-21\.png|file-21\.txt/); assert.doesNotMatch(notice, /file-19\.txt/);
  await plus(page).click();
  assert.equal(await page.getByRole('menuitem', { name: /^Add files or photos/ }).getAttribute('aria-disabled'), 'true');
  await page.keyboard.press('Escape');
  await transfer(page, 'drop', [{ name: 'one-more.txt' }]);
  await alerts(page).filter({ hasText: 'one-more.txt' }).waitFor();
  assert.equal(await chips(page).count(), 20);
}));

test('a file over 30 MB is named in the notice and the files beside it still attach; every notice looks alike', () => using({}, async f => {
  const { page } = f;
  await chooseFiles(page, [text('fine.txt'), { name: 'huge.png', mimeType: 'image/png', buffer: Buffer.alloc(31 * MiB, 1) }, picture('also-fine.png')]);
  await chips(page).nth(1).waitFor();
  assert.deepEqual(await chips(page).locator('[data-slot="attachment-name"]').allInnerTexts(), ['fine.txt', 'also-fine.png']);
  const tooBig = await alerts(page).innerText();
  assert.match(tooBig, /huge\.png/); assert.match(tooBig, /30 MB/); assert.doesNotMatch(tooBig, /fine\.txt/);
  const look = () => alerts(page).evaluate(node => ({ tag: node.tagName, cls: node.className, color: getComputedStyle(node).color, size: getComputedStyle(node).fontSize }));
  const reference = await look();
  await chooseFiles(page, [{ name: 'archive.zip', mimeType: 'application/zip', buffer: Buffer.from('binary') }]);
  await alerts(page).filter({ hasText: 'archive.zip' }).waitFor();
  assert.deepEqual(await look(), reference, 'an unsupported file is told the way a too-big one is');
  assert.equal(await chips(page).count(), 2);
}));

test('a picture past 2048 px or 3.5 MB is shrunk to a JPEG that fits, a smaller one goes as it was', () => using({}, async f => {
  const { page } = f;
  const noise = Buffer.from(await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 1300; canvas.height = 1100;
    const context = canvas.getContext('2d'), image = context.createImageData(1300, 1100);
    for (let i = 0; i < image.data.length; i += 4) { image.data[i] = Math.random() * 256; image.data[i + 1] = Math.random() * 256; image.data[i + 2] = Math.random() * 256; image.data[i + 3] = 255; }
    context.putImageData(image, 0, 0);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png')), bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(binary);
  }), 'base64');
  assert.ok(noise.length > 3.5 * MiB, `the noise picture is ${noise.length} bytes`);
  const wide = Buffer.from(await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 3000; canvas.height = 1500;
    const context = canvas.getContext('2d'), fill = context.createLinearGradient(0, 0, 3000, 1500); fill.addColorStop(0, '#2b6cb0'); fill.addColorStop(1, '#d69e2e');
    context.fillStyle = fill; context.fillRect(0, 0, 3000, 1500);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png')), bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(binary);
  }), 'base64');
  await chooseFiles(page, [picture('noise.png', noise), picture('wide.png', wide), picture('small.png')]);
  await chips(page).nth(2).waitFor();
  assert.equal(await alerts(page).count(), 0, 'shrinking is not an error');
  const sources = await list(page).locator('img').evaluateAll(images => images.map(image => image.src));
  const sizeOf = url => Math.floor((url.length - url.indexOf(',') - 1) * 3 / 4);
  assert.match(sources[0], /^data:image\/jpeg;base64,/); assert.ok(sizeOf(sources[0]) < 3.5 * MiB, 'the noise picture now fits');
  assert.match(sources[1], /^data:image\/jpeg;base64,/);
  const wideSize = await list(page).locator('img').nth(1).evaluate(image => new Promise(resolve => { const copy = new Image(); copy.onload = () => resolve([copy.naturalWidth, copy.naturalHeight]); copy.src = image.src; }));
  assert.deepEqual(wideSize, [2048, 1024], 'the longer side is 2048 px, as the engine would cut it');
  assert.equal(sources[2], `data:image/png;base64,${PNG.toString('base64')}`);
  assert.deepEqual(await chips(page).locator('[data-slot="attachment-name"]').allInnerTexts(), ['noise.png', 'wide.png', 'small.png'], 'names are kept');
}));

test('a queued message edited back into the box keeps every file, with the ones already there', () => using({ running: true }, async f => {
  const { page, composer } = f;
  await page.getByRole('button', { name: 'Stop generation', exact: true }).waitFor();
  await chooseFiles(page, [text('q1.txt'), picture('q2.png')]);
  await chips(page).nth(1).waitFor();
  await composer.click(); await composer.fill('with two files'); await page.keyboard.press('Control+Enter');
  await page.getByRole('list', { name: 'Queued follow-ups', exact: true }).getByText('with two files', { exact: true }).waitFor();
  await chips(page).first().waitFor({ state: 'detached' });
  await chooseFiles(page, [text('n1.txt'), picture('n2.png'), text('n3.txt')]);
  await chips(page).nth(2).waitFor();
  await page.getByRole('button', { name: 'Edit in composer', exact: true }).click();
  await chips(page).nth(4).waitFor();
  assert.deepEqual(await chips(page).locator('[data-slot="attachment-name"]').allInnerTexts(), ['n1.txt', 'n2.png', 'n3.txt', 'q1.txt', 'q2.png']);
  assert.equal(await alerts(page).count(), 0);
}));

for (const colorScheme of ['light', 'dark']) for (const width of [1130, 390]) {
  test(`many mixed files wrap, line up and show whole (${colorScheme}, ${width}px)`, async () => {
    // The chat list is hidden at 390px, so the chat is opened wide and the window then narrowed.
    const f = await fixture({ routes, colorScheme, width: 1130, height: 760 });
    try {
      await f.open('chat-a');
      await f.page.setViewportSize({ width, height: 760 });
      const names = ['quarterly-report-final-version-2026.pdf', 'screenshot.png', 'a-very-long-file-name-that-will-not-fit-on-one-line-of-a-chip-at-all.txt', 'photo-1.png', 'notes.md', 'photo-2.png', 'data.csv', 'diagram.png', 'main.py', 'logo.png', 'readme.md', 'chart.png'];
      await transfer(f.page, 'drop', names.map(name => /\.png$/.test(name) ? { image: true, name } : { name, type: name.endsWith('.pdf') ? 'application/pdf' : 'text/plain', text: name.endsWith('.pdf') ? '%PDF-1.4 synthetic' : undefined }));
      await chips(f.page).nth(names.length - 1).waitFor();
      await f.page.mouse.move(0, 0);
      const fit = await f.page.evaluate(() => {
        const composer = document.querySelector('.composer').getBoundingClientRect();
        const boxes = [...document.querySelectorAll('[data-slot="attachment-chip"]')].map(chip => {
          const box = chip.getBoundingClientRect(), name = chip.querySelector('[data-slot="attachment-name"]'), thumb = chip.querySelector('[data-slot="attachment-thumb"]').getBoundingClientRect();
          return { top: Math.round(box.top), left: Math.round(box.left), right: Math.round(box.right), bottom: Math.round(box.bottom), height: Math.round(box.height), inside: box.left >= composer.left && box.right <= composer.right + 0.5 && box.width > 0, nameClipped: name.scrollWidth > name.clientWidth && !name.title, thumbHigh: Math.round(thumb.height), remove: chip.querySelector('button').getBoundingClientRect().right <= box.right + 0.5 };
        });
        return { boxes, scrolls: document.documentElement.scrollWidth > window.innerWidth };
      });
      assert.ok(fit.boxes.every(box => box.inside), 'every chip lies inside the composer');
      assert.ok(fit.boxes.every(box => !box.nameClipped), 'a name cut short carries its full name as a title');
      assert.ok(fit.boxes.every(box => box.remove), 'the remove button sits inside its chip');
      assert.equal(new Set(fit.boxes.map(box => box.height)).size, 1, 'one chip height');
      assert.equal(new Set(fit.boxes.map(box => box.thumbHigh)).size, 1, 'one thumbnail size');
      const rows = Map.groupBy(fit.boxes, box => box.top); assert.ok(rows.size >= 2, 'the chips wrap onto more rows');
      for (const row of rows.values()) assert.ok(row.every(box => box.bottom === row[0].bottom), 'chips in a row line up');
      assert.equal(fit.scrolls, false, 'the page does not scroll sideways');
      if (shots) { fs.mkdirSync(shots, { recursive: true }); await f.page.screenshot({ path: path.join(shots, `attachments-${colorScheme}-${width}.png`) }); }
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  });
}
