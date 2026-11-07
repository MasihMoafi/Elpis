// Pinned Matilda works like a pinned pet (1 Nov, Masih: "Matilda is disabled from our pin, it shouldn't be … it shouldn't
// show previous messages in the pop-up version; unless we want to click on an icon which is designated for this"; later:
// "disabling it shouldn't disrupt me from using the pinned version").
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const { FACE_DATA_URL } = require('../bridge/matilda-face.cts');

test('her pinned chat works while she is off on the board; her pop-up hides earlier messages until its history icon is pressed', { timeout: 60000 }, async (t: import('node:test').TestContext) => {
  let pinned = false, settings = { replies: false, model: null, provider: null };
  const old = { turnId: 'old', item: { id: 'old-q', type: 'userMessage', content: [{ type: 'text', text: 'An old question' }] } };
  const oldReply = { turnId: 'old', item: { id: 'old-a', type: 'agentMessage', text: 'An old answer.' } };
  let entries = [old, oldReply];
  const f = await fixture({ width: 1000, height: 800, routes: {
    '/api/love-spot/companion': (body: { action?: string } | null) => {
      if (body?.action === 'pin') pinned = true;
      if (body?.action === 'unpin') pinned = false;
      return { pinned, face: FACE_DATA_URL, threadId: 'chat-a', favorite: null, music: null, reason: '' };
    },
    '/api/love-spot/matilda': (body: Partial<typeof settings> | null) => { if (body) settings = { ...settings, ...body }; return body ? { matilda: settings } : settings; },
    '/api/love-spot/talk': (body: { text: string } | null) => {
      if (body) entries = [...entries, { turnId: 'new', item: { id: 'new-q', type: 'userMessage', content: [{ type: 'text', text: body.text }] } }, { turnId: 'new', item: { id: 'new-a', type: 'agentMessage', text: 'Here now.' } }];
      return { entries, busy: false };
    },
  } });
  t.after(() => f.close());
  await f.open('chat-a');
  const page = f.page;
  await page.getByRole('button', { name: 'Pin Matilda', exact: true }).click();
  const presence = page.getByRole('region', { name: 'Pinned Matilda', exact: true }); await presence.waitFor();
  assert.equal(settings.replies, false, 'pinning leaves her board on/off alone');

  await presence.getByRole('button', { name: 'Chat with Matilda', exact: true }).click();
  const mini = page.getByRole('dialog', { name: 'Small chat with Matilda', exact: true }); await mini.waitFor();
  const field = mini.getByRole('textbox', { name: 'Message Matilda', exact: true });
  assert.equal(await field.isEnabled(), true, 'her message field works once pinned');
  const history = mini.getByRole('button', { name: 'Show earlier messages', exact: true });
  await history.waitFor();
  assert.equal(await mini.getByText('An old question', { exact: true }).count(), 0, 'no earlier messages in the pop-up');
  await field.fill('Hello'); await mini.getByRole('button', { name: 'Send to Matilda', exact: true }).click();
  await mini.getByText('Here now.', { exact: true }).waitFor();
  assert.equal(f.posts.filter((post: { path: string }) => post.path === '/api/love-spot/talk').at(-1).body.pinned, true, 'sent as her pinned chat, which works while she is off');
  assert.equal(await mini.getByText('An old answer.', { exact: true }).count(), 0, 'what is said now shows; earlier stays hidden');
  await history.click();
  await mini.getByText('An old question', { exact: true }).waitFor();
  assert.equal(await mini.getByRole('button', { name: 'Hide earlier messages', exact: true }).getAttribute('aria-pressed'), 'true');
  await page.keyboard.press('Escape'); await mini.waitFor({ state: 'hidden' });
  await presence.getByRole('button', { name: 'Chat with Matilda', exact: true }).click(); await mini.waitFor();
  assert.equal(await mini.getByText('An old question', { exact: true }).count(), 0, 'reopening starts without earlier messages again');
  await page.keyboard.press('Escape'); await mini.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Unpin Matilda', exact: true }).click();
  await page.getByRole('button', { name: 'Pin Matilda', exact: true }).waitFor();
  assert.deepEqual(f.errors, []);
});

