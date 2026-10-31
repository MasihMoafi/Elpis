// Real settings controls against the exported renderer and an isolated local fixture.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('./parity-fixture.cjs');
const { LOGO_ACCENT, openSettings, leaveSettings, chooseOption, controlValue } = require('./controls.cjs');
const { uiFit } = require('./ui-fit.cjs');
const { contrastFailures } = require('./hud-contrast.cjs');
const { colours, evidence, assertColours } = require('./primary-action-colours.cjs');
const ACCENTS = ['amber', 'blue', 'teal', 'green', 'violet', 'rose', 'orange'];
const UNCHANGED_ACCENTS = {
  Light: { blue: '#2458b8', teal: '#146b67', green: '#29683f', violet: '#6b44ac', rose: '#a73459' },
  Dark: { blue: '#8bb7ff', teal: '#68d4c7', green: '#8bd49f', violet: '#c1a0fa', rose: '#f39cbb' },
};

test('A87 Send follows the logo at rest, hover, pressed, keyboard focus and disabled in both themes', async () => {
  const directory = process.env.ELPIS_A87_SHOTS;
  const measurements = [];
  for (const colorScheme of ['light', 'dark']) {
    const f = await fixture({ width: 1280, height: 900, colorScheme });
    try {
      await f.open('chat-a');
      for (const accent of ['amber', 'orange']) {
        await appearance(f.page);
        await chooseOption(f.page.getByLabel('Accent colour', { exact: true }), accent);
        await leaveSettings(f.page);
        measurements.push(...await colours(f.page, colorScheme, directory, accent));
      }
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }
  await evidence(directory, measurements);
  assertColours(measurements);
});
test('default and orange accents use the exact main logo colour in both themes', async t => {
  const expected = LOGO_ACCENT.slice(1).match(/../g).map(value => parseInt(value, 16));
  const f = await fixture({ width: 1280, height: 900 }), { page } = f; t.after(f.close);
  await f.open('chat-a');
  for (const mode of ['light', 'dark']) for (const accent of [null, 'amber', 'orange']) {
    const colours = await page.evaluate(({ mode, accent }) => {
      document.documentElement.classList.toggle('dark', mode === 'dark');
      if (accent) document.documentElement.dataset.accent = accent;
      else delete document.documentElement.dataset.accent;
      const probe = document.createElement('span');
      probe.style.color = 'var(--primary)'; document.body.append(probe);
      const primary = getComputedStyle(probe).color.match(/[\d.]+/g).slice(0, 3).map(Number);
      probe.remove();
      probe.style.color = 'var(--primary-action)'; document.body.append(probe);
      const action = getComputedStyle(probe).color.match(/[\d.]+/g).slice(0, 3).map(Number);
      probe.remove();
      return { primary, action };
    }, { mode, accent });
    assert.deepEqual(colours.primary, expected, `${mode} ${accent || 'default'} matches the logo`);
    assert.deepEqual(colours.action, expected, 'Send shares the primary token');
  }
});
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

test('accent applies instantly and persists while every interface surface stays Inter', async t => {
  const f = await fixture({ width: 1280, height: 900 }), { page } = f; t.after(f.close);
  await f.open('chat-a');
  await appearance(page); await theme(page, 'Dark');
  const amber = await token(page, '--primary');
  await chooseOption(page.getByLabel('Accent colour', { exact: true }), 'teal');
  assert.notEqual(await token(page, '--primary'), amber);
  await leaveSettings(page);
  assert.match(await font(page.locator('.message.agent .markdown').first()), /Inter/);
  assert.match(await font(f.composer), /Inter/);
  assert.match(await font(page.locator('.markdown code').first()), /Mono|monospace/);
  assert.match(await font(page.locator('.account-row')), /Inter/);
  await page.reload(); await f.open('chat-a'); assert.match(await font(f.composer), /Inter/);
  await appearance(page);
  await selected(page, 'Accent colour', 'teal');
  assert.equal(await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Dark', exact: true }).getAttribute('aria-checked'), 'true');
  await leaveSettings(page);
  assert.match(await font(page.locator('.message.agent .markdown').first()), /Inter/);
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
        const probe = document.createElement('a');
        probe.className = 'text-primary'; probe.textContent = 'Accent link'; document.body.append(probe);
        const text = getComputedStyle(probe).color; probe.remove();
        const primary = read('--primary'), surfaces = ['--background', '--card', '--sidebar', '--recessed', '--composer'];
        return { primary, text, ring: read('--ring'), gold: read('--gold'), ratios: Object.fromEntries(surfaces.map(name => [name, ratio(text, read(name))])), button: ratio(primary, read('--primary-foreground')) };
      });
      primaries.add(result.primary);
      for (const [surface, ratio] of Object.entries(result.ratios)) assert.ok(ratio >= 4.5, `${mode} ${accent} on ${surface}: ${ratio}`);
      assert.ok(result.button >= 4.5, `${mode} ${accent} button: ${result.button}`);
      if (UNCHANGED_ACCENTS[mode][accent]) assert.equal(result.primary, UNCHANGED_ACCENTS[mode][accent], `${mode} ${accent} stays unchanged`);
      assert.equal(result.ring, result.primary); assert.equal(result.gold, result.primary);
      measurements.push({ mode, accent, ...result });
    }
    assert.equal(primaries.size, 6, 'amber and orange share the approved logo token');
  }
  await fs.mkdir(SHOTS, { recursive: true });
  await fs.writeFile(path.join(SHOTS, 'contrast.json'), JSON.stringify(measurements, null, 2));
  assert.deepEqual(f.errors, []);
});

