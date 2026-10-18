const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { _electron } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { fixture } = require('./parity-fixture.cjs');
const { assertUiFit } = require('./ui-fit.cjs');
const { openSettings, chooseOption, controlValue, leaveSettings } = require('./controls.cjs');

test('native settings changes update both windows without reverting another preference', { skip: !process.env.ELPIS_PRIVATE_DISPLAY && 'Use ELPIS_PRIVATE_DISPLAY=1 xvfb-run -a for native windows' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-settings-'));
  const f = await fixture({ desktop: false, routes: { '/api/settings': () => ({
    version: 'fixture', main: { model: 'sol', provider: 'openai' }, background: { model: null, provider: null },
    smartPrune: { enabled: false, explicitOverride: {} }, memory: {}, options: { serviceTier: 'default' }, write: { available: false, reason: 'Fixture' },
  }) } }); let electron;
  try {
    electron = await _electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', '--ozone-platform=x11', path.resolve(__dirname, 'session-windows-electron.cjs')], env: { ...process.env, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '', HOME: root, ELPIS_HOME: root, SESSION_WINDOW_PROFILE: path.join(root, 'profile'), SESSION_WINDOW_URL: f.page.url() } });
    const first = await electron.firstWindow(); first.setDefaultTimeout(10000);
    await first.locator('.thread-row[data-thread-id="chat-a"]').waitFor();
    await first.locator('.thread-row[data-thread-id="chat-a"] .thread-link').click();
    await first.getByRole('button', { name: 'Chat actions', exact: true }).click();
    const opened = electron.waitForEvent('window');
    await first.getByRole('menuitem', { name: 'Open session in new window', exact: true }).click();
    const second = await opened; second.setDefaultTimeout(10000);
    await second.locator('.thread-row[data-thread-id="chat-a"]').waitFor();
    for (const page of [first, second]) { await openSettings(page); await page.getByRole('tab', { name: 'General', exact: true }).click(); }
    const usage = page => page.getByRole('switch', { name: 'Show context window usage', exact: true });
    await usage(first).click();
    await second.waitForFunction(() => document.querySelector('[aria-label="Show context window usage"]').getAttribute('aria-checked') === 'false');
    await second.getByRole('tab', { name: 'Notifications', exact: true }).click();
    await chooseOption(second.getByLabel('Turn completion notifications', { exact: true }), 'always');
    await first.getByRole('tab', { name: 'Notifications', exact: true }).click();
    await first.waitForFunction(() => document.querySelector('[aria-label="Turn completion notifications"]').getAttribute('data-value') === 'always');
    assert.equal(await controlValue(first.getByLabel('Turn completion notifications', { exact: true })), 'always');
    for (const page of [first, second]) { await page.getByRole('tab', { name: 'General', exact: true }).click(); assert.equal(await usage(page).getAttribute('aria-checked'), 'false'); }
    const saved = JSON.parse(JSON.parse(await fs.readFile(path.join(root, 'profile/workspace.json'), 'utf8'))['elpis-preferences-v1']);
    assert.equal(saved.showContextUsage, false); assert.equal(saved.turnNotifications, 'always');
    if (process.env.ELPIS_PARITY_SHOTS) for (const colorScheme of ['light', 'dark']) {
      await second.emulateMedia({ colorScheme });
      await second.waitForFunction(dark => document.querySelector('.app-shell').classList.contains('dark') === dark, colorScheme === 'dark');
      await second.screenshot({ path: path.join(process.env.ELPIS_PARITY_SHOTS, `settings-${colorScheme}.png`), fullPage: true });
    }
    await leaveSettings(second); await first.close(); await second.reload();
    await second.locator('.thread-row[data-thread-id="chat-a"]').waitFor();
    await openSettings(second); await second.getByRole('tab', { name: 'General', exact: true }).click();
    assert.equal(await usage(second).getAttribute('aria-checked'), 'false');
  } finally { if (electron) await electron.close(); await f.close(); }
});

