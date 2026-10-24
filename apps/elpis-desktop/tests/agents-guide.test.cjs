const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { fixture: startFixture } = require('./parity-fixture.cjs');
async function fixture(options) {
  const f = await startFixture(options);
  await f.page.getByRole('status', { name: 'Elpis is starting' }).waitFor({ state: 'detached', timeout: 10000 });
  return f;
}
const { assertUiFit } = require('./ui-fit.cjs');

const topics = ['One agent or many', 'Mother and Father', 'Writers and checks', 'Choose a pattern', 'Read a run'];
const guide = page => page.getByRole('region', { name: 'Guide to managing agents' });
async function command(page, name) {
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox', { name: 'Search or start a chat' }).fill(name);
  await page.getByRole('option', { name: new RegExp('^' + name) }).click();
}

test('arrow keys do not advance guide topics; mouse selection still works', async () => {
  const f = await fixture(), { page } = f;
  try {
    await command(page, 'Guide');
    const current = guide(page).getByRole('button', { name: 'Choose a pattern', exact: true });
    await current.click();
    await guide(page).getByRole('heading', { name: 'Choose a pattern' }).waitFor();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), 'Choose a pattern');
    assert.ok(await guide(page).getByText('Debate + judge', { exact: true }).isVisible());
    await guide(page).getByRole('button', { name: 'Read a run', exact: true }).click();
    await guide(page).getByRole('heading', { name: 'Read a run' }).waitFor();
  } finally { await f.close(); }
});

test('The command menu opens the guide; topics and the Workflows back link work without starting a run', async () => {
  const f = await fixture(), { page } = f;
  try {
    await command(page, 'Guide');
    await guide(page).waitFor();
    await page.context().route('https://www.anthropic.com/engineering/**', route => route.fulfill({ contentType: 'text/html', body: '<title>Guide reference</title>' }));
    for (const name of topics) {
      await guide(page).getByRole('button', { name, exact: true }).click();
      await guide(page).getByRole('heading', { name, exact: true }).waitFor();
      const links = await guide(page).getByRole('link').evaluateAll(items => items.map(a => ({ href: a.href, target: a.target, rel: a.rel })));
      assert.ok(links.length && links.every(a => a.href.startsWith('https://www.anthropic.com/engineering/') && a.target === '_blank' && a.rel.includes('noreferrer')));
    }
    for (const title of ['Building effective agents', 'How we built our multi-agent research system']) {
      await guide(page).getByRole('button', { name: 'One agent or many', exact: true }).click();
      const opened = page.waitForEvent('popup');
      await guide(page).getByRole('link', { name: title, exact: true }).click();
      const popup = await opened;
      await popup.waitForLoadState();
      assert.equal(await popup.title(), 'Guide reference');
      await popup.close();
    }
    await guide(page).getByRole('button', { name: 'Mother and Father', exact: true }).click();
    assert.match(await guide(page).innerText(), /10/);
    await guide(page).getByRole('button', { name: 'Writers and checks', exact: true }).click();
    assert.match(await guide(page).innerText(), /worktree/);
    await guide(page).getByRole('button', { name: 'Choose a pattern', exact: true }).click();
    for (const name of ['Split by parts', 'Voting', 'Debate', 'Hierarchical', 'Research']) assert.ok((await guide(page).innerText()).includes(name));
    await guide(page).getByRole('button', { name: 'Back to Workflows' }).click();
    await page.getByRole('region', { name: 'Workflows', exact: true }).waitFor();
    await command(page, 'Guide');
    await guide(page).waitFor();
    assert.equal(f.posts.filter(p => /workflows|turns|\/api\/threads$/.test(p.path)).length, 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Canvas help opens the guide and returns to the board', async () => {
  const f = await fixture(), { page } = f;
  try {
    await command(page, 'Workflows');
    await page.getByRole('button', { name: /^Voting/ }).click();
    const help = page.getByRole('region', { name: 'Guide', exact: true });
    await page.locator('.react-flow__node-agent').first().click();
    await help.waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await help.getByRole('button', { name: 'Guide to managing agents', exact: true }).click();
    await guide(page).waitFor();
    await guide(page).getByRole('button', { name: 'Back to Workflows' }).click();
    await help.waitFor();
    assert.match(await page.getByRole('button', { name: /^Voting/ }).innerText(), /on the board/i);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

for (const colorScheme of ['light', 'dark']) for (const [width, height, fallbackFont] of [[1280, 800], [900, 700], [900, 700, 'DejaVu Sans']]) test(`guide topics fit one screen (${colorScheme}, ${width}x${height}${fallbackFont ? ', system fallback font' : ''})`, async () => {
  const f = await fixture({ colorScheme, width, height }), { page } = f;
  try {
    await page.keyboard.press('Control+k');
    await page.keyboard.type('Guide');
    await page.keyboard.press('Enter');
    await guide(page).waitFor();
    // CI has no workstation Inter font. Check the wider system fallback as well.
    if (fallbackFont) await page.evaluate(font => document.documentElement.style.setProperty('--ui-font', `"${font}", sans-serif`), fallbackFont);
    await page.evaluate(() => document.fonts.ready);
    await fs.mkdir('/tmp/agents-guide-shots', { recursive: true });
    for (const name of topics) {
      const button = guide(page).getByRole('button', { name, exact: true });
      await button.focus(); await page.keyboard.press('Enter');
      await guide(page).getByRole('heading', { name, exact: true }).waitFor();
      await assertUiFit(guide(page), name);
      assert.ok(await guide(page).evaluate(el => el.getBoundingClientRect().top >= 0 && el.getBoundingClientRect().bottom <= innerHeight), `${name}: the whole topic fits`);
      assert.ok(await guide(page).evaluate(el => { const scroll = el.closest('.page-scroll'); return scroll.scrollHeight <= scroll.clientHeight + 1; }), `${name}: no page scrolling`);
      await page.mouse.move(880, 80);
      await page.screenshot({ animations: 'disabled', path: `/tmp/agents-guide-shots/${colorScheme}-${width}${fallbackFont ? '-fallback' : ''}-${topics.indexOf(name)}.png` });
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
