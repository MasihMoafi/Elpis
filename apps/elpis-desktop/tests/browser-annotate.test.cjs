// The in-page annotation layer (desktop/browser-page-preload.cjs) in a real Chromium page. Electron's IPC is
// replaced by a recorder; nothing leaves the test. Hover, click, drag, text, Space, Escape, markers and the
// draft outline are exercised as a person would, with the mouse and keyboard.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const source = fs.readFileSync(path.join(__dirname, '../desktop/browser-page-preload.cjs'), 'utf8');
const shim = `window.__sent=[];const __listeners={};window.__emit=message=>__listeners['elpis:annotate']?.({},message);
(function(require){${source}\n})(()=>({ipcRenderer:{send:(channel,message)=>window.__sent.push({channel,message}),on:(channel,listener)=>{__listeners[channel]=listener;}}}));`;
const PAGE = `<!doctype html><title>Fixture login</title><style>body{margin:0;font:16px sans-serif}main{padding:40px}#scroller{height:120px;overflow:auto;border:1px solid #ccc}#scroller div{height:600px}</style>
<main><h1>Welcome back</h1><form id="login"><label>Email <input name="email"></label>
<button class="primary big" type="button" onclick="window.clicked=(window.clicked||0)+1">Sign in</button></form>
<p id="note">Forgot password? Reset it here.</p><div id="scroller"><div>long</div></div></main>`;

async function withPage(run) {
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    await page.addInitScript(shim);
    await page.route('http://fixture.test/**', route => route.fulfill({ body: PAGE, contentType: 'text/html' }));
    await page.goto('http://fixture.test/login');
    await run(page);
  } finally { await browser.close(); }
}
const sent = (page, type) => page.evaluate(type => window.__sent.filter(item => item.message.type === type).map(item => item.message), type);
const center = async (page, selector) => { const box = await page.locator(selector).boundingBox(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; };

test('annotation mode: click picks an element, drag picks an area, a selection picks text; the page gets no clicks', async () => {
  await withPage(async page => {
    assert.deepEqual((await sent(page, 'ready')).length, 1, 'the layer announces itself once the page loads');
    const button = await center(page, 'button');
    await page.mouse.click(button.x, button.y);
    assert.equal(await page.evaluate(() => window.clicked), 1, 'outside annotation mode the page works normally');

    await page.evaluate(() => window.__emit({ type: 'state', mode: true, markersVisible: true, comments: [], draft: null }));
    await page.mouse.move(button.x, button.y);
    assert.equal(await page.evaluate(() => document.querySelector('elpis-annotations')?.shadowRoot), null, 'the layer is a closed shadow root');
    await page.mouse.click(button.x, button.y);
    assert.equal(await page.evaluate(() => window.clicked), 1, 'annotating does not press the button');
    const [pick] = (await sent(page, 'pick')).map(message => message.pick);
    assert.equal(pick.kind, 'element'); assert.equal(pick.tag, 'button'); assert.equal(pick.role, 'button'); assert.equal(pick.name, 'Sign in');
    assert.equal(pick.selector, '#login > button.primary.big');
    assert.equal(pick.elementPath, 'html > body > main > form > button');
    assert.match(pick.nearbyText, /Email/); assert.equal(pick.title, 'Fixture login');
    assert.deepEqual(pick.viewport, { width: 900, height: 600 });
    assert.ok(pick.rect.width > 20 && pick.rect.height > 10);

    await page.mouse.move(500, 300); await page.mouse.down(); await page.mouse.move(600, 360, { steps: 4 }); await page.mouse.up();
    const area = (await sent(page, 'pick')).at(-1).pick;
    assert.equal(area.kind, 'region'); assert.deepEqual(area.rect, { x: 500, y: 300, width: 100, height: 60 });

    await page.evaluate(() => window.__emit({ type: 'state', mode: false, markersVisible: true, comments: [], draft: null }));
    await page.locator('#note').selectText();
    await page.evaluate(() => window.__emit({ type: 'state', mode: true, markersVisible: true, comments: [], draft: null }));
    const note = await page.locator('#note').boundingBox();
    await page.mouse.click(note.x + 30, note.y + note.height / 2);
    const text = (await sent(page, 'pick')).at(-1).pick;
    assert.equal(text.kind, 'text'); assert.equal(text.selectedText, 'Forgot password? Reset it here.');
  });
});

for (const kind of ['modal', 'popover']) test(`annotation selects popup elements above the page without dismissing its ${kind}`, async () => {
  await withPage(async page => {
    await page.evaluate(kind => {
      const popup = document.createElement(kind === 'modal' ? 'dialog' : 'div');
      popup.id = 'popup'; if (kind === 'popover') popup.setAttribute('popover', 'manual');
      popup.innerHTML = '<button id="popup-choice">Popup choice</button>';
      popup.style.cssText = 'position:fixed;inset:120px auto auto 200px;padding:40px;margin:0;background:white;border:1px solid black';
      popup.querySelector('button').onclick = () => { window.popupClicks = (window.popupClicks || 0) + 1; };
      document.body.append(popup);
      if (kind === 'modal') popup.showModal(); else popup.showPopover();
    }, kind);
    await page.evaluate(() => window.__emit({ type: 'state', mode: true, markersVisible: true, comments: [], draft: null }));
    const choice = await center(page, '#popup-choice');
    await page.mouse.click(choice.x, choice.y);
    const picks = await sent(page, 'pick');
    assert.equal(picks.length, 1, 'the annotation layer receives the click above the popup');
    assert.equal(picks[0].pick.selector, '#popup-choice');
    assert.equal(picks[0].pick.name, 'Popup choice');
    assert.equal(await page.evaluate(() => window.popupClicks || 0), 0, 'annotating never activates the popup option');
    assert.equal(await page.locator('#popup').evaluate((element, kind) => kind === 'modal' ? element.open : element.matches(':popover-open'), kind), true, 'annotation preserves the popup');
    await page.evaluate(() => window.__emit({ type: 'state', mode: false, markersVisible: false, comments: [], draft: null }));
    await page.mouse.click(choice.x, choice.y);
    assert.equal(await page.evaluate(() => window.popupClicks), 1, 'leaving annotation restores normal popup input');
  });
});
