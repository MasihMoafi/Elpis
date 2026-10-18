// Real settings controls against the exported renderer and an isolated local fixture.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('./parity-fixture.cjs');
const { openSettings, leaveSettings, chooseOption, controlValue } = require('./controls.cjs');
const { uiFit } = require('./ui-fit.cjs');
const ACCENTS = ['amber', 'blue', 'teal', 'green', 'violet', 'rose', 'orange'];
const SHOTS = process.env.ELPIS_THEMES_SHOTS || path.join(process.env.HOME, '.cache/elpis-tests/night-themes');
async function appearance(page) {
  await openSettings(page);
  await page.getByRole('tab', { name: 'Appearance', exact: true }).click();
  return page.getByRole('tabpanel', { name: 'Appearance', exact: true });
}
const token = (page, name) => page.evaluate(name => getComputedStyle(document.documentElement).getPropertyValue(name).trim(), name);
const font = locator => locator.evaluate(element => getComputedStyle(element).fontFamily);
const theme = (page, value) => page.getByRole('radiogroup', { name: 'Theme', exact: true }).getByRole('radio', { name: value, exact: true }).click();
async function selected(page, label, value) {
  assert.equal(await controlValue(page.getByLabel(label, { exact: true })), value);
}

test('accent and chat font apply instantly, persist after restart, and keep their separate roles', async t => {
  const f = await fixture({ width: 1280, height: 900 }), { page } = f; t.after(f.close);
  await f.open('chat-a');
  const original = await font(page.locator('.message.agent .markdown').first());
  await appearance(page); await theme(page, 'Dark');
  const amber = await token(page, '--primary');
  await chooseOption(page.getByLabel('Accent colour', { exact: true }), 'teal');
  assert.notEqual(await token(page, '--primary'), amber);
  await chooseOption(page.getByLabel('Chat font', { exact: true }), 'serif'); await leaveSettings(page);
  assert.match(await font(page.locator('.message.agent .markdown').first()), /DejaVu Serif/);
  assert.match(await font(f.composer), /DejaVu Serif/);
  assert.match(await font(page.locator('.markdown code').first()), /Mono|monospace/);
  assert.doesNotMatch(await font(page.locator('.account-row')), /DejaVu Serif/);
  await page.reload(); await f.open('chat-a'); assert.match(await font(f.composer), /DejaVu Serif/);
  await appearance(page);
  await selected(page, 'Accent colour', 'teal'); await selected(page, 'Chat font', 'serif');
  assert.equal(await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Dark', exact: true }).getAttribute('aria-checked'), 'true');
  for (const [choice, expected] of [['mono', /DejaVu Sans Mono/], ['sans', /Inter/], ['system', /system-ui/], ['default', /Inter/]]) {
    await chooseOption(page.getByLabel('Chat font', { exact: true }), choice);
    await leaveSettings(page); assert.match(await font(f.composer), expected); await appearance(page);
  }
  await leaveSettings(page);
  assert.equal(await font(page.locator('.message.agent .markdown').first()), original);
  assert.deepEqual(f.errors, []);
});

test('all seven accents change shared tokens and meet text contrast in both themes', async t => {
  const f = await fixture({ width: 1280, height: 900 }), { page } = f; t.after(f.close);
  await appearance(page);
  // A deliberate bad palette must make the exact same contrast harness fail.
  if (process.env.ELPIS_THEMES_MUTANT === 'contrast') await page.addStyleTag({ content: 'html:root[data-accent] { --accent-light:#fff; --accent-dark:#000; }' });
  const measurements = [];
  for (const mode of ['Light', 'Dark']) {
    await theme(page, mode); const primaries = new Set();
    for (const accent of ACCENTS) {
      await chooseOption(page.getByLabel('Accent colour', { exact: true }), accent);
      const result = await page.evaluate(() => {
        const root = getComputedStyle(document.documentElement), canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1; const ctx = canvas.getContext('2d');
        const rgb = value => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3); };
        const read = name => root.getPropertyValue(name).trim();
        const luminance = value => rgb(value).map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4).reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0);
        const ratio = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
        const primary = read('--primary'), surfaces = ['--background', '--card', '--sidebar', '--recessed', '--composer'];
        return { primary, ring: read('--ring'), gold: read('--gold'), ratios: Object.fromEntries(surfaces.map(name => [name, ratio(primary, read(name))])), button: ratio(primary, read('--primary-foreground')) };
      });
      primaries.add(result.primary);
      for (const [surface, ratio] of Object.entries(result.ratios)) assert.ok(ratio >= 4.5, `${mode} ${accent} on ${surface}: ${ratio}`);
      assert.ok(result.button >= 4.5, `${mode} ${accent} button: ${result.button}`);
      assert.equal(result.ring, result.primary); assert.equal(result.gold, result.primary);
      measurements.push({ mode, accent, ...result });
    }
    assert.equal(primaries.size, 7, 'each accent has its own token');
  }
  await fs.mkdir(SHOTS, { recursive: true });
  await fs.writeFile(path.join(SHOTS, 'contrast.json'), JSON.stringify(measurements, null, 2));
  assert.deepEqual(f.errors, []);
});

