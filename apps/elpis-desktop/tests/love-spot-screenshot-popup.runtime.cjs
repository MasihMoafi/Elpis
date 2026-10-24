// Real packaged app and engine (tests/real-app.cjs): a screenshot taken while Elpis runs shows a thumbnail in the screen's
// corner, as macOS does; clicking it opens that screenshot alone on a new Love Spot page to draw on, and ignoring it does
// nothing (A239, 24 Oct: "whenever I take a screenshot it should open a new page in the love spot for that screenshot so I
// can draw on it … or at least pops up and if I press it it does it"). GNOME saves screenshots to ~/Pictures/Screenshots;
// the copy's throwaway HOME has its own.
// ELPIS_TEST_APP=/packaged/app ELPIS_TEST_ENGINE=$HOME/.local/bin/elpis-next ELPIS_PLAYWRIGHT_PACKAGE=... [ELPIS_TEST_PORT=9463]
// [ELPIS_TEST_SHOTS=/dir] node --test tests/love-spot-screenshot-popup.runtime.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { startApp, stopApp, skipFirstRun } = require('./real-app.cjs');
const { chooseTheme } = require('./controls.cjs');

/** A screenshot as GNOME writes one: a real PNG drawn in the app's page, saved under the copy's Pictures/Screenshots. */
async function takeScreenshot(page, home, name, colour) {
  const dataURL = await page.evaluate(colour => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 960, height: 600 }), c = canvas.getContext('2d');
    c.fillStyle = colour; c.fillRect(0, 0, 960, 600); c.fillStyle = '#fff'; c.fillRect(80, 80, 400, 120);
    return canvas.toDataURL('image/png');
  }, colour);
  const folder = path.join(home, 'Pictures/Screenshots');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, name), Buffer.from(dataURL.split(',')[1], 'base64'));
}

const popupPage = browser => browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('screenshot-popup.html'));
async function waitForPopup(browser, timeout = 10000) {
  for (const end = Date.now() + timeout; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 200))) {
    const page = popupPage(browser);
    if (page && await page.locator('.shot.in img[src^="data:image/png"]').count().catch(() => 0)) return page;
  }
  throw new Error('No screenshot thumbnail appeared');
}
const board = page => page.evaluate(async () => {
  const [scene, pages, tray] = await Promise.all(['/api/love-spot', '/api/love-spot/pages', '/api/love-spot/screenshots'].map(url => fetch(url).then(r => r.json())));
  return { page: scene.scene.page.name, images: scene.scene.elements.filter(e => e.type === 'image' && !e.isDeleted).length, pages: pages.pages.map(p => p.name ?? p), tray: tray.screenshots.map(s => s.name) };
});

test('a new screenshot pops up a thumbnail; ignoring it does nothing and clicking it opens a new Love Spot page with it', {
  skip: !process.env.ELPIS_TEST_APP || !process.env.ELPIS_TEST_ENGINE, timeout: 180000,
}, async () => {
  const port = Number(process.env.ELPIS_TEST_PORT || 9463), shots = process.env.ELPIS_TEST_SHOTS;
  let running;
  try {
    running = await startApp({ app: process.env.ELPIS_TEST_APP, port, engine: process.env.ELPIS_TEST_ENGINE });
    const { page, browser, home } = running;
    await skipFirstRun(page);
    await page.waitForTimeout(1500);
    const start = await board(page);

    // Ignored: the thumbnail leaves by itself and nothing changes, except that Love Spot's tray still offers the screenshot.
    await takeScreenshot(page, home, 'Screenshot From 2026-10-24 21-00-01.png', '#3a6ea5');
    const ignored = await waitForPopup(browser);
    if (shots) await ignored.waitForTimeout(400), await ignored.screenshot({ path: path.join(shots, 'popup-light.png') });
    await ignored.waitForEvent('close', { timeout: 12000 });
    const after = await board(page);
    assert.equal(after.page, start.page, 'ignoring the thumbnail must not change the Love Spot page');
    assert.deepEqual(after.pages, start.pages, 'ignoring the thumbnail must not add a page');
    assert.equal(after.images, start.images);
    assert.ok(after.tray.includes('Screenshot From 2026-10-24 21-00-01.png'), 'the ignored screenshot stays in the Love Spot tray');
    assert.equal(await page.locator('.love-spot-editor').count(), 0, 'ignoring the thumbnail must not open Love Spot');

    // Clicked: Elpis shows Love Spot with a new page named after the screenshot, holding only that screenshot.
    if (shots) await chooseTheme(page, 'dark');
    await takeScreenshot(page, home, 'Screenshot From 2026-10-24 21-00-09.png', '#a53a6e');
    const popup = await waitForPopup(browser);
    if (shots) await popup.waitForTimeout(400), await popup.screenshot({ path: path.join(shots, 'popup-dark.png') });
    await popup.locator('.shot').click();
    await page.locator('.love-spot-editor canvas.excalidraw__canvas.static').waitFor({ timeout: 20000 });
    await page.waitForTimeout(1500);
    const opened = await board(page);
    assert.equal(opened.page, 'Screenshot From 2026-10-24 21-00-09', 'the screenshot opens on a new page named after it');
    assert.equal(opened.images, 1, 'the new page holds the screenshot');
    assert.ok(opened.pages.includes(start.page), 'the previous page is kept');
    assert.ok(!opened.tray.includes('Screenshot From 2026-10-24 21-00-09.png'), 'the opened screenshot leaves the tray');
    assert.equal(popupPage(browser), undefined, 'the thumbnail closes once clicked');
    await assert.doesNotReject(page.getByRole('button', { name: 'Pages', exact: true }).filter({ hasText: 'Screenshot From 2026-10-24 21-00-09' }).waitFor({ timeout: 5000 }), 'the page menu names the new page');
    if (shots) {
      await page.screenshot({ path: path.join(shots, 'opened-dark.png') });
      await chooseTheme(page, 'light'); await page.locator('aside.sidebar [data-nav-page="loveSpot"]').click(); await page.waitForTimeout(1500);
      await page.screenshot({ path: path.join(shots, 'opened-light.png') });
    }
  } finally { await stopApp(running); }
});
