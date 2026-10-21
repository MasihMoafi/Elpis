const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture, CWD } = require('./parity-fixture.cjs');

const shots = process.env.ELPIS_PARITY_SHOTS;
const parent = { id: 'chat-a', name: 'Elpis — recovery and chat priorities', preview: 'Recovery', cwd: CWD,
  model: 'sol', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' } };
const child = { ...parent, id: 'agent-a', name: 'Kierkegaard · check the sidebar', parentThreadId: parent.id };
const routes = { '/api/threads': (_body, url) => ({ data: url.searchParams.get('archived') === 'true' ? []
  : url.searchParams.has('ancestorThreadId') ? (url.searchParams.get('ancestorThreadId') === parent.id ? [child] : [])
  : [parent, child, { ...parent, id: 'chat-b', name: 'Write the docs' },
    { ...parent, id: 'chat-c', name: 'Plan the release' }], nextCursor: null }) };
const options = colorScheme => ({ colorScheme, width: 1130, height: 800, routes, staticDir: process.env.ELPIS_RENDERER_OUT });
const row = (page, id = parent.id) => page.locator(`aside.sidebar .thread-row[data-thread-id="${id}"]`).first();
const chevron = page => row(page).getByRole('button', { name: /agents in/ });
const surface = locator => locator.evaluate(element => {
  const style = getComputedStyle(element);
  return { background: style.backgroundColor, shadow: style.boxShadow, image: style.backgroundImage };
});
const plain = { background: 'rgba(0, 0, 0, 0)', shadow: 'none', image: 'none' };
async function capture(page, name) {
  if (!shots) return;
  await fs.mkdir(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
}
async function settle(page) {
  // The shared button transitions background/shadow for 150ms.
  await page.waitForTimeout(200);
}
async function assertRowHover(page, id, token) {
  const target = row(page, id);
  await target.locator('.thread-link').hover();
  const colors = await target.evaluate((element, token) => {
    const probe = document.createElement('span');
    probe.style.backgroundColor = `var(${token})`;
    element.append(probe);
    const expected = getComputedStyle(probe).backgroundColor, actual = getComputedStyle(element).backgroundColor;
    probe.remove();
    return { actual, expected };
  }, token);
  assert.equal(colors.actual, colors.expected, `${id} keeps its own ${token} background`);
  assert.notEqual(colors.actual, plain.background, 'the row still highlights');
}

for (const colorScheme of ['light', 'dark']) {
  test(`agent chevron has no background or shadow at rest, hover and keyboard focus (${colorScheme})`, async () => {
    const f = await fixture(options(colorScheme)), { page } = f;
    try {
      await f.open(parent.id);
      const toggle = chevron(page);
      if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
      await row(page, child.id).waitFor();
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      await page.mouse.move(700, 60);
      await settle(page);
      const rest = await surface(toggle);
      await capture(page, `chat-list-${colorScheme}-rest`);
      await toggle.hover();
      await settle(page);
      const hover = await surface(toggle);
      await capture(page, `chat-list-${colorScheme}-hover`);
      assert.deepEqual(rest, plain, 'expanded chevron at rest');
      assert.deepEqual(hover, plain, 'expanded chevron on hover');
      await assertRowHover(page, parent.id, '--selected');
      await assertRowHover(page, 'chat-b', '--hover');
      await toggle.click();
      await row(page, child.id).waitFor({ state: 'hidden' });
      await page.mouse.move(700, 60);
      await settle(page);
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      assert.deepEqual(await surface(toggle), plain, 'collapsed chevron at rest');
      await toggle.hover();
      await settle(page);
      assert.deepEqual(await surface(toggle), plain, 'collapsed chevron on hover');
      await page.mouse.move(700, 60);
      // Reach the real button by Tab, rather than faking a focus pseudo-class.
      await row(page).locator('.thread-link').focus();
      await page.keyboard.press('Shift+Tab');
      await settle(page);
      assert.equal(await toggle.evaluate(element => element === document.activeElement && element.matches(':focus-visible')), true);
      assert.deepEqual(await surface(toggle), plain, 'keyboard focus has no shadow ring');
      assert.equal(await toggle.evaluate(element => getComputedStyle(element).outlineStyle), 'solid');
      await capture(page, `chat-list-${colorScheme}-keyboard-focus`);
      await page.keyboard.press('Enter');
      await row(page, child.id).waitFor();
      await page.keyboard.press('Space');
      await row(page, child.id).waitFor({ state: 'hidden' });
      await page.reload();
      await f.open(parent.id);
      await chevron(page).hover();
      await settle(page);
      assert.deepEqual(await surface(chevron(page)), plain, 'transparent after reload');
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  });

  test(`running composer Stop has ${colorScheme === 'light' ? 'no gray background or shadow' : 'its existing secondary background'} (${colorScheme})`, async () => {
    const f = await fixture({ ...options(colorScheme), running: true }), { page } = f;
    try {
      await f.open(parent.id);
      const stop = page.getByRole('button', { name: 'Stop response', exact: true });
      await stop.waitFor();
      await page.mouse.move(700, 60);
      await settle(page);
      const rest = await surface(stop);
      await capture(page, `running-composer-${colorScheme}-rest`);
      await stop.hover();
      await settle(page);
      const hover = await surface(stop);
      await capture(page, `running-composer-${colorScheme}-hover`);
      if (colorScheme === 'light') {
        assert.deepEqual(rest, plain, 'light Stop at rest');
        assert.deepEqual(hover, plain, 'light Stop on hover');
        await page.mouse.move(700, 60);
        await f.composer.fill('Follow-up draft');
        await page.getByRole('button', { name: 'Send follow-up', exact: true }).focus();
        await page.keyboard.press('Shift+Tab');
        await settle(page);
        assert.equal(await stop.evaluate(element => element === document.activeElement && element.matches(':focus-visible')), true);
        assert.deepEqual(await surface(stop), plain, 'light Stop on keyboard focus');
        assert.equal(await stop.evaluate(element => getComputedStyle(element).outlineStyle), 'solid');
        await capture(page, 'running-composer-light-keyboard-focus');
      } else {
        const expected = await stop.evaluate(element => {
          const probe = document.createElement('span');
          element.append(probe);
          probe.style.backgroundColor = 'var(--muted)';
          const rest = getComputedStyle(probe).backgroundColor;
          probe.style.backgroundColor = 'color-mix(in oklab, var(--secondary), var(--foreground) 5%)';
          const hover = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return { rest, hover };
        });
        assert.equal(rest.background, expected.rest, 'dark Stop keeps its secondary fill');
        assert.equal(hover.background, expected.hover, 'dark Stop keeps its hover fill');
      }
      await stop.click();
      assert.equal(f.posts.filter(post => post.path === '/api/threads/chat-a/interrupt').length, 1, 'Stop still interrupts the current reply');
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  });
}
