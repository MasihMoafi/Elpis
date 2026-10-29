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

  test(`the live Working row sits 1 px below its original place over the composer (${colorScheme})`, async () => {
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
      assert.ok(gap >= 21 && gap <= 23, `Working row to composer: ${gap}px (wanted 22 px: the original 23 less 1)`);
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  });
}

// "spaces must be in harmony": a message's actions (time, ‹ 1 / 2 ›, Reply, Copy, Edit, More …) share one box size and
// one centre line, and the gaps between what the eye sees (the ink of each glyph, the text of the time and the version
// group as one unit) are even. Ink is measured from the SVG geometry plus its stroke, so wide and narrow glyphs count.
const inkRow = row => {
  const ink = element => {
    const svgs = element.matches('svg') ? [element] : [...element.querySelectorAll('svg')];
    if (svgs.length) {
      const boxes = svgs.flatMap(svg => {
        const scale = svg.getBoundingClientRect().width / (svg.viewBox.baseVal?.width || svg.getBoundingClientRect().width);
        return [...svg.querySelectorAll('path, circle, rect, line, polyline, polygon, ellipse')].map(shape => {
          const r = shape.getBoundingClientRect(), style = getComputedStyle(shape);
          const half = style.stroke !== 'none' ? parseFloat(style.strokeWidth) * scale / 2 : 0;
          return { left: r.left - half, right: r.right + half, top: r.top - half, bottom: r.bottom + half };
        });
      });
      const text = [...element.childNodes].filter(node => node.nodeType === 3 && node.textContent.trim());
      for (const node of text) { const range = document.createRange(); range.selectNodeContents(node); const r = range.getBoundingClientRect(); boxes.push(r); }
      for (const span of element.querySelectorAll(':scope > span')) if (span.textContent.trim()) { const range = document.createRange(); range.selectNodeContents(span); boxes.push(range.getBoundingClientRect()); }
      return { left: Math.min(...boxes.map(b => b.left)), right: Math.max(...boxes.map(b => b.right)), top: Math.min(...boxes.map(b => b.top)), bottom: Math.max(...boxes.map(b => b.bottom)) };
    }
    const range = document.createRange(); range.selectNodeContents(element); return range.getBoundingClientRect();
  };
  const items = [...row.children].filter(element => element.getClientRects().length && (element.textContent.trim() || element.querySelector('svg')) && getComputedStyle(element).visibility !== 'hidden');
  return items.map(element => {
    const box = element.getBoundingClientRect(), i = ink(element), icon = element.matches('button') ? element : null, glyph = element.querySelector('svg')?.getBoundingClientRect() ?? box;
    return { name: element.getAttribute('aria-label') || element.className || element.tagName, box: icon ? `${box.width}x${box.height}` : null,
      cy: +((box.top + box.bottom) / 2).toFixed(2), glyphCy: +((glyph.top + glyph.bottom) / 2).toFixed(2), inkLeft: i.left, inkRight: i.right };
  });
};
for (const colorScheme of ['light', 'dark']) test(`message actions share one box, one centre line and even ink gaps, with and without versions (${colorScheme})`, async () => {
  const f = await fixture(options(colorScheme, { routes: { ...routes, '/api/threads/chat-a/versions': () => ({ versions: [{ turnId: 't1', index: 2, count: 2, previous: 'chat-b' }] }) } })), { page } = f;
  try {
    await f.open('chat-a');
    await page.locator('.user-turn').first().getByRole('group', { name: 'Message versions' }).waitFor();
    const rows = { 'user with versions': page.locator('.user-turn').nth(0), 'user': page.locator('.user-turn').nth(1), 'agent': page.locator('.message.agent').nth(1) };
    const failures = [];
    for (const [label, message] of Object.entries(rows)) {
      await message.evaluate(element => element.scrollIntoView({ block: 'center' })); await message.hover();
      const row = message.locator('.message-actions');
      await row.getByRole('button', { name: /^Copy (message|reply)$/ }).waitFor();
      const m = await row.evaluate(inkRow);
      await capture(page, `message-actions-${label.replace(/ /g, '-')}-${colorScheme}`, around([await row.boundingBox()], 16));
      const boxes = [...new Set(m.filter(item => item.box).map(item => item.box))];
      if (boxes.length !== 1) failures.push(`${label}: buttons differ in size: ${boxes.join(', ')}`);
      const centres = m.flatMap(item => [item.cy, item.glyphCy]);
      if (Math.max(...centres) - Math.min(...centres) > 0.5) failures.push(`${label}: not on one centre line: ${centres.join(', ')}`);
      const gaps = m.slice(1).map((item, i) => +(item.inkLeft - m[i].inkRight).toFixed(1));
      if (Math.max(...gaps) - Math.min(...gaps) > 1) failures.push(`${label}: uneven ink gaps ${m.map(item => item.name).join(' | ')}: ${gaps.join(', ')}`);
    }
    assert.deepEqual(failures, []);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

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
