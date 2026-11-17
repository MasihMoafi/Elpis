const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cts');
const { openSettings, chooseOption } = require('./controls.cts');

for (const colorScheme of ['light', 'dark']) test(`sidebar hierarchy and running status remain distinct (${colorScheme})`, async () => {
  const f = await fixture({ colorScheme, running: true });
  try {
    await f.open('chat-b');
    assert.equal(await f.page.locator('.sidebar-status .status-line').count(), 0, 'a healthy connection adds no footer indicator');
    const heading = f.page.getByRole('button', { name: 'Recents', exact: true });
    await heading.waitFor();
    assert.equal(await heading.locator('.section-count').textContent(), '3');
    const working = f.page.locator('.thread-row[data-thread-id="chat-a"] .thread-dot');
    await working.locator('..').waitFor();
    const mark = await working.evaluate((e: HTMLElement) => ({
      state: e.dataset.state,
      fill: getComputedStyle(e.querySelector('.elpis-working-dot')!).fill,
      shape: getComputedStyle(e).borderRadius,
    }));
    assert.equal(mark.state, 'working');
    assert.notEqual(mark.fill, 'rgba(0, 0, 0, 0)');
    assert.notEqual(mark.shape, '50%');
    const colors = await f.page.locator('.thread-list').evaluate((root: HTMLElement) => [
      getComputedStyle(root.querySelector('.section-label')!).color,
      getComputedStyle(root.querySelector('[data-thread-id="chat-b"] .thread-title')!).color,
    ]);
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
    assert.equal(await f.page.getByRole('button', { name: 'Add new project', exact: true }).locator('svg').count(), 0, 'the empty-project action has no unwanted plus');
    assert.equal(await f.page.getByText('Local workspace', { exact: true }).count(), 0);
    const footer = await f.page.locator('.sidebar-footer').evaluate((element: HTMLElement) => {
      const account = element.querySelector('.account-row')!.getBoundingClientRect();
      const settings = element.querySelector('[aria-label="Settings"]')!.getBoundingClientRect();
      return { accountTop: account.top, accountBottom: account.bottom, settingsTop: settings.top, settingsBottom: settings.bottom };
    });
    assert.ok(footer.settingsTop >= footer.accountTop && footer.settingsBottom <= footer.accountBottom, 'settings share the bottom account row rather than consuming a second row');
    assert.equal(await f.page.getByRole('button', { name: 'Projects', exact: true }).count(), 0);
    assert.equal(await f.page.locator('section[aria-label="Recents"]').count(), 0);
    assert.equal(await f.page.locator('section[aria-label="Pinned"] .thread-row').count(), 3);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('the footer only shows connection trouble and hides it again after recovery', async () => {
  let connected = true;
  const f = await fixture({ routes: { '/api/health': () => ({ connected }) } });
  try {
    await f.open('chat-a');
    await f.composer.fill('Keep this draft across a connection change');
    const indicator = f.page.locator('.sidebar-status .status-line');
    assert.equal(await indicator.count(), 0);
    connected = false; f.emit('connection', { connected });
    await indicator.waitFor();
    assert.equal(await indicator.getAttribute('title'), 'Disconnected');
    connected = true; f.emit('connection', { connected });
    await indicator.waitFor({ state: 'detached' });
    assert.equal(await f.composer.inputValue(), 'Keep this draft across a connection change');
    assert.equal(await f.page.getByRole('button', { name: 'Use dark theme', exact: true }).count(), 1);
    assert.equal(await f.page.getByRole('button', { name: 'Settings', exact: true }).count(), 1);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('default model search opens its actual control and hides groups with no matching settings', async () => {
  const f = await fixture({ routes: { '/api/settings': () => ({
    version: 'v1', main: { model: 'sol', provider: 'openai' }, background: {},
    smartPrune: { explicitOverride: {} }, memory: {}, write: { available: true },
  }) } });
  try {
    await f.open('chat-a'); await openSettings(f.page);
    await f.page.getByLabel('Search settings', { exact: true }).fill('default model');
    await f.page.getByText('Default model', { exact: true }).waitFor();
    assert.equal(await f.page.getByRole('tab', { name: 'Configuration', exact: true }).getAttribute('aria-selected'), 'true');
    await f.page.getByLabel('Search settings', { exact: true }).fill('default');
    await f.page.getByRole('tab', { name: 'General', exact: true }).click();
    const panel = f.page.locator('[role="tabpanel"]:not([hidden])');
    const empty = await panel.locator('.settings-group').evaluateAll((groups: HTMLElement[]) => groups.filter(g => {
      const rows = [...g.querySelectorAll<HTMLElement>('.settings-row:not(.settings-actions)')];
      return g.getClientRects().length && rows.length && !rows.some(r => r.getClientRects().length);
    }).map(g => g.getAttribute('aria-label')));
    assert.deepEqual(empty, []);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('streaming Read aloud begins before synthesis finishes and speed changes during playback survive reload', async () => {
  let completed = false;
  const audio = require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures/read-aloud-tone.mp3'));
  const id = '11111111-1111-4111-8111-111111111111';
  const f = await fixture({ chat: [['t1', 'Read this.', 'A sentence read by the local streaming voice.']], routes: {
    '/api/read-aloud': () => ({ available: true, streaming: true, revision: 'local' }),
    '/api/read-aloud/prepare': () => ({ url: `/api/read-aloud/audio/${id}` }),
    [`/api/read-aloud/audio/${id}`]: (_body: unknown, _url: URL, res: import('node:http').ServerResponse) => {
      if (res.req.method === 'DELETE') { res.writeHead(204); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); res.write(audio);
      const timer = setTimeout(() => { completed = true; res.end(audio); }, 3000);
      res.once('close', () => clearTimeout(timer));
    },
  } });
  try {
    await f.page.addInitScript(() => {
      const Original = window.Audio;
      window.Audio = function(src?: string) {
        const audio = new Original(src);
        (window as Window & { __readingAudio?: HTMLAudioElement }).__readingAudio = audio;
        return audio;
      } as unknown as typeof Audio;
    });
    await f.page.reload(); await f.open('chat-a');
    const reply = f.page.locator('.message.agent').first();
    await reply.getByRole('button', { name: 'Read aloud', exact: true }).click();
    await f.page.waitForFunction(() => ((window as Window & { __readingAudio?: HTMLAudioElement }).__readingAudio?.currentTime ?? 0) > 0, null, { timeout: 2000 });
    assert.equal(completed, false, 'first playback precedes the last generated chunk');
    await chooseOption(reply.getByLabel('Read aloud speed'), '1.5');
    const playback = await f.page.evaluate(() => {
      const audio = (window as Window & { __readingAudio?: HTMLAudioElement }).__readingAudio!;
      return { rate: audio.playbackRate, pitch: audio.preservesPitch };
    });
    assert.deepEqual(playback, { rate: 1.5, pitch: true });
    await reply.getByRole('button', { name: 'Stop', exact: true }).click();
    await f.page.reload(); await f.open('chat-a');
    await reply.getByRole('button', { name: 'Read aloud', exact: true }).click();
    assert.equal(await f.page.evaluate(() => (window as Window & { __readingAudio?: HTMLAudioElement }).__readingAudio!.playbackRate), 1.5);
    await reply.getByRole('button', { name: 'Stop', exact: true }).click();
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
