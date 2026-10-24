// Real packaged app and engine (tests/real-app.cjs): opening Love Spot shows the latest message, readable, the first time,
// again after visiting a chat, and after a restart (24 Oct, A238: "when I open love spot it should take me to the latest
// message"). The board is far wider than the window, so a fit-everything view would shrink the note to a few pixels.
// ELPIS_TEST_APP=/packaged/app ELPIS_TEST_ENGINE=$HOME/.local/bin/elpis-next ELPIS_PLAYWRIGHT_PACKAGE=... [ELPIS_TEST_PORT=9461]
// [ELPIS_TEST_SHOTS=/dir] node --test tests/love-spot-latest.runtime.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { startApp, stopApp, skipFirstRun } = require('./real-app.cjs');
const { chooseTheme } = require('./controls.cjs');

const LATEST = '#ff00ff';
const note = (id, x, y, text, updated, strokeColor = '#1e1e1e') => ({ id, type: 'text', x, y, width: 420, height: 25, angle: 0, strokeColor,
  backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid', roughness: 0, opacity: 100, groupIds: [], frameId: null,
  roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated, link: null, locked: false, fontSize: 20,
  fontFamily: 6, text, originalText: text, textAlign: 'left', verticalAlign: 'top', containerId: null, autoResize: true, lineHeight: 1.25 });

/** A board whose newest note sits far from the others, and whose last array entry is an older note. */
async function writeBoard(home) {
  const dir = path.join(home, '.local/share/excalidraw-local'), now = Date.now();
  await fs.mkdir(dir, { recursive: true });
  const elements = [
    note('old-1', 0, 0, 'first note from last week', now - 7 * 864e5),
    note('old-2', 0, 300, 'second note', now - 6 * 864e5),
    note('latest', 6000, 5200, 'the newest message on the board', now - 60e3, LATEST),
    note('old-3', -2500, -1800, 'an old note added to the file last', now - 5 * 864e5),
  ];
  await fs.writeFile(path.join(dir, 'scene.excalidraw'), JSON.stringify({ type: 'excalidraw', version: 2, source: 'Love Spot', elements, files: {}, appState: {},
    page: { name: 'Current page', session: '7b6f0d3c-1f3e-4d55-9d2a-2f6f0f3b8a11' } }));
}

/** Where the newest note's pink pixels are drawn on the board, in CSS pixels, and the board's own size. */
async function latestOnScreen(page) {
  await page.locator('.love-spot-editor canvas.excalidraw__canvas.static').waitFor({ timeout: 20000 });
  await page.waitForTimeout(1500);
  return page.evaluate(() => {
    const canvas = document.querySelector('.love-spot-editor canvas.excalidraw__canvas.static');
    const scale = canvas.width / canvas.getBoundingClientRect().width;
    const { data, width, height } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    let top = Infinity, bottom = -1, left = Infinity, right = -1;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i] > 200 && data[i + 1] < 90 && data[i + 2] > 200) { top = Math.min(top, y); bottom = Math.max(bottom, y); left = Math.min(left, x); right = Math.max(right, x); }
    }
    return { found: bottom >= 0, height: (bottom - top + 1) / scale, top: top / scale, bottom: bottom / scale, left: left / scale, right: right / scale,
      boardWidth: width / scale, boardHeight: height / scale };
  });
}

function assertReadable(where, at) {
  assert.ok(at.found, `${where}: the newest message is not on screen`);
  assert.ok(at.height >= 14, `${where}: the newest message is ${at.height.toFixed(1)}px tall, too small to read`);
  assert.ok(at.top >= 0 && at.bottom <= at.boardHeight && at.left >= 0 && at.right <= at.boardWidth, `${where}: the newest message is cut off`);
}

const openLoveSpot = page => page.locator('aside.sidebar [data-nav-page="loveSpot"]').click();

test('opening Love Spot shows the latest message: first time, again, and after a restart', {
  skip: !process.env.ELPIS_TEST_APP || !process.env.ELPIS_TEST_ENGINE, timeout: 240000,
}, async () => {
  const port = Number(process.env.ELPIS_TEST_PORT || 9461), shots = process.env.ELPIS_TEST_SHOTS;
  let running;
  try {
    running = await startApp({ app: process.env.ELPIS_TEST_APP, port, engine: process.env.ELPIS_TEST_ENGINE });
    await writeBoard(running.home);
    await skipFirstRun(running.page);
    await openLoveSpot(running.page);
    assertReadable('first open', await latestOnScreen(running.page));
    if (shots) {
      await running.page.screenshot({ path: path.join(shots, 'latest-light.png') });
      await chooseTheme(running.page, 'dark'); await openLoveSpot(running.page); await running.page.waitForTimeout(1500);
      await running.page.screenshot({ path: path.join(shots, 'latest-dark.png') });
      await chooseTheme(running.page, 'light');
    }
    await running.page.locator('aside.sidebar [data-nav-page="chat"]').click().catch(() => running.page.getByRole('button', { name: 'New chat' }).first().click());
    await running.page.waitForTimeout(500);
    await openLoveSpot(running.page);
    assertReadable('opened again', await latestOnScreen(running.page));
    await stopApp(running); running = undefined;

    running = await startApp({ app: process.env.ELPIS_TEST_APP, port, engine: process.env.ELPIS_TEST_ENGINE });
    await writeBoard(running.home);
    await skipFirstRun(running.page);
    await openLoveSpot(running.page);
    assertReadable('after a restart', await latestOnScreen(running.page));
  } finally { await stopApp(running); }
});
