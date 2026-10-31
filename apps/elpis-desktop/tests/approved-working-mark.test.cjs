const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, CWD, THREADS } = require('./parity-fixture.cjs');
const { threadMenuItem } = require('./controls.cjs');

const geometry = page => page.evaluate(() => {
  const box = selector => {
    const rect = document.querySelector(selector)?.getBoundingClientRect();
    return rect ? { x: Math.round(rect.x * 10) / 10, y: Math.round(rect.y * 10) / 10, width: Math.round(rect.width * 10) / 10, height: Math.round(rect.height * 10) / 10 } : null;
  };
  return { viewport: window.innerWidth, workspace: box('.workspace-body'), content: box('.workspace-content'), scroll: box('.chat-scroll'), chat: box('.chat-content'), turn: box('.turn'), working: box('.turn-working'), mark: box('.turn-working .elpis-working-mark'), sidePanel: box('[aria-label="Side panel"]'), teamPanel: box('.team-panel') };
});

for (const colorScheme of ['light', 'dark']) {
  test(`approved working animation remains hollow with a blinking dot in ${colorScheme}`, async t => {
    const f = await fixture({ staticDir: process.env.ELPIS_RENDERER_OUT, colorScheme, running: true, width: 1440, height: 900 });
    t.after(() => f.close());
    await f.open('chat-a');
    const mark = f.page.locator('.elpis-working-mark').last();
    await mark.waitFor();
    const x = async () => Math.round((await mark.boundingBox()).x * 10) / 10;
    const initialX = await x();
    await f.page.waitForTimeout(2200);
    assert.equal(await x(), initialX, 'the timer appearing during a turn does not move the mark');
    await f.page.getByRole('button', { name: 'Show side panel', exact: true }).click();
    await f.page.getByRole('region', { name: 'Side panel', exact: true }).waitFor();
    assert.equal(await x(), initialX, 'opening the right panel does not move the mark');
    assert.equal(await f.page.locator('.turn-working').last().evaluate(row => getComputedStyle(row).marginTop), '7px', 'the Working row sits about one millimetre higher');
    for (const reducedMotion of ['no-preference', 'reduce']) {
      await f.page.emulateMedia({ reducedMotion });
      const actual = await mark.evaluate(svg => {
        const shape = svg.querySelector('path');
        const dot = svg.querySelector('circle');
        return {
          width: svg.getBoundingClientRect().width,
          height: svg.getBoundingClientRect().height,
          fill: getComputedStyle(shape).fill,
          strokeWidth: getComputedStyle(shape).strokeWidth,
          rotation: getComputedStyle(svg.querySelector('.elpis-working-rotor')).animationDuration,
          blinkingDot: !!dot && getComputedStyle(dot).animationName !== 'none',
          blink: dot && getComputedStyle(dot).animationDuration,
        };
      });
      assert.equal(actual.width, 18, 'the mark keeps the approved send-icon size');
      assert.equal(actual.height, 18);
      assert.equal(actual.fill, 'none', 'the previous filled diamond must not return');
      assert.notEqual(actual.strokeWidth, '0px');
      assert.equal(actual.rotation, '4s', 'system motion settings must not halve the approved speed');
      assert.equal(actual.blinkingDot, true);
      assert.equal(actual.blink, '2s');
    }
    assert.deepEqual(f.errors, []);
  });
}

test('working mark stays anchored when the Agents pane opens', async t => {
  const agent = { id: 'agent-panel', name: 'Agent panel helper', cwd: CWD, parentThreadId: 'chat-a', source: { subAgent: { thread_spawn: { agent_path: '/root/agent-panel' } } }, status: { type: 'idle' } };
  const f = await fixture({ staticDir: process.env.ELPIS_RENDERER_OUT, running: true, width: 1440, height: 900, threads: [...THREADS, agent] });
  t.after(() => f.close());
  await f.open('chat-a');
  const mark = f.page.locator('.turn-working .elpis-working-mark').last(); await mark.waitFor();
  await f.page.getByRole('button', { name: 'Hide agents panel', exact: true }).click();
  await f.page.locator('.team-panel').waitFor({ state: 'detached' });
  const closed = await geometry(f.page), closedX = Math.round((await mark.boundingBox()).x * 10) / 10;
  await f.page.getByRole('button', { name: 'Show agents panel', exact: true }).click();
  await f.page.locator('.team-panel').waitFor();
  const open = await geometry(f.page), openX = Math.round((await mark.boundingBox()).x * 10) / 10;
  assert.equal(openX, closedX, `opening the right Agents pane does not move the working mark: ${JSON.stringify({ closed, open })}`);
  assert.deepEqual(f.errors, []);
});

