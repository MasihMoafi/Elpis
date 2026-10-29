// Three of Masih's requests (29 Oct 2026), checked in the exported UI:
// 1. The composer's action row (voice, mic, Stop, Send): one box size, one centre line, even visible gaps, a solid Stop.
// 2. The live "Working" row sits close above the composer ("this is too far away from the chatbox, it shouldn't be").
// 3. Every icon with a twin in his SVG collection draws the collection's paths (tests/fixtures/elpis-icon-collection.json,
//    copied from ~/Desktop/p/vector-collection/review/assets/projects/elpis/interface).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('./parity-fixture.cjs');
const { icons } = require('./fixtures/elpis-icon-collection.json');

const shots = process.env.ELPIS_PARITY_SHOTS;
const routes = {
  '/api/voice': () => ({ available: true }),
  '/api/tools/transcription': () => ({ available: true, backend: 'local', label: 'Local Whisper' }),
};
const options = (colorScheme, extra = {}) => ({ colorScheme, width: 1130, height: 800, routes, ...extra });
const words = d => d.replace(/,/g, ' ').trim().split(/\s+/).join(' ');
async function capture(page, name, clip) {
  if (!shots) return;
  await fs.mkdir(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, `${name}.png`), clip });
}
const box = rect => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
const around = (rects, pad = 24) => {
  const left = Math.min(...rects.map(r => r.x)), top = Math.min(...rects.map(r => r.y));
  const right = Math.max(...rects.map(r => r.x + r.width)), bottom = Math.max(...rects.map(r => r.y + r.height));
  return { x: Math.max(0, left - pad), y: Math.max(0, top - pad), width: right - left + 2 * pad, height: bottom - top + 2 * pad };
};

