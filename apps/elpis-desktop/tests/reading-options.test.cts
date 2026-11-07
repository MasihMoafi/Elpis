// Reading options in Settings → Appearance, as Claude's desktop app has them: Transcript text size (Small, Medium,
// Large), Transcript width (Narrow, Medium, Wide), and Code font (code, diffs and the terminal). Saved on
// this device with the other preferences. The exported UI against tests/parity-fixture.cjs, a mock bridge with no
// engine or model. Captures go to $ELPIS_PARITY_SHOTS when it is set.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fixture } = require('./parity-fixture.cjs');
const { openSettings, leaveSettings } = require('./controls.cts');

const PREFERENCES = 'elpis-preferences-v1';
type Locator = { first(): Locator; evaluate<T>(fn: (element: Element, name: keyof CSSStyleDeclaration) => T, name: keyof CSSStyleDeclaration): Promise<T>; locator(selector: string): Locator; innerText(): Promise<string>; allInnerTexts(): Promise<string[]>; getByRole(role: string, options?: { name: string; exact?: boolean }): Locator; getByText(text: string, options?: { exact?: boolean }): Locator; click(): Promise<void>; waitFor(): Promise<void>; inputValue(): Promise<string>; fill(value: string): Promise<void>; press(key: string): Promise<void>; count(): Promise<number> };
type Page = { locator(selector: string): Locator; getByRole(role: string, options: { name: string; exact?: boolean }): Locator; evaluate<T>(fn: (key: string) => T, key: string): Promise<T> };
const style = (locator: Locator, property: keyof CSSStyleDeclaration) => locator.first().evaluate((element, name) => getComputedStyle(element)[name], property);
const reply = (page: Page) => page.locator('.message.agent .markdown p').first();
const prompt = (page: Page) => page.locator('.chat-content .user-turn').first();
async function appearance(page: Page) {
  await openSettings(page);
  await page.getByRole('tab', { name: 'Appearance', exact: true }).click();
  return page.getByRole('tabpanel', { name: 'Appearance' });
}
const checked = (group: Locator) => group.locator('[role="radio"][aria-checked="true"]').innerText();
const saved = (page: Page) => page.evaluate(key => JSON.parse(localStorage.getItem(key) || '{}'), PREFERENCES);
async function eventually(check: () => Promise<void>, ms = 4000) {
  const deadline = Date.now() + ms;
  for (;;) { try { return await check(); } catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 50)); } }
}