test('Full access and healthy context ring use the readable theme accent', async t => {
  const routes = {
    '/api/threads/chat-a/context': () => ({
      threadId: 'chat-a',
      ledger: { used: 100, window: 1000, categories: [], basis: 'engine' },
      compact: { available: true },
    }),
    '/api/threads/chat-a/permissions': ({ permissions }) => ({ permissions }),
  };
  const f = await fixture({ width: 1280, height: 900, routes }), { page } = f; t.after(f.close);
  await f.open('chat-a');
  await page.getByRole('button', { name: 'Change permissions', exact: true }).click();
  await page.getByRole('menuitem', { name: /Full access/ }).click();
  await page.locator('.context-ring .context-ring-fill').waitFor();

  for (const mode of ['Light', 'Dark']) {
    await appearance(page);
    await theme(page, mode);
    for (const accent of ['teal', ...ACCENTS.filter(accent => accent !== 'teal')]) {
      await chooseOption(page.getByLabel('Accent colour', { exact: true }), accent);
      await page.waitForFunction(value => document.documentElement.dataset.accent === value, accent);
      await leaveSettings(page);
      const actual = await page.evaluate(() => {
        const primary = document.createElement('span');
        primary.style.color = 'var(--primary)'; document.body.append(primary);
        const expected = getComputedStyle(primary).color; primary.remove();
        const permission = document.querySelector('.composer-pill.permissions-full');
        const icons = permission?.querySelectorAll('svg');
        const ring = document.querySelector('.context-ring .context-ring-fill');
        return {
          expected,
          permission: permission && getComputedStyle(permission).color,
          lock: icons?.[0] && getComputedStyle(icons[0]).color,
          caret: icons?.[1] && getComputedStyle(icons[1]).color,
          ring: ring && getComputedStyle(ring).stroke,
        };
      });
      const label = `${mode} ${accent}`;
      const exactTeal = mode === 'Light' && accent === 'teal' ? 'rgb(20, 107, 103)' : mode === 'Dark' && accent === 'teal' ? 'rgb(104, 212, 199)' : null;
      if (exactTeal) {
        assert.equal(actual.expected, exactTeal, `${label}: selected accent resolves to exact theme teal`);
        assert.deepEqual({ permission: actual.permission, lock: actual.lock, caret: actual.caret, ring: actual.ring },
          { permission: exactTeal, lock: exactTeal, caret: exactTeal, ring: exactTeal }, `${label}: rendered controls use exact theme teal`);
      }
      assert.equal(actual.permission, actual.expected, `${label}: Full access text uses theme primary`);
      assert.equal(actual.lock, actual.expected, `${label}: Full access lock uses theme primary`);
      assert.equal(actual.caret, actual.expected, `${label}: Full access caret uses theme primary`);
      assert.ok(actual.ring, `${label}: the healthy context ring is rendered`);
      assert.equal(actual.ring, actual.expected, `${label}: healthy context ring uses theme primary`);
      await appearance(page);
    }
  }
  assert.deepEqual(f.errors, []);
});

