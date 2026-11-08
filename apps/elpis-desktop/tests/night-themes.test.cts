// Real settings controls against the exported renderer and an isolated local fixture.
const { test }: typeof import('node:test') = require('node:test');
const assert = require('node:assert/strict');


const { fixture } = require('./parity-fixture.cts');
const { openSettings, leaveSettings, chooseOption, controlValue } = require('./controls.cts');
type Locator = { evaluate<T>(fn: (element: Element) => T): Promise<T>; getByRole(role: string, options: object): Locator; click(): Promise<void> };
type Page = { evaluate<T>(fn: (value: string) => T, value: string): Promise<T>; getByRole(role: string, options: object): Locator; getByLabel(label: string, options: object): Locator };

async function appearance(page: Page) {
  await openSettings(page);
  await page.getByRole('tab', { name: 'Appearance', exact: true }).click();
  return page.getByRole('tabpanel', { name: 'Appearance', exact: true });
}
const token = (page: Page, name: string) => page.evaluate(name => getComputedStyle(document.documentElement).getPropertyValue(name).trim(), name);
const font = (locator: Locator) => locator.evaluate(element => getComputedStyle(element).fontFamily);
const theme = (page: Page, value: string) => page.getByRole('radiogroup', { name: 'Theme', exact: true }).getByRole('radio', { name: value, exact: true }).click();
async function selected(page: Page, label: string, value: string) {
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
  // Love Spot's local accent also supplies its derived ring; the rest of the app keeps the selected accent.
  const loveAccent = await page.locator('button[data-nav-page="loveSpot"]').evaluate((element: Element) => {
    const style = getComputedStyle(element), root = getComputedStyle(document.documentElement);
    return { local: style.getPropertyValue('--primary').trim(), ring: style.getPropertyValue('--ring').trim(), global: root.getPropertyValue('--primary').trim() };
  });
  assert.notEqual(loveAccent.local, loveAccent.global);
  assert.equal(loveAccent.ring, loveAccent.local);
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

test('a failed preference write shows an error and leaves the saved choice active', async t => {
  const f = await fixture(), { page } = f; t.after(f.close);
  await appearance(page);
  const previous = await token(page, '--primary');
  await page.evaluate(() => {
    const storage = window.elpisDesktop?.storage; if (!storage) throw Error('Desktop storage unavailable'); const save = storage.setItem;
    storage.setItem = (key, value) => { if (key === 'elpis-preferences-v1') throw Error('Fixture disk full'); save(key, value); };
  });
  await chooseOption(page.getByLabel('Accent colour', { exact: true }), 'blue');
  await page.getByRole('alert').filter({ hasText: 'Fixture disk full' }).waitFor();
  await selected(page, 'Accent colour', 'amber'); assert.equal(await token(page, '--primary'), previous);
  assert.deepEqual(f.errors, []);
});