test('small chat dictates into the draft and remembers whether to speak new replies', { timeout: 60000 }, async (t: import('node:test').TestContext) => {
  let pinned = false, turn = 0;
  let entries: { turnId: string; item: object }[] = [];
  const voiced: string[] = [];
  const f = await fixture({ routes: {
    '/api/love-spot/companion': (body: { action?: string } | null) => {
      if (body?.action === 'pin') pinned = true;
      return { pinned, face: FACE_DATA_URL, threadId: 'chat-a', favorite: null, music: null, reason: '' };
    },
    '/api/love-spot/talk': (body: { text: string } | null) => {
      if (body) { turn++; entries = [...entries, { turnId: String(turn), item: { id: `q${turn}`, type: 'userMessage', content: [{ type: 'text', text: body.text }] } }, { turnId: String(turn), item: { id: `a${turn}`, type: 'agentMessage', text: '**Hello** there.' } }]; }
      return { entries, busy: false };
    },
  } });
  t.after(() => f.close());
  await f.page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } });
    Object.defineProperty(window, 'MediaRecorder', { value: class {
      static isTypeSupported() { return true; }
      state = 'inactive'; ondataavailable?: (event: { data: Blob }) => void; onstop?: () => void;
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['audio']) }); this.onstop?.(); }
    } });
    Object.defineProperty(window, 'Audio', { value: class {
      onended: (() => void) | null = null; onerror: (() => void) | null = null; src = '';
      play() { document.body.dataset.matildaPlaying = 'yes'; return Promise.resolve(); }
      pause() { document.body.dataset.matildaPaused = 'yes'; }
      removeAttribute() {}
    } });
  });
  await f.page.route('**/api/tools/transcription?*', (route: { request(): { method(): string }; fulfill(options: object): Promise<unknown> }) => route.fulfill({ json: route.request().method() === 'POST' ? { text: 'Dictated words' } : { available: true, backend: 'fixture', label: 'test' } }));
  await f.page.route('**/api/read-aloud', (route: { request(): { method(): string; postData(): string }; fulfill(options: object): Promise<unknown> }) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { available: true } });
    voiced.push(JSON.parse(route.request().postData()).text);
    return route.fulfill({ contentType: 'audio/wav', body: 'audio' });
  });
  await f.page.reload(); await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
  await f.page.getByRole('button', { name: 'Pin Matilda', exact: true }).click();
  await f.page.getByRole('button', { name: 'Chat with Matilda', exact: true }).click();
  const mini = f.page.getByRole('dialog', { name: 'Small chat with Matilda' });
  const field = mini.getByRole('textbox', { name: 'Message Matilda' });
  await f.page.waitForFunction(() => document.querySelector('[aria-label="Dictate message"]')?.getAttribute('title')?.includes('Dictate with test'));
  await mini.getByRole('button', { name: 'Dictate message' }).click();
  await mini.getByRole('button', { name: 'Stop recording and transcribe' }).click();
  await f.page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Matilda"]')?.value === 'Dictated words');
  await mini.getByRole('button', { name: 'Send to Matilda' }).click();
  await f.page.waitForFunction(() => document.body.dataset.matildaPlaying === 'yes');
  assert.deepEqual(voiced, ['Hello there.']);
  await field.fill('Another message');
  assert.equal(await f.page.locator('body').getAttribute('data-matilda-paused'), 'yes');
  await mini.getByRole('button', { name: "Speak Matilda's replies" }).click();
  await mini.getByRole('button', { name: 'Send to Matilda' }).click();
  await mini.getByText('Hello there.', { exact: true }).last().waitFor();
  assert.deepEqual(voiced, ['Hello there.']);
  await f.page.keyboard.press('Escape');
  await f.page.getByRole('button', { name: 'Chat with Matilda', exact: true }).click();
  assert.equal(await f.page.getByRole('button', { name: "Speak Matilda's replies" }).getAttribute('aria-pressed'), 'false');
});
