const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { uiFit } = require('./ui-fit.cjs');

test('fit checker measures visible ink: collapsed details and covered dialog backgrounds are excluded', async () => {
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await page.setContent(`<style>
      body { margin: 20px; font: 16px Arial; }
      kbd { display: inline-flex; line-height: 1; }
      details p { position: absolute; top: 120px; left: 20px; margin: 0; }
      #background { position: absolute; top: 120px; left: 20px; margin: 0; }
      [role=alertdialog] { position: fixed; top: 100px; left: 10px; padding: 20px; background: white; }
      #clipped { width: 35px; overflow: hidden; white-space: nowrap; }
    </style><kbd>Ctrl Shift K</kbd>
    <details><summary>Advanced</summary><p>Hidden until opened</p></details>
    <p id="background">Visible background text</p>
    <div id="clipped" hidden>Clipped visible text</div>
    <button onclick="document.querySelector('[role=alertdialog]').hidden=false">Open dialog</button>
    <div role="alertdialog" hidden><p style="margin:0">Dialog covers the background</p></div>`);
    assert.deepEqual(await uiFit(page.locator('body')), [], 'closed details are not painted; short line boxes do not clip ink');
    await page.getByText('Advanced', { exact: true }).click();
    assert.ok((await uiFit(page.locator('body'))).some(issue => issue.startsWith('text overlap:')), 'opening details exposes the actual overlap');
    await page.getByText('Advanced', { exact: true }).click();
    await page.getByRole('button', { name: 'Open dialog' }).click();
    assert.deepEqual(await uiFit(page.locator('body')), [], 'the alert dialog paints over the background text');
    await page.evaluate(() => { document.querySelector('[role=alertdialog]').hidden = true; document.querySelector('#clipped').hidden = false; });
    assert.ok((await uiFit(page.locator('body'))).some(issue => issue.startsWith('clipped text:')), 'visible clipping still fails');
  } finally { await browser.close(); }
});
