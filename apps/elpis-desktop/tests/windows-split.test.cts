const { threadMenuItem } = require('./controls.cts');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { fixture, THREADS } = require('./parity-fixture.cts');
const secondary = (page: { frameLocator(selector: string): { getByRole(role: string, options: object): { waitFor(): Promise<void>; fill(value: string): Promise<void>; click(): Promise<void>; evaluate(fn: (el: Element) => boolean): Promise<boolean> }; getByText(text: string, options: object): { waitFor(): Promise<void> } } }) => page.frameLocator('iframe[title="Split session"]');
async function split(page: Parameters<typeof secondary>[0] & { locator(selector: string): { getByRole(role: string, options: object): { click(): Promise<void> } } }, id = 'chat-b') {
  await page.locator(`.thread-row[data-thread-id="${id}"]`).getByRole('button', { name: /^Actions for/ }).click();
  await (await threadMenuItem(page, 'Open session in split view')).click();
  await secondary(page).getByRole('textbox', { name: 'Message Elpis', exact: true }).waitFor();
}
test('split chats keep separate composers, send to their own chat, focus with brackets, and close either pane', async () => {
  const f = await fixture({ width: 1400, height: 850, desktop: false }); const { page, composer } = f;
  try {
    await f.open('chat-a'); await composer.fill('left draft'); await split(page);
    const right = secondary(page).getByRole('textbox', { name: 'Message Elpis', exact: true });
    await right.fill('right draft'); assert.equal(await composer.inputValue(), 'left draft');
    // The bracket keys reach the other pane by postMessage (components/session-split.tsx), so its focus lands a task later.
    const focusedIn = (pane: 'split' | 'main') => page.waitForFunction((inSplit: boolean) => {
      const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Split session"]');
      // The frame keeps its own focused element while the main page has the focus: the frame itself must be focused too.
      const doc = inSplit ? (document.activeElement === frame ? frame?.contentDocument : null) : document;
      return doc?.activeElement?.getAttribute('aria-label') === 'Message Elpis';
    }, pane === 'split', { timeout: 5_000 }).catch(() => assert.fail(`the ${pane} composer did not take the focus`));
    await composer.click(); await page.keyboard.press('Control+Alt+]'); await focusedIn('split');
    await page.keyboard.press('Control+Alt+['); await focusedIn('main');
    // A split can be typed in before its connection is ready; Enter only sends once the send button is enabled.
    await page.waitForFunction(() => {
      const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Split session"]');
      const button = frame?.contentDocument?.querySelector<HTMLButtonElement>('button[aria-label="Send message"]');
      return !!button && !button.disabled;
    });
    await right.click(); const sent = page.waitForResponse((res: { url(): string }) => res.url().endsWith('/threads/chat-b/turns')); await page.keyboard.press('Enter'); await sent;
    assert.ok(f.posts.some((p: { path: string; body: unknown }) => p.path === '/api/threads/chat-b/turns' && JSON.stringify(p.body).includes('right draft')));
    assert.equal(await composer.inputValue(), 'left draft');
    await secondary(page).getByRole('button', { name: 'Close split view', exact: true }).click();
    await page.locator('iframe[title="Split session"]').waitFor({ state: 'detached' });
    assert.equal(await composer.inputValue(), 'left draft');
    await split(page); await secondary(page).getByRole('textbox', { name: 'Message Elpis', exact: true }).fill('Keep the right draft'); await page.getByRole('button', { name: 'Close split view', exact: true }).click();
    await page.locator('iframe[title="Split session"]').waitFor({ state: 'detached' });
    await page.locator('.thread-row.active[data-thread-id="chat-b"]').waitFor();
    assert.equal(await composer.inputValue(), 'Keep the right draft');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
test('a split pane keeps what is typed while it starts', async () => {
  const f = await fixture({ width: 1400, height: 850, desktop: false }); const { page } = f;
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    await f.open('chat-a');
    // The split's scripts are held: its page shows the message box from its HTML before the app has started.
    type Route = { request(): { frame(): { parentFrame(): unknown } }; continue(): Promise<void> };
    await page.route('**/_next/static/chunks/**', async (route: Route) => {
      if (route.request().frame().parentFrame()) await held;
      await route.continue();
    });
    await split(page);
    type Box = { isEditable(): Promise<boolean>; fill(value: string): Promise<void>; inputValue(): Promise<string> };
    const right = secondary(page).getByRole('textbox', { name: 'Message Elpis', exact: true }) as unknown as Box;
    assert.equal(await right.isEditable(), false, 'the box took typing before the pane had started, and starting replaces it');
    const typed = right.fill('typed while starting');
    release(); await typed;
    await page.waitForFunction(() => {
      const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Split session"]');
      const button = frame?.contentDocument?.querySelector<HTMLButtonElement>('button[aria-label="Send message"]');
      return !!button && !button.disabled;
    });
    assert.equal(await right.inputValue(), 'typed while starting');
    assert.deepEqual(f.errors, []);
  } finally { release(); await f.close(); }
});
test('Alt+click opens a split; one chat receives the same live reply in both panes', async () => {
  let releaseResume = () => {};
  const resumed = new Promise<void>(resolve => { releaseResume = resolve; });
  const f = await fixture({ width: 1400, height: 850, desktop: false, routes: {
    '/api/threads/chat-a/resume': async () => { await resumed; return { thread: THREADS[0], activeTurnId: null }; },
  } }); const { page } = f;
  try {
    await f.open('chat-a');
    await Promise.all([
      page.waitForResponse((response: { url(): string; request(): { frame(): { parentFrame(): unknown } } }) => new URL(response.url()).pathname === '/api/events'
        && response.request().frame().parentFrame() === page.mainFrame()),
      page.locator('.thread-row[data-thread-id="chat-a"] .thread-link').click({ modifiers: ['Alt'] }),
    ]);
    await secondary(page).getByRole('textbox', { name: 'Message Elpis', exact: true }).waitFor();
    await secondary(page).getByText('All green.', { exact: true }).waitFor();
    assert.ok(f.listening() >= 2, 'the split pane never subscribed to live events');
    // Completed items are already recorded by the bridge. Keep resume held until both panes show this event,
    // so a recovery history read cannot stand in for live delivery (or later discard a fixture-only item).
    f.turns.push(['shared', 'Reply in both panes.', 'Both panes receive this reply.']);
    f.emit('message', { method: 'item/completed', params: { threadId: 'chat-a', turnId: 'shared', item: { id: 'a-shared', type: 'agentMessage', text: 'Both panes receive this reply.' } } });
    await page.getByText('Both panes receive this reply.', { exact: true }).waitFor();
    await secondary(page).getByText('Both panes receive this reply.', { exact: true }).waitFor();
    assert.deepEqual(f.errors, []);
  } finally { releaseResume(); await f.close(); }
});