test('working mark stays anchored when the right panel opens at a 1004px CSS viewport and 1.64 device scale', async t => {
  const f = await fixture({ staticDir: process.env.ELPIS_RENDERER_OUT, running: true, width: 1004, height: 900, deviceScaleFactor: 1.64 });
  t.after(() => f.close());
  await f.open('chat-a');
  assert.equal(await f.page.evaluate(() => window.innerWidth), 1004, 'the fixture uses the reported CSS viewport width');
  assert.ok(Math.abs(await f.page.evaluate(() => window.devicePixelRatio) - 1.64) < 0.01, 'the fixture matches the reported device scale');
  const mark = f.page.locator('.turn-working .elpis-working-mark').last(); await mark.waitFor();
  const closed = await geometry(f.page), initialX = Math.round((await mark.boundingBox()).x * 10) / 10;
  await f.page.getByRole('button', { name: 'Show side panel', exact: true }).click();
  await f.page.getByRole('region', { name: 'Side panel', exact: true }).waitFor();
  const open = await geometry(f.page), panelX = Math.round((await mark.boundingBox()).x * 10) / 10;
  assert.equal(panelX, initialX, `opening the right panel at this width does not move the working mark: ${JSON.stringify({ closed, open })}`);
  assert.deepEqual(f.errors, []);
});

test('working mark stays anchored when the right panel opens in split view at 1004px', async t => {
  const f = await fixture({ staticDir: process.env.ELPIS_RENDERER_OUT, running: true, width: 1004, height: 900, deviceScaleFactor: 1.64 });
  t.after(() => f.close());
  await f.open('chat-a');
  await f.page.locator('.thread-row[data-thread-id="chat-b"]').getByRole('button', { name: /^Actions for/ }).click();
  await (await threadMenuItem(f.page, 'Open session in split view')).click();
  const split = f.page.frameLocator('iframe[title="Split session"]');
  await split.getByRole('textbox', { name: 'Message Elpis', exact: true }).waitFor();
  const mark = f.page.locator('.turn-working .elpis-working-mark').last(); await mark.waitFor();
  const closed = await geometry(f.page), initialX = Math.round((await mark.boundingBox()).x * 10) / 10;
  await f.page.getByRole('button', { name: 'Show side panel', exact: true }).click();
  await f.page.getByRole('region', { name: 'Side panel', exact: true }).waitFor();
  const open = await geometry(f.page), panelX = Math.round((await mark.boundingBox()).x * 10) / 10;
  assert.equal(panelX, initialX, `opening the right panel in split view does not move the working mark: ${JSON.stringify({ closed, open })}`);
  assert.deepEqual(f.errors, []);
});

for (const colorScheme of ['light', 'dark']) {
  test(`Working mark stays put with populated Files and a resized panel (${colorScheme})`, async () => {
    const f = await fixture({ colorScheme, running: true, width: 1600, height: 900, routes: {
      '/api/files/dir': () => ({ data: [{ name: 'README.md', dir: false }] }),
      '/api/file': () => ({ path: 'README.md', content: '# Fixture', size: 9, mtimeMs: 1 }),
    } }), { page } = f;
    try {
      await f.open('chat-a');
      const mark = page.locator('.elpis-working-mark').last();
      await mark.waitFor();
      const before = await geometry(page);
      await page.getByRole('button', { name: 'Show side panel', exact: true }).click();
      await page.getByRole('button', { name: 'New side panel tab', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Files', exact: true }).click();
      await page.getByRole('treeitem', { name: 'README.md', exact: true }).click();
      const opened = await geometry(page);
      assert.ok(opened.sidePanel.width >= 600, `populated Files has its real wide default: ${JSON.stringify(opened)}`);
      assert.equal(opened.mark.x, before.mark.x, `populated Files: ${JSON.stringify({ before, opened })}`);
      const edge = page.getByRole('separator', { name: 'Resize side panel' });
      const box = await edge.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x - 100, box.y + box.height / 2);
      await page.mouse.up();
      const resized = await geometry(page);
      assert.ok(resized.sidePanel.width > opened.sidePanel.width + 80, `real divider resized: ${JSON.stringify({ opened, resized })}`);
      assert.equal(resized.mark.x, before.mark.x, `resized Files: ${JSON.stringify({ before, resized })}`);
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  });
}
