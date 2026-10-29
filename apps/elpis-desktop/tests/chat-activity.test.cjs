// Agent work in the chat as Claude's desktop app shows it: finished tool activity folds into one muted row
// ("Ran 2 commands (1 failed)"), each command opens to a coloured shell block and its output (failures in red),
// a running step counts its seconds, inline code is a red chip, and while a turn runs Enter and Ctrl+Enter
// choose between steering and queueing. Local fixture of the bridge; no runtime or model calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { oranges } = require('./controls.cjs');

const thread = { id: 'work', name: 'Agent work', cwd: '/tmp/demo', model: 'sol', modelProvider: 'openai', status: { type: 'active' }, desktopAccess: { writable: true, mode: 'direct' } };
const unknown = command => [{ type: 'unknown', command }];
/** One finished turn (two groups around a reply) and one running turn, in the order they happened. */
function history(now) {
  const t1 = now - 600_000;
  const entry = (turnId, item, startedAtMs, completedAtMs = startedAtMs) => ({ turnId, item, startedAtMs, completedAtMs });
  const shell = `/bin/bash -lc 'rg -n "TODO" src && echo $HOME | wc -l'`;
  return [
    entry('t1', { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'Tidy the build folder.' }] }, t1),
    entry('t1', { id: 'c1', type: 'commandExecution', command: shell, cwd: '/tmp/demo', status: 'completed', exitCode: 0, aggregatedOutput: '3\n', durationMs: 400, commandActions: unknown(shell) }, t1 + 1000),
    entry('t1', { id: 'c2', type: 'commandExecution', command: 'npm test', cwd: '/tmp/demo', status: 'failed', exitCode: 1, aggregatedOutput: '1 test failed\nError: expected 2, got 3', durationMs: 2100, commandActions: unknown('npm test') }, t1 + 2000),
    entry('t1', { id: 'a1', type: 'agentMessage', text: 'Now the leftovers in `/tmp`. They cannot go to the Trash from there.' }, t1 + 3000),
    entry('t1', { id: 'f1', type: 'fileChange', status: 'completed', changes: [{ path: 'src/app.ts', kind: { type: 'update' }, diff: '- a\n+ b' }] }, t1 + 4000),
    entry('t1', { id: 'm1', type: 'mcpToolCall', server: 'rag', tool: 'search', status: 'completed', arguments: { query: 'leftovers' }, result: { content: [{ type: 'text', text: '2 hits' }] } }, t1 + 5000),
    entry('t1', { id: 'c3', type: 'commandExecution', command: 'sed -n 1,40p src/app.ts', cwd: '/tmp/demo', status: 'completed', exitCode: 0, aggregatedOutput: 'export const app = 1;', durationMs: 30, commandActions: [{ type: 'read', command: 'sed -n 1,40p src/app.ts', name: 'app.ts', path: '/tmp/demo/src/app.ts' }] }, t1 + 6000),
    entry('t1', { id: 'c4', type: 'commandExecution', command: 'ls -la build', cwd: '/tmp/demo', status: 'completed', exitCode: 0, aggregatedOutput: 'total 0', durationMs: 20, commandActions: unknown('ls -la build') }, t1 + 7000),
    entry('t1', { id: 'a2', type: 'agentMessage', text: 'Everything is moved. Test files: `legal/evals/test-files/`.' }, t1 + 8000),
    entry('t2', { id: 'u2', type: 'userMessage', content: [{ type: 'text', text: 'Restart the local site.' }] }, now - 90_000),
    entry('t2', { id: 'a3', type: 'agentMessage', text: 'Restarting the site from its new place.' }, now - 80_000),
    // Sent while t2 ran (steered into it): it belongs after the work it followed, not at the top of the turn.
    entry('t2', { id: 'u3', type: 'userMessage', content: [{ type: 'text', text: 'Use port 8088.' }] }, now - 78_000),
    entry('t2', { id: 'c5', type: 'commandExecution', command: 'npm run build', cwd: '/tmp/demo', status: 'completed', exitCode: 0, aggregatedOutput: 'built', durationMs: 9000, commandActions: unknown('npm run build') }, now - 75_000, now - 66_000),
    // Running for 62 seconds when the page loads: the timer reads 1:02 and keeps counting.
    { turnId: 't2', item: { id: 'c6', type: 'commandExecution', command: 'npm run dev -- --port 8088', cwd: '/tmp/demo', status: 'inProgress', exitCode: null, aggregatedOutput: '', durationMs: null, commandActions: unknown('npm run dev -- --port 8088') }, startedAtMs: now - 62_000 },
  ];
}