test('system theme follows OS changes while explicit theme ignores them', async t => {
  const f = await fixture({ colorScheme: 'light' }), { page } = f; t.after(f.close);
  await appearance(page); await theme(page, 'System');
  await chooseOption(page.getByLabel('Accent colour', { exact: true }), 'blue');
  const light = await token(page, '--primary');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
  assert.notEqual(await token(page, '--primary'), light);
  await theme(page, 'Light'); assert.equal(await token(page, '--primary'), light);
  await page.emulateMedia({ colorScheme: 'light' }); await page.emulateMedia({ colorScheme: 'dark' });
  assert.equal(await token(page, '--primary'), light);
  await page.reload(); await appearance(page); assert.equal(await token(page, '--primary'), light);
  assert.deepEqual(f.errors, []);
});

test('settings and chat fit in three light/dark combinations, including keyboard and a narrow window', async t => {
  const f = await fixture({ width: 1280, height: 900, chat: [
    ['t1', 'How does the parser work?', 'The parser runs in **two passes**.\n\n1. Scan the source into tokens.\n2. Build a syntax tree from those tokens.\n\n```ts\nconst tokens = scan(source);\nconst result = parse(tokens);\n```\n\nUse `parse` for a complete expression. [Read the guide](https://example.invalid/guide) for examples.'],
    ['t2', 'What should I test first?', 'Start with an empty input, then try one valid expression.'],
  ] }), { page } = f; t.after(f.close);
  await fs.mkdir(SHOTS, { recursive: true }); await f.open('chat-a');
  for (const [mode, accent, choice] of [['Light', 'blue', 'sans'], ['Dark', 'teal', 'serif'], ['Dark', 'amber', 'mono']]) {
    await appearance(page); await theme(page, mode);
    await chooseOption(page.getByLabel('Accent colour', { exact: true }), accent);
    const chatFont = page.getByLabel('Chat font', { exact: true });
    await chatFont.focus(); await page.keyboard.press('Enter');
    await page.keyboard.type(choice, { delay: 80 });
    await page.keyboard.press('Enter'); await selected(page, 'Chat font', choice);
    assert.deepEqual(await uiFit(page.getByRole('tabpanel', { name: 'Appearance' })), []);
    const name = `${mode.toLowerCase()}-${accent}-${choice}`;
    await page.screenshot({ path: path.join(SHOTS, `${name}-settings.png`) });
    await leaveSettings(page); await f.composer.fill('A readable conversation, in the font you choose.');
    await page.screenshot({ path: path.join(SHOTS, `${name}-chat.png`) });
  }
  await page.setViewportSize({ width: 900, height: 700 }); await appearance(page);
  assert.deepEqual(await uiFit(page.getByRole('tabpanel', { name: 'Appearance' })), []);
  await page.screenshot({ path: path.join(SHOTS, 'narrow-settings.png') });
  assert.deepEqual(f.errors, []);
});

test('unknown saved accent/font values recover to the defaults', async t => {
  const f = await fixture({ storage: { 'elpis-preferences-v1': JSON.stringify({ accent: 'bad', chatFont: 'url(bad)' }) } }), { page } = f; t.after(f.close);
  await appearance(page); await selected(page, 'Accent colour', 'amber'); await selected(page, 'Chat font', 'default');
  assert.deepEqual(f.errors, []);
});

test('a failed preference write shows an error and leaves the saved choice active', async t => {
  const f = await fixture(), { page } = f; t.after(f.close);
  await appearance(page);
  const previous = await token(page, '--primary');
  await page.evaluate(() => {
    const storage = window.elpisDesktop.storage, save = storage.setItem;
    storage.setItem = (key, value) => { if (key === 'elpis-preferences-v1') throw Error('Fixture disk full'); save(key, value); };
  });
  await chooseOption(page.getByLabel('Accent colour', { exact: true }), 'blue');
  await page.getByRole('alert').filter({ hasText: 'Fixture disk full' }).waitFor();
  await selected(page, 'Accent colour', 'amber'); assert.equal(await token(page, '--primary'), previous);
  assert.deepEqual(f.errors, []);
});

test('saved appearance is applied by the shared layout on a standalone page', async t => {
  const f = await fixture(), { page } = f; t.after(f.close);
  await appearance(page); await theme(page, 'Light');
  await chooseOption(page.getByLabel('Accent colour', { exact: true }), 'teal');
  await chooseOption(page.getByLabel('Chat font', { exact: true }), 'serif');
  const primary = await token(page, '--primary');
  // The exported error page uses the root layout without mounting the chat app.
  await page.goto(new URL('/404.html', page.url()).href);
  await page.getByRole('heading', { name: '404', exact: true }).waitFor();
  await page.waitForFunction(() => document.documentElement.dataset.accent === 'teal');
  assert.equal(await token(page, '--primary'), primary);
  assert.match(await token(page, '--chat-font'), /DejaVu Serif/);
  assert.deepEqual(f.errors, []);
});

test('the chat font also reaches side-chat messages and its composer', async t => {
  const f = await fixture({ routes: {
    '/api/threads/chat-a/side-chat': () => ({ threadId: 'side-a' }),
    '/api/side-chats/side-a/turns': () => ({ turn: { id: 'side-turn' } }),
  } }), { page } = f; t.after(f.close);
  await f.open('chat-a'); await appearance(page);
  await chooseOption(page.getByLabel('Chat font', { exact: true }), 'serif'); await leaveSettings(page);
  await f.composer.press('Control+;');
  const box = page.getByRole('textbox', { name: 'Side question', exact: true });
  assert.match(await font(box), /DejaVu Serif/);
  await box.fill('A side question in the selected font.'); await box.press('Enter');
  const message = page.getByRole('region', { name: 'Side chat' }).locator('.message.user').first();
  await message.waitFor(); assert.match(await font(message), /DejaVu Serif/);
  assert.deepEqual(f.errors, []);
});