test('Appearance offers the reading options; Large and Wide change the transcript and its columns and survive a reload', async () => {
  const f = await fixture({ width: 1440, height: 900 }), { page } = f;
  try {
    await f.open('chat-a');
    const before = { text: await style(reply(page), 'fontSize'), prompt: await style(prompt(page), 'fontSize'), column: await style(page.locator('.chat-content'), 'maxWidth'), composer: await style(page.locator('.composer'), 'maxWidth'), box: await style(page.locator('.composer textarea'), 'fontSize'), sidebar: await style(page.locator('aside.sidebar .thread-title'), 'fontFamily') };
    assert.deepEqual([before.text, before.column, before.composer], ['14px', '740px', '740px'], 'the defaults are today’s look');
    assert.match(before.sidebar, /^Inter, system-ui/);
    const settings = await appearance(page);
    const size = settings.getByRole('radiogroup', { name: 'Transcript text size' }), width = settings.getByRole('radiogroup', { name: 'Transcript width' });
    assert.deepEqual(await size.getByRole('radio').allInnerTexts(), ['Small', 'Medium', 'Large']);
    assert.deepEqual(await width.getByRole('radio').allInnerTexts(), ['Narrow', 'Medium', 'Wide']);
    assert.deepEqual([await checked(size), await checked(width)], ['Medium', 'Narrow']);
    for (const text of ['Size of the conversation transcript text.', 'Maximum width of the transcript and composer columns.', 'Set a custom monospace font for code and terminal.']) await settings.getByText(text, { exact: true }).waitFor();
    assert.equal(await settings.getByRole('textbox', { name: 'Code font' }).inputValue(), '');
    await size.getByRole('radio', { name: 'Large' }).click();
    await width.getByRole('radio', { name: 'Wide' }).click();
    const stored = await saved(page); assert.equal(stored.transcriptSize, 'l'); assert.equal(stored.transcriptWidth, 'l');
    await leaveSettings(page);
    await eventually(async () => assert.equal(await style(reply(page), 'fontSize'), '16px'));
    assert.equal(await style(prompt(page), 'fontSize'), '16px', 'your messages too');
    assert.equal(await style(page.locator('.chat-content'), 'maxWidth'), '1100px');
    assert.equal(await style(page.locator('.composer'), 'maxWidth'), '1100px', 'the composer column follows');
    assert.equal(await style(page.locator('.composer textarea'), 'fontSize'), before.box, 'the message box keeps its size');
    assert.match(await style(page.locator('aside.sidebar .thread-title'), 'fontFamily'), /^Inter/);
    await page.locator('aside.sidebar .thread-row').first().click({ button: 'right' });
    assert.match(await style(page.getByRole('menu'), 'fontFamily'), /^Inter/, 'menus use the same interface font');
    await page.keyboard.press('Escape');
    await page.reload();
    await f.open('chat-a');
    assert.equal(await style(reply(page), 'fontSize'), '16px', 'after a reload');
    assert.equal(await style(page.locator('.chat-content'), 'maxWidth'), '1100px');
    const again = await appearance(page);
    assert.deepEqual([await checked(again.getByRole('radiogroup', { name: 'Transcript text size' })), await checked(again.getByRole('radiogroup', { name: 'Transcript width' }))], ['Large', 'Wide']);
    await again.getByRole('radiogroup', { name: 'Transcript text size' }).getByRole('radio', { name: 'Small' }).click();
    await again.getByRole('radiogroup', { name: 'Transcript width' }).getByRole('radio', { name: 'Medium' }).click();
    await leaveSettings(page);
    assert.equal(await style(reply(page), 'fontSize'), '13px');
    assert.equal(await style(page.locator('.chat-content'), 'maxWidth'), '900px');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Code font: a saved name leads code, diffs and the terminal, open or new; a wrong name is refused; Reset restores the default', async () => {
  const f = await fixture({ width: 1440, height: 900 }), { page } = f;
  try {
    await f.open('chat-a');
    await page.keyboard.press('Control+Backquote');
    const rows = page.locator('.terminal-body .xterm-rows');
    await rows.waitFor();
    assert.match(await style(rows, 'fontFamily'), /^"JetBrains Mono"/);
    let settings = await appearance(page);
    const field = settings.getByRole('textbox', { name: 'Code font' });
    await field.fill('Mono; color: red');
    await settings.getByRole('button', { name: 'Save code font' }).click();
    await settings.getByText('Use one font name: letters, digits, spaces, hyphens, underscores and dots.').waitFor();
    assert.equal((await saved(page)).codeFont ?? '', '', 'a refused name is not saved');
    await field.fill('DejaVu Sans Mono');
    await field.press('Enter');
    await eventually(async () => assert.equal((await saved(page)).codeFont, 'DejaVu Sans Mono'));
    assert.equal(await settings.getByRole('alert').count(), 0);
    await leaveSettings(page);
    assert.match(await style(page.locator('.chat-content code').first(), 'fontFamily'), /^"DejaVu Sans Mono", "JetBrains Mono"/, 'code in replies');
    await eventually(async () => assert.match(await style(rows, 'fontFamily'), /^"DejaVu Sans Mono"/, 'the open terminal follows'));
    await page.keyboard.press('Control+Backquote');
    await page.keyboard.press('Control+Backquote');
    await rows.waitFor();
    assert.match(await style(rows, 'fontFamily'), /^"DejaVu Sans Mono"/);
    settings = await appearance(page);
    await settings.getByRole('button', { name: 'Reset code font' }).click();
    await eventually(async () => assert.equal((await saved(page)).codeFont, ''));
    assert.equal(await settings.getByRole('textbox', { name: 'Code font' }).inputValue(), '');
    await leaveSettings(page);
    assert.match(await style(page.locator('.chat-content code').first(), 'fontFamily'), /^"JetBrains Mono"/);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