test('light orange accents keep real chat and Settings text readable, with orange markers and dark fill labels', async t => {
  const f = await fixture({ width: 1280, height: 900, chat: [
    ['t1', 'How does the parser work?', 'The parser runs in **two passes**.\n\n1. Scan the source into tokens.\n2. Build a syntax tree.\n\nSee [the guide](https://example.invalid/guide) for examples.', [], null],
    ['t2', 'What should I test first?', 'Start with an empty input, then try one valid expression.', [], null],
  ] }), { page } = f; t.after(f.close);
  await fs.mkdir(SHOTS, { recursive: true });
  await f.open('chat-a');
  await page.getByRole('button', { name: 'New chat tab', exact: true }).click();
  await f.open('chat-b');
  await page.getByRole('tab', { name: 'Fix the parser', exact: true }).click();
  for (const mode of ['Light', 'Dark']) for (const accent of ['amber', 'orange']) {
    await appearance(page); await theme(page, mode);
    await chooseOption(page.getByLabel('Accent colour', { exact: true }), accent);
    await page.getByRole('listbox').waitFor({ state: 'hidden' });
    await page.mouse.move(1260, 880);
    assert.deepEqual(await page.evaluate(contrastFailures), [], `${mode} ${accent} Settings text contrast`);
    if (accent === 'amber') await page.screenshot({ path: path.join(SHOTS, `${mode.toLowerCase()}-amber-settings.png`), animations: 'disabled' });
    await leaveSettings(page);
    await f.composer.fill('Test empty input, then one valid expression.');
    await f.composer.focus();
    assert.deepEqual(await page.evaluate(contrastFailures), [], `${mode} ${accent} chat text contrast`);
    const marks = await page.evaluate(() => {
      const css = (element, pseudo) => getComputedStyle(element, pseudo);
      const link = css(document.querySelector('.message.agent a'));
      const send = css(document.querySelector('.send-button'));
      const probe = document.createElement('span');
      probe.style.color = 'var(--primary)'; document.body.append(probe);
      const primary = css(probe).color; probe.remove();
      return { primary, link: link.color, underline: link.textDecorationColor, line: link.textDecorationLine,
        tab: css(document.querySelector('.task-tab.active'), '::after').backgroundColor,
        icon: css(document.querySelector('.task-tab.active > button svg')).color,
        sidebar: css(document.querySelector('.thread-row.active'), '::before').backgroundColor,
        fill: send.backgroundColor, label: send.color };
    });
    assert.equal(marks.line, 'underline');
    for (const role of ['tab', 'icon', 'sidebar']) assert.equal(marks[role], marks.primary, `${mode} ${accent} ${role} uses the shared visual accent`);
    assert.equal(marks.fill, marks.primary, 'Send shares the main logo colour');
    if (mode === 'Light') {
      assert.notEqual(marks.link, marks.underline, 'ink link text keeps its orange underline');
      assert.equal(marks.label, 'rgb(37, 37, 36)', 'orange send fill keeps dark ink');
    }
    await page.getByRole('button', { name: 'Add files and more', exact: true }).click();
    await page.getByRole('menuitem', { name: /Plan mode/ }).click();
    assert.deepEqual(await page.evaluate(contrastFailures), [], `${mode} ${accent} Plan text contrast`);
    assert.equal(await page.locator('.plan-pill > svg').evaluate(element => getComputedStyle(element).color), marks.primary, 'Plan icon keeps the visual accent beside ink text');
    await page.getByRole('button', { name: 'Turn plan mode off', exact: true }).click();
    await f.composer.focus();
    await page.mouse.move(1260, 880);
    if (accent === 'amber') await page.screenshot({ path: path.join(SHOTS, `${mode.toLowerCase()}-amber-chat.png`), animations: 'disabled' });
  }
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

test('settings and chat fit in three light/dark combinations and a narrow window', async t => {
  const f = await fixture({ width: 1280, height: 900, chat: [
    ['t1', 'How does the parser work?', 'The parser runs in **two passes**.\n\n1. Scan the source into tokens.\n2. Build a syntax tree from those tokens.\n\n```ts\nconst tokens = scan(source);\nconst result = parse(tokens);\n```\n\nUse `parse` for a complete expression. [Read the guide](https://example.invalid/guide) for examples.'],
    ['t2', 'What should I test first?', 'Start with an empty input, then try one valid expression.'],
  ] }), { page } = f; t.after(f.close);
  await fs.mkdir(SHOTS, { recursive: true }); await f.open('chat-a');
  for (const [mode, accent, choice] of [['Light', 'blue', 'sans'], ['Dark', 'teal', 'serif'], ['Dark', 'amber', 'mono']]) {
    await appearance(page); await theme(page, mode);
    await chooseOption(page.getByLabel('Accent colour', { exact: true }), accent);
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

test('an unknown saved accent recovers to the default', async t => {
  const f = await fixture({ storage: { 'elpis-preferences-v1': JSON.stringify({ accent: 'bad', chatFont: 'url(bad)' }) } }), { page } = f; t.after(f.close);
  await appearance(page); await selected(page, 'Accent colour', 'amber');
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
  const primary = await token(page, '--primary');
  // The exported error page uses the root layout without mounting the chat app.
  await page.goto(new URL('/404.html', page.url()).href);
  await page.getByRole('heading', { name: '404', exact: true }).waitFor();
  await page.waitForFunction(() => document.documentElement.dataset.accent === 'teal');
  assert.equal(await token(page, '--primary'), primary);
  assert.match(await token(page, '--chat-font'), /Inter/);
  assert.deepEqual(f.errors, []);
});

test('Inter also reaches side-chat messages and its composer', async t => {
  const f = await fixture({ routes: {
    '/api/threads/chat-a/side-chat': () => ({ threadId: 'side-a' }),
    '/api/side-chats/side-a/turns': () => ({ turn: { id: 'side-turn' } }),
  } }), { page } = f; t.after(f.close);
  await f.open('chat-a');
  await f.composer.press('Control+;');
  const box = page.getByRole('textbox', { name: 'Side question', exact: true });
  assert.match(await font(box), /Inter/);
  await box.fill('A side question in the selected font.'); await box.press('Enter');
  const message = page.getByRole('region', { name: 'Side chat' }).locator('.message.user').first();
  await message.waitFor(); assert.match(await font(message), /Inter/);
  assert.deepEqual(f.errors, []);
});
