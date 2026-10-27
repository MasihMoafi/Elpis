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
  return { circle: x('.conversation-colour-trigger .conversation-colour-swatch'), title: x('.agent-identity, .thread-title') };
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
        const circle = element.querySelector('.conversation-colour-trigger .conversation-colour-swatch').getBoundingClientRect();
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
      assert.equal(await row(parent.id).locator('.conversation-colour-trigger').evaluate(element => element === document.activeElement), true, 'Tab reaches the persistent colour control');
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