test('production Electron windows share chats and live replies; native menu, chat menu, independent close and IPC survive', { skip: !process.env.ELPIS_PRIVATE_DISPLAY && 'Use ELPIS_PRIVATE_DISPLAY=1 xvfb-run -a for native keys' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-windows-'));
  const f = await fixture({ desktop: false }); let electron;
  try {
    electron = await _electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', '--ozone-platform=x11', path.resolve(__dirname, 'session-windows-electron.cjs')], env: { ...process.env, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '', HOME: root, ELPIS_HOME: root, CODEX_HOME: root, SESSION_WINDOW_PROFILE: path.join(root, 'profile'), SESSION_WINDOW_URL: f.page.url() } });
    const first = await electron.firstWindow(); first.setDefaultTimeout(10000);
    await first.locator('.thread-row[data-thread-id="chat-a"]').waitFor();
    await first.getByRole('status', { name: 'Elpis is starting', exact: true }).waitFor({ state: 'detached' });
    await first.locator('.thread-row[data-thread-id="chat-a"] .thread-link').click();
    await first.getByRole('textbox', { name: 'Message Elpis', exact: true }).fill('First window draft');
    const opened = electron.waitForEvent('window');
    await first.getByRole('button', { name: 'Chat actions', exact: true }).click();
    await first.getByRole('menuitem', { name: 'Open session in new window', exact: true }).click();
    const second = await opened; second.setDefaultTimeout(10000);
    await second.locator('.thread-row[data-thread-id="chat-a"]').waitFor();
    await second.getByRole('status', { name: 'Elpis is starting', exact: true }).waitFor({ state: 'detached' });
    await assert.rejects(second.evaluate(() => window.elpisDesktop.openSessionWindow('../invalid')), /Invalid session/);
    assert.equal((await second.evaluate(() => window.elpisDesktop.quickEntry.status())).supported, true);
    await second.locator('.thread-row.active[data-thread-id="chat-a"]').waitFor();
    assert.equal(new URL(first.url()).origin, new URL(second.url()).origin);
    assert.deepEqual(await first.locator('.thread-list .thread-title').allTextContents(), await second.locator('.thread-list .thread-title').allTextContents());
    // Native menu's accelerator is a real keyboard event, with production menu construction.
    const menuWindow = electron.waitForEvent('window');
    await second.bringToFront();
    const nativeId = await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow().getNativeWindowHandle().readUInt32LE());
    execFileSync('xdotool', ['windowfocus', '--sync', String(nativeId)], { timeout: 3000 });
    execFileSync('xdotool', ['key', '--clearmodifiers', 'ctrl+shift+n'], { timeout: 3000 });
    const third = await menuWindow;
    await third.getByRole('textbox', { name: 'Message Elpis', exact: true }).waitFor();
    assert.equal(await third.locator('.thread-row.active').count(), 0, 'new session is empty');
    await third.close();
    await second.getByRole('textbox', { name: 'Message Elpis', exact: true }).fill('Second window draft');
    assert.equal(await first.getByRole('textbox', { name: 'Message Elpis', exact: true }).inputValue(), 'First window draft');
    f.emit('message', { method: 'item/completed', params: { threadId: 'chat-a', turnId: 'shared', item: { id: 'shared-native', type: 'agentMessage', text: 'Live in both native windows.' } } });
    for (const page of [first, second]) await page.getByText('Live in both native windows.', { exact: true }).waitFor();
    for (const colorScheme of ['light', 'dark']) {
      for (const page of [first, second]) { await page.emulateMedia({ colorScheme }); await page.waitForFunction(dark => document.querySelector('.app-shell').classList.contains('dark') === dark, colorScheme === 'dark'); await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished.catch(() => {}))); });
        assert.ok(await page.evaluate(() => { const foreground = getComputedStyle(document.querySelector('.app-shell')).color; return ['.new-chat', 'textarea[aria-label="Message Elpis"]'].every(selector => getComputedStyle(document.querySelector(selector)).color === foreground); }), 'navigation and composer text use the settled theme foreground');
        await assertUiFit(page.locator('.workspace'), 'native chat fits'); }
      if (process.env.ELPIS_PARITY_SHOTS) {
        const host = await electron.browserWindow(second);
        const picture = await host.evaluate(async window => (await window.webContents.capturePage()).toDataURL());
        await fs.writeFile(path.join(process.env.ELPIS_PARITY_SHOTS, `window-${colorScheme}.png`), Buffer.from(picture.split(',')[1], 'base64'));
      }
    }
    await second.locator('.thread-row[data-thread-id="chat-b"]').getByRole('button', { name: /^Actions for/ }).click();
    await second.getByRole('menuitem', { name: 'Open session in split view', exact: true }).click();
    const pane = second.frameLocator('iframe[title="Split session"]');
    await pane.getByRole('textbox', { name: 'Message Elpis', exact: true }).fill('Native split draft');
    await second.getByRole('textbox', { name: 'Message Elpis', exact: true }).click(); await second.keyboard.press('Control+]');
    assert.ok(await pane.getByRole('textbox', { name: 'Message Elpis', exact: true }).evaluate(el => el === document.activeElement));
    await second.keyboard.press('Control+[');
    await assertUiFit(second.locator('.workspace'), 'native split primary fits');
    await assertUiFit(pane.locator('.workspace'), 'native split secondary fits');
    await pane.getByRole('button', { name: 'Chat actions', exact: true }).click();
    const fromPane = electron.waitForEvent('window'); await pane.getByRole('menuitem', { name: 'Open session in new window', exact: true }).click();
    const paneWindow = await fromPane; await paneWindow.locator('.thread-row.active[data-thread-id="chat-b"]').waitFor(); await paneWindow.close();
    await pane.getByRole('button', { name: 'Close split view', exact: true }).click();
    await second.locator('iframe').waitFor({ state: 'detached' });
    await first.close();
    // The surviving window must keep its registered handlers and create another window after its sibling closes.
    await second.getByRole('button', { name: 'Chat actions', exact: true }).click();
    const newWindow = electron.waitForEvent('window');
    await second.getByRole('menuitem', { name: 'New Session in New Window', exact: true }).click();
    const fourth = await newWindow; await fourth.locator('.thread-row[data-thread-id="chat-a"]').waitFor();
    assert.equal(await second.getByRole('textbox', { name: 'Message Elpis', exact: true }).inputValue(), 'Second window draft');
    await fourth.close();
    assert.equal(await electron.evaluate(() => global.sessionWindows.windows.size), 1);
    await second.locator('.thread-row[data-thread-id="chat-b"] .thread-link').click(); await second.reload();
    await second.locator('.thread-row.active[data-thread-id="chat-b"]').waitFor();
  } finally { if (electron) await electron.close(); await f.close(); }
});