for (const colorScheme of ['light', 'dark']) {
  test(`composer actions share one box size, one centre line and even visible gaps; Stop is solid (${colorScheme})`, async () => {
    const f = await fixture(options(colorScheme, { running: true })), { page } = f;
    try {
      await f.open('chat-a');
      const row = page.locator('.composer-actions');
      const names = ['Start voice chat', 'Dictate message', 'Stop response', 'Send follow-up'];
      for (const name of names) await row.getByRole('button', { name, exact: true }).waitFor();
      await page.mouse.move(5, 5);
      const m = await row.evaluate((element, names) => names.map(name => {
        const button = element.querySelector(`[aria-label="${name}"]`), glyph = button.querySelector('svg');
        const b = button.getBoundingClientRect(), g = glyph.getBoundingClientRect();
        return { name, box: { left: b.left, right: b.right, width: b.width, height: b.height, cy: b.top + b.height / 2 },
          glyph: { left: g.left, right: g.right, width: g.width, height: g.height, cy: g.top + g.height / 2 },
          d: [...glyph.querySelectorAll('path')].map(p => p.getAttribute('d')) };
      }), names);
      await capture(page, `composer-actions-${colorScheme}`, around([await row.boundingBox(), await page.locator('.composer').boundingBox()], 12));
      // What the eye sees: the plain icons, then the filled Send box.
      const seen = [m[0].glyph, m[1].glyph, m[2].glyph, m[3].box];
      const gaps = seen.slice(1).map((item, i) => +(item.left - seen[i].right).toFixed(2));
      const sizes = m.map(item => `${item.box.width}x${item.box.height}`);
      assert.deepEqual(sizes, Array(names.length).fill(sizes[2]), `every action has the box Stop has: ${sizes.join(', ')} (visible gaps ${gaps.join(', ')})`);
      assert.equal(sizes[0], '32x32', 'the shared box is the 32 px icon button');
      const glyphs = m.map(item => `${item.glyph.width}x${item.glyph.height}`);
      assert.deepEqual(glyphs, Array(names.length).fill(glyphs[0]), `every glyph has one size: ${glyphs.join(', ')}`);
      const centres = m.flatMap(item => [item.box.cy, item.glyph.cy]);
      assert.ok(Math.max(...centres) - Math.min(...centres) <= 0.5, `one centre line: ${centres.join(', ')}`);
      assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 0.5, `voice → mic → Stop → Send box gaps are even: ${gaps.join(', ')}`);
      const stop = m[2].d;
      assert.equal(stop.length, 1, 'Stop draws one shape');
      assert.equal((stop[0].match(/M/gi) ?? []).length, 1, 'Stop is a solid mark, not a hollow frame');
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  });

  test(`the live Working row sits close above the composer (${colorScheme})`, async () => {
    const f = await fixture(options(colorScheme, { running: true, height: 640 })), { page } = f;
    try {
      await f.open('chat-a');
      const working = page.locator('.turn-working[role="status"]').last();
      await working.waitFor();
      await page.locator('.chat-scroll').evaluate(element => element.scrollTo({ top: element.scrollHeight }));
      await page.waitForTimeout(100);
      const [w, c] = [await working.boundingBox(), await page.locator('form.composer').boundingBox()];
      const gap = c.y - (w.y + w.height);
      await capture(page, `working-row-${colorScheme}`, around([w, c], 16));
      assert.ok(gap >= 4 && gap <= 12, `Working row to composer: ${gap}px (wanted 4 to 12 px)`);
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  });
}

test('every icon with a twin in the SVG collection draws the collection paths', async () => {
  const f = await fixture(options('light')), { page } = f;
  try {
    await f.open('chat-a');
    await page.locator('.composer [aria-label="Dictate message"]').waitFor();
    // A clip path (the gauge's filled share) is not artwork.
    const drawn = locator => locator.first().evaluate(svg => ({ viewBox: svg.getAttribute('viewBox'), paths: [...svg.querySelectorAll('path:not(clipPath path)')].map(p => p.getAttribute('d')) }));
    const failures = [];
    const check = async (where, locator, name) => {
      const want = icons[name], got = await drawn(locator);
      if (got.viewBox !== want.viewBox || got.paths.map(words).join(' ') !== want.paths.map(words).join(' ')) failures.push(`${where} is not the collection's ${name}`);
    };
    const side = page.locator('aside.sidebar');
    await check('New chat', side.locator('[aria-label="New chat"] svg'), 'new-chat');
    await check('Workflows', side.locator('[data-nav-page="canvas"] svg'), 'workflows');
    await check('Love Spot', side.locator('[data-nav-page="loveSpot"] svg'), 'love-spot');
    await check('Lab', side.locator('[data-nav-page="experimentLab"] svg'), 'experiment-lab');
    await check('Search', side.locator('.search-field svg'), 'search');
    await check('Theme', side.getByRole('button', { name: 'Use dark theme', exact: true }).locator('svg'), 'theme');
    await check('Settings', side.getByRole('button', { name: 'Settings', exact: true }).locator('svg'), 'settings');
    const composer = page.locator('form.composer');
    await check('Add files and more', composer.locator('[aria-label="Add files and more"] svg'), 'plus');
    await check('Send', composer.locator('[aria-label="Send message"] svg'), 'send');
    await check('Dictate', composer.locator('[aria-label="Dictate message"] svg'), 'mic');
    await check('Context gauge', composer.locator('.context-ring svg'), 'context');
    await composer.getByRole('button', { name: 'Add files and more', exact: true }).click();
    const menu = page.getByRole('menu');
    await check('Attach', menu.getByRole('menuitem', { name: /Add files or photos/ }).locator('svg'), 'attach');
    await check('Plan mode', menu.getByRole('menuitem', { name: /Plan mode/ }).locator('svg'), 'plan');
    await check('Shell', menu.getByRole('menuitem', { name: /Run as a shell command/ }).locator('svg'), 'terminal');
    await page.keyboard.press('Escape');
    await composer.locator('[aria-label="Change permissions"]').click();
    for (const [label, name] of [['Ask for approval', 'ask'], ['Approve for me', 'auto-approve'], ['Full access', 'full-access'], ['Bypass permissions', 'bypass']])
      await check(label, page.getByRole('menu').getByRole('menuitem', { name: new RegExp(label) }).locator('svg'), name);
    await page.keyboard.press('Escape');
    await side.getByRole('button', { name: 'Settings', exact: true }).click();
    for (const [id, name] of [['general', 'settings'], ['notifications', 'bell'], ['appearance', 'theme'], ['voice', 'mic'], ['configuration', 'file-edit'],
      ['personalization', 'person'], ['shortcuts', 'keyboard'], ['usage', 'context'], ['providers', 'models'], ['about', 'context'], ['mcp', 'tool'],
      ['browser', 'browser'], ['hooks', 'workflows'], ['git', 'branch'], ['worktrees', 'folder'], ['archived', 'archive']])
      await check(`Settings → ${id}`, page.locator(`#settings-tab-${id} svg`), name);
    assert.deepEqual(failures, []);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