async function fixture({ longGroup = false } = {}) {
  const steered = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local'); let raw = ''; for await (const chunk of req) raw += chunk;
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); return; }
    if (url.pathname === '/api/health') return json({ connected: true });
    if (url.pathname === '/api/models') return json({ data: [{ id: 'sol', model: 'sol', displayName: 'Sol' }], nextCursor: null });
    if (url.pathname === '/api/threads') return json({ data: url.searchParams.has('ancestorThreadId') || url.searchParams.get('archived') === 'true' ? [] : [thread], nextCursor: null });
    // Newest first, as the bridge pages history.
    if (url.pathname === '/api/threads/work' && req.method === 'GET') {
      const entries = history(Date.now());
      if (longGroup) entries.splice(2, 0, ...Array.from({ length: 24 }, (_, index) => ({ turnId: 't1', item: { id: `long-${index}`, type: 'commandExecution', command: `node inspect-${index}.mjs`, cwd: '/tmp/demo', status: 'completed', exitCode: 0, aggregatedOutput: 'Inspection complete.', commandActions: unknown(`node inspect-${index}.mjs`) } })));
      return json({ thread, data: entries.reverse(), nextCursor: null });
    }
    if (url.pathname === '/api/threads/work/resume') return json({ thread, activeTurnId: 't2' });
    if (url.pathname === '/api/threads/work/steer') { steered.push(JSON.parse(raw)); return json({}); }
    if (url.pathname.startsWith('/api/')) return json({});
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    try { const content = await fs.readFile(path.join(__dirname, '../out', relative)); res.setHeader('content-type', relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); res.end(content); }
    catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  /** A page with the chat open; `preferences` are saved on this device before the app starts. */
  async function open({ colorScheme = 'light', preferences, reducedMotion = 'no-preference' } = {}) {
    const page = await browser.newPage({ viewport: { width: 1320, height: 900 }, colorScheme, reducedMotion }); page.setDefaultTimeout(6000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    // Computed colours come back as color-mix()/oklch() too; read them as the pixel a canvas paints.
    await page.addInitScript(() => { window.__rgb = value => { const context = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d'); context.fillStyle = value; context.fillRect(0, 0, 1, 1); const [r, g, b] = context.getImageData(0, 0, 1, 1).data; return `rgb(${r}, ${g}, ${b})`; }; });
    if (preferences) await page.addInitScript(value => localStorage.setItem('elpis-preferences-v1', value), JSON.stringify(preferences));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('button', { name: 'Agent work', exact: true }).click();
    await page.getByText('Restarting the site from its new place.', { exact: true }).waitFor();
    return { page, errors };
  }
  return { steered, open, close: async () => { await browser.close(); server.close(); } };
}

const rgb = value => value.match(/[\d.]+/g).slice(0, 3).map(Number);
function hue(value) {
  const [r, g, b] = rgb(value), max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === min) return -1;
  const h = max === r ? 60 * (((g - b) / (max - min)) % 6) : max === g ? 60 * ((b - r) / (max - min) + 2) : 60 * ((r - g) / (max - min) + 4);
  return (h + 360) % 360;
}
const luminance = value => { const [r, g, b] = rgb(value).map(c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const isRed = value => { const [r, g, b] = rgb(value); return (hue(value) < 12 || hue(value) > 345) && r > g + 60 && r > b + 60; };
const seconds = text => { const m = text.match(/^(?:(\d+)m )?(\d+)s$/); assert.ok(m, `a timer reads "39s" or "1m 2s", not "${text}"`); return Number(m[1] ?? 0) * 60 + Number(m[2]); };

test('finished work folds into one row per group, opens by click or keyboard, and shows commands as Claude does', async () => {
  const app = await fixture();
  try {
    // A87 permits the selected amber accent. Blue still exposes hard-coded orange on these surfaces.
    const { page, errors } = await app.open({ preferences: { accent: 'blue' } });
    await page.locator('.worked-for > summary').click();
    await page.locator('.worked-for > .worked-for-body').waitFor();
    const groups = page.locator('.activity-group');
    const failedGroup = groups.filter({ hasText: /^Ran 2 commands/ });
    const mixed = groups.filter({ hasText: /^Edited and read app\.ts/ });
    assert.equal((await failedGroup.locator('> summary').innerText()).trim(), 'Ran 2 commands (1 failed)');
    assert.equal((await mixed.locator('> summary .activity-group-label').innerText()).trim(), 'Edited and read app.ts, used rag, ran a command', 'mixed work is listed in the order it began; the one file read and edited is named once');
    assert.equal((await mixed.locator('> summary .change-counts').innerText()).replace(/\s+/g, ' ').trim(), '+1 −1');

    // Collapsed when finished; Enter, Space and a click each toggle it, and aria-expanded says which.
    const summary = failedGroup.locator('> summary');
    assert.equal(await summary.getAttribute('aria-expanded'), 'false');
    assert.equal(await failedGroup.locator('.step-script').first().isVisible(), false);
    const expanded = value => failedGroup.locator(`> summary[aria-expanded="${value}"]`).waitFor();
    await summary.focus(); await page.keyboard.press('Enter'); await expanded(true);
    await page.keyboard.press(' '); await expanded(false);
    await summary.click(); await expanded(true);

    // Each command: a short title, the command in a bordered, coloured shell block, then its output.
    const steps = failedGroup.locator('.step');
    assert.equal(await steps.count(), 2);
    assert.equal((await steps.nth(0).locator('.step-title').innerText()).trim(), 'Ran rg -n "TODO" src && echo $HOME | wc -l', 'the title is the command without its bash -lc wrapper');
    const block = steps.nth(0).locator('.step-script');
    assert.ok(parseFloat(await block.evaluate(node => getComputedStyle(node).borderTopWidth)) >= 1, 'the command sits in a bordered block');
    const colours = await block.evaluate(node => {
      const span = text => [...node.querySelectorAll('span')].find(element => element.textContent === text);
      const colour = element => element && window.__rgb(getComputedStyle(element).color);
      return { base: window.__rgb(getComputedStyle(node.querySelector('code') || node).color), command: colour(span('rg')), string: colour(span('"TODO"')), operator: colour(span('&&')), variable: colour(span('$HOME')), pipe: colour(span('|')), next: colour(span('wc')) };
    });
    for (const [part, value] of Object.entries(colours)) assert.ok(value, `the shell block colours ${part}`);
    assert.ok(hue(colours.command) >= 195 && hue(colours.command) <= 245, `commands are blue (${colours.command})`);
    assert.ok(hue(colours.string) >= 90 && hue(colours.string) <= 165, `strings are green (${colours.string})`);
    assert.equal(colours.next, colours.command, 'every command in a pipeline is coloured as a command');
    assert.equal(new Set([colours.base, colours.command, colours.string, colours.operator, colours.variable]).size, 5, `command, string, variable and operator each have their own colour (${JSON.stringify(colours)})`);
    assert.equal(colours.pipe, colours.operator);
    assert.match(await steps.nth(0).locator('.step-output').innerText(), /^3\s*$/);

    // A failed command: "Exit code 1" and its output in red monospace.
    const exit = steps.nth(1).getByText('Exit code 1', { exact: true });
    const exitStyle = await exit.evaluate(node => ({ color: window.__rgb(getComputedStyle(node).color), font: getComputedStyle(node).fontFamily }));
    assert.ok(isRed(exitStyle.color), `the exit code line is red (${exitStyle.color})`);
    assert.match(exitStyle.font, /mono/i);
    assert.ok(isRed(await steps.nth(1).locator('.step-output').evaluate(node => window.__rgb(getComputedStyle(node).color))), 'a failed command\'s output is red');
    assert.equal(await steps.nth(0).getByText(/^Exit code/).count(), 0, 'a successful command shows no exit code');

    // Mixed work opens to each step; a read reads as one.
    await mixed.locator('> summary').click();
    assert.equal((await mixed.locator('.step:has(.step-script) > .step-head > .step-title').first().innerText()).trim(), 'Read app.ts');

    // Inline code: red text on a soft tint, readable.
    const chip = page.locator('.markdown :not(pre) > code').filter({ hasText: 'legal/evals/test-files/' });
    const chipStyle = () => chip.evaluate(node => ({ color: window.__rgb(getComputedStyle(node).color), background: window.__rgb(getComputedStyle(node).backgroundColor) }));
    let style = await chipStyle();
    assert.ok(isRed(style.color), `light: inline code is red (${style.color})`);
    assert.ok(luminance(style.background) > 0.75 && luminance(style.background) < 0.97, `light: the chip has a soft tint (${style.background})`);
    assert.ok(contrast(style.color, style.background) >= 4.5, `light: inline code is readable (${contrast(style.color, style.background).toFixed(2)})`);

    const workingHexagon = page.locator('.activity-group .elpis-working-rotor');
    await workingHexagon.evaluate(node => { node.style.stroke = '#e89d34'; });
    assert.ok((await oranges(page)).some(hit => hit.startsWith('path.elpis-working-rotor: stroke')), 'the guard still rejects an orange stroke other than the approved Send colour');
    await workingHexagon.evaluate(node => node.style.removeProperty('stroke'));
    assert.deepEqual(await oranges(page), [], 'light theme, chat with open activity: no orange');

    await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForTimeout(200);
    style = await chipStyle();
    assert.ok(isRed(style.color), `dark: inline code is red (${style.color})`);
    assert.ok(luminance(style.background) < 0.1, `dark: the chip's tint is dark (${style.background})`);
    assert.ok(contrast(style.color, style.background) >= 4.5, `dark: inline code is readable (${contrast(style.color, style.background).toFixed(2)})`);
    assert.ok(isRed(await exit.evaluate(node => window.__rgb(getComputedStyle(node).color))), 'dark: the exit code line is red');
    assert.deepEqual(errors, []);
  } finally { await app.close(); }
});

test('a message sent while a turn runs appears where it was sent, after the work before it', async () => {
  const f = await fixture();
  try {
    const { page, errors } = await f.open();
    const order = await page.locator('section.turn').last().evaluate(turn => {
      const texts = ['Restart the local site.', 'Restarting the site from its new place.', 'Use port 8088.'];
      const all = [...turn.querySelectorAll('*')].filter(node => !node.children.length || [...node.childNodes].some(child => child.nodeType === 3 && child.textContent.trim()));
      return texts.map(text => all.findIndex(node => node.textContent.trim() === text));
    });
    assert.ok(order.every(at => at >= 0), `all three are shown (${order})`);
    assert.ok(order[0] < order[1] && order[1] < order[2], `in the order they happened: prompt, reply, then the steered message (${order})`);
    assert.deepEqual(errors, []);
  } finally { await f.close(); }
});

test('a running step reads as a sentence with a live timer and animated dots', async () => {
  const app = await fixture();
  try {
    const { page, errors } = await app.open();
    const live = page.locator('.activity-group').filter({ hasText: 'Running npm run dev' });
    const label = live.locator('> summary');
    // The turn is known to be running once the chat's live state arrives (after its history).
    await live.locator('.live-timer').waitFor();
    assert.match((await label.innerText()).trim(), /^Running npm run dev -- --port 8088\s+1m \d+s$/);
    const timer = live.locator('.live-timer');
    const first = seconds((await timer.innerText()).trim());
    assert.ok(first >= 62 && first <= 66, `the timer counts from the step's start (${first}s)`);
    await page.waitForTimeout(2300);
    const later = seconds((await timer.innerText()).trim());
    assert.ok(later >= first + 2, `the timer advances (${first}s, then ${later}s)`);
    const rotor = live.locator('.elpis-working-rotor');
    assert.equal(await rotor.evaluate(node => getComputedStyle(node).animationName), 'elpis-orbit', 'the filled shape rotates');
    assert.equal(await page.locator('.turn-working').count(), 0, 'one live line at a time: the running step, not a second "Working"');
    assert.deepEqual(errors, []);
    await page.close();

    const still = await app.open({ reducedMotion: 'reduce' });
    const slowRotor = still.page.locator('.activity-group .elpis-working-rotor');
    await slowRotor.waitFor();
    assert.equal(await slowRotor.evaluate(node => getComputedStyle(node).animationDuration), '4s', 'the approved hexagon (d5fc7f16c) keeps its speed under reduced motion');
  } finally { await app.close(); }
});

test('while a turn runs, Enter follows the follow-up setting and Ctrl+Enter does the other for that message', async () => {
  const app = await fixture();
  try {
    const { page, errors } = await app.open();
    const composer = page.getByRole('textbox', { name: 'Message Elpis', exact: true });
    await page.getByRole('button', { name: 'Stop response', exact: true }).waitFor();
    assert.equal(await composer.getAttribute('placeholder'), 'Enter to send, Ctrl+Enter to queue for later');

    await composer.fill('steer this'); await composer.press('Enter');
    await page.waitForFunction(() => !document.querySelector('[aria-label="Message Elpis"]').value);
    assert.deepEqual(app.steered.map(body => body.text), ['steer this'], 'Enter steers the running turn (the default)');
    await composer.fill('later please'); await composer.press('Control+Enter');
    const queued = page.getByRole('list', { name: 'Queued follow-ups', exact: true });
    await queued.getByText('later please', { exact: true }).waitFor();
    assert.deepEqual(app.steered.map(body => body.text), ['steer this'], 'Ctrl+Enter queues instead');
    assert.deepEqual(errors, []);
    await page.close();

    // With Queue chosen in Settings, the keys swap and the hint says so.
    const queue = await app.open({ preferences: { followUp: 'queue' } });
    const box = queue.page.getByRole('textbox', { name: 'Message Elpis', exact: true });
    await queue.page.getByRole('button', { name: 'Stop response', exact: true }).waitFor();
    assert.equal(await box.getAttribute('placeholder'), 'Enter to queue for later, Ctrl+Enter to send now');
    await box.fill('queued by Enter'); await box.press('Enter');
    await queue.page.getByRole('list', { name: 'Queued follow-ups', exact: true }).getByText('queued by Enter', { exact: true }).waitFor();
    await box.fill('steered by Ctrl'); await box.press('Control+Enter');
    await queue.page.waitForFunction(() => !document.querySelector('[aria-label="Message Elpis"]').value);
    assert.deepEqual(app.steered.map(body => body.text), ['steer this', 'steered by Ctrl']);
    await queue.page.close();

    // The Ctrl+Enter send shortcut keeps Enter for new lines: Ctrl+Enter follows the setting, Ctrl+Shift+Enter does the other.
    const mod = await app.open({ preferences: { sendShortcut: 'modEnter' } });
    const modBox = mod.page.getByRole('textbox', { name: 'Message Elpis', exact: true });
    await mod.page.getByRole('button', { name: 'Stop response', exact: true }).waitFor();
    assert.equal(await modBox.getAttribute('placeholder'), 'Ctrl+Enter to send, Ctrl+Shift+Enter to queue for later');
    await modBox.fill('line'); await modBox.press('Enter');
    assert.equal(await modBox.inputValue(), 'line\n', 'Enter adds a line');
    await modBox.press('Control+Shift+Enter');
    await mod.page.getByRole('list', { name: 'Queued follow-ups', exact: true }).getByText('line', { exact: true }).waitFor();
    assert.equal(app.steered.length, 2);
  } finally { await app.close(); }
});


test('tool details and groups collapse from the bottom, return focus, and still reopen from the top', async () => {
  const app = await fixture({ longGroup: true });
  try {
    const { page, errors } = await app.open();
    await page.locator('.worked-for > summary').click();
    await page.locator('.worked-for > .worked-for-body').waitFor();
    const group = page.locator('.worked-for .activity-group').first();
    const head = group.locator('> summary');
    await head.click();
    await group.locator('> .activity-group-body').waitFor();
    const step = group.locator('.step').first();
    const stepHead = step.locator('> summary');
    if (!await step.evaluate(node => node.open)) await stepHead.click();
    if (process.env.ELPIS_TEST_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.ELPIS_TEST_SCREENSHOTS, 'elpis-tool-collapse.png') });
    await step.getByRole('button', { name: 'Collapse details', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.activity-group .step').open);
    assert.equal(await stepHead.evaluate(node => node === document.activeElement), true);
    assert.equal(await group.evaluate(node => node.open), true, 'closing one tool keeps the group open');
    await stepHead.press('Enter');
    await step.getByRole('button', { name: 'Collapse details', exact: true }).waitFor();
    assert.ok(await group.evaluate(node => node.getBoundingClientRect().height > innerHeight), 'exercise a group longer than the viewport');
    await group.getByRole('button', { name: 'Collapse tool calls', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.activity-group').open);
    assert.equal(await head.evaluate(node => node === document.activeElement), true);
    await head.press('Enter');
    await group.getByRole('button', { name: 'Collapse tool calls', exact: true }).waitFor();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await group.getByRole('button', { name: 'Collapse tool calls', exact: true }).click();
    await page.waitForFunction(() => { const head = document.querySelector('.activity-group > summary'); const box = head.getBoundingClientRect(); return !head.parentElement.open && box.top >= 0 && box.bottom <= innerHeight; });
    assert.equal(await head.evaluate(node => node === document.activeElement), true);
    assert.deepEqual(errors, []);
  } finally { await app.close(); }
});
