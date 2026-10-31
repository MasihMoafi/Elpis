// A118: "the indent shouldn't be for the mother agent". Measure the actual exported renderer,
// with the same parity bridge as the neighbouring sidebar tests. No CSS or DOM overrides here.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture, CWD } = require('./parity-fixture.cjs');

const shots = process.env.ELPIS_PARITY_SHOTS;
const chat = (id, name, extra = {}) => ({ id, name, preview: name, cwd: CWD, model: 'sol', modelProvider: 'openai',
  status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' }, ...extra });
const parent = chat('chat-a', 'Elpis — recovery and chat priorities');
const plain = chat('chat-b', 'Compare spec-kit'), last = chat('chat-c', 'mamad');
const child = chat('agent-child', 'Check sidebar alignment with a long agent title that must stay inside the row', { parentThreadId: parent.id });
const nested = chat('agent-nested', 'Review the alignment', { parentThreadId: child.id });
const leaf = chat('agent-leaf', 'Check the project list', { parentThreadId: parent.id });
const threads = [plain, parent, last, child, leaf, nested];
const routes = { '/api/threads': (_body, url) => ({ data: url.searchParams.get('archived') === 'true' ? []
  : url.searchParams.has('ancestorThreadId') ? threads.filter(thread => thread.parentThreadId === url.searchParams.get('ancestorThreadId'))
  : threads, nextCursor: null }) };
for (const thread of threads) {
  routes[`/api/threads/${thread.id}`] = () => ({ thread, data: [], nextCursor: null });
  routes[`/api/threads/${thread.id}/resume`] = () => ({ thread, activeTurnId: null });
}

test('selected chat frames keep their size and share the theme accent in both schemes', async () => {
  const love = chat('love-frame', 'Love Spot: Frame reference');
  const sample = [...threads.map(thread => thread.parentThreadId ? { ...thread, source: { subAgent: { thread_spawn: {
    agent_path: `/root/${thread.id}`, parent_thread_id: thread.parentThreadId, depth: thread.id === nested.id ? 2 : 1,
  } } } } : thread), love];
  const frameRoutes = { '/api/threads': (_body, url) => ({ data: url.searchParams.get('archived') === 'true' ? []
    : url.searchParams.has('ancestorThreadId') ? sample.filter(thread => thread.parentThreadId === url.searchParams.get('ancestorThreadId'))
    : sample, nextCursor: null }) };
  for (const thread of sample) {
    frameRoutes[`/api/threads/${thread.id}`] = () => ({ thread, data: [], nextCursor: null });
    frameRoutes[`/api/threads/${thread.id}/resume`] = () => ({ thread, activeTurnId: null });
  }
  const inspect = async (colorScheme, width, staticDir, proposed) => {
    const f = await fixture({ routes: frameRoutes, colorScheme, width, height: 760, staticDir });
    const { page } = f, states = {};
    try {
      await page.locator(`.thread-row[data-thread-id="${parent.id}"] > button[aria-expanded]:first-child`).click();
      await page.locator(`.thread-row[data-thread-id="${child.id}"]`).waitFor();
      for (const id of [plain.id, child.id, love.id]) {
        const row = page.locator(`.thread-row[data-thread-id="${id}"]`);
        const before = await row.boundingBox();
        const beforeTitle = await row.locator('.thread-title').boundingBox();
        await f.open(id);
        await page.locator('.chat-view[data-team-loading="true"]').waitFor({ state: 'hidden' });
        const tab = page.locator('.task-tab.chat-tab.active'), composer = page.locator('.composer');
        await tab.waitFor();
        const after = await row.boundingBox(), afterTitle = await row.locator('.thread-title').boundingBox();
        assert.deepEqual(after, before, `${id}: selection must not move or resize the row`);
        assert.deepEqual(afterTitle, beforeTitle, `${id}: selection must not move the title`);
        const geometry = async locator => locator.evaluate(element => {
          const bounds = element.getBoundingClientRect(), style = getComputedStyle(element);
          return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, background: style.backgroundColor,
            padding: style.padding, radius: style.borderRadius, corner: style.cornerShape };
        });
        const frame = async locator => locator.evaluate(element => {
          const style = getComputedStyle(element, '::before');
          return { content: style.content, background: style.backgroundImage, mask: style.maskComposite,
            border: style.borderTopWidth, pointer: style.pointerEvents };
        });
        const hasComposer = await composer.count() > 0;
        assert.equal(hasComposer, id !== child.id, `${id}: delegated runs keep their read-only state`);
        const rowFrame = await frame(row), tabFrame = await frame(tab), composerFrame = hasComposer ? await frame(composer) : null;
        if (proposed) {
          for (const [name, actual] of Object.entries({ row: rowFrame, tab: tabFrame })) {
            assert.equal(actual.content, '""', `${id}: ${name} frame exists`);
            assert.match(actual.background, /linear-gradient/, `${id}: ${name} has an accent gradient`);
            assert.ok(actual.mask.split(',').every(value => value.trim() === 'exclude'), `${id}: ${name} keeps the fill clear`);
            assert.equal(actual.pointer, 'none', `${id}: ${name} does not block controls`);
          }
          assert.equal(rowFrame.border, '2px', `${id}: retain the old highlight width`);
          assert.equal(tabFrame.border, '1px');
          if (composerFrame) assert.equal(composerFrame.content, 'none', 'the optional composer redesign remains a preview');
          assert.equal(rowFrame.background, tabFrame.background, `${id}: row and tab use the same accent`);

          const accent = await row.evaluate(element => {
            const probe = document.createElement('span');
            probe.style.color = 'var(--primary)'; element.append(probe);
            const color = getComputedStyle(probe).color; probe.remove(); return color;
          });
          assert.ok(rowFrame.background.includes(accent), `${id}: the frame uses its theme accent`);
          if (id === love.id) assert.equal(accent, colorScheme === 'light' ? 'rgb(139, 16, 23)' : 'rgb(236, 87, 94)');
          const inactive = page.locator('.thread-row:not(.active)').first();
          assert.equal((await frame(inactive)).content, 'none', 'inactive rows have no active frame');
        }
        const glow = await row.evaluate((element, candidate) => {
          const style = getComputedStyle(element, candidate ? '::after' : '::before');
          return { left: style.left, top: style.top, bottom: style.bottom, width: style.width, shadow: style.boxShadow };
        }, proposed);
        states[id] = { row: await geometry(row), title: await geometry(row.locator('.thread-title')),
          tab: await geometry(tab), composer: hasComposer ? await geometry(composer) : null, glow };
      }
      await f.composer.fill('draft remains editable');
      assert.equal(await f.composer.inputValue(), 'draft remains editable');
      await f.composer.fill('');
      if (proposed && shots) {
        await fs.mkdir(shots, { recursive: true });
        if (colorScheme === 'light') await f.open(plain.id);
        await page.screenshot({ path: path.join(shots, `chat-frame-${colorScheme}-${width}.png`), animations: 'disabled' });
      }
      assert.deepEqual(f.errors, []);
      return states;
    } finally { await f.close(); }
  };
  for (const [colorScheme, width] of [['light', 1440], ['dark', 820]]) {
    const baseline = process.env.ELPIS_FRAME_BASELINE_OUT
      ? await inspect(colorScheme, width, process.env.ELPIS_FRAME_BASELINE_OUT, false) : null;
    const candidate = await inspect(colorScheme, width, process.env.ELPIS_RENDERER_OUT, true);
    if (baseline) assert.deepEqual(candidate, baseline, `${colorScheme}: frame must preserve installed geometry and fill`);
  }
});

async function setup(colorScheme, project = false) {
  const storage = project ? {
    'elpis-projects-v1': JSON.stringify({ projects: [{ id: 'alignment', name: 'Alignment project', cwd: CWD }], selectedId: null }),
    'elpis-project-chats-v1': JSON.stringify(Object.fromEntries([plain, parent, last].map(thread => [thread.id, 'alignment']))),
  } : {};
  const f = await fixture({ routes, storage, colorScheme, height: 1000, staticDir: process.env.ELPIS_RENDERER_OUT });
  await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
  const section = f.page.locator(project ? 'aside.sidebar .project-group' : 'aside.sidebar section[aria-label="Recents"]');
  const row = id => section.locator(`.thread-row[data-thread-id="${id}"]`);
  await row(parent.id).waitFor();
  return { ...f, section, row, toggle: () => row(parent.id).getByRole('button', { name: /agents in/ }) };
}

const coordinates = row => row.evaluate(element => {
  const x = selector => element.querySelector(selector).getBoundingClientRect().x;
  return { circle: x('.conversation-state-slot .thread-dot'), title: x('.agent-identity, .thread-title') };
});
async function capture(page, name) {
  if (!shots) return;
  await fs.mkdir(shots, { recursive: true });
  await page.locator('aside.sidebar').screenshot({ path: path.join(shots, `${name}.png`) });
}

for (const colorScheme of ['light', 'dark']) {
  for (const project of [false, true]) test(`agents chevron stays inside the sidebar with a 4px circle gap at depths 0 and 1 in ${project ? 'projects' : 'Recents'} (${colorScheme})`, async () => {
    const f = await setup(colorScheme, project), { page, row, toggle } = f;
    const measured = [];
    const measure = async (id, depth, state) => {
      measured.push({ depth, state, ...await row(id).evaluate(element => {
        const button = element.querySelector(':scope > button[aria-expanded]');
        const icon = button.querySelector('svg').getBoundingClientRect();
        const circle = element.querySelector('.conversation-state-slot .thread-dot').getBoundingClientRect();
        const target = button.getBoundingClientRect();
        const clipped = [];
        for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
          if (getComputedStyle(ancestor).overflowX !== 'visible') clipped.push(ancestor.getBoundingClientRect().left);
        }
        return { left: icon.left, right: icon.right, circle: circle.left, clipLeft: Math.max(...clipped),
          sidebar: element.closest('aside.sidebar').getBoundingClientRect().left,
          target: { left: target.left, width: target.width, height: target.height } };
      }) });
    };
    try {
      await measure(parent.id, 0, 'collapsed');
      await toggle().click();
      await row(child.id).waitFor();
      await measure(parent.id, 0, 'expanded');
      await measure(child.id, 1, 'collapsed');
      await row(child.id).getByRole('button', { name: /Expand agents in/ }).click();
      await row(nested.id).waitFor();
      await measure(child.id, 1, 'expanded');
      await page.mouse.move(700, 60);
      await capture(page, `${project ? 'project' : 'recents'}-${colorScheme}-chevron-gap`);
      if (shots) await fs.writeFile(path.join(shots, `${project ? 'project' : 'recents'}-${colorScheme}-chevron-gap.json`), JSON.stringify(measured, null, 2));
      for (const actual of measured) {
        const label = `depth ${actual.depth}, ${actual.state}`;
        assert.ok(actual.left >= actual.sidebar, `${label}: chevron's left edge stays inside the sidebar`);
        assert.ok(actual.left >= actual.clipLeft, `${label}: the scroll container does not clip the chevron`);
        assert.ok(actual.circle - actual.right >= 4, `${label}: chevron needs at least 4px before the circle; got ${actual.circle - actual.right}px`);
        assert.ok(actual.target.width >= 12 && actual.target.height >= 24, `${label}: keep the existing click target`);
      }
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  });

  for (const project of [false, true]) test(`mother and agent coordinates in ${project ? 'projects' : 'Recents'} (${colorScheme})`, async () => {
    const f = await setup(colorScheme, project), { page, row, toggle } = f;
    const name = `${project ? 'project' : 'recents'}-${colorScheme}`, measured = {};
    try {
      const reference = await coordinates(row(plain.id));
      const measure = async state => { measured[state] = await coordinates(row(parent.id)); };
      await page.mouse.move(700, 60);
      await measure('rest');
      await capture(page, `${name}-collapsed`);
      await row(parent.id).locator('.thread-link').hover();
      await measure('hover');
      await toggle().click();
      await row(child.id).waitFor();
      await row(leaf.id).waitFor();
      await page.mouse.move(700, 60);
      await measure('expanded');
      const agents = { branch: await coordinates(row(child.id)), leaf: await coordinates(row(leaf.id)) };
      await capture(page, `${name}-expanded`);
      await row(child.id).getByRole('button', { name: /Expand agents in/ }).press('Enter');
      await row(nested.id).waitFor();
      agents.nested = await coordinates(row(nested.id));
      await row(parent.id).locator('.thread-link').click();
      await row(parent.id).and(page.locator('.active')).waitFor();
      await measure('selected');
      await capture(page, `${name}-selected`);
      await row(parent.id).locator('.thread-link').focus();
      await page.keyboard.press('Shift+Tab');
      assert.equal(await toggle().evaluate(element => element === document.activeElement && element.matches(':focus-visible')), true, 'Tab reaches the chevron');
      await capture(page, `${name}-focus`);
      await page.keyboard.press('Space');
      await row(child.id).waitFor({ state: 'hidden' });
      await measure('collapsed again');
      await page.keyboard.press('Enter');
      await row(child.id).waitFor();
      await measure('keyboard expanded');
      await page.reload();
      await row(parent.id).waitFor();
      await page.locator('.startup-splash').waitFor({ state: 'detached' });
      await measure('after reload');
      if (shots) await fs.writeFile(path.join(shots, `${name}-coordinates.json`), JSON.stringify({ reference, measured, agents }, null, 2));
      for (const [state, actual] of Object.entries(measured)) assert.deepEqual(actual, reference, `${state}: mother's circle and title line up with a plain row`);
      for (const [kind, actual] of Object.entries(agents)) {
        const indent = kind === 'nested' ? 28 : 14;
        assert.deepEqual(actual, { circle: reference.circle + indent, title: reference.title + indent }, `${kind}: one 14px step per generation, with or without a chevron`);
      }
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  });

  test(`plain chat keeps its reserved chevron column through sibling expansion and selection (${colorScheme})`, async () => {
    const f = await setup(colorScheme), { page, row, toggle } = f;
    try {
      const original = await coordinates(row(plain.id)), left = await row(plain.id).evaluate(element => element.getBoundingClientRect().x);
      assert.deepEqual(original, { circle: left + 25.5, title: left + 50 }, 'the plain row reserves the same chevron column as project chats');
      assert.equal(await row(plain.id).getByRole('button', { name: /agents in/ }).count(), 0, 'no chevron is added to plain chats');
      await row(plain.id).hover();
      assert.deepEqual(await coordinates(row(plain.id)), original, 'plain hover');
      await toggle().click();
      await row(child.id).waitFor();
      assert.deepEqual(await coordinates(row(plain.id)), original, 'expanding a sibling');
      await row(plain.id).locator('.thread-link').click();
      await row(plain.id).and(page.locator('.active')).waitFor();
      assert.deepEqual(await coordinates(row(plain.id)), original, 'plain selection');
      await page.reload();
      await row(plain.id).waitFor();
      assert.deepEqual(await coordinates(row(plain.id)), original, 'plain reload');
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  });
}
