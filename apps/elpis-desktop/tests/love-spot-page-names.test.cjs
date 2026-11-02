// Masih, 28 Oct: "pages should show text as many as they can fully; not to show them halfly". The page picker sizes to
// the open page's name (it shrinks only when the toolbar runs out of room), and the page list shows each name whole.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');

const LONG = 'Wednesday design review with Matilda and the final icon notes';
const OTHER = 'Thursday sketches for the onboarding flow and the empty states';

for (const colorScheme of ['light']) test(`Love Spot page names show whole in the picker and its list (${colorScheme})`, async () => {
  const page = { name: LONG, session: 'fixture-page' };
  let scene = { elements: [], files: {}, appState: {}, page };
  const f = await fixture({ staticDir: process.env.ELPIS_RENDERER_OUT, width: 1440, height: 900, colorScheme, loveScene: scene,
    routes: { '/api/love-spot': body => { if (body) scene = body; return { scene, revision: 'fixture' }; }, '/api/love-spot/pages': () => ({ current: page, pages: [{ name: LONG, modified: 2 }, { name: OTHER, modified: 1 }] }) } });
  try {
    await f.page.goto(new URL('/love-spot.html#token=fixture', f.page.url()).href);
    const picker = f.page.getByRole('button', { name: 'Pages', exact: true }).filter({ hasText: LONG });
    await picker.waitFor();
    await f.page.waitForTimeout(300);
    const cut = element => element.evaluate(node => [...node.querySelectorAll('span'), node].filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.textContent));
    assert.deepEqual(await cut(picker), [], 'the picker shows the whole page name');
    await picker.click();
    for (const name of [LONG, OTHER]) {
      const item = f.page.getByRole('menuitem').filter({ hasText: name });
      await item.waitFor();
      assert.deepEqual(await cut(item), [], `the list shows "${name}" whole`);
    }
    if (process.env.SHOTS) await f.page.screenshot({ path: `${process.env.SHOTS}/love-pages-${colorScheme}.png` });
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
