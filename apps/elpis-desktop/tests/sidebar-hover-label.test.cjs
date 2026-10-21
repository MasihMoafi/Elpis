// A133: "self-explanatory!" — the full chat name must never cover its sidebar row.
// Run against out/ copied from CI. No CSS, DOM, or tooltip replacements are injected.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture, CWD } = require('./parity-fixture.cjs');

const longName = 'Didar — latest build and chat visibility';
const chat = (id, name, extra = {}) => ({ id, name, preview: name, cwd: CWD, model: 'sol', modelProvider: 'openai',
  status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' }, ...extra });
const threads = [chat('chat-a', longName), chat('chat-b', 'Didar'), chat('chat-c', 'دیدار — بررسی نام بسیار طولانی گفتگو و نمایش کامل آن'),
  chat('pinned', longName), chat('grouped', longName), chat('agent', 'Agent — ' + longName, { parentThreadId: 'chat-a' }),
  ...Array.from({ length: 20 }, (_, i) => chat(`many-${i}`, `Conversation ${i + 1} with a long name`))];
const shots = process.env.ELPIS_PARITY_SHOTS;
const row = (page, id, section = 'section[aria-label="Recents"]') => page.locator(`aside.sidebar ${section} .thread-row[data-thread-id="${id}"]`);

async function setup(colorScheme, project = false, extraRoutes = {}) {
  const routes = { '/api/threads': (_body, url) => ({ data: url.searchParams.get('archived') === 'true' ? []
    : url.searchParams.has('ancestorThreadId') ? threads.filter(t => t.parentThreadId === url.searchParams.get('ancestorThreadId')) : threads, nextCursor: null }),
    ...extraRoutes };
  const storage = { 'elpis-pinned-chats-v1': JSON.stringify(['pinned']),
    'elpis-chat-groups-v1': JSON.stringify({ groups: [{ id: 'review', name: 'Review' }], members: { grouped: 'review' }, groupBy: 'custom', sortBy: 'recency', collapsed: [], order: [] }) };
  if (project) Object.assign(storage, {
    'elpis-projects-v1': JSON.stringify({ projects: [{ id: 'match-making', name: 'match-making', cwd: CWD }], selectedId: null }),
    'elpis-project-chats-v1': JSON.stringify({ 'chat-a': 'match-making', 'chat-b': 'match-making', 'chat-c': 'match-making' }),
  });
  const f = await fixture({ colorScheme, width: 1130, height: 1000, routes, storage, threads, staticDir: process.env.ELPIS_RENDERER_OUT });
  await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
  return f;
}

async function capture(page, name, geometry) {
  if (!shots) return;
  await fs.mkdir(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
  if (geometry) await fs.writeFile(path.join(shots, `${name}.json`), JSON.stringify(geometry, null, 2));
}

async function geometry(target) {
  return target.evaluate(element => {
    const box = selector => element.querySelector(selector).getBoundingClientRect().toJSON();
    const link = element.querySelector('.thread-link'), rowStyle = getComputedStyle(element);
    return { row: element.getBoundingClientRect().toJSON(), title: box('.thread-title'), link: box('.thread-link'),
      titleEnd: element.getBoundingClientRect().right - parseFloat(rowStyle.paddingRight) - parseFloat(rowStyle.borderRightWidth) - parseFloat(getComputedStyle(link).paddingRight),
      nativeTitle: link.getAttribute('title') };
  });
}

function fullWidth(actual, context) {
  assert.ok(Math.abs(actual.title.right - actual.titleEnd) < 0.5,
    `${context}: name must use the full row at rest; ${actual.titleEnd - actual.title.right}px was reserved for controls`);
}

function unchanged(before, after, context) {
  assert.deepEqual(after.title, before.title, `${context}: controls must overlay the name without changing its size or position`);
  assert.deepEqual(after.row, before.row, `${context}: the row must not jump`);
}

async function controls(target, shown) {
  const actions = target.locator('.thread-row-actions');
  await actions.evaluate((element, shown) => new Promise((resolve, reject) => {
    const deadline = performance.now() + 3000;
    const check = () => Number(getComputedStyle(element).opacity) === Number(shown) ? resolve()
      : performance.now() > deadline ? reject(new Error(`controls did not become ${shown ? 'visible' : 'hidden'}`)) : requestAnimationFrame(check);
    check();
  }), shown);
  return actions.evaluate(element => ({ opacity: getComputedStyle(element).opacity,
    fade: getComputedStyle(element).maskImage, background: getComputedStyle(element).backgroundImage }));
}

async function resizeSidebar(page, width) {
  const handle = page.getByRole('separator', { name: 'Resize sidebar', exact: true });
  await handle.focus();
  for (let i = 0; i < 20; i++) {
    const current = Number(await handle.getAttribute('aria-valuenow'));
    if (current === width) return;
    await handle.press(current < width ? 'ArrowRight' : 'ArrowLeft');
  }
  assert.fail(`sidebar did not resize to ${width}px`);
}

async function checkLabel(page, target, name, screenshot) {
  const link = target.locator('.thread-link');
  await page.getByRole('textbox', { name: 'Search conversations', exact: true }).focus();
  await page.mouse.move(700, 60);
  await target.scrollIntoViewIfNeeded();
  const before = await geometry(target);
  await link.hover();
  const measured = await geometry(target);
  await capture(page, screenshot, measured);
  // Chromium's native title popup (the reported dark label) is outside the DOM and its placement is uncontrolled.
  assert.equal(measured.nativeTitle, null, `R24: native title "${measured.nativeTitle}" can cover its row; use the positioned label`);
  const tooltip = page.getByRole('tooltip').filter({ hasText: name });
  await tooltip.waitFor();
  assert.equal(await tooltip.innerText(), name, 'the label exposes the complete name');
  const actual = await tooltip.boundingBox(), sidebar = await page.locator('aside.sidebar').boundingBox();
  assert.ok(actual.x >= sidebar.x + sidebar.width + 6 - 0.5, `R24: label needs a 6px gap outside sidebar: ${JSON.stringify({ actual, sidebar, row: measured.row })}`);
  assert.ok(actual.x + actual.width <= (await page.viewportSize()).width, 'the complete label stays in the viewport');
  const visible = await tooltip.evaluate(element => ({ clipped: element.scrollHeight > element.clientHeight, wrapping: getComputedStyle(element).overflowWrap }));
  assert.equal(visible.clipped, false, 'long labels wrap without clipping');
  fullWidth(before, screenshot);
  unchanged(before, measured, screenshot);
  await capture(page, screenshot, { ...measured, tooltip: actual, sidebar });
  await page.mouse.move(700, 60);
  await tooltip.waitFor({ state: 'hidden' });
}

for (const theme of ['light', 'dark']) {
  test(`A133: positioned full labels in Recents, Pinned and agents (${theme})`, async () => {
    const f = await setup(theme), { page } = f;
    try {
      for (const [id, name] of [['chat-a', longName], ['chat-b', 'Didar'], ['chat-c', threads[2].name], ['many-19', threads.at(-1).name]]) {
        await checkLabel(page, row(page, id), name, `${theme}-recents-${id}`);
      }
      await checkLabel(page, row(page, 'pinned', 'section[aria-label="Pinned"]'), longName, `${theme}-pinned`);
      await checkLabel(page, row(page, 'grouped', 'section[aria-label="Groups"]'), longName, `${theme}-grouped`);
      await row(page, 'chat-a').getByRole('button', { name: `Expand agents in ${longName}`, exact: true }).click();
      await checkLabel(page, row(page, 'agent'), 'Agent — ' + longName, `${theme}-agent`);
      const link = row(page, 'chat-a').locator('.thread-link');
      await page.keyboard.press('Tab');
      await link.focus();
      await page.getByRole('tooltip').filter({ hasText: longName }).waitFor();
      await page.keyboard.press('Escape');
      await page.getByRole('tooltip').waitFor({ state: 'hidden' });
      await link.press('Enter');
      await row(page, 'chat-a').and(page.locator('.active')).waitFor();
      await page.reload();
      await page.locator('.startup-splash').waitFor({ state: 'detached' });
      await checkLabel(page, row(page, 'chat-a'), longName, `${theme}-reload`);
      const search = page.getByRole('textbox', { name: 'Search conversations', exact: true });
      await search.fill('no-matching-a133-chat');
      await page.waitForFunction(() => document.querySelectorAll('aside.sidebar .thread-row').length === 0);
      assert.equal(await page.getByRole('tooltip').count(), 0, 'an empty search leaves no stale label');
      await capture(page, `${theme}-empty`);
      await search.fill('Didar');
      await checkLabel(page, row(page, 'chat-a', 'section[aria-label="Results"]'), longName, `${theme}-search`);
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  });

  test(`A133: Project names use the full row; hover and focus overlay buttons without resizing (${theme})`, async () => {
    const f = await setup(theme, true), { page } = f;
    try {
      for (const width of [256, 200, 480]) {
        await resizeSidebar(page, width);
        for (const id of ['chat-a', 'chat-b', 'chat-c']) {
          const target = row(page, id, '.project-group');
          await page.getByRole('textbox', { name: 'Search conversations', exact: true }).focus();
          await page.mouse.move(700, 60);
          const before = await geometry(target);
          await capture(page, `${theme}-project-${width}-${id}-rest`, before);
          await target.locator('.thread-link').hover();
          const after = await geometry(target);
          await capture(page, `${theme}-project-${width}-${id}`, { before, after });
          fullWidth(before, `${theme}/${width}/${id}`);
          unchanged(before, after, 'hover');
          const shown = await controls(target, true);
          assert.match(shown.fade, /linear-gradient/, 'the buttons fade into the row background');
          assert.match(shown.background, /linear-gradient/, 'the fade uses the current row tint');
          for (const name of [`Pin ${threads.find(t => t.id === id).name}`, `Archive ${threads.find(t => t.id === id).name}`]) {
            assert.equal(await target.getByRole('button', { name, exact: true }).isVisible(), width !== 200,
              'only rows too narrow for the buttons use the menu fallback');
          }
          if (id === 'chat-b') assert.equal(await target.locator('.thread-title').evaluate(element => element.scrollWidth <= element.clientWidth), true, 'Didar remains fully readable');
          await page.mouse.move(700, 60);
          await controls(target, false);
          await target.locator('.thread-link').focus();
          await controls(target, true);
          unchanged(before, await geometry(target), 'keyboard focus');
          await capture(page, `${theme}-project-${width}-${id}-focus`);
        }
        await checkLabel(page, row(page, 'chat-a', '.project-group'), longName, `${theme}-project-${width}-label`);
      }
      // Narrow rows keep the existing menu's Pin and Archive available to pointer and keyboard.
      await resizeSidebar(page, 200);
      const target = row(page, 'chat-a', '.project-group');
      await target.getByRole('button', { name: `Actions for ${longName}`, exact: true }).click();
      await page.getByRole('menuitem', { name: 'Pin', exact: true }).waitFor();
      await page.getByRole('menuitem', { name: 'Archive', exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await page.setViewportSize({ width: 390, height: 1000 });
      await page.getByRole('button', { name: 'Open sidebar', exact: true }).click();
      await checkLabel(page, row(page, 'chat-a', '.project-group'), longName, `${theme}-mobile`);
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  });
}
