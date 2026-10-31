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
const { assertCollectionIcon } = require('./collection-icon-assertions.cjs');
const { FACE_DATA_URL } = require('../bridge/matilda-face.cjs');
const { icons: selectedMusicIcons } = require('./fixtures/selected-music-icons.json');

const shots = process.env.ELPIS_PARITY_SHOTS;
const routes = {
  '/api/voice': () => ({ available: true }),
  '/api/tools/transcription': () => ({ available: true, backend: 'local', label: 'Local Whisper' }),
};
const options = (colorScheme, extra = {}) => ({ colorScheme, width: 1130, height: 800, routes, ...extra });
async function capture(page, name, clip) {
  if (!shots) return;
  await fs.mkdir(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, `${name}.png`), clip });
}
const box = rect => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
const normalizedPath = value => value.replace(/,/g, ' ').trim().split(/\s+/).join(' ');
const luminance = color => {
  const rgb = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  assert.ok(rgb?.length === 3, `expected an opaque RGB color, got ${color}`);
  const channels = rgb.map(value => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
};
const contrast = (foreground, background) => {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
};
const around = (rects, pad = 24) => {
  const left = Math.min(...rects.map(r => r.x)), top = Math.min(...rects.map(r => r.y));
  const right = Math.max(...rects.map(r => r.x + r.width)), bottom = Math.max(...rects.map(r => r.y + r.height));
  return { x: Math.max(0, left - pad), y: Math.max(0, top - pad), width: right - left + 2 * pad, height: bottom - top + 2 * pad };
};

for (const colorScheme of ['light', 'dark']) {
  test(`composer actions share one 16px stroke, one centre line without an extra send menu (${colorScheme})`, async () => {
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
      assert.equal(sizes[0], '28x28', 'the shared box uses --control-h at 28px');
      const glyphs = m.map(item => `${item.glyph.width}x${item.glyph.height}`);
      assert.deepEqual(glyphs, Array(names.length).fill(glyphs[0]), `every glyph has one size: ${glyphs.join(', ')}`);
      assert.equal(glyphs[0], '16x16');
      const centres = m.flatMap(item => [item.box.cy, item.glyph.cy]);
      assert.ok(Math.max(...centres) - Math.min(...centres) <= 0.5, `one centre line: ${centres.join(', ')}`);
      assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 0.5, `voice → mic → Stop → Send box gaps are even: ${gaps.join(', ')}`);
      const stopShape = await row.getByRole('button', { name: 'Stop response' }).locator('svg').evaluate(svg => {
        const path = svg.querySelector('path');
        if (!path) return { fill: getComputedStyle(svg).fill, minimum: 0, maximum: 2 };
        const box = path.getBBox(), length = path.getTotalLength();
        const distances = Array.from({ length: 32 }, (_, i) => {
          const p = path.getPointAtLength(length * i / 32);
          return Math.abs((p.x - box.x - box.width / 2) / (box.width / 2)) + Math.abs((p.y - box.y - box.height / 2) / (box.height / 2));
        });
        return { fill: getComputedStyle(svg).fill, minimum: Math.min(...distances), maximum: Math.max(...distances) };
      });
      assert.equal(stopShape.fill, 'none', 'Stop is outlined');
      assert.ok(stopShape.minimum >= .8 && stopShape.maximum <= 1.2, `Stop is a diamond rather than a square: ${JSON.stringify(stopShape)}`);
      assert.equal(await row.getByRole('button', { name: 'More send options', exact: true }).count(), 0, 'Send has no extra queue menu');
      assert.equal(await page.locator('.composer textarea').evaluate(el => el.getBoundingClientRect().height), 66, 'an empty composer starts at the taller typing height');
      const features = page.getByRole('group', { name: 'Elpis features' }).locator('.feature-chip');
      await features.first().waitFor();
      const featureMetrics = await features.evaluateAll(chips => chips.map(chip => {
        const style = getComputedStyle(chip), mark = chip.querySelector('.feature-dot, .context-ring-icon')?.getBoundingClientRect();
        return { font: style.fontSize, color: style.color, mark: mark?.width };
      }));
      assert.deepEqual([...new Set(featureMetrics.map(item => item.font))], ['12px']);
      assert.equal(new Set(featureMetrics.map(item => item.color)).size, 1, 'Ledger and feature labels use one colour');
      assert.deepEqual([...new Set(featureMetrics.map(item => item.mark))], [7], 'every status mark uses one dot size');
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  });

  test(`the live Working row sits two pixels higher over the composer (${colorScheme})`, async () => {
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
      assert.ok(gap >= 13 && gap <= 15, `Working row to composer: ${gap}px (wanted 14px after moving the row 2px higher)`);
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

test('approved collection paths cover all shared icon consumers in the composer and settings', async () => {
  const f = await fixture(options('light')), { page } = f;
  try {
    await f.open('chat-a');
    await page.locator('.composer [aria-label="Dictate message"]').waitFor();
    const check = (where, locator, name) => assertCollectionIcon(locator, name, where);
    const side = page.locator('aside.sidebar');
    await check('New chat', side.locator('[aria-label="New chat"] svg'), 'new-chat');
    await check('New chat tab', page.getByRole('button', { name: 'New chat tab', exact: true }).locator('svg'), 'plus');
    await check('Workflows', side.locator('[data-nav-page="canvas"] svg'), 'workflows');
    await check('Love Spot', side.locator('[data-nav-page="loveSpot"] svg'), 'love-spot');
    await check('Lab', side.locator('[data-nav-page="experimentLab"] svg'), 'experiment-lab');
    await check('Search', side.locator('.search-field svg'), 'search');
    await check('Theme', side.getByRole('button', { name: 'Use dark theme', exact: true }).locator('svg'), 'theme');
    await check('Settings', side.getByRole('button', { name: 'Settings', exact: true }).locator('svg'), 'settings');
    const composer = page.locator('form.composer');
    await check('Send', composer.locator('[aria-label="Send message"] svg'), 'send');
    await check('Add files and more', composer.getByRole('button', { name: 'Add files and more', exact: true }).locator('svg'), 'plus');
    await check('Dictate message', composer.getByRole('button', { name: 'Dictate message', exact: true }).locator('svg'), 'mic');
    const permissions = composer.getByRole('button', { name: 'Change permissions', exact: true });
    await permissions.click();
    const permissionMenu = page.getByRole('menu');
    for (const [label, asset] of [['Ask for approval', 'ask'], ['Approve for me', 'auto-approve'], ['Full access', 'full-access'], ['Bypass permissions', 'bypass']]) {
      await check(`Permission: ${label}`, permissionMenu.getByRole('menuitem', { name: new RegExp(label) }).locator('svg').first(), asset);
    }
    await page.keyboard.press('Escape');
    await composer.getByRole('button', { name: 'Add files and more', exact: true }).click();
    const menu = page.getByRole('menu');
    await check('Attach', menu.getByRole('menuitem', { name: /Add files or photos/ }).locator('svg'), 'attach');
    await check('Plan mode', menu.getByRole('menuitem', { name: /Plan mode/ }).locator('svg'), 'plan');
    await check('Shell', menu.getByRole('menuitem', { name: /Run as a shell command/ }).locator('svg'), 'terminal');
    await page.keyboard.press('Escape');
    await side.getByRole('button', { name: 'Settings', exact: true }).click();
    for (const [id, name] of [['general', 'settings'], ['notifications', 'bell'], ['appearance', 'theme'], ['voice', 'mic'], ['configuration', 'file-edit'],
      ['personalization', 'person'], ['shortcuts', 'keyboard'], ['providers', 'models'], ['mcp', 'tool'],
      ['browser', 'browser'], ['hooks', 'workflows'], ['git', 'branch'], ['worktrees', 'folder'], ['archived', 'archive']])
      await check(`Settings → ${id}`, page.locator(`#settings-tab-${id} svg`), name);
    await check('Settings → usage', page.locator('#settings-tab-usage svg'), 'context');
    await check('Settings → about', page.locator('#settings-tab-about svg'), 'context');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

for (const colorScheme of ['light', 'dark']) test(`approved music icons keep exact paths, contrast and aligned geometry (${colorScheme})`, { timeout: 60000 }, async () => {
  let muted = false;
  const actions = [];
  const music = { title: 'Masterpiece', artist: 'Linkin Park', uri: 'file:///music/masterpiece.m4a', status: 'Playing', canMute: true, muted };
  const f = await fixture(options(colorScheme, {
    routes: {
      ...routes,
      '/api/love-spot/companion': body => {
        if (body?.action === 'toggle-mute') { muted = !muted; actions.push(body.action); }
        return { pinned: true, face: FACE_DATA_URL, threadId: 'chat-a', favorite: { ...music, muted }, music: { ...music, muted }, reason: '' };
      },
    },
  }));
  try {
    await f.open('chat-a');
    await f.page.getByRole('button', { name: 'Chat with Matilda', exact: true }).hover();
    const states = [];
    for (const state of [
      { name: 'Mute music', icon: 'music-note', pressed: 'false' },
      { name: 'Unmute music', icon: 'music-muted', pressed: 'true' },
    ]) {
      const button = f.page.getByRole('button', { name: state.name, exact: true });
      await button.waitFor();
      assert.equal(await button.getAttribute('aria-pressed'), state.pressed);
      const svg = button.locator('svg');
      const expected = selectedMusicIcons[state.icon];
      const actual = await svg.evaluate((element, sizes) => {
        const path = element.querySelector('path');
        const originalStyle = { width: element.style.width, height: element.style.height };
        const measurements = sizes.map(size => {
          element.style.width = `${size}px`;
          element.style.height = `${size}px`;
          const rect = element.getBoundingClientRect(), bounds = path.getBBox();
          return {
            size, width: rect.width, height: rect.height,
            centerX: (path.getBoundingClientRect().left + path.getBoundingClientRect().width / 2) - rect.left,
            centerY: (path.getBoundingClientRect().top + path.getBoundingClientRect().height / 2) - rect.top,
            geometry: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
          };
        });
        element.style.width = originalStyle.width;
        element.style.height = originalStyle.height;
        const fill = getComputedStyle(path).fill;
        return {
          viewBox: element.getAttribute('viewBox'),
          paths: [...element.querySelectorAll('path')].map(item => item.getAttribute('d')),
          fillAttribute: element.getAttribute('fill'),
          fillRule: path.getAttribute('fill-rule'),
          transforms: [element, ...element.querySelectorAll('path')].filter(item => item.hasAttribute('transform')).length,
          color: getComputedStyle(element).color,
          fill,
          surface: getComputedStyle(element.closest('.matilda-float-controls')).backgroundColor,
          measurements,
        };
      }, [16, 20, 24]);
      assert.equal(actual.viewBox, expected.viewBox, `${state.icon}: approved frame`);
      assert.deepEqual(actual.paths.map(normalizedPath), expected.paths.map(normalizedPath), `${state.icon}: exact approved path`);
      assert.equal(actual.fillAttribute, 'currentColor');
      assert.equal(actual.fillRule, 'evenodd');
      assert.equal(actual.transforms, 0, 'approved paths have no transforms');
      assert.equal(actual.fill, actual.color, 'path uses the visible control colour');
      assert.ok(contrast(actual.fill, actual.surface) >= 3, `${state.icon}: control contrast is below 3:1`);
      for (const measurement of actual.measurements) {
        assert.ok(Math.abs(measurement.width - measurement.size) < 0.1, `${state.icon}: ${measurement.size}px width`);
        assert.ok(Math.abs(measurement.height - measurement.size) < 0.1, `${state.icon}: ${measurement.size}px height`);
        const { x, y, width, height } = measurement.geometry;
        const [minX, minY, viewWidth, viewHeight] = expected.viewBox.split(' ').map(Number);
        assert.ok(x >= minX && y >= minY && x + width <= minX + viewWidth && y + height <= minY + viewHeight,
          `${state.icon}: path geometry stays inside the approved frame`);
      }
      states.push(actual.measurements);
      if (state.name === 'Mute music') await button.click();
    }
    for (let index = 0; index < states[0].length; index++) {
      assert.ok(Math.abs(states[0][index].centerX - states[1][index].centerX) <= 1,
        `music and muted glyph centres align at ${states[0][index].size}px`);
      assert.ok(Math.abs(states[0][index].centerY - states[1][index].centerY) <= 1,
        `music and muted glyph centres align at ${states[0][index].size}px`);
    }
    assert.deepEqual(actions, ['toggle-mute']);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
