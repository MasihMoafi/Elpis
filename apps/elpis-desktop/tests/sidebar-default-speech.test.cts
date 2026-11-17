const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cts');
const { openSettings, chooseOption } = require('./controls.cts');

for (const colorScheme of ['light', 'dark']) test(`sidebar hierarchy and running status remain distinct (${colorScheme})`, async () => {
  const f = await fixture({ colorScheme, running: true });
  try {
    await f.open('chat-b');
    const heading = f.page.getByRole('button', { name: 'Recents', exact: true });
    await heading.waitFor();
    assert.equal(await heading.locator('.section-count').textContent(), '3');
    const working = f.page.locator('.thread-row[data-thread-id="chat-a"] .thread-dot');
    await working.locator('..').waitFor();
    const mark = await working.evaluate((e: HTMLElement) => ({ state: e.dataset.state, fill: getComputedStyle(e).backgroundColor, shape: getComputedStyle(e).borderRadius }));
    assert.equal(mark.state, 'working');
    assert.notEqual(mark.fill, 'rgba(0, 0, 0, 0)');
    assert.notEqual(mark.shape, '50%');
    const colors = await f.page.locator('.thread-list').evaluate((root: HTMLElement) => [getComputedStyle(root.querySelector('.section-label')!).color, getComputedStyle(root.querySelector('[data-thread-id="chat-b"] .thread-title')!).color]);
    assert.notEqual(colors[0], colors[1], 'headings use the theme accent rather than chat text color');
    await heading.click();
    assert.equal(await heading.getAttribute('aria-expanded'), 'false');
    assert.equal(await heading.locator('.section-count').textContent(), '3', 'folding never makes a populated section look empty');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('empty Projects offers Add project and Recents vanishes when every chat is pinned', async () => {
  const f = await fixture({ storage: { 'elpis-pinned-chats-v1': JSON.stringify(['chat-a', 'chat-b', 'chat-c']) } });
  try {
    await f.open('chat-a');
    await f.page.getByRole('button', { name: 'Add new project', exact: true }).waitFor();
    assert.equal(await f.page.getByRole('button', { name: 'Projects', exact: true }).count(), 0);
    assert.equal(await f.page.locator('section[aria-label="Recents"]').count(), 0);
    assert.equal(await f.page.locator('section[aria-label="Pinned"] .thread-row').count(), 3);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('default model search opens its actual control and hides groups with no matching settings', async () => {
  const f = await fixture();
  try {
    await f.open('chat-a'); await openSettings(f.page);
    await f.page.getByLabel('Search settings', { exact: true }).fill('default model');
    await f.page.getByText('Default model', { exact: true }).waitFor();
    assert.equal(await f.page.getByRole('tab', { name: 'Configuration', exact: true }).getAttribute('aria-selected'), 'true');
    await f.page.getByLabel('Search settings', { exact: true }).fill('default');
    await f.page.getByRole('tab', { name: 'General', exact: true }).click();
    const panel = f.page.locator('[role="tabpanel"]:not([hidden])');
    const empty = await panel.locator('.settings-group').evaluateAll((groups: HTMLElement[]) => groups.filter(g => g.getClientRects().length && g.querySelectorAll('.settings-row:not(.settings-actions)').length && ![...g.querySelectorAll<HTMLElement>('.settings-row:not(.settings-actions)')].some(r => r.getClientRects().length)).map(g => g.getAttribute('aria-label')));
    assert.deepEqual(empty, []);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('streaming Read aloud begins before synthesis finishes and speed changes during playback survive reload', async () => {
  let completed = false;
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(0x7ffffffe, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(0x7fffffda, 40);
  const id = '11111111-1111-4111-8111-111111111111';
  const f = await fixture({ chat: [['t1', 'Read this.', 'A sentence read by the local streaming voice.']], routes: {
    '/api/read-aloud': () => ({ available: true, streaming: true, revision: 'local' }),
    '/api/read-aloud/prepare': () => ({ url: `/api/read-aloud/audio/${id}` }),
    [`/api/read-aloud/audio/${id}`]: (_body: unknown, _url: URL, res: import('node:http').ServerResponse) => {
      res.writeHead(200, { 'Content-Type': 'audio/wav' }); res.write(header); res.write(Buffer.alloc(48000));
      const timer = setTimeout(() => { completed = true; res.end(Buffer.alloc(48000)); }, 3000);
      res.once('close', () => clearTimeout(timer));
    },
  } });
  try {
    await f.page.addInitScript(() => {
      const Original = window.Audio;
      window.Audio = function(src?: string) { const audio = new Original(src); (window as Window & { __readingAudio?: HTMLAudioElement }).__readingAudio = audio; return audio; } as typeof Audio;
    });
    await f.page.reload(); await f.open('chat-a');
    const reply = f.page.locator('.message.assistant').first();
    await reply.getByRole('button', { name: 'Read aloud', exact: true }).click();
    await f.page.waitForFunction(() => ((window as Window & { __readingAudio?: HTMLAudioElement }).__readingAudio?.currentTime ?? 0) > 0, { timeout: 2000 });
    assert.equal(completed, false, 'first playback precedes the last generated chunk');
    await chooseOption(reply.getByLabel('Read aloud speed'), '1.5');
    assert.deepEqual(await f.page.evaluate(() => { const audio = (window as Window & { __readingAudio?: HTMLAudioElement }).__readingAudio!; return { rate: audio.playbackRate, pitch: audio.preservesPitch }; }), { rate: 1.5, pitch: true });
    await reply.getByRole('button', { name: 'Stop', exact: true }).click();
    await f.page.reload(); await f.open('chat-a');
    await reply.getByRole('button', { name: 'Read aloud', exact: true }).click();
    assert.equal(await f.page.evaluate(() => (window as Window & { __readingAudio?: HTMLAudioElement }).__readingAudio!.playbackRate), 1.5);
    await reply.getByRole('button', { name: 'Stop', exact: true }).click();
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
