// Each workspace page in the sidebar has an icon from one family: a vector that takes the text colour. On 18 Oct Love
// Spot showed a 512px photo instead. Local bridge fixture (tests/parity-fixture.cjs).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chooseTheme } = require('./controls.cjs');

async function iconPixels(page, png, positions) {
  return page.evaluate(async ({ png, positions }) => {
    const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
    return positions.map(({ name, icon }) => {
      const x = Math.floor(icon.x), y = Math.floor(icon.y), width = Math.ceil(icon.x + icon.width) - x, height = Math.ceil(icon.y + icon.height) - y;
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, x, y, width, height, 0, 0, width, height);
      const { data } = context.getImageData(0, 0, width, height), ink = [];
      for (let at = 0; at < data.length; at += 4) if (Math.max(...[0, 1, 2].map(channel => Math.abs(data[at + channel] - data[channel]))) > 25) ink.push((at / 4) % width);
      return { name, right: x + Math.max(...ink), width: Math.max(...ink) - Math.min(...ink) + 1 };
    });
  }, { png: png.toString('base64'), positions });
}

test('every sidebar page icon is a text-coloured vector, Love Spot included', async () => {
  const f = await fixture({ width: 1280 });
  try {
    const nav = f.page.locator('aside.sidebar nav[aria-label="Workspace"]');
    await nav.getByRole('button', { name: 'Love Spot', exact: true }).waitFor();
    const icons = await nav.locator('button').evaluateAll(buttons => buttons.map(button => {
      const icon = button.firstElementChild, paint = icon?.tagName === 'svg' ? icon.getAttribute('fill') === 'currentColor' || icon.getAttribute('stroke') === 'currentColor' : false;
      return `${button.textContent.trim()}: ${icon?.tagName}${paint ? ' currentColor' : ''}`;
    }));
    assert.ok(icons.some(line => line.startsWith('Love Spot')), icons.join('\n'));
    assert.deepEqual(icons.filter(line => !line.endsWith('svg currentColor')), [], 'icons outside the family');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Agents is absent from workspace navigation and commands; Workflows and sidebar Agent runs remain', async () => {
  const f = await fixture({ routes: { '/api/threads': (_, url) => ({ data: url.searchParams.has('ancestorThreadId') ? [] : [
    { id: 'chat-a', name: 'Parent chat', status: { type: 'idle' } },
    { id: 'run-a', name: 'Retained agent run', parentThreadId: 'chat-a', source: { subAgent: { thread_spawn: { agent_path: '/root/check' } } }, status: { type: 'idle' } },
  ], nextCursor: null }) } });
  try {
    const { page } = f;
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    const nav = page.locator('.nav-list');
    assert.equal(await nav.getByRole('button', { name: /^Agents\b/ }).count(), 0);
    for (const name of ['Workflows', 'Love Spot', 'Observability']) assert.equal(await nav.getByRole('button', { name, exact: true }).count(), 1);
    await page.getByRole('button', { name: 'Agent runs (1)', exact: true }).click();
    await page.getByRole('region', { name: 'Agent runs', exact: true }).getByText('Retained agent run', { exact: true }).waitFor();
    await page.keyboard.press('Control+k');
    await page.getByRole('combobox', { name: 'Search or start a chat' }).fill('Agents');
    assert.equal(await page.getByRole('option', { name: 'Agents', exact: true }).count(), 0);
    await page.keyboard.press('Escape');
    await f.composer.fill('/agents');
    assert.equal(await page.getByRole('option', { name: /^\/agents\b/ }).count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('sidebar header icon buttons share their size and right column in light and dark', async t => {
  const f = await fixture({ width: 2120, height: 1100, storage: {
    'elpis-projects-v1': JSON.stringify({ projects: [{ id: 'parser', name: 'Parser', cwd: '/tmp/parity-fixture' }], selectedId: null }),
  } });
  try {
    const { page } = f;
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    for (const theme of ['light', 'dark']) {
      if (theme === 'dark') await chooseTheme(page, theme);
      const aside = page.locator('aside.sidebar');
      const controls = ['Add new project', 'Group and sort', 'Start new chat in Parser'];
      const boxes = [], positions = [];
      for (const name of controls) {
        const button = aside.getByRole('button', { name, exact: true });
        const box = await button.boundingBox(), icon = await button.locator('svg').boundingBox();
        positions.push({ name, button: box, icon });
        boxes.push({ name, right: box.x + box.width, width: box.width, height: box.height, iconRight: icon.x + icon.width, iconWidth: icon.width, iconHeight: icon.height });
      }
      t.diagnostic(`${theme}: ${JSON.stringify(boxes)}`);
      assert.deepEqual(boxes.map(({ name, ...box }) => box), boxes.map(() => { const { name, ...box } = boxes[0]; return box; }));
      await aside.locator('.project-row').hover();
      const menu = aside.locator('.sidebar-group-actions button');
      const size = await menu.boundingBox();
      assert.deepEqual([size.width, size.height], [boxes[0].width, boxes[0].height]);
      await aside.getByRole('button', { name: 'Group and sort', exact: true }).click();
      await page.getByRole('menu', { name: 'Group and sort', exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await page.getByRole('menu', { name: 'Group and sort', exact: true }).waitFor({ state: 'hidden' });
      await page.waitForTimeout(350);
      await page.mouse.click(600, 100);
      const png = await page.screenshot({ animations: 'disabled' });
      const pixels = await iconPixels(page, png, positions);
      t.diagnostic(`${theme} pixels: ${JSON.stringify(pixels)}`);
      assert.equal(new Set(pixels.map(icon => icon.right)).size, 1, 'the visible icon right edges match by pixel');
      assert.equal(new Set(pixels.map(icon => icon.width)).size, 1, 'the visible icon widths match by pixel');
      if (process.env.ELPIS_SHOTS) {
        await fs.mkdir(process.env.ELPIS_SHOTS, { recursive: true });
        await fs.writeFile(path.join(process.env.ELPIS_SHOTS, `sidebar-${theme}.png`), png);
        await aside.screenshot({ path: path.join(process.env.ELPIS_SHOTS, `sidebar-${theme}-detail.png`), animations: 'disabled' });
        await fs.writeFile(path.join(process.env.ELPIS_SHOTS, `sidebar-${theme}-positions.json`), JSON.stringify(positions, null, 2));
        await fs.writeFile(path.join(process.env.ELPIS_SHOTS, `sidebar-${theme}-pixels.json`), JSON.stringify(pixels, null, 2));
      }
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
