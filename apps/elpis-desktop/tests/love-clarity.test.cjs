const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { loveSpotFixture } = require('./love-spot-fixture.cjs');
const shots = path.join(process.env.HOME, '.cache/elpis-tests/love-clarity');

for (const colorScheme of ['light', 'dark']) test(`Love Spot identifies chats, lights on answers, and clears on board or chat visit · ${colorScheme}`, async () => {
  const card = { id: 'review-card', type: 'rectangle', x: 80, y: 80, width: 220, height: 190, version: 1, versionNonce: 1,
    customData: { loveAgent: { preset: 'reviewer', name: 'Review', prompt: 'Review the task', task: 'Review the example', model: 'sol', provider: 'openai', threadId: 'review-chat', status: 'running' } } };
  const chats = [
    { id: 'review-chat', name: 'Review', source: 'cli', status: { type: 'idle' } },
    { id: 'matilda-chat', name: 'Love Spot', source: 'cli', status: { type: 'idle' } },
    { id: 'ordinary-chat', name: 'My conversation', source: 'cli', status: { type: 'idle' } },
  ];
  const f = await loveSpotFixture({ colorScheme,
    prepareDirectory: async directory => { await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, 'scene.excalidraw'), JSON.stringify({ elements: [card], files: {}, appState: {} })); },
    configureClient: client => {
      client.listThreads = async () => ({ data: chats, nextCursor: null });
      client.readThread = async id => ({ thread: chats.find(chat => chat.id === id), data: [], nextCursor: null });
      client.resume = async id => ({ thread: chats.find(chat => chat.id === id), activeTurnId: null });
      client.workflowHistory = async () => ({ data: [{ id: 'team-one', rootThreadId: 'ordinary-chat', name: 'Review the example', status: 'running', tasks: [{ status: 'succeeded' }, { status: 'running' }] }] });
    },
  });
  try {
    const { page } = f;
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.locator(".brand img").evaluate(image => image.decode());
    await page.waitForTimeout(1100);
    const group = page.getByRole('group', { name: 'Love Spot', exact: true });
    await group.getByText('Review', { exact: true }).waitFor();
    assert.equal(await page.getByRole('region', { name: 'Recents', exact: true }).getByText('Review', { exact: true }).count(), 0);
    assert.equal(await page.locator('.love-unread').count(), 0, 'Loading history does not signal a new answer');
    const reply = text => page.evaluate(async text => {
      const { scene } = await (await fetch('/api/love-spot')).json();
      const elements = scene.elements.map(e => e.id !== 'review-card' ? e : { ...e, version: e.version + 1, versionNonce: e.versionNonce + 1, customData: { loveAgent: { ...e.customData.loveAgent, status: 'completed', output: text } } });
      const result = await fetch('/api/love-spot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...scene, elements }) });
      if (!result.ok) throw Error(await result.text());
    }, text);
    const openChat = async id => {
      await page.locator(`aside [data-thread-id="${id}"] .thread-link`).click();
      await page.locator(`aside .thread-row.active[data-thread-id="${id}"]`).waitFor();
    };
    await reply('Review complete. The example is ready.');
    await page.locator('.love-unread').waitFor();
    assert.equal(await page.locator('.love-unread').textContent(), '1');
    await fs.mkdir(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, `${colorScheme}-reply.png`) });
    await openChat('ordinary-chat');
    assert.equal(await page.locator('.love-unread').textContent(), '1', 'an ordinary chat does not acknowledge Love Spot');
    for (const id of ['review-chat', 'matilda-chat']) {
      await openChat(id);
      await page.locator('.love-unread').waitFor({ state: 'hidden' });
      const unavailable = page.getByRole('button', { name: 'Voice unavailable', exact: true });
      await unavailable.waitFor(); assert.equal(await unavailable.isDisabled(), true, 'legacy and named Love Spot chats share the audio fallback');
      await openChat('ordinary-chat');
      await reply(`Another answer after visiting ${id}.`);
      await page.locator('.love-unread').waitFor();
      assert.equal(await page.locator('.love-unread').textContent(), '1', 'later replies notify again after leaving the chat');
    }
    await page.locator('[data-nav-page="loveSpot"]').click();
    await page.locator('.excalidraw canvas').first().waitFor();
    assert.equal(await page.locator('.love-unread').count(), 0, 'Visiting acknowledges the reply');
    const primary = await page.locator('.love-spot').evaluate(el => getComputedStyle(el).getPropertyValue('--primary').trim().toLowerCase());
    assert.equal(primary, colorScheme === 'dark' ? '#ec575e' : '#8b1017');
    const canvasPrimary = await page.locator('.excalidraw').first().evaluate(el => getComputedStyle(el).getPropertyValue('--color-primary').trim().toLowerCase());
    assert.equal(canvasPrimary, primary, 'Canvas tools follow the Love Spot deck palette');
    const tool = await page.locator('.excalidraw input.ToolIcon_type_radio:checked + .ToolIcon__icon').first().evaluate(el => {
      const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
      const rgb = value => { context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3); };
      return { color: rgb(getComputedStyle(el).color), fill: rgb(getComputedStyle(el).backgroundColor) };
    });
    assert.ok(tool.color[0] > tool.color[2] && tool.fill[0] > tool.fill[2], `Selected canvas tool is red, including its visible fill: ${JSON.stringify(tool)}`);
    await page.screenshot({ path: path.join(shots, `${colorScheme}-love.png`) });
    await page.locator('[data-nav-page="canvas"]').click();
    await page.getByRole('button', { name: 'Current workflows', exact: true }).click();
    const history = page.getByRole('region', { name: 'Current workflows', exact: true });
    await history.getByText('Review the example', { exact: true }).waitFor();
    assert.match(await history.textContent(), /running.*1\/2 tasks complete/);
    await page.screenshot({ path: path.join(shots, `${colorScheme}-workflows.png`) });
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
